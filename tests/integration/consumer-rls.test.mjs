import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import crypto from 'node:crypto'
import pg from 'pg'

assert.ok(process.env.PUBLIC_DATABASE_URL, 'PUBLIC_DATABASE_URL is required for consumer RLS integration tests')
const runtimeUrl = process.env.PUBLIC_DATABASE_URL
const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required')

describe('Integration: Consumer RLS & Function Isolation', () => {
  let runtime
  let admin
  let viewerId
  let otherId
  let unrelatedId

  before(async () => {
    runtime = new pg.Pool({ connectionString: runtimeUrl })
    admin = new pg.Pool({ connectionString: adminUrl })

    const candidate1 = await runtime.query(
      "select user_id::text from consumer.lookup_login_candidate('aarav.ganguly')",
    )
    assert.ok(candidate1.rows[0], 'aarav.ganguly fixture is required')
    viewerId = candidate1.rows[0].user_id

    const candidate2 = await runtime.query(
      "select user_id::text from consumer.lookup_login_candidate('aditi.kapoor')",
    )
    assert.ok(candidate2.rows[0], 'aditi.kapoor fixture is required')
    otherId = candidate2.rows[0].user_id

    const candidate3 = await runtime.query(
      "select user_id::text from consumer.lookup_login_candidate('alexander.mehta')",
    )
    assert.ok(candidate3.rows[0], 'alexander.mehta fixture is required')
    unrelatedId = candidate3.rows[0].user_id
  })

  after(async () => {
    if (runtime) await runtime.end()
    if (admin) await admin.end()
  })

  describe('P05.3 Helper Owner Catalog Invariants & ACLs', () => {
    test('consumer_policy_function_owner is NOLOGIN, BYPASSRLS, and has no runtime/login members', async () => {
      const ownerRes = await admin.query(
        `select rolcanlogin, rolbypassrls from pg_roles where rolname = 'consumer_policy_function_owner'`,
      )
      assert.equal(ownerRes.rows[0]?.rolcanlogin, false, 'Helper owner must be NOLOGIN')
      assert.equal(ownerRes.rows[0]?.rolbypassrls, true, 'Helper owner must be BYPASSRLS')

      // Assert neither consumer_runtime nor consumer_bff_login has membership in consumer_policy_function_owner
      const memberRes = await admin.query(
        `select 1 from pg_auth_members m
           join pg_roles r on r.oid = m.roleid
           join pg_roles u on u.oid = m.member
          where r.rolname = 'consumer_policy_function_owner'
            and u.rolname in ('consumer_runtime', 'consumer_bff_login')`,
      )
      assert.equal(memberRes.rowCount, 0, 'No runtime or login role may be a member of consumer_policy_function_owner')
    })

    test('consumer_bff_login cannot directly execute consumer policy helper functions', async () => {
      const client = await runtime.connect()
      try {
        // Without SET LOCAL ROLE consumer_runtime, consumer_bff_login has no EXECUTE on helper functions
        const dummyId = crypto.randomUUID()
        await assert.rejects(
          async () => {
            await client.query(`select consumer.can_access_group($1::uuid)`, [dummyId])
          },
          /permission denied for function can_access_group/,
        )
      } finally {
        client.release()
      }
    })
  })

  describe('P05.3 Consumer RLS Scoping, Negative Paths, and Multi-Group Isolation', () => {
    test('runtime identity cannot enumerate an unrelated consumer', async () => {
      const client = await runtime.connect()
      try {
        await client.query('begin')
        await client.query('set local role consumer_runtime')
        await client.query("select set_config('app.current_user_id', $1, true)", [viewerId])
        const visible = await client.query('select user_id::text as id from consumer.user_account')
        const ids = visible.rows.map((row) => row.id)
        assert.ok(ids.includes(viewerId), 'the current user must remain visible')
        assert.ok(!ids.includes(unrelatedId), 'unrelated user must be hidden by RLS')
        await client.query('rollback')
      } finally {
        client.release()
      }
    })

    test('collaboration groups evaluate without recursion and enforce access boundaries', async () => {
      const client = await runtime.connect()
      try {
        await client.query('begin')
        await client.query('set local role consumer_runtime')
        await client.query("select set_config('app.current_user_id', $1, true)", [viewerId])

        // 1. Create a collaboration group owned by viewerId
        const groupRes = await client.query(
          `insert into consumer.collaboration_group (name, owner_user_id)
           values ('Test Collaboration Team', $1)
           returning group_id::text`,
          [viewerId],
        )
        const groupId = groupRes.rows[0].group_id

        // 2. Add aditi.kapoor (otherId) to the group as viewer
        const roleRes = await client.query(
          "select role_id::text from consumer.role_definition where role_code = 'group_viewer' limit 1",
        )
        const roleId = roleRes.rows[0]?.role_id
        assert.ok(roleId, 'group_viewer role is required')

        await client.query(
          `insert into consumer.group_membership (group_id, user_id, role_id)
           values ($1, $2, $3)`,
          [groupId, otherId, roleId],
        )

        // 3. Query collaboration groups - must NOT throw SQLSTATE 54001
        const groups = await client.query('select group_id::text as id, name from consumer.collaboration_group')
        assert.ok(groups.rows.some((g) => g.id === groupId))

        // 4. Query user directory - otherId should now be visible via shares_group_with
        const sharedUsers = await client.query('select user_id::text as id from consumer.user_account')
        const sharedIds = sharedUsers.rows.map((u) => u.id)
        assert.ok(sharedIds.includes(viewerId), 'owner remains visible')
        assert.ok(sharedIds.includes(otherId), 'group member is visible via collaboration group')
        assert.ok(!sharedIds.includes(unrelatedId), 'unrelated user remains hidden')

        // 5. Switch context to otherId (member) - can see group
        await client.query("select set_config('app.current_user_id', $1, true)", [otherId])
        const memberGroups = await client.query('select group_id::text as id from consumer.collaboration_group')
        assert.ok(memberGroups.rows.some((g) => g.id === groupId), 'member can access group')

        // 6. Negative mutation: member (viewer) cannot delete the group
        const deleteRes = await client.query(
          'delete from consumer.collaboration_group where group_id = $1',
          [groupId],
        )
        assert.equal(deleteRes.rowCount, 0, 'Group viewer cannot delete group (RLS silently filters row)')

        // 7. Switch context to unrelatedId - cannot see the group
        await client.query("select set_config('app.current_user_id', $1, true)", [unrelatedId])
        const unrelatedGroups = await client.query('select group_id::text as id from consumer.collaboration_group')
        assert.ok(!unrelatedGroups.rows.some((g) => g.id === groupId), 'unrelated user cannot see group')

        // 8. Missing user context - cannot see group or users
        await client.query("select set_config('app.current_user_id', '', true)")
        const noContextGroups = await client.query('select group_id::text as id from consumer.collaboration_group')
        assert.equal(noContextGroups.rowCount, 0, 'Missing user context cannot see any groups')

        await client.query('rollback')
      } finally {
        client.release()
      }
    })

    test('connection reuse with transaction rollback clears GUC context', async () => {
      const client = await runtime.connect()
      try {
        // Step 1: In a transaction, set app.current_user_id to viewerId, then rollback
        await client.query('begin')
        await client.query('set local role consumer_runtime')
        await client.query("select set_config('app.current_user_id', $1, true)", [viewerId])
        await client.query('rollback')

        // Step 2: On the SAME client connection, verify GUC context is cleared
        const gucRes = await client.query(
          "select current_setting('app.current_user_id', true) as guc",
        )
        assert.ok(!gucRes.rows[0]?.guc, 'GUC context must be cleared after transaction rollback')
      } finally {
        client.release()
      }
    })
  })
})

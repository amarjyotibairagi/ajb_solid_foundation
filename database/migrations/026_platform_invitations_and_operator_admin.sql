-- Migration 026: Admin-panel onboarding and operator administration.
--
-- Before this migration a newly provisioned tenant had no users and the only
-- way to create its first owner was scripts/tenant-operator.mjs on the server.
-- Platform operators likewise could only be created, re-roled, or re-enabled
-- from a shell. This migration moves those operations behind the platform BFF
-- while keeping the BFF's direct table privileges narrow:
--
--   * every write is a SECURITY DEFINER function owned by platform_owner that
--     enforces its own invariants and writes its audit row in the same
--     transaction, matching the pattern of migration 021;
--   * invitation secrets are stored only as SHA-256 hashes;
--   * the tenant BFF, which connects as tenant_registry_reader_login and has
--     no platform write privileges, can consume exactly one owner invitation
--     for exactly its own tenant through a single narrowly-scoped function.

begin;

-- 1. Tenant owner invitations ------------------------------------------------
-- Issued by a platform operator, redeemed on the tenant's own hostname. The
-- platform never writes into a tenant schema; the tenant BFF creates the owner
-- account inside the tenant transaction and consumes the invitation here.

create table if not exists platform.tenant_owner_invitation (
  invitation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant_registry(tenant_id) on delete cascade,
  email_normalized text not null check (email_normalized = lower(email_normalized) and length(email_normalized) between 3 and 320),
  display_name text not null check (length(btrim(display_name)) between 1 and 255),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid references platform.platform_user(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (consumed_at is null or revoked_at is null)
);

create index if not exists tenant_owner_invitation_tenant_idx
  on platform.tenant_owner_invitation (tenant_id, created_at desc);

alter table platform.tenant_owner_invitation owner to platform_owner;
revoke all on platform.tenant_owner_invitation from public;
grant select on platform.tenant_owner_invitation to platform_bff_runtime;

create or replace function platform.issue_tenant_owner_invitation(
  p_tenant_key text,
  p_email text,
  p_display_name text,
  p_token_hash text,
  p_ttl_hours integer,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
  v_invitation_id uuid;
begin
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 720 then
    raise exception 'Invitation lifetime must be between 1 and 720 hours.' using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id
    from tenant_registry
   where tenant_key = p_tenant_key
     and lifecycle_status in ('provisioning', 'active', 'suspended')
   for update;
  if not found then
    raise exception 'Tenant is not eligible for an owner invitation.' using errcode = '55000';
  end if;

  -- One outstanding owner invitation per tenant: reissuing revokes the old link.
  update tenant_owner_invitation
     set revoked_at = now()
   where tenant_id = v_tenant_id and consumed_at is null and revoked_at is null;

  insert into tenant_owner_invitation (
    tenant_id, email_normalized, display_name, token_hash, issued_by, expires_at
  ) values (
    v_tenant_id, lower(btrim(p_email)), btrim(p_display_name), p_token_hash, p_actor_user_id,
    now() + make_interval(hours => p_ttl_hours)
  ) returning invitation_id into v_invitation_id;

  insert into platform_audit (
    user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
  ) values (
    p_actor_user_id, v_tenant_id, 'tenant_onboarding', 'owner_invitation_issued', 'SUCCESS',
    'tenant_owner_invitation', v_invitation_id::text, 'allow'
  );
  return v_invitation_id;
end
$$;

create or replace function platform.revoke_tenant_owner_invitation(
  p_invitation_id uuid,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
begin
  update tenant_owner_invitation
     set revoked_at = now()
   where invitation_id = p_invitation_id and consumed_at is null and revoked_at is null
   returning tenant_id into v_tenant_id;
  if not found then return false; end if;
  insert into platform_audit (
    user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
  ) values (
    p_actor_user_id, v_tenant_id, 'tenant_onboarding', 'owner_invitation_revoked', 'SUCCESS',
    'tenant_owner_invitation', p_invitation_id::text, 'allow'
  );
  return true;
end
$$;

-- Read-only check used by the tenant accept page before the user submits.
create or replace function platform.inspect_tenant_owner_invitation(
  p_tenant_id uuid,
  p_token_hash text
) returns table (email_normalized text, display_name text, expires_at timestamptz)
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  select i.email_normalized, i.display_name, i.expires_at
    from tenant_owner_invitation i
   where i.tenant_id = p_tenant_id
     and i.token_hash = p_token_hash
     and i.consumed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
$$;

-- Atomically claims the invitation. The tenant BFF calls this while its own
-- tenant transaction (which creates the owner) is still open and rolls that
-- transaction back if this returns no row.
create or replace function platform.consume_tenant_owner_invitation(
  p_tenant_id uuid,
  p_token_hash text
) returns table (invitation_id uuid, email_normalized text, display_name text)
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  return query
  update tenant_owner_invitation i
     set consumed_at = now()
   where i.tenant_id = p_tenant_id
     and i.token_hash = p_token_hash
     and i.consumed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
  returning i.invitation_id, i.email_normalized, i.display_name;

  if found then
    insert into platform_audit (
      user_id, tenant_id, feature, action, status, resource_type, policy_decision
    ) values (
      null, p_tenant_id, 'tenant_onboarding', 'owner_invitation_accepted', 'SUCCESS',
      'tenant_owner_invitation', 'allow'
    );
  end if;
end
$$;

-- 2. Tenant profile edits ----------------------------------------------------
-- Identity fields stay immutable (migration 020). Only presentation and
-- contact fields change here.

create or replace function platform.update_tenant_profile(
  p_tenant_key text,
  p_actor_user_id uuid,
  p_display_name text,
  p_legal_name text,
  p_default_locale text,
  p_logo_url text,
  p_primary_color text,
  p_secondary_color text,
  p_login_message text
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
begin
  if p_default_locale is not null and p_default_locale !~ '^[a-z]{2}(-[A-Z]{2})?$' then
    raise exception 'Locale is invalid.' using errcode = '22023';
  end if;
  if (p_primary_color is not null and p_primary_color !~ '^#[0-9A-Fa-f]{6}$')
     or (p_secondary_color is not null and p_secondary_color !~ '^#[0-9A-Fa-f]{6}$') then
    raise exception 'Colors must be #RRGGBB.' using errcode = '22023';
  end if;
  if p_logo_url is not null and p_logo_url <> '' and p_logo_url !~ '^https://' then
    raise exception 'Logo URL must use https.' using errcode = '22023';
  end if;

  update tenant_registry
     set display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
         legal_name = coalesce(nullif(btrim(p_legal_name), ''), legal_name),
         default_locale = coalesce(p_default_locale, default_locale)
   where tenant_key = p_tenant_key and lifecycle_status not in ('deleting', 'deleted')
   returning tenant_id into v_tenant_id;
  if not found then return false; end if;

  insert into tenant_branding (tenant_id) values (v_tenant_id) on conflict (tenant_id) do nothing;
  update tenant_branding
     set logo_url = case when p_logo_url is null then logo_url else nullif(p_logo_url, '') end,
         primary_color = coalesce(p_primary_color, primary_color),
         secondary_color = coalesce(p_secondary_color, secondary_color),
         login_message = case when p_login_message is null then login_message else nullif(btrim(p_login_message), '') end,
         default_locale = coalesce(p_default_locale, default_locale)
   where tenant_id = v_tenant_id;

  insert into platform_audit (
    user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
  ) values (
    p_actor_user_id, v_tenant_id, 'tenant_lifecycle', 'tenant_profile_updated', 'SUCCESS',
    'tenant', p_tenant_key, 'allow'
  );
  return true;
end
$$;

-- 3. Platform operator administration ---------------------------------------

-- Invited operators have no password until they accept. The format CHECK from
-- migration 024 already admits NULL; only the column's NOT NULL blocked it.
alter table platform.platform_user alter column password_hash drop not null;

create table if not exists platform.platform_operator_invitation (
  invitation_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references platform.platform_user(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid references platform.platform_user(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

alter table platform.platform_operator_invitation owner to platform_owner;
revoke all on platform.platform_operator_invitation from public;
grant select on platform.platform_operator_invitation to platform_bff_runtime;

-- Serialises every operation that could remove the last active owner.
create or replace function platform.assert_platform_owner_remains(p_excluding uuid)
returns void
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  perform pg_advisory_xact_lock(hashtext('platform-owner-lock'));
  if not exists (
    select 1 from platform_user
     where role = 'platform_owner' and is_active and id <> p_excluding
  ) then
    raise exception 'At least one active platform_owner must remain.' using errcode = '55000';
  end if;
end
$$;

-- Creates an inactive operator with an unusable password and an invitation.
-- The account becomes active only when the invitee sets a password.
create or replace function platform.invite_platform_operator(
  p_username text,
  p_display_name text,
  p_email text,
  p_role text,
  p_token_hash text,
  p_ttl_hours integer,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_user_id uuid;
begin
  if p_role not in ('platform_owner', 'platform_admin', 'platform_viewer') then
    raise exception 'Unknown platform role.' using errcode = '22023';
  end if;
  if p_username !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception 'Username must be 3-64 lowercase letters, digits, dot, dash or underscore.' using errcode = '22023';
  end if;
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 720 then
    raise exception 'Invitation lifetime must be between 1 and 720 hours.' using errcode = '22023';
  end if;

  -- A NULL hash cannot authenticate (login verifies against a dummy hash), so
  -- the account is unusable until the invitation sets a real argon2id hash.
  insert into platform_user (username, password_hash, role, display_name, email_normalized, is_active)
  values (p_username, null, p_role, nullif(btrim(p_display_name), ''), nullif(lower(btrim(p_email)), ''), false)
  returning id into v_user_id;

  insert into platform_operator_invitation (user_id, token_hash, issued_by, expires_at)
  values (v_user_id, p_token_hash, p_actor_user_id, now() + make_interval(hours => p_ttl_hours));

  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'platform_operators', 'operator_invited', 'SUCCESS', 'platform_user', v_user_id::text, 'allow');
  return v_user_id;
end
$$;

create or replace function platform.reissue_platform_operator_invitation(
  p_user_id uuid,
  p_token_hash text,
  p_ttl_hours integer,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  if p_user_id = p_actor_user_id then
    raise exception 'You cannot reset your own credentials here.' using errcode = '55000';
  end if;
  if not exists (select 1 from platform_user where id = p_user_id) then return false; end if;
  update platform_operator_invitation set revoked_at = now()
   where user_id = p_user_id and consumed_at is null and revoked_at is null;
  insert into platform_operator_invitation (user_id, token_hash, issued_by, expires_at)
  values (p_user_id, p_token_hash, p_actor_user_id, now() + make_interval(hours => p_ttl_hours));
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'platform_operators', 'operator_credential_reset_issued', 'SUCCESS', 'platform_user', p_user_id::text, 'allow');
  return true;
end
$$;

create or replace function platform.inspect_platform_operator_invitation(p_token_hash text)
returns table (username text, display_name text, role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  select u.username::text, u.display_name, u.role::text, i.expires_at
    from platform_operator_invitation i
    join platform_user u on u.id = i.user_id
   where i.token_hash = p_token_hash
     and i.consumed_at is null and i.revoked_at is null and i.expires_at > now()
$$;

-- Sets the operator's argon2id hash (computed in Node, never in SQL), activates
-- the account, and revokes existing sessions and WebAuthn credentials so a
-- reset also resets the second factor.
create or replace function platform.accept_platform_operator_invitation(
  p_token_hash text,
  p_password_hash text
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_user_id uuid;
begin
  if p_password_hash !~ '^\$argon2id\$' then
    raise exception 'Password hash must be argon2id.' using errcode = '22023';
  end if;
  update platform_operator_invitation
     set consumed_at = now()
   where token_hash = p_token_hash
     and consumed_at is null and revoked_at is null and expires_at > now()
  returning user_id into v_user_id;
  if not found then return null; end if;

  update platform_user
     set password_hash = p_password_hash, is_active = true, updated_at = now()
   where id = v_user_id;
  delete from platform_session where user_id = v_user_id;
  delete from platform_webauthn_credential where user_id = v_user_id;

  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (v_user_id, 'platform_operators', 'operator_invitation_accepted', 'SUCCESS', 'platform_user', v_user_id::text, 'allow');
  return v_user_id;
end
$$;

create or replace function platform.set_platform_operator_role(
  p_user_id uuid,
  p_role text,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_current text;
begin
  if p_role not in ('platform_owner', 'platform_admin', 'platform_viewer') then
    raise exception 'Unknown platform role.' using errcode = '22023';
  end if;
  if p_user_id = p_actor_user_id then
    raise exception 'You cannot change your own role.' using errcode = '55000';
  end if;
  select role into v_current from platform_user where id = p_user_id for update;
  if not found then return false; end if;
  if v_current = 'platform_owner' and p_role <> 'platform_owner' then
    perform assert_platform_owner_remains(p_user_id);
  end if;
  update platform_user set role = p_role, updated_at = now() where id = p_user_id;
  -- Existing sessions carry the old role's trust; force re-authentication.
  delete from platform_session where user_id = p_user_id;
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'platform_operators', 'operator_role_changed:' || p_role, 'SUCCESS', 'platform_user', p_user_id::text, 'allow');
  return true;
end
$$;

create or replace function platform.set_platform_operator_active(
  p_user_id uuid,
  p_active boolean,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_role text;
  v_hash text;
begin
  if p_user_id = p_actor_user_id then
    raise exception 'You cannot change your own account status.' using errcode = '55000';
  end if;
  select role, password_hash into v_role, v_hash from platform_user where id = p_user_id for update;
  if not found then return false; end if;
  if not p_active and v_role = 'platform_owner' then
    perform assert_platform_owner_remains(p_user_id);
  end if;
  if p_active and (v_hash is null or v_hash !~ '^\$argon2id\$') then
    raise exception 'The account has no password yet. Reissue its invitation instead.' using errcode = '55000';
  end if;
  update platform_user set is_active = p_active, updated_at = now() where id = p_user_id;
  if not p_active then
    delete from platform_session where user_id = p_user_id;
    delete from platform_webauthn_challenge where user_id = p_user_id;
  end if;
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'platform_operators', case when p_active then 'operator_enabled' else 'operator_disabled' end,
          'SUCCESS', 'platform_user', p_user_id::text, 'allow');
  return true;
end
$$;

create or replace function platform.revoke_platform_operator_sessions(
  p_user_id uuid,
  p_reset_mfa boolean,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  if not exists (select 1 from platform_user where id = p_user_id) then return false; end if;
  if p_reset_mfa and p_user_id = p_actor_user_id then
    raise exception 'You cannot reset your own second factor.' using errcode = '55000';
  end if;
  delete from platform_session where user_id = p_user_id;
  if p_reset_mfa then
    delete from platform_webauthn_credential where user_id = p_user_id;
    delete from platform_webauthn_challenge where user_id = p_user_id;
  end if;
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'platform_operators',
          case when p_reset_mfa then 'operator_mfa_reset' else 'operator_sessions_revoked' end,
          'SUCCESS', 'platform_user', p_user_id::text, 'allow');
  return true;
end
$$;

-- 4. Ownership and execute grants --------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'platform.issue_tenant_owner_invitation(text, text, text, text, integer, uuid)',
    'platform.revoke_tenant_owner_invitation(uuid, uuid)',
    'platform.inspect_tenant_owner_invitation(uuid, text)',
    'platform.consume_tenant_owner_invitation(uuid, text)',
    'platform.update_tenant_profile(text, uuid, text, text, text, text, text, text, text)',
    'platform.assert_platform_owner_remains(uuid)',
    'platform.invite_platform_operator(text, text, text, text, text, integer, uuid)',
    'platform.reissue_platform_operator_invitation(uuid, text, integer, uuid)',
    'platform.inspect_platform_operator_invitation(text)',
    'platform.accept_platform_operator_invitation(text, text)',
    'platform.set_platform_operator_role(uuid, text, uuid)',
    'platform.set_platform_operator_active(uuid, boolean, uuid)',
    'platform.revoke_platform_operator_sessions(uuid, boolean, uuid)'
  ] loop
    execute format('alter function %s owner to platform_owner', fn);
    execute format('revoke all on function %s from public', fn);
  end loop;
end
$$;

-- The WebAuthn tables were created by an administrative role in 019; the
-- operator functions above run as platform_owner and must reach them.
grant select, delete on platform.platform_webauthn_credential, platform.platform_webauthn_challenge to platform_owner;

grant execute on function
  platform.issue_tenant_owner_invitation(text, text, text, text, integer, uuid),
  platform.revoke_tenant_owner_invitation(uuid, uuid),
  platform.update_tenant_profile(text, uuid, text, text, text, text, text, text, text),
  platform.invite_platform_operator(text, text, text, text, text, integer, uuid),
  platform.reissue_platform_operator_invitation(uuid, text, integer, uuid),
  platform.inspect_platform_operator_invitation(text),
  platform.accept_platform_operator_invitation(text, text),
  platform.set_platform_operator_role(uuid, text, uuid),
  platform.set_platform_operator_active(uuid, boolean, uuid),
  platform.revoke_platform_operator_sessions(uuid, boolean, uuid)
  to platform_bff_runtime;

grant execute on function
  platform.inspect_tenant_owner_invitation(uuid, text),
  platform.consume_tenant_owner_invitation(uuid, text)
  to tenant_registry_reader_login;

insert into platform.schema_migration (migration_key, migration_scope)
values ('026_platform_invitations_and_operator_admin:v1', 'platform')
on conflict (migration_key) do nothing;

commit;

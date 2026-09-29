import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { MetricCard } from '@skeleton/ui/MetricCard'
import { useTurnstile } from '@skeleton/ui/useTurnstile'
import { WorkspaceSettings } from './WorkspaceSettings'
import { FilesPage } from './FilesPage'
import { IntegrationsSettings } from './IntegrationsSettings'
import {
  Activity,
  ArrowRight,
  ArrowRightLeft,
  BadgeCheck,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Clock3,
  Database,
  Eye,
  EyeOff,
  FileClock,
  FileText,
  FolderKanban,
  KeyRound,
  Layers,
  Lock,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  User,
  UserCheck,
  UserPlus,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react'

const API_ORIGIN = import.meta.env.VITE_TENANT_API_ORIGIN || ''

type TenantRole = 'admin' | 'manager' | 'user' | 'guest'

// The API accepts canonical role codes only; the UI keeps its short labels.
const CANONICAL_ROLE: Record<TenantRole, string> = {
  admin: 'tenant_admin',
  manager: 'tenant_manager',
  user: 'tenant_member',
  guest: 'tenant_viewer',
}

type TenantUser = {
  id: string
  username: string
  displayName: string
  email: string
  status: string
  role: TenantRole
  roleDescription?: string
  createdAt?: string
}

type AuditLog = {
  id: string
  action: string
  resourceType: string
  outcome: 'success' | 'denied' | 'failure'
  occurredAt: string
  actor: string
}

type TenantInfo = {
  tenantId: string
  slug: string
  name: string
  domain: string
  description: string
  primaryColor: string
  accentColor: string
  planName: string
}

export default function App() {
  const [tenantInfo, setTenantInfo] = useState<TenantInfo>({
    tenantId: '',
    slug: '',
    name: 'Enterprise Workspace',
    domain: '',
    description: '',
    primaryColor: '#2563eb',
    accentColor: '#0f172a',
    planName: 'Enterprise',
  })

  // Auth state
  const [currentUser, setCurrentUser] = useState<TenantUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)

  // Login Gate form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { isVerified, turnstileToken, isCollapsed, isBadgeVisible, turnstileContainerRef, resetTurnstile } = useTurnstile({
    enabled: !checkingSession && !currentUser,
    onError: setErrorMsg,
  })

  // Workspace UI state
  const [mobileOpen, setMobileOpen] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [editRoleUser, setEditRoleUser] = useState<TenantUser | null>(null)
  const [toast, setToast] = useState('')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [activeNav, setActiveNav] = useState('Overview')
  const [members, setMembers] = useState<TenantUser[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ name: string; link: string; delivered: boolean } | null>(null)

  // Load tenant metadata
  const loadTenantInfo = async () => {
    const res = await fetch(`${API_ORIGIN}/api/tenant/bootstrap`, { credentials: 'include' })
    const data = await res.json()
    if (!res.ok || !data.tenant) throw new Error(data.message || 'Tenant workspace is unavailable.')
    const metadata = data.tenant.branding?.safeMetadata || {}
    setTenantInfo({
      tenantId: data.tenant.tenantId,
      slug: data.tenant.subdomain,
      name: data.tenant.displayName,
      domain: data.tenant.hostname,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      primaryColor: data.tenant.branding?.primaryColor || '#2563eb',
      accentColor: data.tenant.branding?.secondaryColor || '#0f172a',
      planName: typeof metadata.planName === 'string' ? metadata.planName : 'Enterprise',
    })
    document.title = data.tenant.displayName
  }

  // Check initial session
  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadTenantInfo(),
      fetch(`${API_ORIGIN}/api/auth/session`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        if (data.authenticated && data.user) {
          setCurrentUser({
            id: data.user.id,
            username: data.user.username,
            displayName: data.user.displayName,
            email: data.user.email,
            status: 'active',
            role: data.user.role || 'user',
          })
          setCsrfToken(data.csrfToken)
        }
      }),
    ])
      .catch(() => {
        if (!cancelled) setErrorMsg('This tenant workspace could not be loaded.')
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Handle Login Submit
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    if (!isVerified) return

    setErrorMsg(null)
    if (!username.trim()) {
      setErrorMsg('Please enter your username.')
      return
    }

    setIsLoading(true)
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: username.trim(),
          password,
          turnstileToken,
        }),
      })

      const data = await res.json()

      if (res.ok && data.success) {
        setCurrentUser({
          id: data.user.id,
          username: data.user.username,
          displayName: data.user.displayName,
          email: data.user.email,
          status: 'active',
          role: data.user.role || 'user',
        })
        setCsrfToken(data.csrfToken)
        setToast(`Authenticated with ${tenantInfo.name}`)
      } else {
        setErrorMsg(data.message || `Invalid credentials for ${tenantInfo.name}.`)
        resetTurnstile()
      }
    } catch {
      setErrorMsg('Unable to connect to tenant server. Please check connection.')
      resetTurnstile()
    } finally {
      setIsLoading(false)
    }
  }

  // Handle Logout
  const handleLogout = async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Logout failed')
    } catch {
      setToast('Unable to log out. Please retry.')
      return
    }
    setCurrentUser(null)
    setCsrfToken(null)
    setUsername('')
    setPassword('')
    resetTurnstile()
    setToast('Logged out of tenant workspace.')
  }

  // Fetch members & audit logs for authenticated workspace
  const loadTenantData = async () => {
    setIsLoadingData(true)
    try {
      const [usersRes, auditRes] = await Promise.all([
        fetch(`${API_ORIGIN}/api/v1/users?limit=100`, { credentials: 'include' }),
        fetch(`${API_ORIGIN}/api/v1/audit`, { credentials: 'include' }),
      ])

      const [usersData, auditData] = await Promise.all([
        usersRes.json(),
        auditRes.json(),
      ])

      if (usersRes.ok && usersData.users) setMembers(usersData.users)
      else setToast(usersData.message || 'Unable to load tenant members.')
      if (auditRes.ok && auditData.logs) setAuditLogs(auditData.logs)
      else if (auditRes.status !== 403) setToast(auditData.message || 'Unable to load tenant audit data.')
    } catch {
      setToast('Unable to load tenant data.')
    } finally {
      setIsLoadingData(false)
    }
  }

  useEffect(() => {
    if (currentUser) {
      loadTenantData()
    }
  }, [currentUser])

  // Toast timer
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const filteredMembers = useMemo(() => {
    return members.filter((member) => {
      const matchSearch =
        !search ||
        `${member.displayName} ${member.username} ${member.email}`.toLowerCase().includes(search.toLowerCase())
      const matchRole = !roleFilter || member.role === roleFilter
      return matchSearch && matchRole
    })
  }, [members, search, roleFilter])

  // Invite member
  const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const displayName = String(form.get('displayName') || '')
    const username = String(form.get('username') || '').toLowerCase()
    const email = String(form.get('email') || '').toLowerCase()
    const role = (form.get('role') || 'user') as TenantRole

    try {
      const res = await fetch(`${API_ORIGIN}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ displayName, username, email, role: CANONICAL_ROLE[role] }),
      })
      const data = await res.json()
      if (data.success && data.user) {
        setMembers((prev) => [{ ...data.user, role }, ...prev])
        setToast(`Invited ${displayName} as ${role.toUpperCase()} to this workspace`)
        setInviteDialogOpen(false)
        if (data.invitation) setInviteResult({ name: displayName, link: data.invitation.link, delivered: data.invitation.delivered })
      } else {
        setToast(data.message || 'Unable to invite this member.')
      }
    } catch {
      setToast('Unable to invite this member.')
    }
  }

  // Update role
  const handleUpdateRole = async (userId: string, newRole: TenantRole) => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/v1/users/${userId}/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ role: CANONICAL_ROLE[newRole] }),
      })
      const data = await res.json()
      if (data.success) {
        setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m)))
        setToast(`Role updated to ${newRole.toUpperCase()}`)
        setEditRoleUser(null)
      } else {
        setToast(data.message || 'Unable to update this role.')
      }
    } catch {
      setToast('Unable to update this role.')
    }
  }

  const roleBadges: Record<TenantRole, { label: string; color: string; bg: string; icon: any }> = {
    admin: { label: 'ADMIN', color: '#dc2626', bg: '#fef2f2', icon: ShieldAlert },
    manager: { label: 'MANAGER', color: '#d97706', bg: '#fffbeb', icon: KeyRound },
    user: { label: 'USER', color: '#2563eb', bg: '#eff6ff', icon: UserCheck },
    guest: { label: 'GUEST', color: '#4b5563', bg: '#f3f4f6', icon: Users },
  }

  // Loading screen
  if (checkingSession) {
    return (
      <div className="login-page-bg">
        <div style={{ color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <RefreshCw size={28} className="spin" />
          <span style={{ fontSize: '14px', fontWeight: 500 }}>Connecting to {tenantInfo.name}...</span>
        </div>
      </div>
    )
  }

  // ==========================================
  // UNIFIED LOGIN GATE SCREEN (TENANT BRANDED)
  // ==========================================
  if (!currentUser) {
    return (
      <div className="login-page-bg">
        <div style={styles.loginCard}>
          <div style={styles.header}>
            <div
              style={{
                ...styles.logoBadge,
                backgroundColor: '#f8fafc',
                borderColor: tenantInfo.primaryColor,
              }}
            >
              <Building2 size={24} color={tenantInfo.primaryColor} />
            </div>
            <div style={styles.titleRow}>
              <h1 style={styles.title}>{tenantInfo.name}</h1>
              <span
                style={{
                  ...styles.pillBadge,
                  backgroundColor: '#f1f5f9',
                  color: tenantInfo.accentColor,
                }}
              >
                {tenantInfo.name.split(' ')[0]}
              </span>
            </div>
            <p style={styles.subtitle}>Sign in with your enterprise workspace credentials</p>
          </div>

          {errorMsg && (
            <div style={styles.errorBanner}>
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleLogin} style={styles.form}>
            <div style={styles.fieldGroup}>
              <label htmlFor="tenant-login-username" style={styles.label}>Corporate Username</label>
              <div style={styles.inputWrapper}>
                <User size={18} style={styles.inputIcon} />
                <input
                  id="tenant-login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. aarav.ganguly"
                  autoComplete="username"
                  style={styles.input}
                />
              </div>
            </div>

            <div style={styles.fieldGroup}>
              <label htmlFor="tenant-login-password" style={styles.label}>Password</label>
              <div style={styles.inputWrapper}>
                <Lock size={18} style={styles.inputIcon} />
                <input
                  id="tenant-login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  style={styles.input}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={styles.toggleButton}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className={`turnstile-grid-wrapper ${isCollapsed ? 'collapsed' : ''}`}>
              <div className="turnstile-grid-inner">
                <div ref={turnstileContainerRef} style={styles.turnstileMount} />
              </div>
            </div>

            <div className={`verified-badge-wrapper ${isBadgeVisible ? 'visible' : ''}`}>
              <div className="verified-badge-inner">
                <div style={styles.verifiedPill}>
                  <CheckCircle2 size={15} color="#059669" />
                  <span>Security verification passed</span>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={!isVerified || isLoading}
              className={`submit-btn ${isVerified && !isLoading ? 'active' : 'disabled'}`}
              style={{
                background: isVerified && !isLoading
                  ? tenantInfo.primaryColor
                  : '#e2e8f0',
              }}
            >
              <span>{isLoading ? 'Signing In...' : `Sign In to ${tenantInfo.name.split(' ')[0]}`}</span>
              <ArrowRight size={18} style={{ opacity: isVerified ? 1 : 0.4 }} />
            </button>
          </form>

        </div>
      </div>
    )
  }

  // ==========================================
  // AUTHENTICATED TENANT WORKSPACE
  // ==========================================
  return (
    <div className="app-shell">
      {mobileOpen && (
        <button
          className="mobile-overlay"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">
          <span
            className="brand-mark"
            style={{ background: tenantInfo.primaryColor, color: '#fff' }}
          >
            <ShieldCheck size={18} />
          </span>
          <span className="brand-copy">
            <span className="brand-name">{tenantInfo.name.split(' ')[0]}</span>
            <span className="brand-product">Workspace</span>
          </span>
        </div>

        {/* Current User Context */}
        <div style={{ padding: '14px', borderBottom: '1px solid var(--sidebar-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  background: roleBadges[currentUser?.role || 'user']?.bg,
                  color: roleBadges[currentUser?.role || 'user']?.color,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 700,
                  fontSize: '12px',
                  flexShrink: 0,
                }}
              >
                {currentUser?.displayName.split(' ').map((n) => n[0]).join('').slice(0, 2) || 'AD'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 600, fontSize: '13px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {currentUser?.displayName}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  {tenantInfo.domain}
                </div>
              </div>
            </div>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: '10px',
                background: roleBadges[currentUser?.role || 'user']?.bg,
                color: roleBadges[currentUser?.role || 'user']?.color,
                textTransform: 'uppercase',
              }}
            >
              {currentUser?.role}
            </span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeNav === 'Overview' ? 'active' : ''}`}
            onClick={() => setActiveNav('Overview')}
          >
            <CircleGauge size={18} />
            <span>Workspace Overview</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Members' ? 'active' : ''}`}
            onClick={() => setActiveNav('Members')}
          >
            <Users size={18} />
            <span>People & Teams</span>
            <span className="nav-count">{members.length}</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'RBAC' ? 'active' : ''}`}
            onClick={() => setActiveNav('RBAC')}
          >
            <KeyRound size={18} />
            <span>Roles & Permissions</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Audit' ? 'active' : ''}`}
            onClick={() => setActiveNav('Audit')}
          >
            <FileClock size={18} />
            <span>Audit Trail</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Files' ? 'active' : ''}`}
            onClick={() => setActiveNav('Files')}
          >
            <FileText size={18} />
            <span>Files</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Settings' ? 'active' : ''}`}
            onClick={() => setActiveNav('Settings')}
          >
            <Settings size={18} />
            <span>Tenant Settings</span>
          </button>
        </nav>

        <div style={{ padding: '14px', margin: 'auto 12px 12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#0369a1', fontWeight: 600, fontSize: '12px', marginBottom: '4px' }}>
            <ShieldCheck size={14} />
            <span>Schema Isolation Active</span>
          </div>
          <p style={{ fontSize: '11px', color: '#64748b', margin: 0, lineHeight: 1.4 }}>
            Database access is restricted to this hostname's immutable tenant identity.
          </p>
        </div>
      </aside>

      {/* Main Wrapper */}
      <div className="main-wrapper">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>

          <div className="search-box">
            <Search size={16} />
            <input
              type="search"
              placeholder={`Search ${tenantInfo.name} directory, roles, audit logs...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="topbar-actions">
            <button
              className="primary-button"
              onClick={() => setInviteDialogOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: tenantInfo.primaryColor }}
            >
              <UserPlus size={16} />
              <span>Invite Member</span>
            </button>

            <button
              className="secondary-button"
              onClick={handleLogout}
              title="Sign Out of Tenant"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#dc2626' }}
            >
              <LogOut size={16} />
              <span>Log Out</span>
            </button>
          </div>
        </header>

        <main className="main-content">
          <div className="content-width">
          {toast && (
            <div
              style={{
                position: 'fixed',
                bottom: '24px',
                right: '24px',
                background: '#1e293b',
                color: '#fff',
                padding: '12px 20px',
                borderRadius: '8px',
                boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              <Check size={16} color="#4ade80" />
              <span>{toast}</span>
            </div>
          )}

          {/* VIEW 1: OVERVIEW */}
          {activeNav === 'Overview' && (
            <div>
              <div
                className="welcome-band"
                style={{
                  background: '#f8fafc',
                  borderColor: tenantInfo.primaryColor,
                  color: tenantInfo.accentColor,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: '4px',
                        background: tenantInfo.primaryColor,
                        color: '#fff',
                      }}
                    >
                      B2B TENANT WORKSPACE
                    </span>
                    <span style={{ fontSize: '12px', color: '#64748b' }}>Domain: {tenantInfo.domain}</span>
                  </div>
                  <h2>{tenantInfo.name}</h2>
                  <p style={{ color: '#475569' }}>
                    {tenantInfo.description}. PostgreSQL access is bound to this tenant's dedicated runtime identity.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => setInviteDialogOpen(true)}
                    style={{
                      padding: '10px 18px',
                      background: tenantInfo.primaryColor,
                      color: '#fff',
                      borderRadius: '6px',
                      border: 'none',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <UserPlus size={16} />
                    <span>Invite Team Member</span>
                  </button>
                </div>
              </div>

              <div className="metric-grid">
                <MetricCard
                  label="Total Tenant Users"
                  value={String(members.length)}
                  foot={<span>Current tenant members</span>}
                  icon={<Users size={20} />}
                />
                <MetricCard
                  label="Tenant Identity"
                  value={tenantInfo.tenantId}
                  foot={<span>Immutable and hostname-bound</span>}
                  icon={<Database size={20} />}
                />
                <MetricCard
                  label="Tenant Plan"
                  value={tenantInfo.planName.split(' ')[0] || 'Enterprise'}
                  foot={<span>{tenantInfo.planName}</span>}
                  icon={<Building2 size={20} />}
                />
                <MetricCard
                  label="Security Health"
                  value="100%"
                  foot={<span>0 cross-tenant permissions</span>}
                  icon={<ShieldCheck size={20} />}
                />
              </div>

              {/* Roles Breakdown */}
              <div style={{ marginTop: '28px' }}>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '17px', fontWeight: 600 }}>Role Distribution ({members.length} Users)</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                  {(['admin', 'manager', 'user', 'guest'] as const).map((r) => {
                    const count = members.filter((m) => m.role === r).length
                    const badge = roleBadges[r]
                    const Icon = badge.icon
                    return (
                      <div
                        key={r}
                        style={{
                          background: '#fff',
                          borderRadius: '8px',
                          border: '1px solid #e2e8f0',
                          padding: '16px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '14px',
                        }}
                      >
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '8px',
                            background: badge.bg,
                            color: badge.color,
                            display: 'grid',
                            placeItems: 'center',
                          }}
                        >
                          <Icon size={20} />
                        </div>
                        <div>
                          <div style={{ fontSize: '20px', fontWeight: 800, color: '#1e293b' }}>{count}</div>
                          <div style={{ fontSize: '12px', color: '#64748b', fontWeight: 500, textTransform: 'capitalize' }}>
                            {r} Accounts
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Members Quick Preview */}
              <div style={{ marginTop: '28px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 600 }}>Active Members ({tenantInfo.name})</h3>
                  <button
                    onClick={() => setActiveNav('Members')}
                    style={{ background: 'none', border: 'none', color: tenantInfo.primaryColor, fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
                  >
                    View all {members.length} users &rarr;
                  </button>
                </div>

                <div className="table-wrapper">
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                        <th style={{ padding: '10px 16px' }}>User</th>
                        <th style={{ padding: '10px 16px' }}>Email</th>
                        <th style={{ padding: '10px 16px' }}>Assigned Role</th>
                        <th style={{ padding: '10px 16px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.slice(0, 5).map((m) => (
                        <tr key={m.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1e293b' }}>{m.displayName}</td>
                          <td style={{ padding: '10px 16px', color: '#64748b' }}>{m.email}</td>
                          <td style={{ padding: '10px 16px' }}>
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: '10px',
                                background: roleBadges[m.role]?.bg,
                                color: roleBadges[m.role]?.color,
                                textTransform: 'uppercase',
                              }}
                            >
                              {m.role}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', color: '#16a34a', fontWeight: 500 }}>Active</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 2: MEMBERS */}
          {activeNav === 'Members' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>
                    {tenantInfo.name} Directory ({members.length})
                  </h2>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
                    Members available within this isolated enterprise workspace.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => loadTenantData()}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '8px 14px',
                      background: '#fff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '13px',
                    }}
                  >
                    <RefreshCw size={14} className={isLoadingData ? 'spin' : ''} />
                    <span>Refresh</span>
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => setInviteDialogOpen(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', background: tenantInfo.primaryColor }}
                  >
                    <UserPlus size={16} />
                    <span>Invite Member</span>
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setRoleFilter('')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '20px',
                    border: '1px solid',
                    borderColor: roleFilter === '' ? tenantInfo.primaryColor : '#e2e8f0',
                    background: roleFilter === '' ? tenantInfo.primaryColor : '#fff',
                    color: roleFilter === '' ? '#fff' : '#64748b',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  All Roles ({members.length})
                </button>
                {(['admin', 'manager', 'user', 'guest'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRoleFilter(r)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '20px',
                      border: '1px solid',
                      borderColor: roleFilter === r ? roleBadges[r]?.color : '#e2e8f0',
                      background: roleFilter === r ? roleBadges[r]?.bg : '#fff',
                      color: roleFilter === r ? roleBadges[r]?.color : '#64748b',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >
                    {r} ({members.filter((m) => m.role === r).length})
                  </button>
                ))}
              </div>

              <div className="table-wrapper">
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <th style={{ padding: '12px 16px' }}>User & Identity</th>
                      <th style={{ padding: '12px 16px' }}>Email Address</th>
                      <th style={{ padding: '12px 16px' }}>Assigned Role</th>
                      <th style={{ padding: '12px 16px' }}>Status</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMembers.map((user) => {
                      const badge = roleBadges[user.role] || roleBadges.user!
                      const Icon = badge.icon
                      return (
                        <tr key={user.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <div
                                style={{
                                  width: '32px',
                                  height: '32px',
                                  borderRadius: '50%',
                                  background: badge.bg,
                                  color: badge.color,
                                  display: 'grid',
                                  placeItems: 'center',
                                  fontWeight: 700,
                                  fontSize: '12px',
                                }}
                              >
                                {user.displayName.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, color: '#1e293b' }}>{user.displayName}</div>
                                <div style={{ fontSize: '11px', color: '#94a3b8' }}>@{user.username}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '12px 16px', color: '#64748b' }}>{user.email}</td>
                          <td style={{ padding: '12px 16px' }}>
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '3px 9px',
                                borderRadius: '12px',
                                background: badge.bg,
                                color: badge.color,
                                fontWeight: 700,
                                fontSize: '11px',
                                textTransform: 'uppercase',
                              }}
                            >
                              <Icon size={12} />
                              <span>{user.role}</span>
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#16a34a', fontSize: '12px', fontWeight: 500 }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#16a34a' }} />
                              <span>Active</span>
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                            <button
                              onClick={() => setEditRoleUser(user)}
                              style={{
                                padding: '5px 12px',
                                background: '#f1f5f9',
                                color: '#334155',
                                border: '1px solid #cbd5e1',
                                borderRadius: '5px',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Edit Role
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VIEW 3: RBAC */}
          {activeNav === 'RBAC' && (
            <div>
              <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 8px 0' }}>Role-Based Access Control (RBAC)</h2>
              <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '0 0 24px 0' }}>
                Permissions are evaluated inside this tenant's isolated database boundary.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
                {(['admin', 'manager', 'user', 'guest'] as const).map((r) => {
                  const badge = roleBadges[r]
                  const Icon = badge.icon
                  return (
                    <div
                      key={r}
                      style={{
                        background: '#fff',
                        borderRadius: '10px',
                        border: '1px solid #e2e8f0',
                        padding: '20px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: badge.bg, color: badge.color, display: 'grid', placeItems: 'center' }}>
                          <Icon size={18} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '15px', textTransform: 'capitalize' }}>{r}</div>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>{members.filter((m) => m.role === r).length} active members</div>
                        </div>
                      </div>

                      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '12px', fontSize: '12px', color: '#475569', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <div><strong>Permissions:</strong></div>
                        {r === 'admin' && (
                          <>
                            <div>&bull; Full tenant governance & provisioning</div>
                            <div>&bull; Role assignment & member management</div>
                            <div>&bull; Audit log inspection & exports</div>
                            <div>&bull; Security & API key configuration</div>
                          </>
                        )}
                        {r === 'manager' && (
                          <>
                            <div>&bull; Team workspace orchestration</div>
                            <div>&bull; Member invites & team allocation</div>
                            <div>&bull; Read-only audit log access</div>
                          </>
                        )}
                        {r === 'user' && (
                          <>
                            <div>&bull; Full access to tenant business tools</div>
                            <div>&bull; Project creation & collaboration</div>
                            <div>&bull; Personal profile settings</div>
                          </>
                        )}
                        {r === 'guest' && (
                          <>
                            <div>&bull; Restricted view-only access</div>
                            <div>&bull; Shared reports & dashboards view</div>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* VIEW 4: AUDIT */}
          {activeNav === 'Audit' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 4px 0' }}>Security Audit Trail</h2>
                  <p style={{ color: 'var(--muted)', fontSize: '13px', margin: 0 }}>
                    Immutable event records for this tenant workspace.
                  </p>
                </div>
                <button
                  onClick={() => loadTenantData()}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '8px 14px',
                    background: '#fff',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '13px',
                  }}
                >
                  <RefreshCw size={14} className={isLoadingData ? 'spin' : ''} />
                  <span>Refresh Trail</span>
                </button>
              </div>

              <div className="table-wrapper">
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <th style={{ padding: '12px 16px' }}>Timestamp</th>
                      <th style={{ padding: '12px 16px' }}>Actor</th>
                      <th style={{ padding: '12px 16px' }}>Action</th>
                      <th style={{ padding: '12px 16px' }}>Resource</th>
                      <th style={{ padding: '12px 16px' }}>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                          No audit events recorded yet for this session.
                        </td>
                      </tr>
                    ) : (
                      auditLogs.map((log) => (
                        <tr key={log.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '12px 16px', color: '#64748b', fontSize: '12px' }}>
                            {new Date(log.occurredAt).toLocaleString()}
                          </td>
                          <td style={{ padding: '12px 16px', fontWeight: 600, color: '#1e293b' }}>{log.actor}</td>
                          <td style={{ padding: '12px 16px', fontFamily: 'monospace', color: '#0369a1' }}>{log.action}</td>
                          <td style={{ padding: '12px 16px', color: '#64748b' }}>{log.resourceType}</td>
                          <td style={{ padding: '12px 16px' }}>
                            <span
                              style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: '10px',
                                background: log.outcome === 'success' ? '#dcfce7' : '#fee2e2',
                                color: log.outcome === 'success' ? '#15803d' : '#b91c1c',
                                textTransform: 'uppercase',
                              }}
                            >
                              {log.outcome}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VIEW 5: SETTINGS */}
          {activeNav === 'Files' && <FilesPage csrfToken={csrfToken} accent={tenantInfo.primaryColor} />}

          {activeNav === 'Settings' && (
            <div style={{ maxWidth: '640px' }}>
              <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 16px 0' }}>Tenant Settings</h2>
              
              <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
                <h4 style={{ margin: '0 0 16px 0', fontSize: '15px' }}>Tenant Identity & Schema</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div>
                    <label htmlFor="tenant-settings-name" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Tenant Name</label>
                    <input
                      id="tenant-settings-name"
                      type="text"
                      readOnly
                      value={tenantInfo.name}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                  <div>
                    <label htmlFor="tenant-settings-domain" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Bound Host Domain</label>
                    <input
                      id="tenant-settings-domain"
                      type="text"
                      readOnly
                      value={tenantInfo.domain}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                  <div>
                    <label htmlFor="tenant-settings-id" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Immutable Tenant Identity</label>
                    <input
                      id="tenant-settings-id"
                      type="text"
                      readOnly
                      value={tenantInfo.tenantId}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                </div>
              </div>
              <WorkspaceSettings csrfToken={csrfToken} accent={tenantInfo.primaryColor} />
              <IntegrationsSettings csrfToken={csrfToken} accent={tenantInfo.primaryColor} />
            </div>
          )}
          </div>
        </main>
      </div>

      {/* ONE-TIME INVITATION LINK */}
      {inviteResult && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 1001 }}>
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', width: '100%', maxWidth: '520px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '17px' }}>Invitation for {inviteResult.name}</h3>
            <p style={{ margin: 0, fontSize: '13px', color: '#475569' }}>
              {inviteResult.delivered
                ? 'An invitation was sent. You can also share this link directly.'
                : 'Share this link with them securely. It works once and is shown only now.'}
            </p>
            <code style={{ padding: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', overflowWrap: 'anywhere' }}>{inviteResult.link}</code>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => void navigator.clipboard.writeText(inviteResult.link).then(() => setToast('Invitation link copied'))} style={{ padding: '8px 14px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}>Copy link</button>
              <button onClick={() => setInviteResult(null)} style={{ padding: '8px 14px', border: 0, borderRadius: '6px', background: tenantInfo.primaryColor, color: '#fff', cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* INVITE MODAL */}
      {inviteDialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', width: '100%', maxWidth: '440px', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700 }}>Invite to {tenantInfo.name}</h3>
              <button onClick={() => setInviteDialogOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleInvite}>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="tenant-invite-display-name" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Full Name</label>
                <input
                  id="tenant-invite-display-name"
                  name="displayName"
                  type="text"
                  required
                  placeholder="e.g. Clara Oswald"
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="tenant-invite-username" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Username</label>
                <input
                  id="tenant-invite-username"
                  name="username"
                  type="text"
                  required
                  placeholder="e.g. clara.oswald"
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="tenant-invite-email" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Corporate Email</label>
                <input
                  id="tenant-invite-email"
                  name="email"
                  type="email"
                  required
                  placeholder={`clara@${tenantInfo.slug || 'tenant'}.example`}
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
              <div style={{ marginBottom: '20px' }}>
                <label htmlFor="tenant-invite-role" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Assigned Tenant Role</label>
                <select
                  id="tenant-invite-role"
                  name="role"
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="user">User (Standard Access)</option>
                  <option value="manager">Manager (Team Management)</option>
                  <option value="admin">Admin (Full Control)</option>
                  <option value="guest">Guest (Restricted View)</option>
                </select>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setInviteDialogOpen(false)}
                  style={{ padding: '8px 16px', background: '#f1f5f9', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '8px 16px', background: tenantInfo.primaryColor, color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '13px' }}
                >
                  Send Invitation
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT ROLE MODAL */}
      {editRoleUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
          }}
        >
          <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', width: '100%', maxWidth: '400px' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '17px', fontWeight: 700 }}>Edit Role for {editRoleUser.displayName}</h3>
            <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px 0' }}>
              Select the member's new workspace role.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
              {(['admin', 'manager', 'user', 'guest'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => handleUpdateRole(editRoleUser.id, r)}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: editRoleUser.role === r ? roleBadges[r]?.color : '#e2e8f0',
                    background: editRoleUser.role === r ? roleBadges[r]?.bg : '#fff',
                    color: editRoleUser.role === r ? roleBadges[r]?.color : '#334155',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    textTransform: 'capitalize',
                  }}
                >
                  {r} - {r === 'admin' ? 'Full Administrator' : r === 'manager' ? 'Team Manager' : r === 'user' ? 'Standard User' : 'Guest Auditor'}
                </button>
              ))}
            </div>
            <button
              onClick={() => setEditRoleUser(null)}
              style={{ width: '100%', padding: '8px', background: '#f1f5f9', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loginCard: {
    width: '100%',
    maxWidth: '430px',
    backgroundColor: '#fafbfc',
    borderRadius: '24px',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 30px 70px -15px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 28px -8px rgba(0, 0, 0, 0.5)',
    padding: '36px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    transition: 'padding 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: '6px',
  },
  logoBadge: {
    width: '50px',
    height: '50px',
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: '6px',
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.04)',
    border: '1px solid',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  title: {
    fontSize: '23px',
    fontWeight: 700,
    color: '#0f172a',
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
  },
  pillBadge: {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderRadius: '9999px',
    padding: '2px 9px',
  },
  subtitle: {
    fontSize: '13px',
    color: '#64748b',
    marginTop: '2px',
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#dc2626',
    fontSize: '13px',
    fontWeight: 500,
    padding: '11px 16px',
    borderRadius: '14px',
    textAlign: 'center',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '15px',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '12.5px',
    fontWeight: 600,
    color: '#334155',
    letterSpacing: '0.01em',
    paddingLeft: '2px',
  },
  inputWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
  },
  inputIcon: {
    position: 'absolute',
    left: '14px',
    color: '#94a3b8',
    pointerEvents: 'none',
  },
  input: {
    width: '100%',
    height: '46px',
    backgroundColor: '#ffffff',
    border: '1px solid #dcdfe4',
    borderRadius: '14px',
    padding: '0 42px 0 42px',
    fontSize: '14px',
    color: '#0f172a',
    outline: 'none',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  toggleButton: {
    position: 'absolute',
    right: '12px',
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    cursor: 'pointer',
    padding: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '8px',
  },
  turnstileMount: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  verifiedPill: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    backgroundColor: '#ecfdf5',
    border: '1px solid #a7f3d0',
    color: '#065f46',
    fontSize: '12.5px',
    fontWeight: 500,
    padding: '9px 14px',
    borderRadius: '14px',
  },
}

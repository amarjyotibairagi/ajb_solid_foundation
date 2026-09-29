import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { MetricCard } from '@skeleton/ui/MetricCard'
import { useTurnstile } from '@skeleton/ui/useTurnstile'
import {
  ArrowRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  Crown,
  Eye,
  EyeOff,
  FileText,
  FolderKanban,
  Grid2X2,
  HardDrive,
  Home,
  Image,
  Layers,
  Lock,
  LogOut,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  User,
  UserCheck,
  Users,
  X,
  Zap,
} from 'lucide-react'

const API_ORIGIN = import.meta.env.VITE_PUBLIC_API_ORIGIN || ''

type ConsumerUser = {
  id: string
  username: string
  displayName: string
  email: string
  status: string
  plan: 'free' | 'plus' | 'pro' | 'ultra'
  createdAt?: string
}

type SubscriptionPlan = {
  code: 'free' | 'plus' | 'pro' | 'ultra'
  name: string
  priceMonthly: number
  description: string
  features: string[]
}

type Project = {
  id: string
  title: string
  type: string
  updated: string
  color: string
  ink: string
  icon: typeof FileText
  collaborators: string[]
}

export default function App() {
  // Product name is configured in the platform admin panel.
  const [productName, setProductName] = useState('')
  const appHost = typeof window === 'undefined' ? '' : window.location.host
  useEffect(() => {
    fetch(`${API_ORIGIN}/api/public-config`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.productName) {
          setProductName(data.productName)
          document.title = `${data.productName} · Account`
        }
      })
      .catch(() => undefined)
  }, [])

  // Auth state
  const [currentUser, setCurrentUser] = useState<ConsumerUser | null>(null)
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
  const [dialogOpen, setDialogOpen] = useState(false)
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [activeNav, setActiveNav] = useState('Home')
  const [search, setSearch] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [isSavingProject, setIsSavingProject] = useState(false)
  const [allUsers, setAllUsers] = useState<ConsumerUser[]>([])
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [plansError, setPlansError] = useState('')
  const [isLoadingUsers, setIsLoadingUsers] = useState(false)

  // Check initial session
  useEffect(() => {
    let cancelled = false
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
            plan: data.user.planCode || 'free',
          })
          setCsrfToken(data.csrfToken)
        }
      })
      .catch(() => {
        // Anonymous state
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
      setErrorMsg('Please enter your username or email.')
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
          plan: data.user.planCode || 'free',
        })
        setCsrfToken(data.csrfToken)
        setToast(`Welcome, ${data.user.displayName}!`)
      } else {
        setErrorMsg(data.message || 'Invalid username or password. Please check your credentials.')
        resetTurnstile()
      }
    } catch {
      setErrorMsg('Unable to reach server. Please check your connection.')
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
    setToast('Logged out successfully.')
  }

  // Fetch plans
  useEffect(() => {
    if (!currentUser) return
    async function loadPlans() {
      setPlansError('')
      try {
        const res = await fetch(`${API_ORIGIN}/api/v1/subscriptions/plans`, { credentials: 'include' })
        const data = await res.json()
        if (!res.ok || !Array.isArray(data.plans)) throw new Error('Invalid plans response')
        setPlans(data.plans)
      } catch {
        setPlans([])
        setPlansError('Subscription plans could not be loaded.')
      }
    }
    loadPlans()
  }, [currentUser])

  useEffect(() => {
    if (!currentUser) return
    let cancelled = false
    fetch(`${API_ORIGIN}/api/v1/projects`, { credentials: 'include' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok || !Array.isArray(data.projects)) throw new Error('Invalid projects response')
        if (cancelled) return
        const colors = ['#e8eefc', '#f7e4de', '#e5efdd', '#f3e8ff']
        const inks = ['#365fc7', '#a94e45', '#52703d', '#7e22ce']
        setProjects(data.projects.map((project: { id: string; title: string; type: string; updated_at: string }, index: number) => ({
          id: project.id,
          title: project.title,
          type: project.type,
          updated: new Date(project.updated_at).toLocaleString(),
          color: colors[index % colors.length]!,
          ink: inks[index % inks.length]!,
          icon: project.type === 'Collection' ? Image : project.type === 'Workspace' ? Grid2X2 : FileText,
          collaborators: [currentUser.displayName.split(' ').map((name) => name[0]).join('') || 'ME'],
        })))
      })
      .catch(() => {
        if (!cancelled) setToast('Unable to load projects.')
      })
    return () => { cancelled = true }
  }, [currentUser])

  // Fetch consumer directory users from database
  const loadDirectoryUsers = async () => {
    setIsLoadingUsers(true)
    try {
      const url = new URL(`${API_ORIGIN}/api/v1/users`, window.location.origin)
      if (search) url.searchParams.set('search', search)
      if (planFilter) url.searchParams.set('plan', planFilter)
      url.searchParams.set('limit', '100')

      const res = await fetch(url.toString(), { credentials: 'include' })
      const data = await res.json()
      if (res.ok && data.users) {
        setAllUsers(data.users)
      } else {
        setToast(data.message || 'Unable to load the directory.')
      }
    } catch {
      setToast('Unable to load the directory.')
    } finally {
      setIsLoadingUsers(false)
    }
  }

  useEffect(() => {
    if (currentUser) {
      loadDirectoryUsers()
    }
  }, [currentUser, search, planFilter])

  // Toast timer
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const navigate = (label: string) => {
    setActiveNav(label)
    setMobileOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Handle plan upgrade
  const handleUpgradePlan = async (newPlan: 'free' | 'plus' | 'pro' | 'ultra') => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/v1/me/subscription`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ planCode: newPlan }),
      })
      const data = await res.json()
      if (data.success) {
        setCurrentUser((prev) => prev ? { ...prev, plan: newPlan } : null)
        setToast(`Subscription updated to ${newPlan.toUpperCase()}!`)
        setUpgradeDialogOpen(false)
      } else {
        setToast(data.message || 'Unable to update the subscription.')
      }
    } catch {
      setToast('Unable to update the subscription.')
    }
  }

  // Create project
  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const title = String(data.get('title') || 'Untitled Project')
    const type = String(data.get('type') || 'Document')
    setIsSavingProject(true)
    try {
      const response = await fetch(`${API_ORIGIN}/api/v1/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ title, type }),
      })
      const result = await response.json()
      if (!response.ok || !result.success || !result.project) {
        throw new Error(result.message || 'Project creation failed.')
      }
      const colors = ['#e8eefc', '#f7e4de', '#e5efdd', '#f3e8ff']
      const inks = ['#365fc7', '#a94e45', '#52703d', '#7e22ce']
      const idx = projects.length % colors.length
      setProjects((current) => [{
        id: result.project.id,
        title: result.project.title,
        type: result.project.type,
        updated: new Date(result.project.updated_at).toLocaleString(),
        color: colors[idx]!,
        ink: inks[idx]!,
        icon: type === 'Collection' ? Image : type === 'Workspace' ? Grid2X2 : FileText,
        collaborators: [currentUser?.displayName.split(' ').map((name) => name[0]).join('') || 'ME'],
      }, ...current])
      setDialogOpen(false)
      setToast(`${title} created successfully`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to create project.')
    } finally {
      setIsSavingProject(false)
    }
  }

  const planBadges: Record<string, { label: string; color: string; bg: string; icon: any }> = {
    free: { label: 'FREE', color: '#64748b', bg: '#f1f5f9', icon: Zap },
    plus: { label: 'PLUS', color: '#0284c7', bg: '#e0f2fe', icon: Sparkles },
    pro: { label: 'PRO', color: '#7c3aed', bg: '#ede9fe', icon: Star },
    ultra: { label: 'ULTRA', color: '#ea580c', bg: '#ffedd5', icon: Crown },
  }

  // Loading Session Screen
  if (checkingSession) {
    return (
      <div className="login-page-bg">
        <div style={{ color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <RefreshCw size={28} className="spin" />
          <span style={{ fontSize: '14px', fontWeight: 500 }}>Connecting to {productName || 'your account'}...</span>
        </div>
      </div>
    )
  }

  // ==========================================
  // UNIFIED LOGIN GATE SCREEN
  // ==========================================
  if (!currentUser) {
    return (
      <div className="login-page-bg">
        <div style={styles.loginCard}>
          <div style={styles.header}>
            <div style={styles.logoBadge}>
              <Sparkles size={24} color="#365fc7" />
            </div>
            <div style={styles.titleRow}>
              <h1 style={styles.title}>{productName || 'Sign in'}</h1>
              <span style={{ ...styles.pillBadge, backgroundColor: '#e0e7ff', color: '#3730a3' }}>
                Individuals
              </span>
            </div>
            <p style={styles.subtitle}>Sign in with your individual creator credentials</p>
          </div>

          {errorMsg && (
            <div style={styles.errorBanner}>
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleLogin} style={styles.form}>
            <div style={styles.fieldGroup}>
              <label htmlFor="public-login-username" style={styles.label}>Username or Email</label>
              <div style={styles.inputWrapper}>
                <User size={18} style={styles.inputIcon} />
                <input
                  id="public-login-username"
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
              <label htmlFor="public-login-password" style={styles.label}>Password</label>
              <div style={styles.inputWrapper}>
                <Lock size={18} style={styles.inputIcon} />
                <input
                  id="public-login-password"
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
            >
              <span>{isLoading ? 'Signing In...' : 'Log In'}</span>
              <ArrowRight size={18} style={{ opacity: isVerified ? 1 : 0.4 }} />
            </button>
          </form>

        </div>
      </div>
    )
  }

  // ==========================================
  // AUTHENTICATED WORKSPACE DASHBOARD
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
          <span className="brand-mark" style={{ background: '#365fc7', color: '#fff' }}>
            <Sparkles size={18} />
          </span>
          <span className="brand-copy">
            <span className="brand-name">{productName}</span>
            <span className="brand-product">Individuals</span>
          </span>
        </div>

        {/* User Identity context */}
        <div className="sidebar-context" style={{ padding: '14px 16px', borderBottom: '1px solid var(--sidebar-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  background: '#e0e7ff',
                  color: '#3730a3',
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 600,
                  fontSize: '13px',
                  flexShrink: 0,
                }}
              >
                {currentUser?.displayName.split(' ').map((n) => n[0]).join('').slice(0, 2) || 'US'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 600, fontSize: '13px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {currentUser?.displayName}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  {appHost}
                </div>
              </div>
            </div>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 7px',
                borderRadius: '12px',
                background: planBadges[currentUser?.plan || 'free']?.bg,
                color: planBadges[currentUser?.plan || 'free']?.color,
                textTransform: 'uppercase',
              }}
            >
              {currentUser?.plan || 'free'}
            </span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeNav === 'Home' ? 'active' : ''}`}
            onClick={() => navigate('Home')}
          >
            <Home size={18} />
            <span>Overview & Dashboard</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Workspaces' ? 'active' : ''}`}
            onClick={() => navigate('Workspaces')}
          >
            <FolderKanban size={18} />
            <span>My Projects ({projects.length})</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Community' ? 'active' : ''}`}
            onClick={() => navigate('Community')}
          >
            <Users size={18} />
            <span>Individuals Directory</span>
            <span className="nav-count">100</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Subscription' ? 'active' : ''}`}
            onClick={() => navigate('Subscription')}
          >
            <Crown size={18} />
            <span>Plans & Subscription</span>
          </button>
          <button
            className={`nav-item ${activeNav === 'Settings' ? 'active' : ''}`}
            onClick={() => navigate('Settings')}
          >
            <Settings size={18} />
            <span>Account Settings</span>
          </button>
        </nav>

        {/* Upgrade Promo */}
        <div style={{ padding: '16px', margin: 'auto 12px 12px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#365fc7', fontWeight: 600, fontSize: '12px', marginBottom: '4px' }}>
            <Zap size={14} />
            <span>Current Plan: {currentUser?.plan.toUpperCase()}</span>
          </div>
          <p style={{ fontSize: '11px', color: '#64748b', margin: '0 0 10px 0', lineHeight: 1.4 }}>
            {currentUser?.plan === 'ultra'
              ? 'You have unlimited access to all AI & Cloud resources.'
              : 'Upgrade to unlock unlimited AI synthesis & team collaboration.'}
          </p>
          {currentUser?.plan !== 'ultra' && (
            <button
              onClick={() => setUpgradeDialogOpen(true)}
              style={{
                width: '100%',
                padding: '6px 12px',
                background: '#365fc7',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Upgrade Tier
            </button>
          )}
        </div>
      </aside>

      {/* Main Wrapper */}
      <div className="main-wrapper">
        <header className="topbar">
          <button
            className="mobile-nav-toggle"
            aria-label="Open navigation menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>

          <div className="topbar-search">
            <Search size={16} />
            <input
              type="search"
              placeholder="Search workspaces, individuals, datasets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="topbar-actions">
            <button
              className="primary-btn"
              onClick={() => setDialogOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Plus size={16} />
              <span>New Project</span>
            </button>

            <button
              className="topbar-btn"
              onClick={handleLogout}
              title="Sign Out"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#dc2626' }}
            >
              <LogOut size={16} />
              <span>Log Out</span>
            </button>
          </div>
        </header>

        <main className="content">
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

          {/* VIEW 1: HOME */}
          {activeNav === 'Home' && (
            <div>
              <div className="welcome-band">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: '4px',
                        background: '#365fc7',
                        color: '#fff',
                      }}
                    >
                      B2C INDIVIDUALS CLOUD
                    </span>
                    <span style={{ fontSize: '12px', color: '#64748b' }}>Domain: {appHost}</span>
                  </div>
                  <h2>Welcome back, {currentUser?.displayName}!</h2>
                  <p>
                    Your individual workspace is connected over an encrypted, row-level-isolated
                    database session. Enjoy isolated storage, real-time code synthesis, and
                    collaborative workspace capabilities.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => setUpgradeDialogOpen(true)}
                    style={{
                      padding: '10px 18px',
                      background: '#365fc7',
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
                    <Crown size={16} />
                    <span>Manage Plan ({currentUser?.plan.toUpperCase()})</span>
                  </button>
                </div>
              </div>

              <div className="metrics-grid">
                <MetricCard
                  label="Active Plan Tier"
                  value={currentUser?.plan.toUpperCase() || 'FREE'}
                  foot={<span>{currentUser?.plan === 'ultra' ? 'Unlimited Features' : 'Tier Upgrade Available'}</span>}
                  icon={<Crown size={20} />}
                />
                <MetricCard
                  label="Data Isolation"
                  value="Enforced"
                  foot={<span>Row-level security active on every query</span>}
                  icon={<Shield size={20} />}
                />
                <MetricCard
                  label="Active Workspaces"
                  value={String(projects.length)}
                  foot={<span>{projects.length} Projects in Cloud</span>}
                  icon={<FolderKanban size={20} />}
                />
                <MetricCard
                  label="Network Creators"
                  value="100 Users"
                  foot={<span>Live Individual Database</span>}
                  icon={<Users size={20} />}
                />
              </div>

              <div style={{ marginTop: '28px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 600 }}>Recent Workspaces & Projects</h3>
                  <button
                    onClick={() => setActiveNav('Workspaces')}
                    style={{ background: 'none', border: 'none', color: '#365fc7', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
                  >
                    View all ({projects.length}) &rarr;
                  </button>
                </div>

                <div className="projects-grid">
                  {projects.slice(0, 4).map((project) => {
                    const Icon = project.icon
                    return (
                      <article key={project.id} className="project-card">
                        <div className="project-top">
                          <span className="project-icon" style={{ background: project.color, color: project.ink }}>
                            <Icon size={18} />
                          </span>
                          <span className="project-tag">{project.type}</span>
                        </div>
                        <div className="project-title">{project.title}</div>
                        <div className="project-foot">
                          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{project.updated}</span>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            {project.collaborators.map((c, i) => (
                              <span
                                key={i}
                                style={{
                                  width: '24px',
                                  height: '24px',
                                  borderRadius: '50%',
                                  background: '#e2e8f0',
                                  color: '#334155',
                                  fontSize: '10px',
                                  fontWeight: 600,
                                  display: 'grid',
                                  placeItems: 'center',
                                }}
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* VIEW 2: WORKSPACES */}
          {activeNav === 'Workspaces' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>My Workspaces & Projects</h2>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
                    Manage and create collaborative cloud repositories and document suites.
                  </p>
                </div>
                <button
                  className="primary-btn"
                  onClick={() => setDialogOpen(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <Plus size={16} />
                  <span>Create Project</span>
                </button>
              </div>

              <div className="projects-grid">
                {projects.map((project) => {
                  const Icon = project.icon
                  return (
                    <article key={project.id} className="project-card">
                      <div className="project-top">
                        <span className="project-icon" style={{ background: project.color, color: project.ink }}>
                          <Icon size={18} />
                        </span>
                        <span className="project-tag">{project.type}</span>
                      </div>
                      <div className="project-title" style={{ fontSize: '16px', fontWeight: 600, margin: '12px 0 8px' }}>
                        {project.title}
                      </div>
                      <div className="project-foot">
                        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Last modified {project.updated}</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {project.collaborators.map((c, i) => (
                            <span
                              key={i}
                              style={{
                                width: '26px',
                                height: '26px',
                                borderRadius: '50%',
                                background: '#e2e8f0',
                                color: '#334155',
                                fontSize: '11px',
                                fontWeight: 600,
                                display: 'grid',
                                placeItems: 'center',
                              }}
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          )}

          {/* VIEW 3: COMMUNITY / DIRECTORY */}
          {activeNav === 'Community' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div>
                  <h2 style={{ margin: '0 0 4px 0', fontSize: '22px', fontWeight: 700 }}>Individuals Directory</h2>
                  <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px' }}>
                    100 synthetic individual creators and developers across the four plan tiers (25 per plan).
                  </p>
                </div>
                <button
                  onClick={loadDirectoryUsers}
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
                    fontWeight: 500,
                  }}
                >
                  <RefreshCw size={14} className={isLoadingUsers ? 'spin' : ''} />
                  <span>Refresh Database</span>
                </button>
              </div>

              {/* Plan Filter Badges */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setPlanFilter('')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '20px',
                    border: '1px solid',
                    borderColor: planFilter === '' ? '#365fc7' : '#e2e8f0',
                    background: planFilter === '' ? '#365fc7' : '#fff',
                    color: planFilter === '' ? '#fff' : '#64748b',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  All Plans ({allUsers.length})
                </button>
                {(['free', 'plus', 'pro', 'ultra'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPlanFilter(p)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '20px',
                      border: '1px solid',
                      borderColor: planFilter === p ? planBadges[p]?.color : '#e2e8f0',
                      background: planFilter === p ? planBadges[p]?.bg : '#fff',
                      color: planFilter === p ? planBadges[p]?.color : '#64748b',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                    }}
                  >
                    {p} Plan
                  </button>
                ))}
              </div>

              {/* Users Table */}
              <div className="table-wrapper" style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <th style={{ padding: '12px 16px' }}>User & Identity</th>
                      <th style={{ padding: '12px 16px' }}>Email Address</th>
                      <th style={{ padding: '12px 16px' }}>Plan Tier</th>
                      <th style={{ padding: '12px 16px' }}>Account Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers.map((user) => {
                      const badge = planBadges[user.plan] || planBadges.free!
                      const Icon = badge.icon
                      const isCurrent = currentUser?.username === user.username
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
                                  fontWeight: 600,
                                  fontSize: '12px',
                                }}
                              >
                                {user.displayName.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, color: '#1e293b' }}>
                                  {user.displayName} {isCurrent && <span style={{ color: '#365fc7', fontSize: '11px' }}>(You)</span>}
                                </div>
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
                              <span>{user.plan}</span>
                            </span>
                          </td>
                          <td style={{ padding: '12px 16px' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#16a34a', fontSize: '12px', fontWeight: 500 }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#16a34a' }} />
                              <span>{user.status}</span>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VIEW 4: SUBSCRIPTION */}
          {activeNav === 'Subscription' && (
            <div>
              <div style={{ textAlign: 'center', maxWidth: '640px', margin: '0 auto 32px' }}>
                <h2 style={{ fontSize: '26px', fontWeight: 800, margin: '0 0 8px 0' }}>Simple, Predictable Individual Plans</h2>
                <p style={{ color: 'var(--muted)', fontSize: '14px', margin: 0 }}>
                  Scale effortlessly from a hobby project to an ultra-high performance AI cloud environment.
                </p>
              </div>

              {plansError && <div role="alert" style={{ marginBottom: 16, color: '#b91c1c', fontSize: 13 }}>{plansError}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px' }}>
                {plans.map((plan) => {
                  const isCurrent = currentUser?.plan === plan.code
                  const badge = planBadges[plan.code] || planBadges.free!
                  return (
                    <div
                      key={plan.code}
                      style={{
                        background: '#fff',
                        borderRadius: '12px',
                        border: isCurrent ? '2px solid #365fc7' : '1px solid #e2e8f0',
                        padding: '24px',
                        position: 'relative',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        boxShadow: isCurrent ? '0 8px 30px rgba(54, 95, 199, 0.12)' : 'none',
                      }}
                    >
                      {isCurrent && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '-12px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            background: '#365fc7',
                            color: '#fff',
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 12px',
                            borderRadius: '12px',
                            textTransform: 'uppercase',
                          }}
                        >
                          Current Plan
                        </div>
                      )}

                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>{plan.name}</h3>
                          <span style={{ padding: '3px 8px', borderRadius: '8px', background: badge.bg, color: badge.color, fontWeight: 700, fontSize: '11px' }}>
                            {plan.code.toUpperCase()}
                          </span>
                        </div>
                        <div style={{ margin: '16px 0', display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                          <span style={{ fontSize: '32px', fontWeight: 800, color: '#1e293b' }}>${plan.priceMonthly}</span>
                          <span style={{ fontSize: '13px', color: '#64748b' }}>/ month</span>
                        </div>
                        <p style={{ fontSize: '12px', color: '#64748b', minHeight: '36px', lineHeight: 1.4 }}>{plan.description}</p>

                        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '16px', marginTop: '16px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '10px' }}>What is included:</div>
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: '#334155' }}>
                            {plan.features.map((f, i) => (
                              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                <Check size={14} color="#16a34a" style={{ marginTop: '2px', flexShrink: 0 }} />
                                <span>{f}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      <div style={{ marginTop: '24px' }}>
                        <button
                          onClick={() => handleUpgradePlan(plan.code)}
                          disabled={isCurrent}
                          style={{
                            width: '100%',
                            padding: '10px',
                            borderRadius: '6px',
                            border: 'none',
                            background: isCurrent ? '#f1f5f9' : '#365fc7',
                            color: isCurrent ? '#94a3b8' : '#fff',
                            fontWeight: 600,
                            fontSize: '13px',
                            cursor: isCurrent ? 'default' : 'pointer',
                          }}
                        >
                          {isCurrent ? 'Current Plan' : `Switch to ${plan.name}`}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* VIEW 5: SETTINGS */}
          {activeNav === 'Settings' && (
            <div style={{ maxWidth: '640px' }}>
              <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 16px 0' }}>Account Settings</h2>
              
              <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
                <h4 style={{ margin: '0 0 16px 0', fontSize: '15px' }}>Profile Information</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div>
                    <label htmlFor="public-profile-display-name" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Display Name</label>
                    <input
                      id="public-profile-display-name"
                      type="text"
                      readOnly
                      value={currentUser?.displayName || ''}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                  <div>
                    <label htmlFor="public-profile-username" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Username</label>
                    <input
                      id="public-profile-username"
                      type="text"
                      readOnly
                      value={currentUser?.username || ''}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                  <div>
                    <label htmlFor="public-profile-email" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Email Address</label>
                    <input
                      id="public-profile-email"
                      type="text"
                      readOnly
                      value={currentUser?.email || ''}
                      style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Workspace Isolation</h4>
                <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px 0' }}>
                  Every request runs under a least-privilege database identity with row-level
                  security enforced, so your records are unreachable from any other account.
                </p>
                <div style={{ padding: '12px', background: '#f1f5f9', borderRadius: '6px', fontSize: '12px' }}>
                  Workspace: {appHost}<br />
                  Transport: TLS via Cloudflare<br />
                  Access control: row-level security, forced<br />
                  Credentials: never exposed to the browser
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* CREATE PROJECT MODAL */}
      {dialogOpen && (
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
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700 }}>Create New Workspace Project</h3>
              <button onClick={() => setDialogOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={createProject}>
              <div style={{ marginBottom: '14px' }}>
                <label htmlFor="project-title" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Project Title</label>
                <input
                  id="project-title"
                  name="title"
                  type="text"
                  required
                  placeholder="e.g. Distributed LLM Inference"
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
              <div style={{ marginBottom: '20px' }}>
                <label htmlFor="project-type" style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Project Type</label>
                <select
                  id="project-type"
                  name="type"
                  style={{ width: '100%', padding: '8px 12px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="Document">Document Suite</option>
                  <option value="Collection">Dataset Collection</option>
                  <option value="Workspace">Interactive Code Workspace</option>
                </select>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  style={{ padding: '8px 16px', background: '#f1f5f9', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingProject}
                  style={{ padding: '8px 16px', background: '#365fc7', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '13px' }}
                >
                  {isSavingProject ? 'Creating...' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UPGRADE MODAL */}
      {upgradeDialogOpen && (
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
          <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', width: '100%', maxWidth: '580px', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Choose Your Subscription Tier</h3>
              <button onClick={() => setUpgradeDialogOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '20px' }}>
              {plans.map((p) => {
                const isCurrent = currentUser?.plan === p.code
                return (
                  <div
                    key={p.code}
                    onClick={() => !isCurrent && handleUpgradePlan(p.code)}
                    style={{
                      padding: '16px',
                      borderRadius: '8px',
                      border: isCurrent ? '2px solid #365fc7' : '1px solid #cbd5e1',
                      background: isCurrent ? '#f0f4ff' : '#fff',
                      cursor: isCurrent ? 'default' : 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: '14px' }}>{p.name}</div>
                      {isCurrent && <Check size={16} color="#365fc7" />}
                    </div>
                    <div style={{ fontSize: '18px', fontWeight: 800, margin: '6px 0', color: '#1e293b' }}>${p.priceMonthly}/mo</div>
                    <div style={{ fontSize: '11px', color: '#64748b' }}>{p.description}</div>
                  </div>
                )
              })}
            </div>
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
    gap: '20px',
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
    backgroundColor: '#eef2ff',
    border: '1px solid #c7d2fe',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: '6px',
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.04)',
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

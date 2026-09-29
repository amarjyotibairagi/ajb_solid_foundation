import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createAdminApi } from './admin/api'
import { AuditView } from './admin/AuditView'
import { ConfigurationView } from './admin/ConfigurationView'
import { ConsumersView } from './admin/ConsumersView'
import { FleetView } from './admin/FleetView'
import { OperatorsView } from './admin/OperatorsView'
import { PlansView } from './admin/PlansView'
import { SecurityView } from './admin/SecurityView'
import { TenantManageView } from './admin/TenantManageView'
import { OneTimeLink } from './admin/ui'
import {
  Eye,
  EyeOff,
  Lock,
  User,
  ArrowRight,
  CheckCircle2,
  ShieldCheck,
  Globe,
  KeyRound,
  Layers,
  Users,
  Sliders,
  FileText,
  ArrowLeft,
  ChevronRight,
  Cpu,
  Server,
  HardDrive,
  RefreshCw,
  Clock,
  LogOut,
  Building2,
  PlusCircle,
  Search,
  Database,
  Wifi,
  Check,
  LayoutDashboard,
  Copy,
  Trash2,
  Plus,
  X,
  AlertTriangle,
  MemoryStick,
  Terminal,
  Activity,
  Network,
  ExternalLink,
  List,
  PauseCircle,
  PlayCircle
} from 'lucide-react'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          theme?: 'light' | 'dark' | 'auto'
          size?: 'normal' | 'compact' | 'flexible'
          callback?: (token: string) => void
          'error-callback'?: () => void
          'expired-callback'?: () => void
        }
      ) => string
      reset: (widgetId?: string) => void
      remove: (widgetId?: string) => void
    }
  }
}

const PRODUCTION_TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY
const IS_TURNSTILE_CONFIGURED = Boolean(PRODUCTION_TURNSTILE_SITE_KEY)
// Build-time opt-out for deployments without Cloudflare Turnstile; the BFF
// must run with LOGIN_CHALLENGE=none as well.
const LOGIN_CHALLENGE_DISABLED = import.meta.env.VITE_LOGIN_CHALLENGE === 'none'
const UI_BUILD_REVISION = '2026-08-21-audit-status-normalized'

type AuthUser = {
  id: string
  username: string
  role: 'platform_owner' | 'platform_admin' | 'platform_viewer'
}

type AuditLog = {
  id: string
  timestamp: string
  user_id: string | null
  username: string | null
  feature: string
  action: string
  status: string
}

type CloudflareDnsRecord = {
  id: string
  name: string
  type: string
  content: string
  proxiable: boolean
  proxied: boolean
  ttl: number
  created_on: string
  modified_on: string
  comment?: string | null
  tags?: string[]
  managed?: boolean
}

type ProvisioningStep = {
  stepCode: string
  stepOrder: number
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  message: string
  errorMessage: string | null
}

type ProvisioningJob = {
  jobId: string
  tenantId: string
  displayName: string
  hostname: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'retrying' | 'rolled_back'
  currentStep: string | null
  retryable: boolean
  errorMessage: string | null
  correlationId: string
  steps: ProvisioningStep[]
}

type TenantLifecycleStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'migration_failed'
  | 'provisioning_failed'
  | 'deleting'
  | 'deletion_failed'

type TenantSummary = {
  tenantId: string
  displayName: string
  hostname: string | null
  subdomain: string | null
  status: TenantLifecycleStatus
  region: string
  createdAt: string
  activatedAt: string | null
  jobId: string | null
  jobStatus: string | null
  currentStep: string | null
}

type HardwareData = {
  timestamp: string
  cpu: {
    model: string
    cores: number
    speedMhz: number
    loadAvg: { '1m': number; '5m': number; '15m': number }
    coresList: { core: number; model: string; speedMhz: number }[]
  }
  memory: {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    cachedBytes: number
    buffersBytes: number
    usedPercent: number
    totalGB: string
    freeGB: string
    usedGB: string
  }
  storage: {
    filesystem: string
    totalBytes: number
    usedBytes: number
    availBytes: number
    usedPercent: number
    totalGB: string
    usedGB: string
    availGB: string
  }
  system: {
    hostname: string
    platform: string
    osName: string
    release: string
    arch: string
    uptimeSeconds: number
  }
}

type ServiceItem = {
  id: string
  port: number
  name: string
  category: string
  description: string
  pid: number | null
  pidsCount: number
  user: string
  cpuPercent: number
  memPercent: number
  memoryMb: string
  uptime: string
  cmd: string
  protocol: string
  status: string
}

type ServiceApiItem = Partial<ServiceItem> & {
  cpu?: number
  mem?: number
  rssMb?: string
}

type ServicesSummary = {
  activeCount: number
  totalCpuPercent: string
  totalMemoryMb: string
  totalMemoryGb: string
}

type SubmenuItem = {
  id: string
  label: string
  icon: typeof Globe
  badge?: string
  description: string
}

type MenuCategory = {
  id: string
  label: string
  icon: typeof Globe
  badge?: string
  description: string
  items: SubmenuItem[]
}

const MENU_CATEGORIES: MenuCategory[] = [
  {
    id: 'platform',
    label: 'Platform',
    icon: ShieldCheck,
    badge: '8 Tools',
    description: 'Platform infrastructure, security routing & governance',
    items: [
      { id: 'subdomains', label: 'Subdomains', icon: Globe, badge: 'Live CF', description: 'Live DNS records & Cloudflare Tunnel mappings for the platform domain' },
      { id: 'apis', label: 'APIs', icon: KeyRound, badge: 'v1.4', description: 'Backend endpoints, authentication & rate limits' },
      { id: 'audit_logs', label: 'Audit Logs', icon: FileText, badge: 'Filter', description: 'Filterable security audit trail across operators and tenants' },
      { id: 'configuration', label: 'Configuration', icon: Sliders, badge: 'Registry', description: 'Platform-wide features, limits and settings' },
      { id: 'plans', label: 'Plans', icon: Layers, badge: 'Entitlements', description: 'Plans and the entitlements each one grants' },
      { id: 'operators', label: 'Operators', icon: Users, badge: 'Owners', description: 'Invite operators, change roles, recover access' },
      { id: 'consumers', label: 'Individuals', icon: User, badge: 'B2C', description: 'Individual users of the public app: status, sessions, plans' },
      { id: 'security', label: 'My Security', icon: KeyRound, description: 'Security keys and step-up verification' },
    ],
  },
  {
    id: 'tenant',
    label: 'Tenant',
    icon: Building2,
    badge: 'Multi-Tenant',
    description: 'Tenant organization workspaces & schema isolation',
    items: [
      { id: 'list', label: 'Tenants', icon: List, badge: 'Manage', description: 'View tenants and manage their lifecycle — suspend, resume, or remove' },
      { id: 'subdomain', label: 'Subdomain', icon: Globe, badge: 'Manage', description: 'Provision, route & manage tenant-specific subdomains with Cloudflare SDK' },
      { id: 'new', label: 'New', icon: PlusCircle, badge: 'Create', description: 'Provision isolated tenant workspace & DB schema' },
      { id: 'manage', label: 'Manage', icon: Sliders, badge: 'Config', description: 'Profile, plan, owner onboarding, overrides & job history' },
      { id: 'fleet', label: 'Fleet', icon: Activity, badge: 'Health', description: 'Schema versions and lifecycle failures across tenants' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: Server,
    badge: 'Healthy',
    description: 'Core compute resources, daemons & hardware telemetry',
    items: [
      { id: 'hardware', label: 'Hardware', icon: Cpu, badge: 'Live', description: 'Processor cores, RAM allocation, NVMe storage & host telemetry' },
      { id: 'services', label: 'Services', icon: HardDrive, badge: 'Daemons', description: 'Non-OS active services, listening ports & resource metrics' },
    ],
  },
]

function formatUptime(seconds: number) {
  if (!seconds) return '0m'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

function isSuccessStatus(status: string) {
  return status.trim().toUpperCase() === 'SUCCESS'
}

function toNumber(value: unknown, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function normalizeService(service: ServiceApiItem): ServiceItem {
  const port = toNumber(service.port)
  const pid = service.pid == null ? null : toNumber(service.pid)
  const cpuPercent = toNumber(service.cpuPercent ?? service.cpu)
  const memPercent = toNumber(service.memPercent ?? service.mem)
  const memoryMb = String(service.memoryMb ?? service.rssMb ?? '0.0')

  return {
    id: service.id || `${port}-${pid || 'unknown'}`,
    port,
    name: service.name || 'Application Service',
    category: service.category || 'Application Service',
    description: service.description || `Listening service on port ${port}`,
    pid,
    pidsCount: toNumber(service.pidsCount, pid ? 1 : 0),
    user: service.user || 'unknown',
    cpuPercent,
    memPercent,
    memoryMb,
    uptime: service.uptime || '',
    cmd: service.cmd || '',
    protocol: service.protocol || 'TCP',
    status: service.status || 'LISTEN',
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [mfaRecent, setMfaRecent] = useState(false)
  const [manageTenantKey, setManageTenantKey] = useState<string | null>(null)
  const [productName, setProductName] = useState('Platform')
  const [ownerInvitation, setOwnerInvitation] = useState<{ link: string; delivered: boolean } | null>(null)
  const [tenantRootDomain, setTenantRootDomain] = useState('')
  useEffect(() => {
    fetch('/api/public-config', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.success) return
        setProductName(data.productName)
        setTenantRootDomain(data.tenantRootDomain || '')
        document.title = `${data.productName} · Platform`
      })
      .catch(() => undefined)
  }, [])
  const adminApi = useMemo(() => createAdminApi(csrfToken, () => clearSession()), [csrfToken])

  // Navigation State (default to Main Menu Dashboard)
  const [activeCategory, setActiveCategory] = useState<MenuCategory | null>(null)
  const [activeSubmenuId, setActiveSubmenuId] = useState<string>('subdomains')
  const [activeMainView, setActiveMainView] = useState<'dashboard' | 'category'>('dashboard')

  // Tenant List / Lifecycle State
  const [tenants, setTenants] = useState<TenantSummary[]>([])
  const [isLoadingTenants, setIsLoadingTenants] = useState(false)
  const [tenantListError, setTenantListError] = useState<string | null>(null)
  const [tenantActionPending, setTenantActionPending] = useState<string | null>(null)

  // Cloudflare Subdomains State
  const [dnsRecords, setDnsRecords] = useState<CloudflareDnsRecord[]>([])
  const [zoneInfo, setZoneInfo] = useState<{ id: string; name: string; status: string } | null>(null)
  const [loadingSubdomains, setLoadingSubdomains] = useState(false)
  const [subdomainSearch, setSubdomainSearch] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedRecord, setSelectedRecord] = useState<CloudflareDnsRecord | null>(null)

  // Subdomain Creation Modal & Form State (Tenant > Subdomain)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isExternalDomainModalOpen, setIsExternalDomainModalOpen] = useState(false)
  const [newSubdomainPrefix, setNewSubdomainPrefix] = useState('')
  const [creatingSubdomain, setCreatingSubdomain] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Durable tenant onboarding/provisioning state
  const [creatingTenant, setCreatingTenant] = useState(false)
  const [provisioningJob, setProvisioningJob] = useState<ProvisioningJob | null>(null)
  const [provisioningError, setProvisioningError] = useState<string | null>(null)

  // Subdomain Deletion State
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<CloudflareDnsRecord | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Hardware Telemetry State (System > Hardware)
  const [hardwareData, setHardwareData] = useState<HardwareData | null>(null)
  const [loadingHardware, setLoadingHardware] = useState(false)

  // Non-OS Services Telemetry State (System > Services)
  const [servicesList, setServicesList] = useState<ServiceItem[]>([])
  const [servicesSummary, setServicesSummary] = useState<ServicesSummary | null>(null)
  const [loadingServices, setLoadingServices] = useState(false)
  const [serviceSearch, setServiceSearch] = useState('')
  const [selectedService, setSelectedService] = useState<ServiceItem | null>(null)

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)


  // Login form states
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isVerified, setIsVerified] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isBadgeVisible, setIsBadgeVisible] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const turnstileContainerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) return null
        return await res.json()
      })
      .then((data) => {
        if (cancelled || !data?.success) return
        setCurrentUser(data.user)
        setCsrfToken(data.csrfToken)
        setMfaRecent(Boolean(data.mfaRecent))
      })
      .catch(() => {
        // Anonymous state is expected before login.
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Turnstile initialization
  useEffect(() => {
    if (checkingSession || currentUser) return
    if (LOGIN_CHALLENGE_DISABLED) {
      setIsVerified(true)
      setTurnstileToken('login-challenge-disabled-by-configuration')
      return
    }
    if (!IS_TURNSTILE_CONFIGURED) {
      setErrorMsg('Security verification is not configured for this deployment.')
      return
    }

    let interval: number | undefined
    let collapseTimer: ReturnType<typeof setTimeout> | undefined
    let badgeTimer: ReturnType<typeof setTimeout> | undefined

    const initTurnstile = () => {
      if (window.turnstile && turnstileContainerRef.current && !widgetIdRef.current) {
        try {
          widgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: PRODUCTION_TURNSTILE_SITE_KEY,
            theme: 'light',
            callback: (token: string) => {
              setIsVerified(true)
              setTurnstileToken(token)
              setErrorMsg(null)
              collapseTimer = setTimeout(() => {
                setIsCollapsed(true)
                badgeTimer = setTimeout(() => {
                  setIsBadgeVisible(true)
                }, 750)
              }, 700)
            },
            'expired-callback': () => {
              setIsVerified(false)
              setTurnstileToken(null)
              setIsCollapsed(false)
              setIsBadgeVisible(false)
            },
            'error-callback': () => {
              setIsVerified(false)
              setTurnstileToken(null)
              setIsCollapsed(false)
              setIsBadgeVisible(false)
            },
          })
          if (interval) clearInterval(interval)
        } catch {
          setErrorMsg('Security verification could not be initialized.')
        }
      }
    }

    if (window.turnstile) {
      initTurnstile()
    } else {
      interval = window.setInterval(() => {
        if (window.turnstile) {
          initTurnstile()
        }
      }, 200)
    }

    return () => {
      if (interval) clearInterval(interval)
      if (collapseTimer) clearTimeout(collapseTimer)
      if (badgeTimer) clearTimeout(badgeTimer)
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current)
          widgetIdRef.current = null
        } catch {
          // cleanup
        }
      }
    }
  }, [checkingSession, currentUser])

  const clearSession = () => {
    setCurrentUser(null)
    setCsrfToken(null)
  }

  const resetTurnstile = () => {
    if (LOGIN_CHALLENGE_DISABLED) return
    setIsVerified(false)
    setTurnstileToken(null)
    setIsCollapsed(false)
    setIsBadgeVisible(false)
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current)
      } catch {
        // Turnstile may not be ready during navigation or script reloads.
      }
    }
  }

  const authFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (init.method && init.method !== 'GET' && init.method !== 'HEAD' && csrfToken) {
      headers.set('X-CSRF-Token', csrfToken)
    }
    const send = () => fetch(input, { ...init, credentials: 'same-origin', headers })
    let response = await send()
    if (response.status === 401) clearSession()
    // Privileged mutations require a recent security-key check. Run it and
    // retry once instead of surfacing MFA_STEP_UP_REQUIRED to the operator.
    if (response.status === 403) {
      const body = await response.clone().json().catch(() => null)
      if (body?.code === 'MFA_STEP_UP_REQUIRED') {
        await adminApi.stepUp()
        setMfaRecent(true)
        response = await send()
      }
    }
    return response
  }

  const loadProvisioningJob = async (jobId: string) => {
    const response = await authFetch(`/api/tenant-provisioning/${encodeURIComponent(jobId)}`)
    const data = await response.json()
    if (!response.ok || !data.success) throw new Error(data.message || 'Unable to load provisioning progress.')
    setProvisioningJob(data.job)
    return data.job as ProvisioningJob
  }

  useEffect(() => {
    if (!provisioningJob || ['succeeded', 'failed', 'rolled_back'].includes(provisioningJob.status)) return
    const timer = window.setInterval(() => {
      loadProvisioningJob(provisioningJob.jobId).catch(() => {
        setProvisioningError('Provisioning is still running, but progress could not be refreshed.')
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [provisioningJob?.jobId, provisioningJob?.status])

  const handleCreateTenant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreatingTenant(true)
    setProvisioningError(null)
    const form = new FormData(event.currentTarget)
    const payload = {
      displayName: String(form.get('displayName') || ''),
      legalName: String(form.get('legalName') || ''),
      subdomain: String(form.get('subdomain') || '').toLowerCase(),
      locale: String(form.get('locale') || 'en'),
      logoUrl: String(form.get('logoUrl') || ''),
      primaryColor: String(form.get('primaryColor') || '#2563eb'),
      secondaryColor: String(form.get('secondaryColor') || '#0f172a'),
      loginMessage: String(form.get('loginMessage') || ''),
      region: 'global',
      ...(form.get('ownerEmail')
        ? { owner: { email: String(form.get('ownerEmail')), displayName: String(form.get('ownerName') || form.get('ownerEmail')) } }
        : {}),
      ...(form.get('planCode') ? { planCode: String(form.get('planCode')) } : {}),
      ...(form.get('connectionTier') ? { connectionTier: String(form.get('connectionTier')) } : {}),
    }
    try {
      const response = await authFetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.message || 'Tenant creation could not be started.')
      setOwnerInvitation(data.ownerInvitation ? { link: data.ownerInvitation.link, delivered: data.ownerInvitation.delivered } : null)
      if (data.planError) setProvisioningError(`Tenant created, but the plan could not be assigned: ${data.planError}`)
      await loadProvisioningJob(data.jobId)
    } catch (error) {
      setProvisioningError(error instanceof Error ? error.message : 'Tenant creation could not be started.')
    } finally {
      setCreatingTenant(false)
    }
  }

  const handleRetryProvisioning = async () => {
    if (!provisioningJob) return
    setProvisioningError(null)
    const response = await authFetch(
      `/api/tenant-provisioning/${encodeURIComponent(provisioningJob.jobId)}/retry`,
      { method: 'POST' },
    )
    const data = await response.json()
    if (!response.ok || !data.success) {
      setProvisioningError(data.message || 'Provisioning could not be retried.')
      return
    }
    await loadProvisioningJob(provisioningJob.jobId)
  }

  const loadTenants = async () => {
    setIsLoadingTenants(true)
    setTenantListError(null)
    try {
      const response = await authFetch('/api/tenants')
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.message || 'Unable to load tenants.')
      setTenants(data.tenants as TenantSummary[])
    } catch (error) {
      setTenantListError(error instanceof Error ? error.message : 'Unable to load tenants.')
    } finally {
      setIsLoadingTenants(false)
    }
  }

  useEffect(() => {
    if (activeCategory?.id === 'tenant' && activeSubmenuId === 'list') {
      loadTenants()
    }
  }, [activeCategory?.id, activeSubmenuId])

  const runTenantAction = async (tenantId: string, action: 'suspend' | 'resume' | 'deprovision') => {
    if (action === 'deprovision') {
      const confirmed = window.confirm(
        `Remove tenant ${tenantId}? This permanently deletes its database schema and cannot be undone. The tenant must already be suspended.`,
      )
      if (!confirmed) return
    }
    setTenantActionPending(`${tenantId}:${action}`)
    setTenantListError(null)
    try {
      const response = await authFetch(`/api/tenants/${encodeURIComponent(tenantId)}/${action}`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.message || `Could not ${action} this tenant.`)
      await loadTenants()
    } catch (error) {
      setTenantListError(error instanceof Error ? error.message : `Could not ${action} this tenant.`)
    } finally {
      setTenantActionPending(null)
    }
  }

  // Fetch Cloudflare Subdomains
  const fetchCloudflareSubdomains = async (isBackground = false) => {
    if (!isBackground && dnsRecords.length === 0) setLoadingSubdomains(true)
    try {
      const res = await authFetch('/api/cloudflare/subdomains')
      const data = await res.json()
      if (data.success && Array.isArray(data.records)) {
        setDnsRecords(data.records)
        setZoneInfo(data.zone || null)
        setSelectedRecord((current) =>
          data.records.find((record: CloudflareDnsRecord) => record.id === current?.id) ?? data.records[0] ?? null
        )
      }
    } catch {
      // ignore
    } finally {
      setLoadingSubdomains(false)
    }
  }

  // Fetch Live Hardware Telemetry
  const fetchHardwareTelemetry = async (isBackground = false) => {
    if (!isBackground && !hardwareData) setLoadingHardware(true)
    try {
      const res = await authFetch('/api/system/hardware')
      const data = await res.json()
      if (data.success) {
        setHardwareData(data)
      }
    } catch {
      // ignore
    } finally {
      setLoadingHardware(false)
    }
  }

  // Fetch Live Non-OS Services Telemetry
  const fetchServicesTelemetry = async (isBackground = false) => {
    if (!isBackground && servicesList.length === 0) setLoadingServices(true)
    try {
      const res = await authFetch('/api/system/services')
      const data = await res.json()
      if (data.success && Array.isArray(data.services)) {
        const normalizedServices: ServiceItem[] = data.services.map(normalizeService)
        const totalMemoryMb =
          data.summary?.totalMemoryMb ??
          normalizedServices.reduce((sum: number, service: ServiceItem) => sum + toNumber(service.memoryMb), 0).toFixed(1)
        const totalMemoryGb = data.summary?.totalMemoryGb ?? (toNumber(totalMemoryMb) / 1024).toFixed(2)
        const totalCpuPercent =
          data.summary?.totalCpuPercent ??
          data.summary?.totalCpu ??
          Number(normalizedServices.reduce((sum: number, service: ServiceItem) => sum + service.cpuPercent, 0).toFixed(1))

        setServicesList(normalizedServices)
        setServicesSummary({
          activeCount: normalizedServices.length,
          totalMemoryMb: String(totalMemoryMb),
          totalMemoryGb: String(totalMemoryGb),
          totalCpuPercent: String(totalCpuPercent),
        })
        if (!selectedService && normalizedServices.length > 0) {
          setSelectedService(normalizedServices[0])
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingServices(false)
    }
  }

  // Fetch audit logs
  const fetchAuditLogs = async (isBackground = false) => {
    if (!isBackground && auditLogs.length === 0) setLoadingLogs(true)
    try {
      const res = await authFetch('/api/audit/logs')
      const data = await res.json()
      if (data.success && Array.isArray(data.logs)) {
        setAuditLogs(data.logs)
      }
    } catch {
      // ignore
    } finally {
      setLoadingLogs(false)
    }
  }

  // Data fetching effect based on navigation
  useEffect(() => {
    if (currentUser) {
      const isSubdomainView =
        (activeCategory?.id === 'platform' && activeSubmenuId === 'subdomains') ||
        (activeCategory?.id === 'tenant' && activeSubmenuId === 'subdomain')

      if (isSubdomainView) {
        fetchCloudflareSubdomains()
      } else if (activeCategory?.id === 'platform' && activeSubmenuId === 'audit_logs') {
        fetchAuditLogs()
      } else if (activeCategory?.id === 'system' && activeSubmenuId === 'hardware') {
        fetchHardwareTelemetry()
      } else if (activeCategory?.id === 'system' && activeSubmenuId === 'services') {
        fetchServicesTelemetry()
      } else if (activeMainView === 'dashboard') {
        fetchAuditLogs()
        fetchCloudflareSubdomains()
        fetchHardwareTelemetry()
        fetchServicesTelemetry()
      }
    }
  }, [currentUser, activeCategory, activeSubmenuId, activeMainView])

  // Periodic polling when on hardware or services view
  useEffect(() => {
    if (currentUser && activeCategory?.id === 'system') {
      const timer = setInterval(() => {
        if (activeSubmenuId === 'hardware') {
          fetchHardwareTelemetry(true)
        } else if (activeSubmenuId === 'services') {
          fetchServicesTelemetry(true)
        }
      }, 5000)
      return () => clearInterval(timer)
    }
  }, [currentUser, activeCategory, activeSubmenuId])

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const isRecordProtected = (rec: CloudflareDnsRecord) => {
    const cleanName = rec.name.trim().toLowerCase()
    return (
      // The platform's own hostnames; deleting them would take a surface offline.
      [tenantRootDomain, `www.${tenantRootDomain}`, `platform.${tenantRootDomain}`, `user.${tenantRootDomain}`, `*.${tenantRootDomain}`].includes(cleanName)
    )
  }

  const isRecordDeletable = (rec: CloudflareDnsRecord) => rec.managed === true && !isRecordProtected(rec)

  const handleCreateSubdomain = async (e: FormEvent) => {
    e.preventDefault()
    if (!newSubdomainPrefix.trim()) {
      setCreateError('Please enter a subdomain prefix.')
      return
    }
    setCreatingSubdomain(true)
    setCreateError(null)

    try {
      const res = await authFetch('/api/cloudflare/subdomains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newSubdomainPrefix.trim(),
        }),
      })

      const data = await res.json()
      if (res.ok && data.success) {
        setIsCreateModalOpen(false)
        setNewSubdomainPrefix('')
        await fetchCloudflareSubdomains()
      } else {
        setCreateError(data.message || 'Failed to create subdomain in Cloudflare')
      }
    } catch {
      setCreateError('Network error connecting to Cloudflare API')
    } finally {
      setCreatingSubdomain(false)
    }
  }

  const handleDeleteSubdomain = async (rec: CloudflareDnsRecord) => {
    if (!isRecordDeletable(rec)) {
      alert('Only subdomains managed by this platform tunnel can be deleted here.')
      return
    }

    setDeletingId(rec.id)
    setDeleteError(null)

    try {
      const res = await authFetch(
        `/api/cloudflare/subdomains?id=${encodeURIComponent(rec.id)}`,
        { method: 'DELETE' }
      )

      const data = await res.json()
      if (res.ok && data.success) {
        setDeleteConfirmModal(null)
        await fetchCloudflareSubdomains()
      } else {
        setDeleteError(data.message || 'Failed to delete subdomain')
      }
    } catch {
      setDeleteError('Network error while deleting subdomain')
    } finally {
      setDeletingId(null)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!isVerified || !turnstileToken) return

    setErrorMsg(null)

    if (!username.trim()) {
      setErrorMsg('Please enter your username.')
      return
    }
    if (!password) {
      setErrorMsg('Please enter your password.')
      return
    }

    setIsLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: username.trim(), password, turnstileToken }),
      })

      const data = await res.json()

      if (res.ok && data.success) {
        setCurrentUser(data.user)
        setCsrfToken(data.csrfToken)
        setActiveCategory(null)
        setActiveMainView('dashboard')
      } else {
        setErrorMsg(data.message || 'Credential mismatch. Please check your username and password.')
        resetTurnstile()
      }
    } catch {
      setErrorMsg('Unable to connect to server. Please try again.')
      resetTurnstile()
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = async () => {
    if (currentUser) {
      try {
        await authFetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      } catch {
        // ignore
      }
    }
    clearSession()
    setUsername('')
    setPassword('')
    resetTurnstile()
    setErrorMsg(null)
  }

  // ==========================================
  // SHARED SUBDOMAIN BODY COMPONENT (SINGLE UNIFIED BANNER)
  // ==========================================
  const tenantStatusStyle: Record<TenantLifecycleStatus, { bg: string; fg: string; label: string }> = {
    provisioning: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Provisioning' },
    active: { bg: '#dcfce7', fg: '#166534', label: 'Active' },
    suspended: { bg: '#fef3c7', fg: '#92400e', label: 'Suspended' },
    migration_failed: { bg: '#fee2e2', fg: '#991b1b', label: 'Migration Failed' },
    provisioning_failed: { bg: '#fee2e2', fg: '#991b1b', label: 'Provisioning Failed' },
    deleting: { bg: '#e0e7ff', fg: '#3730a3', label: 'Removing' },
    deletion_failed: { bg: '#fee2e2', fg: '#991b1b', label: 'Removal Failed' },
  }

  const renderTenantListBody = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div
        style={{
          padding: '18px 22px',
          borderRadius: '16px',
          backgroundColor: '#eff6ff',
          border: '1px solid #bfdbfe',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '42px', height: '42px', borderRadius: '12px', backgroundColor: '#2563eb',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff',
              boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
            }}
          >
            <Building2 size={22} />
          </div>
          <div>
            <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Tenant / Tenants
            </span>
            <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>Tenant Lifecycle</h1>
            <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
              <strong>{tenants.length}</strong> tenant{tenants.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <button
          onClick={() => loadTenants()}
          disabled={isLoadingTenants}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px',
            background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px',
            cursor: 'pointer', fontSize: '13px', fontWeight: 500,
          }}
        >
          <RefreshCw size={14} className={isLoadingTenants ? 'spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {tenantListError && (
        <div style={{ padding: '10px 12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12.5px' }}>
          {tenantListError}
        </div>
      )}

      <div className="dynamic-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: '12px 20px', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Tenant</th>
              <th style={{ textAlign: 'left', padding: '12px 20px', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Hostname</th>
              <th style={{ textAlign: 'left', padding: '12px 20px', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Status</th>
              <th style={{ textAlign: 'right', padding: '12px 20px', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 && !isLoadingTenants && (
              <tr><td colSpan={4} style={{ padding: '28px 20px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>No tenants yet.</td></tr>
            )}
            {tenants.map((tenant) => {
              const style = tenantStatusStyle[tenant.status]
              const pendingSuspend = tenantActionPending === `${tenant.tenantId}:suspend`
              const pendingResume = tenantActionPending === `${tenant.tenantId}:resume`
              const pendingDeprovision = tenantActionPending === `${tenant.tenantId}:deprovision`
              return (
                <tr key={tenant.tenantId} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '14px 20px' }}>
                    <div style={{ fontWeight: 600, color: '#0f172a', fontSize: '13.5px' }}>{tenant.displayName}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: '11.5px', color: '#94a3b8' }}>{tenant.tenantId}</div>
                  </td>
                  <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontSize: '12.5px', color: '#334155' }}>
                    {tenant.hostname || '—'}
                  </td>
                  <td style={{ padding: '14px 20px' }}>
                    <span style={{ padding: '3px 9px', borderRadius: '9999px', fontSize: '11px', fontWeight: 700, background: style?.bg, color: style?.fg }}>
                      {style?.label || tenant.status}
                    </span>
                    {tenant.jobStatus && ['pending', 'running', 'retrying'].includes(tenant.jobStatus) && (
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>{tenant.currentStep}</div>
                    )}
                  </td>
                  <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '8px' }}>
                      {tenant.status === 'active' && (
                        <button
                          onClick={() => runTenantAction(tenant.tenantId, 'suspend')}
                          disabled={tenantActionPending !== null}
                          title="Suspend"
                          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 10px', border: '1px solid #fde68a', background: '#fffbeb', color: '#92400e', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                        >
                          <PauseCircle size={13} className={pendingSuspend ? 'spin' : ''} /> Suspend
                        </button>
                      )}
                      {tenant.status === 'suspended' && (
                        <>
                          <button
                            onClick={() => runTenantAction(tenant.tenantId, 'resume')}
                            disabled={tenantActionPending !== null}
                            title="Resume"
                            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 10px', border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                          >
                            <PlayCircle size={13} className={pendingResume ? 'spin' : ''} /> Resume
                          </button>
                          <button
                            onClick={() => runTenantAction(tenant.tenantId, 'deprovision')}
                            disabled={tenantActionPending !== null}
                            title="Remove permanently"
                            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 10px', border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                          >
                            <Trash2 size={13} className={pendingDeprovision ? 'spin' : ''} /> Remove
                          </button>
                        </>
                      )}
                      {tenant.status === 'deletion_failed' && (
                        <span style={{ fontSize: '11.5px', color: '#b91c1c' }}>Removal failed — retry from the provisioning job</span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  const renderSubdomainBody = (isTenantMode: boolean) => {
    const filteredRecords = dnsRecords.filter((rec) =>
      rec.name.toLowerCase().includes(subdomainSearch.toLowerCase()) ||
      rec.type.toLowerCase().includes(subdomainSearch.toLowerCase()) ||
      rec.content.toLowerCase().includes(subdomainSearch.toLowerCase())
    )

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {/* Single Integrated Subdomain Header Banner */}
        <div
          style={{
            padding: '18px 22px',
            borderRadius: '16px',
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                backgroundColor: '#2563eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
              }}
            >
              <Globe size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {isTenantMode ? 'Tenant / Subdomain' : 'Platform / Subdomains'}
                </span>
                <span style={{ color: '#93c5fd' }}>•</span>
                <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: '9999px' }}>
                  Zone Active
                </span>
                {isTenantMode && (
                  <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#fef3c7', color: '#92400e', padding: '1px 7px', borderRadius: '9999px' }}>
                    Tenant Provisioning Active
                  </span>
                )}
              </div>
              <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                Cloudflare DNS & Subdomain Routing (<code>{tenantRootDomain}</code>)
              </h1>
              <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
                Zone ID: <code style={{ fontFamily: 'monospace' }}>{zoneInfo?.id || 'Unavailable'}</code> • SSL: Strict (TLS 1.3) • <strong>{dnsRecords.length}</strong> Records (<strong>{dnsRecords.filter((r) => r.proxied).length}</strong> Proxied)
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={() => fetchCloudflareSubdomains()}
              disabled={loadingSubdomains}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: '#ffffff',
                border: '1px solid #bfdbfe',
                color: '#1d4ed8',
                padding: '8px 14px',
                borderRadius: '10px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}
            >
              <RefreshCw size={14} style={{ animation: loadingSubdomains ? 'spin 1s linear infinite' : 'none' }} />
              <span>Sync Cloudflare</span>
            </button>

            {isTenantMode && (
              <>
                <button
                  onClick={() => setIsExternalDomainModalOpen(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: '#ffffff',
                    color: '#334155',
                    border: '1px solid #cbd5e1',
                    borderRadius: '10px',
                    padding: '8px 14px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <ExternalLink size={14} />
                  <span>External Domain</span>
                </button>
                <button
                  onClick={() => {
                    setCreateError(null)
                    setNewSubdomainPrefix('')
                    setIsCreateModalOpen(true)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 2px 6px rgba(37, 99, 235, 0.25)',
                  }}
                >
                  <Plus size={15} />
                  <span>Create Subdomain</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '340px' }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: '#94a3b8' }} />
            <input
              type="text"
              value={subdomainSearch}
              onChange={(e) => setSubdomainSearch(e.target.value)}
              placeholder="Filter subdomains by name, type, target..."
              style={{
                width: '100%',
                height: '40px',
                padding: '0 14px 0 38px',
                borderRadius: '10px',
                border: '1px solid #cbd5e1',
                fontSize: '13px',
                backgroundColor: '#ffffff',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ fontSize: '12.5px', color: '#64748b' }}>
            Showing {filteredRecords.length} of {dnsRecords.length} records
          </div>
        </div>

        {/* Structured Data Table */}
        <div className="dynamic-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ width: '100%', overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: '780px', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
              <thead>
                <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Subdomain Name</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Type</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Target / Destination</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Proxy Status</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>TTL</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Created (UTC)</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingSubdomains && dnsRecords.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '36px', textAlign: 'center', color: '#94a3b8' }}>
                      Querying Cloudflare SDK for live DNS records...
                    </td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '36px', textAlign: 'center', color: '#94a3b8' }}>
                      No matching DNS records found.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((record) => {
                    const isProtected = isRecordProtected(record)
                    const isDeletable = isRecordDeletable(record)
                    const isSelected = selectedRecord?.id === record.id

                    return (
                      <tr
                        key={record.id}
                        onClick={() => setSelectedRecord(record)}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: isSelected ? '#f8fafc' : 'transparent',
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                        }}
                      >
                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Globe size={15} color="#2563eb" />
                            <span style={{ fontWeight: 700, color: '#0f172a', fontSize: '13.5px' }}>
                              {record.name}
                            </span>
                            {isProtected && (
                              <span
                                title="System Protected Domain (Cannot be deleted)"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  color: '#475569',
                                  backgroundColor: '#f1f5f9',
                                  border: '1px solid #e2e8f0',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                }}
                              >
                                <Lock size={10} color="#64748b" />
                                <span>Protected</span>
                              </span>
                            )}
                          </div>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              color: record.type === 'CNAME' ? '#1d4ed8' : '#6b21a8',
                              backgroundColor: record.type === 'CNAME' ? '#dbeafe' : '#f3e8ff',
                              padding: '2px 8px',
                              borderRadius: '6px',
                              fontFamily: 'monospace',
                            }}
                          >
                            {record.type}
                          </span>
                        </td>

                        <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontSize: '12px', color: '#334155', maxWidth: '280px', wordBreak: 'break-all' }}>
                          {record.content}
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          {record.proxied ? (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '11.5px',
                                fontWeight: 600,
                                color: '#c2410c',
                                backgroundColor: '#ffedd5',
                                padding: '2px 8px',
                                borderRadius: '9999px',
                              }}
                            >
                              <span>☁ Proxied</span>
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: '11.5px',
                                fontWeight: 600,
                                color: '#64748b',
                                backgroundColor: '#f1f5f9',
                                padding: '2px 8px',
                                borderRadius: '9999px',
                              }}
                            >
                              DNS Only
                            </span>
                          )}
                        </td>

                        <td style={{ padding: '14px 20px', color: '#64748b', fontSize: '12px' }}>
                          {record.ttl === 1 ? 'Auto' : `${record.ttl}s`}
                        </td>

                        <td style={{ padding: '14px 20px', color: '#64748b', fontFamily: 'monospace', fontSize: '12px' }}>
                          {new Date(record.created_on).toISOString().split('T')[0]}
                        </td>

                        <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
                            <button
                              title="Copy Subdomain Hostname"
                              onClick={(e) => {
                                e.stopPropagation()
                                copyToClipboard(record.name, record.id)
                              }}
                              style={{
                                background: 'none',
                                border: '1px solid #e2e8f0',
                                borderRadius: '6px',
                                padding: '5px 8px',
                                cursor: 'pointer',
                                color: copiedId === record.id ? '#16a34a' : '#64748b',
                                fontSize: '11.5px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              {copiedId === record.id ? <Check size={12} /> : <Copy size={12} />}
                              <span>{copiedId === record.id ? 'Copied' : 'Copy'}</span>
                            </button>

                            {isTenantMode && (
                              <>
                                {!isDeletable ? (
                                  <button
                                    disabled
                                    title={isProtected ? 'System core subdomain cannot be deleted' : 'Record is not managed by this platform tunnel'}
                                    style={{
                                      background: 'none',
                                      border: '1px solid #f1f5f9',
                                      borderRadius: '6px',
                                      padding: '5px 8px',
                                      color: '#cbd5e1',
                                      fontSize: '11.5px',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      cursor: 'not-allowed',
                                    }}
                                  >
                                    <Lock size={12} />
                                    <span>{isProtected ? 'Protected' : 'Read only'}</span>
                                  </button>
                                ) : (
                                  <button
                                    title="Delete Subdomain Record"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setDeleteError(null)
                                      setDeleteConfirmModal(record)
                                    }}
                                    style={{
                                      background: 'none',
                                      border: '1px solid #fecaca',
                                      borderRadius: '6px',
                                      padding: '5px 8px',
                                      cursor: 'pointer',
                                      color: '#dc2626',
                                      backgroundColor: '#fef2f2',
                                      fontSize: '11.5px',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      transition: 'all 0.15s ease',
                                    }}
                                  >
                                    <Trash2 size={12} />
                                    <span>Delete</span>
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detailed Record Inspector Card */}
        {selectedRecord && (
          <div className="dynamic-card" style={{ backgroundColor: '#ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldCheck size={18} color="#2563eb" />
                <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
                  Cloudflare DNS Inspection: <code>{selectedRecord.name}</code>
                </h3>
              </div>
              <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                ID: {selectedRecord.id}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', fontSize: '12.5px' }}>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Edge Routing Target</div>
                <div style={{ fontWeight: 600, color: '#0f172a', fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedRecord.content}</div>
              </div>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Proxy Status</div>
                <div style={{ fontWeight: 600, color: selectedRecord.proxied ? '#16a34a' : '#64748b' }}>
                  {selectedRecord.proxied ? 'Cloudflare proxy enabled' : 'DNS only'}
                </div>
              </div>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Last Modified</div>
                <div style={{ fontWeight: 600, color: '#0f172a' }}>{new Date(selectedRecord.modified_on).toUTCString()}</div>
              </div>
            </div>
          </div>
        )}

        {/* CREATE SUBDOMAIN MODAL */}
        {isCreateModalOpen && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(15, 23, 42, 0.5)',
              backdropFilter: 'blur(4px)',
              zIndex: 50,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }}
          >
            <div
              className="dynamic-card modal-animate"
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-subdomain-title"
              style={{
                width: '100%',
                maxWidth: '460px',
                padding: '28px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '34px',
                      height: '34px',
                      borderRadius: '10px',
                      backgroundColor: '#eff6ff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#2563eb',
                    }}
                  >
                    <Plus size={18} />
                  </div>
                  <div>
                    <h3 id="create-subdomain-title" style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a' }}>Create {tenantRootDomain} Subdomain</h3>
                    <p style={{ fontSize: '12.5px', color: '#64748b', marginTop: '1px' }}>
                      Choose the name. DNS type, target, and proxy settings are managed automatically.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close create subdomain dialog"
                  onClick={() => setIsCreateModalOpen(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: '4px' }}
                >
                  <X size={18} />
                </button>
              </div>

              {createError && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    fontSize: '13px',
                    marginBottom: '16px',
                  }}
                >
                  {createError}
                </div>
              )}

              <form onSubmit={handleCreateSubdomain} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label htmlFor="platform-new-subdomain" style={{ fontSize: '12.5px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>
                    Subdomain
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                    <input
                      id="platform-new-subdomain"
                      type="text"
                      value={newSubdomainPrefix}
                      onChange={(e) => {
                        setNewSubdomainPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        if (createError) setCreateError(null)
                      }}
                      placeholder="acme"
                      maxLength={63}
                      pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                      autoFocus
                      required
                      style={{
                        flex: 1,
                        height: '42px',
                        padding: '0 14px',
                        borderTopLeftRadius: '10px',
                        borderBottomLeftRadius: '10px',
                        border: '1px solid #cbd5e1',
                        borderRight: 'none',
                        fontSize: '14px',
                      }}
                    />
                    <div
                      style={{
                        height: '42px',
                        padding: '0 14px',
                        backgroundColor: '#f1f5f9',
                        border: '1px solid #cbd5e1',
                        borderTopRightRadius: '10px',
                        borderBottomRightRadius: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#475569',
                      }}
                    >
                      .{tenantRootDomain}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    style={{
                      height: '42px',
                      padding: '0 18px',
                      borderRadius: '10px',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#ffffff',
                      color: '#475569',
                      fontWeight: 600,
                      fontSize: '13.5px',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creatingSubdomain}
                    style={{
                      height: '42px',
                      padding: '0 20px',
                      borderRadius: '10px',
                      border: 'none',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      fontWeight: 600,
                      fontSize: '13.5px',
                      cursor: creatingSubdomain ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    {creatingSubdomain && <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    <span>{creatingSubdomain ? 'Creating in Cloudflare...' : 'Create Subdomain'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* EXTERNAL DOMAIN MODAL */}
        {isExternalDomainModalOpen && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(15, 23, 42, 0.5)',
              backdropFilter: 'blur(4px)',
              zIndex: 50,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }}
          >
            <div
              className="dynamic-card modal-animate"
              role="dialog"
              aria-modal="true"
              aria-labelledby="external-domain-title"
              style={{ width: '100%', maxWidth: '440px', padding: '28px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '34px', height: '34px', borderRadius: '8px', backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>
                    <ExternalLink size={17} />
                  </div>
                  <div>
                    <h3 id="external-domain-title" style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a' }}>Attach External Domain</h3>
                    <p style={{ fontSize: '12.5px', color: '#64748b', marginTop: '1px' }}>External domain configuration will be added later.</p>
                  </div>
                </div>
                <button
                  aria-label="Close external domain dialog"
                  onClick={() => setIsExternalDomainModalOpen(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: '4px' }}
                >
                  <X size={18} />
                </button>
              </div>
              <div style={{ padding: '14px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', borderRadius: '8px', color: '#475569', fontSize: '13px' }}>
                This workflow will handle ownership verification, DNS instructions, TLS activation, and routing independently from {tenantRootDomain} subdomains.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button
                  type="button"
                  onClick={() => setIsExternalDomainModalOpen(false)}
                  style={{ height: '40px', padding: '0 18px', borderRadius: '8px', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', color: '#334155', fontWeight: 600, cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* DELETE CONFIRMATION MODAL */}
        {deleteConfirmModal && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(15, 23, 42, 0.5)',
              backdropFilter: 'blur(4px)',
              zIndex: 50,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }}
          >
            <div
              className="dynamic-card modal-animate"
              style={{
                width: '100%',
                maxWidth: '460px',
                padding: '28px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '16px' }}>
                <div
                  style={{
                    width: '38px',
                    height: '38px',
                    borderRadius: '12px',
                    backgroundColor: '#fef2f2',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#dc2626',
                    flexShrink: 0,
                  }}
                >
                  <AlertTriangle size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a' }}>Delete Subdomain Record?</h3>
                  <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px', lineHeight: 1.5 }}>
                    Are you sure you want to permanently remove <strong>{deleteConfirmModal.name}</strong> from Cloudflare DNS?
                  </p>
                </div>
              </div>

              {deleteError && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    fontSize: '13px',
                    marginBottom: '16px',
                  }}
                >
                  {deleteError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmModal(null)}
                  style={{
                    height: '40px',
                    padding: '0 16px',
                    borderRadius: '10px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#ffffff',
                    color: '#475569',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deletingId === deleteConfirmModal.id}
                  onClick={() => handleDeleteSubdomain(deleteConfirmModal)}
                  style={{
                    height: '40px',
                    padding: '0 18px',
                    borderRadius: '10px',
                    border: 'none',
                    backgroundColor: '#dc2626',
                    color: '#ffffff',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: deletingId === deleteConfirmModal.id ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  {deletingId === deleteConfirmModal.id && <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} />}
                  <span>{deletingId === deleteConfirmModal.id ? 'Deleting...' : 'Delete Subdomain'}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ==========================================
  // SYSTEM > HARDWARE BODY COMPONENT (SINGLE UNIFIED BANNER)
  // ==========================================
  const renderHardwareBody = () => {
    const cpu = hardwareData?.cpu
    const mem = hardwareData?.memory
    const storage = hardwareData?.storage
    const sys = hardwareData?.system

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Single Integrated Hardware Status Banner */}
        <div
          style={{
            padding: '18px 22px',
            borderRadius: '16px',
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                backgroundColor: '#2563eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
              }}
            >
              <Cpu size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  System / Hardware
                </span>
                <span style={{ color: '#93c5fd' }}>•</span>
                <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: '9999px' }}>
                  Hardware Healthy
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#f1f5f9', color: '#475569', padding: '1px 7px', borderRadius: '9999px' }}>
                  {sys?.arch || 'x86_64'}
                </span>
              </div>
              <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                {sys?.hostname || 'Host'} Dedicated VDS Architecture
              </h1>
              <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
                OS: <strong>{sys?.osName || 'Linux'}</strong> • Kernel: <code>{sys?.release || 'Linux 6.x'}</code> • Uptime: <strong>{formatUptime(sys?.uptimeSeconds || 0)}</strong>
              </div>
            </div>
          </div>

          <button
            onClick={() => fetchHardwareTelemetry()}
            disabled={loadingHardware}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#ffffff',
              border: '1px solid #bfdbfe',
              color: '#1d4ed8',
              padding: '8px 14px',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}
          >
            <RefreshCw size={14} style={{ animation: loadingHardware ? 'spin 1s linear infinite' : 'none' }} />
            <span>Poll Hardware</span>
          </button>
        </div>

        {/* 3 Core Hardware Metric Cards: Processor, RAM, NVMe Storage */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '18px' }}>
          {/* 1. PROCESSOR (CPU) */}
          <div className="dynamic-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2563eb' }}>
                  <Cpu size={17} />
                </div>
                <div>
                  <h3 style={{ fontSize: '14.5px', fontWeight: 700, color: '#0f172a' }}>Processor (CPU)</h3>
                  <div style={{ fontSize: '11.5px', color: '#64748b' }}>{cpu?.cores || 12} Virtual Cores</div>
                </div>
              </div>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#166534', backgroundColor: '#dcfce7', padding: '2px 8px', borderRadius: '6px' }}>
                Optimal Load
              </span>
            </div>

            <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#1e293b', marginBottom: '6px' }}>
              {cpu?.model || 'AMD EPYC Processor'}
            </div>

            <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>
                <span>System Load Average</span>
                <span style={{ fontWeight: 600, color: '#0f172a' }}>1m: {cpu?.loadAvg['1m'] ?? 0.2} | 5m: {cpu?.loadAvg['5m'] ?? 0.1} | 15m: {cpu?.loadAvg['15m'] ?? 0.1}</span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.min(100, Math.max(5, ((cpu?.loadAvg['1m'] || 0.2) / (cpu?.cores || 12)) * 100))}%`,
                    height: '100%',
                    backgroundColor: '#2563eb',
                    borderRadius: '9999px',
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>Active Core Distribution</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                {Array.from({ length: cpu?.cores || 12 }).map((_, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '6px 4px',
                      textAlign: 'center',
                      borderRadius: '6px',
                      backgroundColor: '#f1f5f9',
                      border: '1px solid #e2e8f0',
                      fontSize: '11px',
                      fontWeight: 600,
                      color: '#334155',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                    }}
                  >
                    <div style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#10b981' }} />
                    <span>C#{idx}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 2. MEMORY (RAM) */}
          <div className="dynamic-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: '#faf5ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9333ea' }}>
                  <MemoryStick size={17} />
                </div>
                <div>
                  <h3 style={{ fontSize: '14.5px', fontWeight: 700, color: '#0f172a' }}>System RAM</h3>
                  <div style={{ fontSize: '11.5px', color: '#64748b' }}>High-Speed ECC Memory</div>
                </div>
              </div>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#7e22ce', backgroundColor: '#f3e8ff', padding: '2px 8px', borderRadius: '6px' }}>
                {mem?.usedPercent || 28}% Utilized
              </span>
            </div>

            <div style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', marginBottom: '2px' }}>
              {mem?.usedGB || '8.7'} GB <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>/ {mem?.totalGB || '31.3'} GB</span>
            </div>
            <div style={{ fontSize: '12px', color: '#16a34a', marginBottom: '14px' }}>
              {mem?.freeGB || '22.6'} GB Available Free Memory
            </div>

            <div style={{ width: '100%', height: '10px', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden', display: 'flex', marginBottom: '14px' }}>
              <div style={{ width: `${mem?.usedPercent || 28}%`, backgroundColor: '#9333ea', height: '100%' }} title="Used RAM" />
              <div style={{ width: `${Math.min(50, (((mem?.cachedBytes || 0) + (mem?.buffersBytes || 0)) / (mem?.totalBytes || 1)) * 100)}%`, backgroundColor: '#c084fc', height: '100%' }} title="Cached & Buffers" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Used</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#9333ea' }}>{mem?.usedGB || '8.7'} GB</div>
              </div>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Cache/Buffers</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#7c3aed' }}>{((mem?.cachedBytes || 0) / (1024 ** 3)).toFixed(1)} GB</div>
              </div>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Free</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#16a34a' }}>{mem?.freeGB || '22.6'} GB</div>
              </div>
            </div>
          </div>

          {/* 3. STORAGE / NVMe DISK */}
          <div className="dynamic-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16a34a' }}>
                  <HardDrive size={17} />
                </div>
                <div>
                  <h3 style={{ fontSize: '14.5px', fontWeight: 700, color: '#0f172a' }}>NVMe Storage</h3>
                  <div style={{ fontSize: '11.5px', color: '#64748b' }}>Root Volume <code>{storage?.filesystem || '/dev/vda3'}</code></div>
                </div>
              </div>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#166534', backgroundColor: '#dcfce7', padding: '2px 8px', borderRadius: '6px' }}>
                {storage?.usedPercent || 3}% Used
              </span>
            </div>

            <div style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', marginBottom: '2px' }}>
              {storage?.usedGB || '30.2'} GB <span style={{ fontSize: '14px', fontWeight: 500, color: '#64748b' }}>/ {storage?.totalGB || '1,006.6'} GB</span>
            </div>
            <div style={{ fontSize: '12px', color: '#16a34a', marginBottom: '14px' }}>
              {storage?.availGB || '935.3'} GB Available NVMe Space
            </div>

            <div style={{ width: '100%', height: '10px', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden', marginBottom: '14px' }}>
              <div style={{ width: `${Math.max(3, storage?.usedPercent || 3)}%`, backgroundColor: '#10b981', height: '100%', borderRadius: '9999px' }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Allocated</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#0f172a' }}>{storage?.totalGB || '1.0 TB'}</div>
              </div>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Used</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#059669' }}>{storage?.usedGB || '30 GB'}</div>
              </div>
              <div style={{ padding: '8px 4px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '10.5px', color: '#64748b' }}>Available</div>
                <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#16a34a' }}>{storage?.availGB || '935 GB'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Detailed System & Kernel Specifications Matrix */}
        <div className="dynamic-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '18px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={17} color="#2563eb" />
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>Host System Environment & Kernel Matrix</h3>
            </div>
            <span style={{ fontSize: '11.5px', color: '#64748b', fontFamily: 'monospace' }}>
              Last Synced: {new Date(hardwareData?.timestamp || Date.now()).toLocaleTimeString()}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1px', backgroundColor: '#e2e8f0' }}>
            <div style={{ backgroundColor: '#ffffff', padding: '16px 20px' }}>
              <div style={{ fontSize: '11.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Server Hostname</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{sys?.hostname || 'Host'}</div>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '16px 20px' }}>
              <div style={{ fontSize: '11.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Operating System</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{sys?.osName || 'Ubuntu 24.04 LTS'}</div>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '16px 20px' }}>
              <div style={{ fontSize: '11.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Linux Kernel Release</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px', fontFamily: 'monospace' }}>{sys?.release || '6.8.0-124-generic'}</div>
            </div>
            <div style={{ backgroundColor: '#ffffff', padding: '16px 20px' }}>
              <div style={{ fontSize: '11.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Instruction Architecture</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{sys?.arch === 'x64' ? 'x86_64 (64-Bit AMD64)' : sys?.arch}</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ==========================================
  // SYSTEM > SERVICES BODY COMPONENT (SINGLE UNIFIED BANNER)
  // ==========================================
  const renderServicesBody = () => {
    const filteredServices = servicesList.filter((s) =>
      s.name.toLowerCase().includes(serviceSearch.toLowerCase()) ||
      s.category.toLowerCase().includes(serviceSearch.toLowerCase()) ||
      s.port.toString().includes(serviceSearch) ||
      (s.pid && s.pid.toString().includes(serviceSearch)) ||
      s.cmd.toLowerCase().includes(serviceSearch.toLowerCase())
    )

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Single Integrated Services Header Banner */}
        <div
          style={{
            padding: '18px 22px',
            borderRadius: '16px',
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                backgroundColor: '#2563eb',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
              }}
            >
              <Server size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  System / Services
                </span>
                <span style={{ color: '#93c5fd' }}>•</span>
                <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: '9999px' }}>
                  {servicesList.length} Online
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#f1f5f9', color: '#475569', padding: '1px 7px', borderRadius: '9999px' }}>
                  Non-OS Bound
                </span>
              </div>
              <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                Active Application & Daemon Services
              </h1>
              <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
                Total Memory Footprint: <strong>{servicesSummary?.totalMemoryGb || '1.8'} GB</strong> ({servicesSummary?.totalMemoryMb || '1800'} MB) • Aggregate CPU: <strong>{servicesSummary?.totalCpuPercent || '2.4'}%</strong>
              </div>
            </div>
          </div>

          <button
            onClick={() => fetchServicesTelemetry()}
            disabled={loadingServices}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#ffffff',
              border: '1px solid #bfdbfe',
              color: '#1d4ed8',
              padding: '8px 14px',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
            }}
          >
            <RefreshCw size={14} style={{ animation: loadingServices ? 'spin 1s linear infinite' : 'none' }} />
            <span>Refresh Services</span>
          </button>
        </div>

        {/* Search & Filter Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '340px' }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '12px', color: '#94a3b8' }} />
            <input
              type="text"
              value={serviceSearch}
              onChange={(e) => setServiceSearch(e.target.value)}
              placeholder="Search by name, port, category, PID..."
              style={{
                width: '100%',
                height: '40px',
                padding: '0 14px 0 38px',
                borderRadius: '10px',
                border: '1px solid #cbd5e1',
                fontSize: '13px',
                backgroundColor: '#ffffff',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ fontSize: '12.5px', color: '#64748b' }}>
            Showing {filteredServices.length} of {servicesList.length} non-OS services
          </div>
        </div>

        {/* Structured Services Table */}
        <div className="dynamic-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ width: '100%', overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: '820px', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
              <thead>
                <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Service Name</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Category</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Listening Port</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>PID / User</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>CPU Usage</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Memory (RSS)</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Uptime</th>
                  <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569', textAlign: 'right' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loadingServices && servicesList.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: '36px', textAlign: 'center', color: '#94a3b8' }}>
                      Querying Linux socket bindings and process utilization...
                    </td>
                  </tr>
                ) : filteredServices.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: '36px', textAlign: 'center', color: '#94a3b8' }}>
                      No matching non-OS services found.
                    </td>
                  </tr>
                ) : (
                  filteredServices.map((svc) => {
                    const isSelected = selectedService?.id === svc.id

                    return (
                      <tr
                        key={svc.id}
                        onClick={() => setSelectedService(svc)}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: isSelected ? '#f8fafc' : 'transparent',
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                        }}
                      >
                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div style={{ width: '28px', height: '28px', borderRadius: '6px', backgroundColor: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2563eb' }}>
                              {svc.category === 'Database' ? <Database size={15} /> : svc.category === 'Edge Ingress' ? <ShieldCheck size={15} /> : svc.category === 'AI Runtime' ? <Cpu size={15} /> : <Server size={15} />}
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '13.5px' }}>{svc.name}</div>
                              <div style={{ fontSize: '11px', color: '#64748b' }}>{svc.description}</div>
                            </div>
                          </div>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              color: svc.category === 'Database' ? '#7e22ce' : svc.category === 'Edge Ingress' ? '#c2410c' : svc.category === 'Platform UI' ? '#1d4ed8' : '#334155',
                              backgroundColor: svc.category === 'Database' ? '#f3e8ff' : svc.category === 'Edge Ingress' ? '#ffedd5' : svc.category === 'Platform UI' ? '#dbeafe' : '#f1f5f9',
                              padding: '2px 8px',
                              borderRadius: '6px',
                            }}
                          >
                            {svc.category}
                          </span>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', backgroundColor: '#f1f5f9', padding: '1px 5px', borderRadius: '4px' }}>
                              {svc.protocol}
                            </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '13px', color: '#0f172a' }}>
                              :{svc.port}
                            </span>
                          </div>
                        </td>

                        <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontSize: '12px', color: '#475569' }}>
                          <div>PID {svc.pid || 'N/A'}</div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>User: {svc.user}</div>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div style={{ width: '48px', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '9999px', overflow: 'hidden' }}>
                              <div
                                style={{
                                  width: `${Math.min(100, Math.max(8, svc.cpuPercent * 10))}%`,
                                  height: '100%',
                                  backgroundColor: svc.cpuPercent > 10 ? '#ea580c' : '#2563eb',
                                  borderRadius: '9999px',
                                }}
                              />
                            </div>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: '12px', color: '#0f172a' }}>
                              {svc.cpuPercent.toFixed(1)}%
                            </span>
                          </div>
                        </td>

                        <td style={{ padding: '14px 20px' }}>
                          <div style={{ fontWeight: 600, fontSize: '12.5px', color: '#0f172a' }}>
                            {parseFloat(svc.memoryMb) > 1024 ? `${(parseFloat(svc.memoryMb) / 1024).toFixed(2)} GB` : `${svc.memoryMb} MB`}
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>{svc.memPercent.toFixed(1)}% of RAM</div>
                        </td>

                        <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontSize: '12px', color: '#64748b' }}>
                          {svc.uptime}
                        </td>

                        <td style={{ padding: '14px 20px', textAlign: 'right' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '3px 9px',
                              borderRadius: '9999px',
                              backgroundColor: '#ecfdf5',
                              border: '1px solid #a7f3d0',
                              color: '#065f46',
                              fontSize: '11.5px',
                              fontWeight: 700,
                            }}
                          >
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981' }} />
                            <span>ONLINE</span>
                          </span>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Selected Service Command Inspector */}
        {selectedService && (
          <div className="dynamic-card" style={{ backgroundColor: '#ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={18} color="#2563eb" />
                <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
                  Service Inspection: <strong>{selectedService.name}</strong> (Port {selectedService.port})
                </h3>
              </div>
              <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                PID: {selectedService.pid || 'N/A'} • {selectedService.protocol} Socket
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', fontSize: '12.5px', marginBottom: '14px' }}>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Assigned Category</div>
                <div style={{ fontWeight: 600, color: '#0f172a' }}>{selectedService.category}</div>
              </div>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Resident Memory Usage</div>
                <div style={{ fontWeight: 600, color: '#7e22ce' }}>{selectedService.memoryMb} MB ({selectedService.memPercent}% RAM)</div>
              </div>
              <div style={{ padding: '10px 14px', backgroundColor: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                <div style={{ color: '#64748b', marginBottom: '2px' }}>Process CPU Allocation</div>
                <div style={{ fontWeight: 600, color: '#2563eb' }}>{selectedService.cpuPercent}% CPU Load</div>
              </div>
            </div>

            {selectedService.cmd && (
              <div>
                <div style={{ fontSize: '11.5px', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Binary Execution Command</div>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px',
                    backgroundColor: '#0f172a',
                    color: '#e2e8f0',
                    fontFamily: 'monospace',
                    fontSize: '11.5px',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: '120px',
                  }}
                >
                  {selectedService.cmd}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // ==========================================
  // AUTHENTICATED PLATFORM VIEWPORT & SIDEBAR
  // ==========================================
  if (checkingSession) {
    return (
      <div style={styles.loginCard}>
        <div style={styles.logoCircle}>
          <ShieldCheck size={28} color="#ffffff" strokeWidth={2.5} />
        </div>
      </div>
    )
  }

  if (currentUser) {
    const isDashboard = activeCategory === null && activeMainView === 'dashboard'
    const currentCategory = activeCategory || MENU_CATEGORIES[0]
    const currentSubmenu = currentCategory.items.find((i) => i.id === activeSubmenuId) || currentCategory.items[0]

    return (
      <div className="platform-layout" data-build-revision={UI_BUILD_REVISION}>
        {/* Full-width Top Header Bar */}
        <header className="platform-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Logo */}
            <div
              onClick={() => {
                setActiveCategory(null)
                setActiveMainView('dashboard')
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
            >
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '10px',
                  backgroundColor: '#0f172a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 6px rgba(15, 23, 42, 0.2)',
                }}
              >
                <ShieldCheck size={18} color="#ffffff" />
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.02em' }}>
                  {productName}
                </span>
                <span
                  style={{
                    fontSize: '10.5px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: '#2563eb',
                    backgroundColor: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '6px',
                    padding: '1px 6px',
                  }}
                >
                  Platform
                </span>
              </div>
            </div>

            {/* Breadcrumb Separator */}
            <div style={{ width: '1px', height: '20px', backgroundColor: '#e2e8f0', margin: '0 4px' }} />

            {/* Dynamic Breadcrumb */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#64748b' }}>
              {isDashboard ? (
                <span style={{ fontWeight: 600, color: '#0f172a' }}>Dashboard</span>
              ) : (
                <>
                  <span
                    onClick={() => {
                      setActiveCategory(null)
                      setActiveMainView('dashboard')
                    }}
                    style={{ cursor: 'pointer', color: '#64748b' }}
                  >
                    Main Menu
                  </span>
                  <ChevronRight size={14} color="#94a3b8" />
                  <span>{currentCategory.label}</span>
                  <ChevronRight size={14} color="#94a3b8" />
                  <span style={{ fontWeight: 600, color: '#0f172a' }}>{currentSubmenu.label}</span>
                </>
              )}
            </div>
          </div>

          {/* Header Right Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                backgroundColor: '#f0fdf4',
                border: '1px solid #bbf7d0',
                padding: '5px 12px',
                borderRadius: '9999px',
                fontSize: '12px',
                fontWeight: 500,
                color: '#166534',
              }}
            >
              <div className="pulse-dot" />
              <span>Operational</span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 12px 4px 6px',
                backgroundColor: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '9999px',
              }}
            >
              <div
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  backgroundColor: '#e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 600,
                  fontSize: '11px',
                  color: '#334155',
                }}
              >
                {currentUser.username.charAt(0).toUpperCase()}
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}>{currentUser.username}</span>
            </div>

            <button
              onClick={handleLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: '10px',
                padding: '6px 12px',
                fontSize: '12.5px',
                fontWeight: 600,
                color: '#475569',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#fef2f2'
                e.currentTarget.style.borderColor = '#fecaca'
                e.currentTarget.style.color = '#dc2626'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#ffffff'
                e.currentTarget.style.borderColor = '#cbd5e1'
                e.currentTarget.style.color = '#475569'
              }}
            >
              <LogOut size={14} />
              <span>Sign Out</span>
            </button>
          </div>
        </header>

        {/* Main Content Area: Sidebar + Viewport */}
        <div className="platform-body">
          {/* Sidebar on Left */}
          <aside className="platform-sidebar">
            <div className={`sidebar-nav-container ${activeCategory ? 'view-secondary' : ''}`}>
              {/* PANE 1: Main Menu */}
              <div className="sidebar-pane">
                <div style={{ padding: '4px 8px 12px 8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94a3b8' }}>
                    Main Menu
                  </span>
                </div>

                <button
                  onClick={() => {
                    setActiveCategory(null)
                    setActiveMainView('dashboard')
                  }}
                  className={`sidebar-item-btn ${isDashboard ? 'active' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '8px',
                        backgroundColor: isDashboard ? '#dbeafe' : '#f1f5f9',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: isDashboard ? '#1d4ed8' : '#475569',
                      }}
                    >
                      <LayoutDashboard size={16} />
                    </div>
                    <span style={{ fontSize: '13.5px' }}>Dashboard</span>
                  </div>
                  <span
                    style={{
                      fontSize: '10.5px',
                      fontWeight: 600,
                      color: isDashboard ? '#1d4ed8' : '#64748b',
                      backgroundColor: isDashboard ? '#ffffff' : '#f1f5f9',
                      padding: '1px 6px',
                      borderRadius: '6px',
                    }}
                  >
                    Overview
                  </span>
                </button>

                {MENU_CATEGORIES.map((category) => {
                  const CategoryIcon = category.icon
                  const isSelected = activeCategory?.id === category.id
                  return (
                    <button
                      key={category.id}
                      onClick={() => {
                        setActiveCategory(category)
                        setActiveMainView('category')
                        setActiveSubmenuId(category.items[0].id)
                      }}
                      className={`sidebar-item-btn ${isSelected ? 'active' : ''}`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '8px',
                            backgroundColor: isSelected ? '#dbeafe' : '#f1f5f9',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: isSelected ? '#1d4ed8' : '#475569',
                          }}
                        >
                          <CategoryIcon size={16} />
                        </div>
                        <span style={{ fontSize: '13.5px' }}>{category.label}</span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {category.badge && (
                          <span
                            style={{
                              fontSize: '10.5px',
                              fontWeight: 600,
                              color: isSelected ? '#1d4ed8' : '#64748b',
                              backgroundColor: isSelected ? '#ffffff' : '#f1f5f9',
                              padding: '1px 6px',
                              borderRadius: '6px',
                            }}
                          >
                            {category.badge}
                          </span>
                        )}
                        <ChevronRight size={15} color={isSelected ? '#1d4ed8' : '#94a3b8'} />
                      </div>
                    </button>
                  )
                })}

                <div
                  style={{
                    marginTop: 'auto',
                    padding: '14px',
                    backgroundColor: '#f8fafc',
                    borderRadius: '12px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <Globe size={14} color="#2563eb" />
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#0f172a' }}>Cloudflare Zone</span>
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#64748b', wordBreak: 'break-all' }}>
                    <code>{tenantRootDomain}</code> (TLS 1.3)
                  </div>
                </div>
              </div>

              {/* PANE 2: Secondary Menu */}
              <div className="sidebar-pane">
                <button
                  onClick={() => {
                    setActiveCategory(null)
                    setActiveMainView('dashboard')
                  }}
                  className="sidebar-back-btn"
                >
                  <ArrowLeft size={14} />
                  <span>Back to Main Menu</span>
                </button>

                {activeCategory && (
                  <div style={{ padding: '2px 8px 12px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        style={{
                          width: '22px',
                          height: '22px',
                          borderRadius: '6px',
                          backgroundColor: '#eff6ff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#2563eb',
                        }}
                      >
                        <activeCategory.icon size={13} />
                      </div>
                      <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#0f172a' }}>
                        {activeCategory.label}
                      </span>
                    </div>
                  </div>
                )}

                {activeCategory?.items.map((item) => {
                  const ItemIcon = item.icon
                  const isActive = activeSubmenuId === item.id && activeMainView === 'category'
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setActiveSubmenuId(item.id)
                        setActiveMainView('category')
                      }}
                      className={`sidebar-item-btn ${isActive ? 'active' : ''}`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <ItemIcon size={15} color={isActive ? '#1d4ed8' : '#64748b'} />
                        <span>{item.label}</span>
                      </div>
                      {item.badge && (
                        <span
                          style={{
                            fontSize: '10.5px',
                            fontWeight: 600,
                            color: isActive ? '#1d4ed8' : '#64748b',
                            backgroundColor: isActive ? '#dbeafe' : '#f1f5f9',
                            padding: '1px 6px',
                            borderRadius: '6px',
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </aside>

          {/* Viewport: Dynamic Container Area */}
          <main className="platform-viewport" key={isDashboard ? 'dashboard' : `${currentCategory.id}-${currentSubmenu.id}`}>
            {/* ---------------------------------------------------- */}
            {/* VIEW 1: MAIN MENU DASHBOARD                          */}
            {/* ---------------------------------------------------- */}
            {isDashboard && (
              <div className="viewport-animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Main Menu
                      </span>
                      <span style={{ color: '#cbd5e1' }}>/</span>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>Dashboard</span>
                    </div>
                    <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.02em', margin: 0 }}>
                      Platform Command Center
                    </h1>
                    <p style={{ fontSize: '13.5px', color: '#64748b', marginTop: '4px' }}>
                      Real-time telemetry, Cloudflare DNS routing, and core service status for <code>{tenantRootDomain}</code>.
                    </p>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      onClick={() => {
                        fetchAuditLogs()
                        fetchCloudflareSubdomains()
                        fetchHardwareTelemetry()
                        fetchServicesTelemetry()
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        backgroundColor: '#ffffff',
                        border: '1px solid #cbd5e1',
                        borderRadius: '10px',
                        padding: '8px 14px',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#334155',
                        cursor: 'pointer',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                      }}
                    >
                      <RefreshCw size={14} />
                      <span>Refresh All</span>
                    </button>
                  </div>
                </div>

                {/* KPI Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
                  <div
                    onClick={() => {
                      setActiveCategory(MENU_CATEGORIES[0])
                      setActiveSubmenuId('subdomains')
                      setActiveMainView('category')
                    }}
                    className="dynamic-card"
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>Cloudflare Subdomains</span>
                      <Globe size={18} color="#2563eb" />
                    </div>
                    <div style={{ fontSize: '26px', fontWeight: 700, color: '#0f172a' }}>
                      {dnsRecords.length > 0 ? `${dnsRecords.length} Active` : '3 Records'}
                    </div>
                    <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <CheckCircle2 size={12} />
                      <span>Live sync via Cloudflare SDK</span>
                    </div>
                  </div>

                  <div
                    onClick={() => {
                      setActiveCategory(MENU_CATEGORIES[2])
                      setActiveSubmenuId('services')
                      setActiveMainView('category')
                    }}
                    className="dynamic-card"
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>Active Services</span>
                      <Server size={18} color="#2563eb" />
                    </div>
                    <div style={{ fontSize: '26px', fontWeight: 700, color: '#0f172a' }}>
                      {servicesList.length} Online
                    </div>
                    <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Activity size={12} />
                      <span>{servicesSummary?.totalMemoryGb || '1.8'} GB RAM • {servicesSummary?.totalCpuPercent || '2.4'}% CPU</span>
                    </div>
                  </div>

                  <div
                    onClick={() => {
                      setActiveCategory(MENU_CATEGORIES[2])
                      setActiveSubmenuId('hardware')
                      setActiveMainView('category')
                    }}
                    className="dynamic-card"
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>Host Hardware</span>
                      <Cpu size={18} color="#2563eb" />
                    </div>
                    <div style={{ fontSize: '26px', fontWeight: 700, color: '#0f172a' }}>
                      {hardwareData ? `${hardwareData.cpu.cores} Cores • ${hardwareData.memory.totalGB} GB` : '12 Cores • 31.3 GB'}
                    </div>
                    <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <CheckCircle2 size={12} />
                      <span>RAM: {hardwareData?.memory.usedPercent || 28}% | NVMe: {hardwareData?.storage.usedPercent || 3}%</span>
                    </div>
                  </div>

                  <div
                    onClick={() => {
                      setActiveCategory(MENU_CATEGORIES[0])
                      setActiveSubmenuId('audit_logs')
                      setActiveMainView('category')
                    }}
                    className="dynamic-card"
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>Audit Events</span>
                      <FileText size={18} color="#059669" />
                    </div>
                    <div style={{ fontSize: '26px', fontWeight: 700, color: '#0f172a' }}>
                      {auditLogs.length} Events
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                      Synced with <code>platform.platform_audit</code>
                    </div>
                  </div>
                </div>

                {/* Subdomains Overview in Dashboard */}
                <div className="dynamic-card" style={{ padding: '24px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <div>
                      <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#0f172a' }}>Live Subdomains under {tenantRootDomain}</h3>
                      <p style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>
                        Direct Cloudflare SDK integration query
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setActiveCategory(MENU_CATEGORIES[0])
                        setActiveSubmenuId('subdomains')
                        setActiveMainView('category')
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        backgroundColor: '#eff6ff',
                        color: '#1d4ed8',
                        border: '1px solid #bfdbfe',
                        padding: '6px 12px',
                        borderRadius: '8px',
                        fontSize: '12.5px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <span>Manage All Subdomains</span>
                      <ArrowRight size={14} />
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
                    {dnsRecords.map((rec) => (
                      <div
                        key={rec.id}
                        style={{
                          padding: '14px 16px',
                          borderRadius: '12px',
                          backgroundColor: '#f8fafc',
                          border: '1px solid #e2e8f0',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <span style={{ fontWeight: 700, fontSize: '14px', color: '#0f172a' }}>{rec.name}</span>
                          <span style={{ fontSize: '10.5px', fontWeight: 700, color: '#2563eb', backgroundColor: '#dbeafe', padding: '2px 6px', borderRadius: '4px' }}>
                            {rec.type}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: '8px' }}>
                          {rec.content}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px' }}>
                          <span style={{ color: rec.proxied ? '#ea580c' : '#64748b', fontWeight: 600 }}>
                            {rec.proxied ? '☁ Proxied' : 'DNS Only'}
                          </span>
                          <span style={{ color: '#94a3b8' }}>TTL: {rec.ttl === 1 ? 'Auto' : `${rec.ttl}s`}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ---------------------------------------------------- */}
            {/* VIEW 2: CATEGORY VIEWPORT (SINGLE INTEGRATED HEADER)  */}
            {/* ---------------------------------------------------- */}
            {!isDashboard && (
              <div className="viewport-animate-in" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* 1. PLATFORM > SUBDOMAINS */}
                {activeCategory?.id === 'tenant' && activeSubmenuId === 'list' && renderTenantListBody()}

                {activeCategory?.id === 'platform' && activeSubmenuId === 'subdomains' && renderSubdomainBody(false)}

                {/* 2. TENANT > SUBDOMAIN */}
                {activeCategory?.id === 'tenant' && activeSubmenuId === 'subdomain' && renderSubdomainBody(true)}

                {/* 3. SYSTEM > HARDWARE */}
                {activeCategory?.id === 'system' && activeSubmenuId === 'hardware' && renderHardwareBody()}

                {/* 4. SYSTEM > SERVICES */}
                {activeCategory?.id === 'system' && activeSubmenuId === 'services' && renderServicesBody()}

                {/* 5. PLATFORM > APIS */}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'apis' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div
                      style={{
                        padding: '18px 22px',
                        borderRadius: '16px',
                        backgroundColor: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '14px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                        <div
                          style={{
                            width: '42px',
                            height: '42px',
                            borderRadius: '12px',
                            backgroundColor: '#2563eb',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#ffffff',
                            boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
                          }}
                        >
                          <KeyRound size={22} />
                        </div>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                            <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              Platform / APIs
                            </span>
                            <span style={{ color: '#93c5fd' }}>•</span>
                            <span style={{ fontSize: '11px', fontWeight: 700, backgroundColor: '#dcfce7', color: '#166534', padding: '1px 7px', borderRadius: '9999px' }}>
                              v1.4 Gateway
                            </span>
                          </div>
                          <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                            Registered Platform API Endpoints
                          </h1>
                          <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
                            Backend routes, authentication contracts & rate limits
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="dynamic-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div style={{ width: '100%', overflowX: 'auto' }}>
                        <table style={{ width: '100%', minWidth: '600px', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                              <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Method</th>
                              <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Endpoint</th>
                              <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Description</th>
                              <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Auth</th>
                              <th style={{ padding: '12px 20px', fontWeight: 600, color: '#475569' }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#dbeafe', color: '#1e40af', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>GET</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/system/services</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Live non-OS active services, ports & memory/CPU</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Session</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#dbeafe', color: '#1e40af', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>GET</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/system/hardware</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Live CPU, RAM, NVMe & kernel host telemetry</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Session</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#dbeafe', color: '#1e40af', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>GET</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/cloudflare/subdomains</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Cloudflare SDK live DNS records query</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Session</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#dcfce7', color: '#166534', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>POST</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/cloudflare/subdomains</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Reserve a managed {tenantRootDomain} subdomain</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Owner + CSRF</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#fee2e2', color: '#991b1b', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>DELETE</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/cloudflare/subdomains</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Delete a record owned by this platform tunnel</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Owner + CSRF</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '14px 20px' }}><span style={{ backgroundColor: '#dcfce7', color: '#166534', fontWeight: 700, padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>POST</span></td>
                              <td style={{ padding: '14px 20px', fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' }}>/api/auth/login</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>PostgreSQL crypt validation & session creation</td>
                              <td style={{ padding: '14px 20px', color: '#64748b' }}>Public</td>
                              <td style={{ padding: '14px 20px' }}><span style={{ color: '#16a34a', fontWeight: 600 }}>200 OK</span></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}


                {/* 7. PLATFORM > AUDIT LOGS, CONFIGURATION, PLANS, OPERATORS, SECURITY */}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'audit_logs' && <AuditView api={adminApi} />}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'configuration' && <ConfigurationView api={adminApi} isOwner={currentUser?.role === 'platform_owner'} />}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'plans' && <PlansView api={adminApi} canEdit={currentUser?.role === 'platform_owner'} />}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'operators' && (
                  currentUser?.role === 'platform_owner'
                    ? <OperatorsView api={adminApi} currentUserId={currentUser.id} />
                    : <div className="admin-notice admin-notice-warning">Only platform owners can manage operators.</div>
                )}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'security' && <SecurityView api={adminApi} mfaRecent={mfaRecent} />}
                {activeCategory?.id === 'platform' && activeSubmenuId === 'consumers' && <ConsumersView api={adminApi} />}

                {/* 8. TENANT > MANAGE & FLEET */}
                {activeCategory?.id === 'tenant' && activeSubmenuId === 'manage' && <TenantManageView key={manageTenantKey ?? 'none'} api={adminApi} initialTenantKey={manageTenantKey} />}
                {activeCategory?.id === 'tenant' && activeSubmenuId === 'fleet' && (
                  <FleetView api={adminApi} onOpenTenant={(tenantKey) => { setManageTenantKey(tenantKey); setActiveSubmenuId('manage') }} />
                )}

                {/* 9. TENANT > NEW & EDIT */}
                {activeCategory?.id === 'tenant' && activeSubmenuId === 'new' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div
                      style={{
                        padding: '18px 22px',
                        borderRadius: '16px',
                        backgroundColor: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '14px',
                      }}
                    >
                      <div
                        style={{
                          width: '42px',
                          height: '42px',
                          borderRadius: '12px',
                          backgroundColor: '#2563eb',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#ffffff',
                          boxShadow: '0 4px 10px rgba(37, 99, 235, 0.25)',
                        }}
                      >
                        <PlusCircle size={22} />
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            Tenant / New
                          </span>
                        </div>
                        <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#1e3a8a', margin: 0 }}>
                          Provision New Tenant Workspace
                        </h1>
                        <div style={{ fontSize: '12.5px', color: '#3b82f6', marginTop: '2px' }}>
                          Creates an immutable tenant identity, isolated database boundary, and hostname route
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '8px' }}>
                      {['Tenant Details', 'Branding', 'Subdomain', 'Review', 'Provisioning', 'Activation'].map((label, index) => {
                        const activeIndex = provisioningJob ? (provisioningJob.status === 'succeeded' ? 5 : 4) : 0
                        const completed = index < activeIndex
                        const active = index === activeIndex
                        return (
                          <div key={label} style={{ minHeight: '48px', padding: '8px 10px', borderTop: `3px solid ${completed ? '#16a34a' : active ? '#2563eb' : '#cbd5e1'}`, background: active ? '#eff6ff' : '#ffffff' }}>
                            <div style={{ fontSize: '10px', color: '#64748b' }}>0{index + 1}</div>
                            <div style={{ fontSize: '11px', fontWeight: 650, color: active ? '#1d4ed8' : '#334155' }}>{label}</div>
                          </div>
                        )
                      })}
                    </div>

                    {!provisioningJob ? (
                      <form onSubmit={handleCreateTenant} style={{ display: 'flex', flexDirection: 'column', gap: '22px', maxWidth: '920px' }}>
                        <section>
                          <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: '#0f172a' }}>Tenant Details</h2>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px' }}>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Display name
                              <input required name="displayName" maxLength={160} placeholder="Acme Corporation" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Legal name
                              <input name="legalName" maxLength={240} placeholder="Acme Corporation Limited" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                          </div>
                        </section>

                        <section>
                          <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: '#0f172a' }}>Branding</h2>
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '14px' }}>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Logo URL
                              <input name="logoUrl" type="url" placeholder="https://cdn.example.com/logo.png" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Primary color
                              <input name="primaryColor" type="color" defaultValue="#2563eb" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Secondary color
                              <input name="secondaryColor" type="color" defaultValue="#0f172a" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '14px', marginTop: '14px' }}>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Login message
                              <input name="loginMessage" maxLength={300} placeholder="Sign in with your corporate credentials." style={{ width: '100%', height: '42px', marginTop: '6px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px' }} />
                            </label>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                              Locale
                              <select name="locale" defaultValue="en" style={{ width: '100%', height: '42px', marginTop: '6px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff' }}>
                                <option value="en">English</option>
                                <option value="de">German</option>
                                <option value="fr">French</option>
                              </select>
                            </label>
                          </div>
                        </section>

                        <section>
                          <h2 style={{ fontSize: '16px', margin: '0 0 12px', color: '#0f172a' }}>Subdomain</h2>
                          <label style={{ fontSize: '12px', fontWeight: 600, color: '#334155', display: 'block', maxWidth: '520px' }}>
                            {tenantRootDomain} address
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', marginTop: '6px' }}>
                              <input required name="subdomain" minLength={2} maxLength={63} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" placeholder="acme" onInput={(event) => { event.currentTarget.value = event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }} style={{ width: '100%', height: '42px', padding: '0 12px', border: '1px solid #cbd5e1', borderRadius: '6px 0 0 6px' }} />
                              <span style={{ height: '42px', display: 'grid', placeItems: 'center', padding: '0 12px', background: '#f1f5f9', border: '1px solid #cbd5e1', borderLeft: 0, borderRadius: '0 6px 6px 0', color: '#475569', fontSize: '13px' }}>.{tenantRootDomain}</span>
                            </div>
                          </label>
                        </section>

                        <section style={{ paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
                          <h2 style={{ fontSize: '16px', margin: '0 0 6px', color: '#0f172a' }}>Onboarding (optional)</h2>
                          <p style={{ fontSize: '12.5px', color: '#64748b', margin: '0 0 12px' }}>
                            The owner receives a single-use link to set up their account once the tenant is active. You can also invite them later from Tenant / Manage.
                          </p>
                          <div className="admin-form-grid">
                            <label className="admin-field"><span className="admin-field-label">Owner name</span><input className="admin-input" name="ownerName" maxLength={255} placeholder="Jane Doe" /></label>
                            <label className="admin-field"><span className="admin-field-label">Owner email</span><input className="admin-input" name="ownerEmail" type="email" placeholder="jane@acme.com" /></label>
                            <label className="admin-field"><span className="admin-field-label">Plan code</span><input className="admin-input" name="planCode" pattern="[a-z][a-z0-9_]{1,62}" placeholder="standard" /></label>
                            <label className="admin-field">
                              <span className="admin-field-label">Connection tier</span>
                              <select className="admin-input" name="connectionTier" defaultValue="">
                                <option value="">Platform/plan default</option>
                                <option value="dedicated">Dedicated — own database login</option>
                                <option value="pooled">Pooled — shared login, for many small tenants</option>
                              </select>
                            </label>
                          </div>
                        </section>

                        <section style={{ paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
                          <h2 style={{ fontSize: '16px', margin: '0 0 6px', color: '#0f172a' }}>Review</h2>
                          <p style={{ fontSize: '12.5px', color: '#64748b', margin: '0 0 14px' }}>
                            The immutable tenant ID, PostgreSQL role, and schema name are generated by the server. Customer-entered names are never used as database identifiers.
                          </p>
                          {provisioningError && <div style={{ padding: '10px 12px', marginBottom: '12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12.5px' }}>{provisioningError}</div>}
                          <button type="submit" disabled={creatingTenant} style={{ height: '42px', padding: '0 18px', display: 'inline-flex', alignItems: 'center', gap: '8px', border: 0, borderRadius: '6px', background: creatingTenant ? '#94a3b8' : '#2563eb', color: '#fff', fontWeight: 650, cursor: creatingTenant ? 'wait' : 'pointer' }}>
                            {creatingTenant ? <RefreshCw size={16} className="spin" /> : <ShieldCheck size={16} />}
                            {creatingTenant ? 'Starting provisioning...' : 'Create Secure Tenant'}
                          </button>
                        </section>
                      </form>
                    ) : (
                      <section style={{ maxWidth: '820px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: '16px', marginBottom: '18px' }}>
                          <div>
                            <h2 style={{ fontSize: '18px', margin: '0 0 4px', color: '#0f172a' }}>Creating {provisioningJob.displayName}</h2>
                            <div style={{ fontSize: '12.5px', color: '#64748b' }}>{provisioningJob.hostname} · Correlation {provisioningJob.correlationId}</div>
                          </div>
                          <span style={{ padding: '5px 9px', borderRadius: '6px', background: provisioningJob.status === 'succeeded' ? '#dcfce7' : provisioningJob.status === 'failed' ? '#fee2e2' : '#dbeafe', color: provisioningJob.status === 'succeeded' ? '#166534' : provisioningJob.status === 'failed' ? '#991b1b' : '#1d4ed8', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' }}>{provisioningJob.status}</span>
                        </div>
                        <div style={{ borderTop: '1px solid #e2e8f0' }}>
                          {provisioningJob.steps.map((step) => (
                            <div key={step.stepCode} style={{ minHeight: '44px', display: 'grid', gridTemplateColumns: '24px 1fr auto', alignItems: 'center', gap: '10px', borderBottom: '1px solid #e2e8f0' }}>
                              {step.status === 'succeeded' ? <CheckCircle2 size={17} color="#16a34a" /> : step.status === 'running' ? <RefreshCw size={17} color="#2563eb" className="spin" /> : step.status === 'failed' ? <AlertTriangle size={17} color="#dc2626" /> : <Clock size={17} color="#94a3b8" />}
                              <span style={{ fontSize: '13px', color: step.status === 'pending' ? '#64748b' : '#0f172a', fontWeight: step.status === 'running' ? 650 : 500 }}>{step.message}</span>
                              <span style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase' }}>{step.status}</span>
                            </div>
                          ))}
                        </div>
                        {ownerInvitation && <div style={{ marginTop: '14px' }}><OneTimeLink label="Owner invitation link (usable once the tenant is active)" link={ownerInvitation.link} delivered={ownerInvitation.delivered} /></div>}
                        {(provisioningJob.errorMessage || provisioningError) && <div style={{ marginTop: '14px', padding: '10px 12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12.5px' }}>{provisioningJob.errorMessage || provisioningError}</div>}
                        <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
                          {provisioningJob.status === 'failed' && provisioningJob.retryable && <button type="button" onClick={handleRetryProvisioning} style={{ height: '38px', padding: '0 14px', border: 0, borderRadius: '6px', background: '#2563eb', color: '#fff', fontWeight: 650, cursor: 'pointer' }}><RefreshCw size={14} style={{ marginRight: '7px', verticalAlign: 'middle' }} />Retry</button>}
                          {provisioningJob.status === 'succeeded' && <a href={`https://${provisioningJob.hostname}`} target="_blank" rel="noreferrer" style={{ height: '38px', padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: '7px', borderRadius: '6px', background: '#166534', color: '#fff', fontWeight: 650, textDecoration: 'none', fontSize: '13px' }}>Open Tenant <ExternalLink size={14} /></a>}
                          {['succeeded', 'failed'].includes(provisioningJob.status) && <button type="button" onClick={() => { setProvisioningJob(null); setProvisioningError(null); setOwnerInvitation(null) }} style={{ height: '38px', padding: '0 14px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', color: '#334155', fontWeight: 600, cursor: 'pointer' }}>New Tenant</button>}
                        </div>
                      </section>
                    )}
                  </div>
                )}

              </div>
            )}
          </main>
        </div>
      </div>
    )
  }

  // ==========================================
  // LOGIN SCREEN
  // ==========================================
  return (
    <div className="login-page-bg" data-build-revision={UI_BUILD_REVISION}>
      <div style={styles.loginCard}>
        <div style={styles.header}>
          <div style={styles.logoBadge}>
            <ShieldCheck size={24} color="#0f172a" />
          </div>
          <div style={styles.titleRow}>
            <h1 style={styles.title}>{productName}</h1>
            <span style={styles.pillBadge}>Platform</span>
          </div>
          <p style={styles.subtitle}>Sign in with your administrator credentials</p>
        </div>

        {errorMsg && (
          <div style={styles.errorBanner}>
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.fieldGroup}>
            <label htmlFor="platform-login-username" style={styles.label}>Username</label>
            <div style={styles.inputWrapper}>
              <User size={18} style={styles.inputIcon} />
              <input
                id="platform-login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                autoComplete="username"
                style={styles.input}
              />
            </div>
          </div>

          <div style={styles.fieldGroup}>
            <label htmlFor="platform-login-password" style={styles.label}>Password</label>
            <div style={styles.inputWrapper}>
              <Lock size={18} style={styles.inputIcon} />
              <input
                id="platform-login-password"
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

const styles: Record<string, React.CSSProperties> = {
  loginCard: {
    width: '100%',
    maxWidth: '430px',
    backgroundColor: '#fafbfc',
    borderRadius: '24px',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 30px 70px -15px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 28px -8px rgba(0, 0, 0, 0.5)',
    padding: '38px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '22px',
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
    backgroundColor: '#f1f5f9',
    border: '1px solid #e2e8f0',
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
    color: '#475569',
    backgroundColor: '#e2e8f0',
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
    gap: '16px',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
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
    transition: 'color 0.15s',
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

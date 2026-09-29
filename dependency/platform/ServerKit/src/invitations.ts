import crypto from 'node:crypto'
import { createOpaqueToken, hashToken } from './security.js'

/**
 * Invitation tokens carry a short type prefix so one accept endpoint can route
 * them without a database probe: `own_` = platform-issued tenant owner
 * invitation, `inv_` = tenant-issued user invitation, `opr_` = platform
 * operator invitation.
 */
export type InvitationKind = 'owner' | 'user' | 'operator'

const prefixes: Record<InvitationKind, string> = { owner: 'own_', user: 'inv_', operator: 'opr_' }
const tokenPattern = /^(own|inv|opr)_[A-Za-z0-9_-]{43}$/

export function createInvitationToken(kind: InvitationKind): { token: string; tokenHash: string } {
  const token = `${prefixes[kind]}${createOpaqueToken(32)}`
  return { token, tokenHash: hashToken(token) }
}

export function parseInvitationToken(token: unknown): { kind: InvitationKind; tokenHash: string } | null {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null
  const kind: InvitationKind = token.startsWith('own_') ? 'owner' : token.startsWith('inv_') ? 'user' : 'operator'
  return { kind, tokenHash: hashToken(token) }
}

/**
 * Builds the accept link. The token travels in the URL fragment, which
 * browsers never send to the server, so it stays out of access logs, proxies,
 * and Referer headers. The accept page reads it and POSTs it.
 */
export function invitationLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/accept-invite#token=${encodeURIComponent(token)}`
}

export type NotificationMessage = {
  type: 'tenant_owner_invitation' | 'tenant_user_invitation' | 'platform_operator_invitation'
  to: string
  subject: string
  link: string
  context: Record<string, string>
}

export type NotificationResult = { delivered: boolean; channel: 'webhook' | 'none'; error?: string }

/**
 * Pluggable delivery. With NOTIFICATION_WEBHOOK_URL set, messages are POSTed as
 * JSON with an HMAC-SHA256 signature (X-Signature: sha256=<hex> over the raw
 * body, keyed by NOTIFICATION_WEBHOOK_SECRET) to a relay that owns email/SMS
 * delivery. Without it, nothing is sent and callers show the link once to the
 * operator who issued it.
 */
export class NotificationSender {
  constructor(
    private readonly webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL || '',
    private readonly webhookSecret = process.env.NOTIFICATION_WEBHOOK_SECRET || '',
  ) {
    if (this.webhookUrl && !this.webhookUrl.startsWith('https://') && process.env.NODE_ENV === 'production') {
      throw new Error('NOTIFICATION_WEBHOOK_URL must use https in production.')
    }
    if (this.webhookUrl && !this.webhookSecret) {
      throw new Error('NOTIFICATION_WEBHOOK_SECRET is required when NOTIFICATION_WEBHOOK_URL is set.')
    }
  }

  get enabled(): boolean {
    return Boolean(this.webhookUrl)
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.webhookUrl) return { delivered: false, channel: 'none' }
    const body = JSON.stringify({ ...message, sentAt: new Date().toISOString() })
    const signature = crypto.createHmac('sha256', this.webhookSecret).update(body).digest('hex')
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(8_000),
      })
      return response.ok
        ? { delivered: true, channel: 'webhook' }
        : { delivered: false, channel: 'webhook', error: `HTTP ${response.status}` }
    } catch (error) {
      return { delivered: false, channel: 'webhook', error: error instanceof Error ? error.message : 'delivery failed' }
    }
  }
}

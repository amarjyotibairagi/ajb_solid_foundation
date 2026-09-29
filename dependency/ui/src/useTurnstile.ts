import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string
          action?: string
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

export const PRODUCTION_TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
/**
 * Set at build time (VITE_LOGIN_CHALLENGE=none) only for deployments that run
 * without Cloudflare Turnstile. The servers must be configured the same way
 * (LOGIN_CHALLENGE=none) or they reject the placeholder token.
 */
export const LOGIN_CHALLENGE_DISABLED = import.meta.env.VITE_LOGIN_CHALLENGE === 'none'
export const DISABLED_CHALLENGE_TOKEN = 'login-challenge-disabled-by-configuration'

/**
 * Renders and manages a Cloudflare Turnstile widget's lifecycle: polls for
 * the script to be ready, renders once, tracks verified/collapsed/badge
 * state through the same timed reveal sequence, and exposes a reset for
 * post-submit re-arming. `enabled` should be false while a session check is
 * still pending or a user is already signed in, matching how each login
 * screen only needs the widget while its own login gate is showing.
 */
export function useTurnstile({ enabled, onError }: { enabled: boolean; onError: (message: string | null) => void }) {
  const [isVerified, setIsVerified] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isBadgeVisible, setIsBadgeVisible] = useState(false)
  const turnstileContainerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    let interval: number | undefined
    let collapseTimer: ReturnType<typeof setTimeout> | undefined
    let badgeTimer: ReturnType<typeof setTimeout> | undefined

    const initTurnstile = () => {
      if (LOGIN_CHALLENGE_DISABLED) {
        setIsVerified(true)
        setTurnstileToken(DISABLED_CHALLENGE_TOKEN)
        if (interval) clearInterval(interval)
        return
      }
      if (window.turnstile && turnstileContainerRef.current && !widgetIdRef.current && PRODUCTION_TURNSTILE_SITE_KEY) {
        try {
          widgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
            sitekey: PRODUCTION_TURNSTILE_SITE_KEY,
            action: 'login',
            theme: 'light',
            size: 'flexible',
            callback: (token: string) => {
              setIsVerified(true)
              setTurnstileToken(token)
              onError(null)
              collapseTimer = setTimeout(() => {
                setIsCollapsed(true)
                badgeTimer = setTimeout(() => {
                  setIsBadgeVisible(true)
                }, 600)
              }, 400)
            },
            'error-callback': () => {
              setIsVerified(false)
              setTurnstileToken(null)
              setIsCollapsed(false)
              setIsBadgeVisible(false)
              onError('Verification failed. Please retry.')
            },
            'expired-callback': () => {
              setIsVerified(false)
              setTurnstileToken(null)
              setIsCollapsed(false)
              setIsBadgeVisible(false)
            },
          })
          if (interval) clearInterval(interval)
        } catch {
          setIsVerified(false)
          setTurnstileToken(null)
          setIsCollapsed(false)
          setIsBadgeVisible(false)
          onError('Security verification could not be initialized.')
        }
      } else if (!PRODUCTION_TURNSTILE_SITE_KEY && import.meta.env.DEV) {
        setIsVerified(true)
        setTurnstileToken('dev-token')
      } else if (!PRODUCTION_TURNSTILE_SITE_KEY) {
        onError('Security verification is not configured.')
      }
    }

    interval = window.setInterval(initTurnstile, 250)
    initTurnstile()

    return () => {
      if (interval) clearInterval(interval)
      if (collapseTimer) clearTimeout(collapseTimer)
      if (badgeTimer) clearTimeout(badgeTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const resetTurnstile = () => {
    if (LOGIN_CHALLENGE_DISABLED) return
    setIsVerified(false)
    setTurnstileToken(null)
    setIsCollapsed(false)
    setIsBadgeVisible(false)
    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current)
      } catch {
        // ignore
      }
    }
  }

  return { isVerified, turnstileToken, isCollapsed, isBadgeVisible, turnstileContainerRef, resetTurnstile }
}

import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

// Targets come from the environment: PLATFORM_PUBLIC_ORIGIN,
// PUBLIC_PUBLIC_ORIGIN and VISUAL_CHECK_TENANT_HOSTS (comma-separated tenant
// hostnames). Set VISUAL_CHECK_NO_TURNSTILE=true for LOGIN_CHALLENGE=none.
const setting = (name) => process.env[name] || ''
const apps = [
  { name: 'platform', url: setting('PLATFORM_PUBLIC_ORIGIN'), expectsTurnstile: process.env.VISUAL_CHECK_NO_TURNSTILE !== 'true' },
  { name: 'public', url: setting('PUBLIC_PUBLIC_ORIGIN'), expectsTurnstile: process.env.VISUAL_CHECK_NO_TURNSTILE !== 'true' },
  ...setting('VISUAL_CHECK_TENANT_HOSTS').split(',').map((host) => host.trim()).filter(Boolean)
    .map((host) => ({ name: host.split('.')[0], url: `https://${host}`, expectsTurnstile: process.env.VISUAL_CHECK_NO_TURNSTILE !== 'true' })),
].filter((app) => app.url)
if (!apps.length) throw new Error('Set PLATFORM_PUBLIC_ORIGIN, PUBLIC_PUBLIC_ORIGIN and/or VISUAL_CHECK_TENANT_HOSTS.')

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

const outputDirectory = '/tmp/platform-visual'
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({ headless: true })
const results = []

for (const app of apps) {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport })
    const errors = []
    const challengeHttpErrors = []
    page.on('console', (message) => {
      const expectedHeadlessChallengeMessage = message.text().startsWith('Failed to load resource: the server responded with a status of 401')
      if (
        message.type() === 'error' &&
        !message.text().includes('font-size:0;color:transparent') &&
        !expectedHeadlessChallengeMessage
      ) {
        errors.push(`console: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
    page.on('response', (response) => {
      if (response.url().includes('challenges.cloudflare.com') && response.status() >= 400) {
        challengeHttpErrors.push(response.status())
      }
    })

    const response = await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(5_000)
    await page.screenshot({ path: `${outputDirectory}/${app.name}-${viewport.name}.png`, fullPage: true })

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      heading: document.querySelector('h1')?.textContent ?? '',
      text: document.body.innerText,
    }))
    const turnstileFrames = page.frames().filter((frame) => frame.url().includes('challenges.cloudflare.com')).length
    if (response?.status() !== 200) errors.push(`page returned HTTP ${response?.status() ?? 'unknown'}`)
    if (layout.bodyWidth > layout.viewportWidth || layout.documentWidth > layout.viewportWidth) {
      errors.push('page has horizontal overflow')
    }
    if (app.expectsTurnstile && turnstileFrames === 0) errors.push('Turnstile frame was not rendered')
    if (layout.text.includes('Verification failed') && layout.text.includes('Security verification passed')) {
      errors.push('contradictory Turnstile state is visible')
    }

    results.push({
      app: app.name,
      viewport: viewport.name,
      status: response?.status(),
      title: await page.title(),
      heading: layout.heading,
      horizontalOverflow: Math.max(layout.bodyWidth, layout.documentWidth) > layout.viewportWidth,
      turnstileFrames,
      // A 401 from the optional browser Private Access Token probe is expected in headless Chromium.
      challengeHttpErrors,
      errors,
    })
    await page.close()
  }
}

await browser.close()
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.errors.length > 0)) process.exitCode = 1

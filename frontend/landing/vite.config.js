import { defineConfig, loadEnv } from 'vite'

// Brand values come from the build environment (setup.sh passes them from
// .env/setup.env). These defaults only apply to a bare `npm run build`.
const defaults = {
  VITE_BRAND_NAME: 'Your Platform',
  VITE_BRAND_TAGLINE: 'One platform for your organizations and people',
  VITE_BRAND_DESCRIPTION: 'Sign in to manage your workspace.',
  VITE_PLATFORM_URL: '/',
  VITE_PUBLIC_URL: '/',
  VITE_CONTACT_EMAIL: '',
}

export default defineConfig(({ mode }) => {
  const fromFiles = loadEnv(mode, process.cwd(), 'VITE_')
  for (const [key, fallback] of Object.entries(defaults)) {
    process.env[key] = process.env[key] || fromFiles[key] || fallback
  }
  return {
    server: { host: '127.0.0.1', port: 3651, strictPort: true },
    preview: { host: '127.0.0.1', port: 3651, strictPort: true },
  }
})

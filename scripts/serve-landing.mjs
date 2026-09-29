import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultHost = '127.0.0.1'
const defaultPort = Number(process.env.LANDING_PORT || process.env.PORT || 3651)
const defaultRoot = resolve(fileURLToPath(new URL('../frontend/landing/dist', import.meta.url)))

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function headers(pathname) {
  return {
    'Cache-Control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
}

export function createLandingServer(distRoot = defaultRoot) {
  return createServer(async (request, response) => {
    try {
      const method = request.method || 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }

      let pathname
      let decodedPath
      try {
        const url = new URL(request.url || '/', 'http://localhost')
        pathname = url.pathname
        decodedPath = decodeURIComponent(pathname)
      } catch {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad Request')
        return
      }

      if (pathname === '/api/health') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers(pathname) })
        response.end(method === 'HEAD' ? undefined : JSON.stringify({ success: true, status: 'ok' }))
        return
      }

      const candidate = resolve(distRoot, `.${decodedPath}`)
      let file = candidate.startsWith(`${distRoot}${sep}`) ? candidate : resolve(distRoot, 'index.html')
      try {
        const fileStat = await stat(file)
        if (!fileStat.isFile()) file = resolve(distRoot, 'index.html')
      } catch {
        file = resolve(distRoot, 'index.html')
      }

      response.writeHead(200, {
        'Content-Type': types[extname(file)] || 'application/octet-stream',
        ...headers(pathname),
      })

      if (method === 'HEAD') {
        response.end()
        return
      }

      const stream = createReadStream(file)
      stream.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal Server Error')
        } else {
          response.destroy()
        }
      })
      stream.pipe(response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal Server Error')
      } else {
        response.destroy()
      }
    }
  })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  createLandingServer().listen(defaultPort, defaultHost, () => {
    console.log(`Landing origin listening at http://${defaultHost}:${defaultPort}`)
  })
}


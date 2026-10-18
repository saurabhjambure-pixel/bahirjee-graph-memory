// The ONLY Vercel Function in this project.
//
// Vercel turns every file under /api into its own Function, and the Hobby plan allows
// 12 per deployment. (Automatic bundling into fewer functions only happens for Next.js
// and SvelteKit — this is a Vite app, so it does not apply.) Everything therefore lives
// in /lib and is dispatched from this single entrypoint; vercel.json rewrites /api/*
// to /api/router?route=* so each logical route keeps its own URL.
//
// Adding a route = add a file in lib/handlers/ and one line below. Do NOT add new files
// under /api — each one costs a function against the limit.

// Body parsing is owned by this file, not by Vercel.
//
// Vercel only reads a `config` export from files under /api, so a `bodyParser: false`
// in a lib/handlers/* file is silently ignored. Since `upload` needs the untouched
// multipart stream, the parser is disabled here and re-implemented below: JSON routes
// get req.body populated exactly as before, and multipart routes get their stream left
// alone so busboy can consume it.
export const config = {
  api: {
    bodyParser: false,
  },
}

const JSON_BODY_LIMIT = 2 * 1024 * 1024 // generous for JSON; multipart never takes this path

export function isMultipart(req) {
  return /^multipart\/form-data/i.test(req.headers?.['content-type'] || '')
}

/**
 * Populate `req.body` for non-multipart requests, mirroring Vercel's default parser.
 *
 * Multipart requests are skipped entirely — reading the stream here would leave busboy
 * with nothing to consume. Handlers that read `req.body` on a multipart route see `{}`.
 */
export async function parseRequestBody(req) {
  if (req.body !== undefined) return // already parsed (local proxy, or a re-entrant call)
  if (req.method === 'GET' || req.method === 'HEAD') return
  if (isMultipart(req)) {
    req.body = {}
    return
  }

  const raw = await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > JSON_BODY_LIMIT) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

  req.rawBody = raw
  if (raw.length === 0) {
    req.body = {}
    return
  }

  const contentType = req.headers?.['content-type'] || ''
  if (/application\/json/i.test(contentType) || raw[0] === 0x7b /* { */ || raw[0] === 0x5b /* [ */) {
    try {
      req.body = JSON.parse(raw.toString('utf8'))
      return
    } catch {
      req.body = {}
      return
    }
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    req.body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
    return
  }

  req.body = {}
}

const handlers = {
  gemini: () => import('../lib/handlers/gemini.js').then((mod) => mod.handler),
  claude: () => import('../lib/handlers/claude.js').then((mod) => mod.handler),
  groq: () => import('../lib/handlers/groq.js').then((mod) => mod.handler),
  sarvam: () => import('../lib/handlers/sarvam.js').then((mod) => mod.handler),
  jev: () => import('../lib/handlers/jev.js').then((mod) => mod.handler),
  scrape: () => import('../lib/handlers/scrape.js').then((mod) => mod.handler),
  search: () => import('../lib/handlers/search.js').then((mod) => mod.handler),
  exa: () => import('../lib/handlers/exa.js').then((mod) => mod.handler),
  connectors: () => import('../lib/handlers/connectors.js').then((mod) => mod.handler),
  intelligence: () => import('../lib/handlers/intelligence.js').then((mod) => mod.handler),
  'intelligence-worker': () => import('../lib/handlers/intelligence-worker.js').then((mod) => mod.handler),
  'intelligence-targets': () => import('../lib/handlers/intelligence-targets.js').then((mod) => mod.handler),
  'auth-link': () => import('../lib/handlers/auth-link.js').then((mod) => mod.handler),
  'brief-access': () => import('../lib/handlers/brief-access.js').then((mod) => mod.handler),
  report: () => import('../lib/handlers/report.js').then((mod) => mod.handler),
  'cron-runs': () => import('../lib/handlers/cron-runs.js').then((mod) => mod.handler),
  'cron-daily': () => import('../lib/handlers/cron-daily.js').then((mod) => mod.handler),
  graph: () => import('../lib/handlers/graph.js').then((mod) => mod.handler),
  upload: () => import('../lib/handlers/upload.js').then((mod) => mod.handler),
}

export async function resolveRouteHandler(route) {
  const loader = handlers[route]
  if (!loader) {
    return null
  }

  return loader()
}

/**
 * Work out which logical route was requested.
 *
 * The rewrite supplies `?route=<name>`, which is authoritative: after a rewrite `req.url`
 * can already read as `/api/router`, so the path is no longer reliable. Path parsing is
 * kept as a fallback for direct invocation and local dev.
 */
export function resolveRouteName(req) {
  const fromQuery = req.query?.route
  if (fromQuery) {
    return String(fromQuery).replace(/^\/+/, '').split('/')[0].split('?')[0]
  }

  const pathname = new URL(req.url, `https://${req.headers?.host || 'localhost'}`).pathname
  return pathname.replace(/^\/api\//, '').split('/')[0]
}

export default async function handler(req, res) {
  const route = resolveRouteName(req)

  // Guard against the rewrite resolving to this file itself.
  if (!route || route === 'router') {
    res.status(404).json({ error: 'Route not found' })
    return
  }

  const routeHandler = await resolveRouteHandler(route)

  if (!routeHandler) {
    res.status(404).json({ error: 'Route not found' })
    return
  }

  try {
    await parseRequestBody(req)
  } catch (error) {
    res.status(413).json({ error: error.message })
    return
  }

  return routeHandler(req, res)
}

/**
 * An in-process fake of PostgREST — enough of it for the real Supabase client to run the
 * pipeline's reads and writes in a test, so a test can pin a ROUND TRIP (what was written is
 * what reads back) instead of grepping for the code that should do it.
 *
 * Supports: GET with eq/neq/gt/gte/lt/lte/is/in filters, order and limit; POST insert and
 * upsert (on_conflict, merge- or ignore-duplicates); PATCH; DELETE; single-object Accept;
 * /rpc/* (answers null). Embedded-resource filters (`tracked_entities.company_id=…`) are
 * ignored — seed rows already scoped.
 *
 * Failure seams, for the "nothing throws, the report is quietly worse" cases:
 *   failReads      — tables whose GET returns a 500
 *   missingColumns — 'table.column' entries; a write carrying one gets PGRST204, exactly as
 *                    PostgREST answers a column whose migration has not been applied
 *   rpcResults     — name → (args) => ({ status, body }); scripts an RPC's answer, e.g.
 *                    { status: 404, body: { code: 'PGRST202' } } for a function an
 *                    unapplied migration has not created yet. Unscripted RPCs answer null.
 *
 * Every RPC call is recorded in `rpcCalls` as { name, args }, so a test can pin what a
 * writer SENT — an RPC's arguments are a boundary like any column.
 *
 * Usage: const pg = await startFakePostgrest(); process.env.SUPABASE_URL = pg.url; …
 * Set the env BEFORE importing anything that creates the Supabase client.
 */
import { createServer } from 'node:http'

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function cmp(a, b) {
  const na = Number(a), nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const da = Date.parse(a), db = Date.parse(b)
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db
  return String(a).localeCompare(String(b))
}

function matches(row, key, raw) {
  if (key.includes('.')) return true
  const [op, ...rest] = raw.split('.')
  const value = rest.join('.')
  const v = row[key]
  switch (op) {
    case 'eq': return String(v) === value
    case 'neq': return String(v) !== value
    case 'gte': return v != null && cmp(v, value) >= 0
    case 'gt': return v != null && cmp(v, value) > 0
    case 'lte': return v != null && cmp(v, value) <= 0
    case 'lt': return v != null && cmp(v, value) < 0
    case 'is': return value === 'null' ? v == null : String(v) === value
    case 'in': return value.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(v))
    default: return true
  }
}

export async function startFakePostgrest() {
  const pg = { db: {}, failReads: new Set(), missingColumns: new Set(), nextId: 1, rpcCalls: [], rpcResults: {} }
  pg.reset = () => { pg.db = {}; pg.failReads = new Set(); pg.missingColumns = new Set(); pg.rpcCalls = []; pg.rpcResults = {} }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(payload === undefined ? '' : JSON.stringify(payload))
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '')
        let args = {}
        try { args = body ? JSON.parse(body) : {} } catch { /* recorded as {} */ }
        pg.rpcCalls.push({ name, args })
        const scripted = pg.rpcResults[name]
        if (typeof scripted !== 'function') return send(200, null)
        const { status = 200, body: payload = null } = scripted(args) || {}
        return send(status, payload)
      }
      const table = url.pathname.replace('/rest/v1/', '')
      const rows = (pg.db[table] ||= [])
      const filters = [...url.searchParams.entries()].filter(([k]) => !RESERVED.has(k))
      const single = String(req.headers.accept || '').includes('vnd.pgrst.object')
      const prefer = String(req.headers.prefer || '')
      const out = (list, status = 200) => {
        if (single) {
          return list.length === 1
            ? send(status, list[0])
            : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${list.length} rows` })
        }
        return send(status, prefer.includes('return=minimal') && req.method !== 'GET' ? undefined : list)
      }
      const missingIn = (records) => {
        for (const r of records) {
          for (const col of Object.keys(r || {})) {
            if (pg.missingColumns.has(`${table}.${col}`)) return col
          }
        }
        return null
      }

      if (req.method === 'GET') {
        if (pg.failReads.has(table)) return send(500, { message: `fake read failure on ${table}` })
        let list = rows.filter(r => filters.every(([k, v]) => matches(r, k, v)))
        const order = url.searchParams.get('order')
        if (order) {
          const [col, dir] = order.split(',')[0].split('.')
          list = [...list].sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a[col], b[col]))
        }
        const limit = Number(url.searchParams.get('limit'))
        if (limit) list = list.slice(0, limit)
        return out(list)
      }
      if (req.method === 'POST') {
        const incoming = [].concat(body ? JSON.parse(body) : [])
        const missing = missingIn(incoming)
        if (missing) return send(400, { code: 'PGRST204', message: `Could not find the '${missing}' column of '${table}' in the schema cache` })
        const conflict = url.searchParams.get('on_conflict')?.split(',')
        const written = []
        for (const r of incoming) {
          const hit = conflict && rows.find(x => conflict.every(c => String(x[c]) === String(r[c])))
          if (hit) {
            if (prefer.includes('ignore-duplicates')) continue
            Object.assign(hit, r)
            written.push(hit)
          } else {
            const row = { id: `id-${pg.nextId++}`, created_at: new Date().toISOString(), ...r }
            rows.push(row)
            written.push(row)
          }
        }
        return out(written, 201)
      }
      if (req.method === 'PATCH') {
        const patch = body ? JSON.parse(body) : {}
        const missing = missingIn([patch])
        if (missing) return send(400, { code: 'PGRST204', message: `Could not find the '${missing}' column of '${table}' in the schema cache` })
        const hit = rows.filter(r => filters.every(([k, v]) => matches(r, k, v)))
        for (const r of hit) Object.assign(r, patch)
        return out(hit)
      }
      if (req.method === 'DELETE') {
        pg.db[table] = rows.filter(r => !filters.every(([k, v]) => matches(r, k, v)))
        return out([])
      }
      return send(405, {})
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  pg.url = `http://127.0.0.1:${server.address().port}`
  pg.close = () => server.close()
  return pg
}

/**
 * The orphaned service worker. Browsers that visited before 2026-08-16 still have the old
 * vite-plugin-pwa worker installed; with /sw.js a 404 it could never update, so they kept
 * serving a precached copy of the app until a hard refresh. public/sw.js replaces it with a
 * worker that removes itself. Pinned here because nothing throws when it regresses — the
 * founder just sees last month's UI.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
let n = 0
const check = async (name, fn) => {
  try { await fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
console.log('\nservice worker kill switch\n')

await check('/sw.js is a real file, so the old worker finds something to update to', () => {
  assert.ok(fs.existsSync(new URL('../public/sw.js', import.meta.url)))
})
await check('it never caches or intercepts anything', () => {
  const sw = read('public/sw.js').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(sw, /addEventListener\(\s*['"]fetch['"]/)
  assert.doesNotMatch(sw, /caches\.(open|match)|addAll|importScripts/)
})
await check('on activate it clears caches, unregisters, and reloads its tabs', async () => {
  const calls = []
  const listeners = {}
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: () => calls.push('skipWaiting'),
    registration: { unregister: async () => calls.push('unregister') },
    clients: { matchAll: async () => [{ url: '/x', navigate: async (u) => calls.push(`navigate:${u}`) }] },
  }
  const caches = { keys: async () => ['workbox-precache', 'runtime'], delete: async (k) => calls.push(`delete:${k}`) }
  vm.runInNewContext(read('public/sw.js'), { self, caches })
  listeners.install()
  let pending
  listeners.activate({ waitUntil: (p) => { pending = p } })
  await pending
  assert.deepEqual(calls, ['skipWaiting', 'delete:workbox-precache', 'delete:runtime', 'unregister', 'navigate:/x'])
})
await check('the host serves it fresh and does not rewrite it to index.html', () => {
  const v = JSON.parse(read('vercel.json'))
  const rewrite = v.rewrites.find(r => r.destination === '/index.html')
  assert.match(rewrite.source, /sw\\\.js/, 'the SPA rewrite must exclude /sw.js or the browser is handed HTML as a worker')
  const h = v.headers.find(x => x.source === '/sw.js')
  assert.ok(h && /no-cache|no-store/.test(h.headers.find(k => k.key === 'Cache-Control').value))
})
await check('the app also unregisters leftovers once it is running', () => {
  assert.match(read('src/main.jsx'), /getRegistrations\(\)[\s\S]*unregister\(\)/)
})
console.log(`\n${n} passed`)

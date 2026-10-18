import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(decodeURIComponent(new URL('..', import.meta.url).pathname))
const manifestPath = path.join(root, 'public', 'manifest.webmanifest')
const indexPath = path.join(root, 'index.html')
const mainPath = path.join(root, 'src', 'main.jsx')

const manifestExists = fs.existsSync(manifestPath)
assert.equal(manifestExists, true, 'manifest.webmanifest must exist in public/ so requests stay on-origin')

const html = fs.readFileSync(indexPath, 'utf8')
assert.match(html, /<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["'][^>]*>/i,
  'index.html must link to the same-origin manifest file')

const main = fs.readFileSync(mainPath, 'utf8')
assert.doesNotMatch(main, /registerSW|virtual:pwa-register/i,
  'PWA service-worker registration must be disabled to avoid Vercel manifest SSO redirects')

console.log('manifest policy check passed')

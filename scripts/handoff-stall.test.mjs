import assert from 'node:assert/strict'
import { isHandoffStalled, isJobAbandoned } from '../lib/_intelligenceJobs.js'

let n = 0
const check = (name, fn) => {
  try { fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
const ahead = (s) => new Date(Date.now() + s * 1000).toISOString()
console.log('\nhandoff stall\n')

// Shape written by releaseForNextStep: heartbeat = release time, lock already expired.
const released = (secondsSinceRelease) => ({ status: 'processing', last_heartbeat_at: ago(secondsSinceRelease), lock_expires_at: ago(secondsSinceRelease + 1) })

check('a job released and unclaimed for 25s is a lost self-trigger — and the 90s rule would still be silent', () => {
  const job = released(25)
  assert.equal(isHandoffStalled(job), true)
  assert.equal(isJobAbandoned(job), false, 'this is the ~85s the run used to lose')
})
check('a job released a moment ago is left to its self-trigger', () => {
  assert.equal(isHandoffStalled(released(5)), false)
})
check('a running worker (unexpired lock) is never mistaken for a lost handoff', () => {
  assert.equal(isHandoffStalled({ status: 'processing', last_heartbeat_at: ago(60), lock_expires_at: ahead(60) }), false)
})
check('only a processing job can be stalled', () => {
  for (const status of ['pending', 'completed', 'failed', 'awaiting_context_review']) {
    assert.equal(isHandoffStalled({ ...released(60), status }), false, status)
  }
  assert.equal(isHandoffStalled(null), false)
})
check('a job with no lock or heartbeat on record is not guessed at', () => {
  assert.equal(isHandoffStalled({ status: 'processing', last_heartbeat_at: null, lock_expires_at: ago(60) }), false)
  assert.equal(isHandoffStalled({ status: 'processing', last_heartbeat_at: ago(60), lock_expires_at: null }), false)
})
console.log(`\n${n} passed`)

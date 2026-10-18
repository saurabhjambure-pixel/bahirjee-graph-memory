/**
 * Source Watch tests.
 *
 * Pins the two rules the module exists to enforce, because both are silent when they
 * break: a broken baseline rule floods every first run with "this page exists" noise,
 * and a broken change rule makes the founder re-read the same pricing page every week.
 * Neither shows up as an error — only as a worse report.
 *
 * Run: npm run test:watch
 */
import assert from 'node:assert/strict'
import {
  normalizeForHash,
  hashContent,
  summarizeDiff,
  prioritizeSources,
  rotateSources,
  isSubstitutedPage,
  watchSource,
  watchSources,
  DAILY_WATCH_FETCHES,
} from '../src/services/sourceWatch.js'

/** In-memory snapshot store standing in for Supabase. */
const makeStore = (seed = {}) => {
  const snapshots = new Map(Object.entries(seed))
  const failures = []
  const checked = []
  return {
    snapshots,
    failures,
    checked,
    latest: async (id) => snapshots.get(id) || null,
    record: async ({ entitySourceId, contentHash, extract }) => {
      snapshots.set(entitySourceId, { content_hash: contentHash, extract, fetched_at: '2026-08-01' })
    },
    markChecked: async (id) => { checked.push(id) },
    markFailure: async (id, n) => { failures.push([id, n]) },
  }
}

const source = (over = {}) => ({
  id: 'src-1',
  url: 'https://competitor.com/pricing',
  source_type: 'pricing',
  entity: { name: 'Competitor', category: 'competitor' },
  ...over,
})

const page = (body) => `${'Boilerplate nav and footer text. '.repeat(30)}\n${body}`

// ── Normalization strips render-time noise ──────────────────────────────────────
{
  const a = normalizeForHash('Plan A $99\nLast updated 2026-08-01 14:32\ntoken=a1b2c3d4e5f6a7b8c9d0')
  const b = normalizeForHash('Plan A $99\nLast updated 2026-08-02 09:15\ntoken=f9e8d7c6b5a4938271f0')
  assert.equal(a, b, 'timestamps and tokens must not register as a content change')

  const c = normalizeForHash('Plan   A\n\n  $99  ')
  const d = normalizeForHash('Plan A $99')
  assert.equal(c, d, 'whitespace reflow must not register as a change')
}

// ── Hashing agrees with normalization ───────────────────────────────────────────
{
  const h1 = await hashContent('Pricing: $99/mo   updated 2026-08-01')
  const h2 = await hashContent('Pricing: $99/mo updated 2026-08-05')
  assert.equal(h1, h2, 'hash must ignore normalized-away noise')

  const h3 = await hashContent('Pricing: $129/mo')
  assert.notEqual(h1, h3, 'a real price change must change the hash')
  assert.match(h1, /^[a-f0-9]{64}$/, 'sha-256 hex')
}

// ── Diff reports both directions ────────────────────────────────────────────────
{
  const diff = summarizeDiff('Starter $29\nPro $99\nFree tier available', 'Starter $29\nPro $149\nEnterprise custom')
  assert.match(diff, /ADDED/)
  assert.match(diff, /Pro \$149/)
  assert.match(diff, /Enterprise custom/)
  assert.match(diff, /REMOVED/)
  assert.match(diff, /Pro \$99/)
  assert.match(diff, /Free tier available/)
  assert.equal(summarizeDiff('same\ntext', 'same\ntext'), '', 'identical text yields no diff')
}

// ── Prioritisation is deterministic and puts competitor pricing first ───────────
{
  const ranked = prioritizeSources([
    { id: 'a', url: 'https://x.com/blog', source_type: 'press', entity: { category: 'infra' } },
    { id: 'b', url: 'https://y.com/pricing', source_type: 'pricing', entity: { category: 'competitor' } },
    { id: 'c', url: 'https://y.com/careers', source_type: 'careers', entity: { category: 'competitor' } },
  ])
  assert.deepEqual(ranked.map(s => s.id), ['b', 'c', 'a'])

  const shuffled = prioritizeSources([
    { id: 'c', url: 'https://y.com/careers', source_type: 'careers', entity: { category: 'competitor' } },
    { id: 'a', url: 'https://x.com/blog', source_type: 'press', entity: { category: 'infra' } },
    { id: 'b', url: 'https://y.com/pricing', source_type: 'pricing', entity: { category: 'competitor' } },
  ])
  assert.deepEqual(shuffled.map(s => s.id), ['b', 'c', 'a'], 'input order must not affect selection')
}

// ── RULE 1: first sighting is a baseline, never a signal ────────────────────────
{
  const store = makeStore()
  const result = await watchSource(source(), {
    scrape: async () => page('Pro $99/mo'),
    runId: 'run-1',
    store,
  })
  assert.equal(result, null, 'a page we have never seen is not news')
  assert.ok(store.snapshots.has('src-1'), 'but the baseline must be stored')
  assert.deepEqual(store.checked, ['src-1'])
}

// ── RULE 2: an unchanged page produces nothing ──────────────────────────────────
{
  const body = page('Pro $99/mo')
  const store = makeStore({ 'src-1': { content_hash: await hashContent(body), extract: body } })
  const result = await watchSource(source(), { scrape: async () => body, runId: 'run-2', store })
  assert.equal(result, null, 'unchanged page must not emit an observation')
}

// ── A real change emits a first-party observation ───────────────────────────────
{
  const before = page('Pro $99/mo')
  const store = makeStore({ 'src-1': { content_hash: await hashContent(before), extract: before } })

  const result = await watchSource(source(), {
    scrape: async () => page('Pro $149/mo'),
    runId: 'run-3',
    store,
  })

  assert.ok(result, 'a changed page must emit an observation')
  assert.equal(result.source_class, 'primary_company', 'watch evidence is first-party')
  assert.equal(result.source_type, 'source_watch')
  assert.equal(result.theme, 'competitor_intel')
  assert.equal(result.url, 'https://competitor.com/pricing')
  assert.match(result.data, /PRIMARY SOURCE CHANGE DETECTED/)
  assert.match(result.data, /Pro \$149/, 'the new value must reach the analyzer')
  assert.match(result.data, /OWN page/, 'framing must distinguish this from a news report')
}

// ── careers pages route to the talent theme, not competitor ─────────────────────
{
  const before = page('2 open roles')
  const store = makeStore({ 'src-2': { content_hash: await hashContent(before), extract: before } })
  const result = await watchSource(
    source({ id: 'src-2', source_type: 'careers', url: 'https://competitor.com/careers' }),
    { scrape: async () => page('14 open roles including VP Sales'), runId: 'r', store }
  )
  assert.equal(result.theme, 'talent_signals')
}

// ── A failed or too-short fetch records a failure and emits nothing ─────────────
{
  const store = makeStore()
  const thrown = await watchSource(source(), {
    scrape: async () => { throw new Error('502') },
    runId: 'r',
    store,
  })
  assert.equal(thrown, null)
  assert.equal(store.failures.length, 1, 'a failed fetch must count toward retirement')

  const stub = await watchSource(source({ id: 'src-3' }), { scrape: async () => 'tiny', runId: 'r', store })
  assert.equal(stub, null, 'a soft-404 stub is not a page')
  assert.equal(store.failures.length, 2)
}

// ── The run cap and time budget are both respected ──────────────────────────────
{
  const store = makeStore()
  const many = Array.from({ length: 20 }, (_, i) => source({ id: `s${i}`, url: `https://c${i}.com/pricing` }))

  const capped = await watchSources(many, {
    scrape: async () => page('content'),
    runId: 'r',
    limit: 5,
    store,
  })
  assert.equal(capped.checked, 5, 'must not exceed the per-run fetch cap')

  let calls = 0
  const budgeted = await watchSources(many, {
    scrape: async () => page('content'),
    runId: 'r',
    limit: 12,
    canAfford: () => ++calls <= 3,
    store: makeStore(),
  })
  assert.equal(budgeted.checked, 3, 'must stop when the step runs out of time budget')
}

// ─── Daily rotation ─────────────────────────────────────────────────────────
//
// The weekly run fetches a capped set ONCE, so a total ordering by importance is right.
// A daily loop with that same ordering would re-fetch the same top pages every morning
// and never reach the tail — a competitor's pricing page checked 30 times a month and
// their careers page never. Neither behaviour throws; the watch just quietly stops
// watching most of what it was given.
{
  const src = (id, over = {}) => ({
    id,
    url: `https://x.com/${id}`,
    source_type: 'pricing',
    entity: { name: 'E', category: 'competitor' },
    last_checked: null,
    ...over,
  })
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()

  const pool = [
    src('a', { last_checked: iso(1) }),
    src('b', { last_checked: iso(5) }),
    src('c', { last_checked: null }),
    src('d', { last_checked: iso(3) }),
  ]

  const today = rotateSources(pool, 2)
  assert.deepEqual(today.map(s => s.id), ['c', 'b'],
    'a never-checked page comes first (it has no baseline and so can never report a ' +
    'change until it gets one), then the longest-unchecked')

  // Walking the rotation must reach everything. Simulate three mornings, stamping
  // last_checked the way watchSource does.
  const state = new Map(pool.map(s => [s.id, { ...s }]))
  const seen = new Set()
  for (let day = 0; day < 3; day++) {
    for (const s of rotateSources([...state.values()], 2)) {
      seen.add(s.id)
      state.get(s.id).last_checked = new Date(Date.now() + day * 1000).toISOString()
    }
  }
  assert.equal(seen.size, pool.length,
    'every watched page must be reached within a few days, or the tail is never watched')

  // Determinism: equal timestamps fall back to the standing importance order.
  const tied = [
    src('low', { last_checked: iso(2), entity: { name: 'E', category: 'industry_body' } }),
    src('high', { last_checked: iso(2), entity: { name: 'E', category: 'competitor' } }),
  ]
  assert.deepEqual(rotateSources(tied, 1).map(s => s.id), ['high'],
    'a tie must break on importance, not on array order')

  assert.equal(rotateSources(pool).length, Math.min(DAILY_WATCH_FETCHES, pool.length))
  assert.deepEqual(rotateSources([], 4), [])
  assert.deepEqual(rotateSources(null, 4), [])
  assert.deepEqual(rotateSources([{ id: 'x' }, { url: 'u' }], 4), [],
    'a row missing an id or url cannot be fetched and must not consume a slot')

  // A permanently failing page must not jam the rotation. sourceWatch stamps
  // last_checked on FAILURE as well as success, so the rotation moves past it.
  const service = (await import('node:fs')).readFileSync(
    new URL('../src/services/sourceWatch.js', import.meta.url), 'utf8')
  const markFailure = service.slice(service.indexOf('async function markFailure'))
  assert.match(markFailure.slice(0, 600), /last_checked/,
    'if a failure did not stamp last_checked, one dead URL would be picked every ' +
    'morning forever and nothing else would ever be checked')
}

// ─── Substituted pages ──────────────────────────────────────────────────────
//
// The Exa fallback keyword-searches the requested URL and returns the best result even when
// nothing matches it, so a page that does not exist comes back as a confident multi-kilobyte
// success from a different site. Observed live: janitri.in/changelog (no such page) returned
// 24,889 characters. A discovery read tolerates that; a change monitor cannot, because the
// hash is then taken over a substitute that moves whenever Exa's ranking moves — phantom
// changes shaped exactly like real ones.
{
  assert.equal(isSubstitutedPage('https://janitri.in/changelog', 'https://someoneelse.com/blog'), true,
    'a different host is never the page we asked for')
  assert.equal(isSubstitutedPage('https://janitri.in/changelog', 'https://janitri.in/'), false,
    'same host, different path: providers legitimately normalise and redirect — rejecting ' +
    'these would throw away real reads')
  assert.equal(isSubstitutedPage('https://www.janitri.in/x', 'https://janitri.in/x'), false, 'www is not a different site')
  assert.equal(isSubstitutedPage('https://JANITRI.in/x', 'https://janitri.in/x'), false, 'host comparison is case-insensitive')
  assert.equal(isSubstitutedPage('https://janitri.in/x', null), false,
    'an undisclosed resolvedUrl must be ACCEPTED — Parallel AI does not report one, and ' +
    'failing closed on silence would stop the watch working at all')
  assert.equal(isSubstitutedPage('not a url', 'https://x.com'), false, 'unparseable input must not throw')
  assert.equal(isSubstitutedPage('https://x.com', 'not a url'), false)
}

console.log('source watch tests passed')

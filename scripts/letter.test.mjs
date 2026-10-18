/**
 * The Monday Letter — renderer, taxonomy and transport.
 *
 * Four things here would undo the positioning rather than merely break a feature:
 *
 *   1. THE CAP HOLDS. The pipeline finds twenty things; the letter serves one claim and
 *      three movements. A regression here turns the letter back into the dump the app
 *      already was.
 *   2. THE ADVICE GUARD BINDS ON THE RENDERED TEXT. The brief is audited, but the letter
 *      is a second surface built from it. If the letter could say "you should", the
 *      no-advice position would be a claim the product does not keep.
 *   3. NOTHING IS GUESSED. No movement without a source; no date the pipeline could not
 *      verify. A letter is exactly where a founder acts on a value.
 *   4. MAIL FAILS SOFT. A missing provider key returns { sent: false }, never a throw — a
 *      run that produced a good brief must not be marked failed by a mail outage.
 *
 * Run: npm run test:letter
 */
import assert from 'node:assert/strict'
import { buildLetter, REFUSAL_LINE } from '../src/services/letterService.js'
import { selectClaimAndMovements, detectAdviceLeakage, MAX_MOVEMENTS } from '../src/services/briefSchema.js'
import {
  SOURCE_CLASSES,
  SOURCE_CLASS_LABELS,
  SOURCE_CLASS_LABELS_PLURAL,
  SOURCE_CLASS_PROVENANCE,
  isSelfAttesting,
} from '../src/services/sourceClass.js'
import { buildRecognitionLine, buildContextSentences, MIN_SENTENCES_FOR_CONFIRM } from '../src/services/recognition.js'
import { sendMail, isMailConfigured, __resetMailDisclosureForTests } from '../lib/_mail.js'
import { resolveSiteOrigin, absoluteUrl, isLocalOrigin } from '../lib/_siteUrl.js'
import { completeIntelligenceJob } from '../lib/_intelligenceJobs.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const context = {
  operating_geography: 'Maharashtra and Gujarat',
  strategic_anchors: {
    operational_reality: 'Warehouse management software',
    buyer_type: { primary: 'Mid-Market' },
    narrative_lens: 'Faster implementation than incumbents',
  },
  customer_segments: [{ name: 'third-party logistics firms', pain_point: 'Manual stock reconciliation' }],
  key_competitors: [{ name: 'Holisol' }, { name: 'Stockarea' }, { name: 'Increff' }],
}

// Twenty signals, as a real run produces.
const signals = Array.from({ length: 20 }, (_, i) => ({
  source_url: `https://src${i % 9}.example.com/item-${i}`,
  source_class: SOURCE_CLASSES[i % SOURCE_CLASSES.length],
  the_move: `Competitor movement number ${i}`,
  relevance_score: 100 - i,
  date: '2026-09-02',
  date_confidence: i % 4 === 0 ? 'low' : 'high',
  entity_involved: `Entity ${i}`,
  corroborating_urls: i % 5 === 0 ? [`https://other${i}.example.com/x`] : [],
}))

const brief = {
  schema: 'brief.v2',
  headline: 'Two of your three largest competitors moved on mid-market pricing in the same fortnight.',
  our_read: 'Pricing pressure at the entry tier is now structural rather than promotional.',
  what_changed: signals.slice(0, 6).map(s => ({
    text: s.the_move,
    evidence_refs: [s.source_url],
    source_class: s.source_class,
  })),
  confidence: { level: 'Medium', basis: '14 sourced findings, 9 domains, 3 kinds of source.', evidence_count: 14, unique_domains: 9, source_classes: 3, depth: 'full', capped_by: [] },
}

const report = { brief, signals, context, created_at: '2026-09-08T06:00:00Z' }

// ── 1. the cap ──────────────────────────────────────────────────────────────
{
  const { claim, movements, rest, total } = selectClaimAndMovements(brief, signals)
  assert.equal(movements.length, MAX_MOVEMENTS, 'the surface must serve exactly three movements')
  assert.ok(claim.length > 0, 'a claim must be selected')
  assert.equal(movements.length + rest.length, total, 'rest must account for everything not served')
  assert.ok(rest.length > 0, 'a 6-item what_changed must leave a remainder — nothing is discarded')

  const letter = buildLetter({ report })
  assert.equal(letter.movementCount, MAX_MOVEMENTS, 'the letter must not exceed the cap')

  // The cap is enforced in code, not by the fixture happening to be short.
  const wide = buildLetter({ report: { ...report, brief: { ...brief, what_changed: brief.what_changed.concat(brief.what_changed) } } })
  assert.equal(wide.movementCount, MAX_MOVEMENTS, 'twelve findings must still yield three movements')
}
console.log('  ✓ one claim, three movements')

// ── 2. the advice guard, on the rendered letter ─────────────────────────────
{
  const letter = buildLetter({ report })
  const leaked = detectAdviceLeakage(letter.auditText)
  assert.equal(leaked.length, 0, `the letter's pipeline-derived content leaked advice: ${leaked.join(', ')}`)

  assert.ok(letter.text.includes(REFUSAL_LINE), 'the refusal must be in the plain-text part')
  assert.ok(letter.html.includes('still your call'), 'the refusal must be in the HTML part')

  // auditText must cover the content, or the assertion above is vacuous.
  assert.ok(letter.auditText.includes(brief.headline), 'auditText must contain the claim')
  for (const m of selectClaimAndMovements(brief, signals).movements) {
    assert.ok(letter.auditText.includes(m.text), 'auditText must contain every movement it rendered')
  }

  // ...and it must EXCLUDE the fixed copy, or the guard can never pass: the refusal line
  // says "what you should do", which is itself an advice phrase.
  assert.ok(!letter.auditText.includes(REFUSAL_LINE), 'auditText must exclude Bahirjee\'s own boilerplate')
  assert.ok(
    detectAdviceLeakage(REFUSAL_LINE).length > 0,
    'the refusal contains an advice phrase by design — if it stops doing so, this exclusion is no longer load-bearing and the test is misleading'
  )

  // The guard has to actually be capable of firing, or a clean result proves nothing.
  const advisory = buildLetter({
    report: { ...report, brief: { ...brief, headline: 'You should raise prices before the quarter closes.' } },
  })
  assert.ok(
    detectAdviceLeakage(advisory.auditText).length > 0,
    'the guard must detect advice in pipeline content — otherwise the clean result above is meaningless'
  )
}
console.log('  ✓ advice guard binds on the rendered letter')

// ── 3. nothing is guessed ───────────────────────────────────────────────────
{
  const { movements } = selectClaimAndMovements(brief, signals)
  for (const m of movements) {
    assert.ok(m.url, 'every movement must carry the URL it came from')
    assert.ok(m.text, 'every movement must carry text')
  }

  // A date the pipeline could not verify never reaches the reader.
  const unverified = selectClaimAndMovements(
    { what_changed: [{ text: 'x', evidence_refs: ['https://a.example.com/1'] }] },
    [{ source_url: 'https://a.example.com/1', date: '2026-09-02', date_confidence: 'low' }]
  )
  assert.equal(unverified.movements[0].date, null, 'a low-confidence date must be dropped, not printed')

  // A movement with no evidence at all still renders rather than throwing, but carries no
  // source line to imply one.
  const unsourced = buildLetter({ report: { ...report, brief: { ...brief, what_changed: [{ text: 'Something happened' }] }, signals: [] } })
  assert.ok(!unsourced.text.includes('undefined'), 'an unsourced movement must not print "undefined"')
  assert.ok(!unsourced.html.includes('undefined'), 'an unsourced movement must not print "undefined" in HTML')
}
console.log('  ✓ no movement without a source, no date without verification')

// ── 4. self-attestation decides the caveat ──────────────────────────────────
{
  const mk = (sourceClass) => selectClaimAndMovements(
    { what_changed: [{ text: 't', evidence_refs: ['https://a.example.com/1'], source_class: sourceClass }] },
    [{ source_url: 'https://a.example.com/1', source_class: sourceClass, corroborating_urls: [] }]
  ).movements[0]

  assert.equal(mk('primary_company').needs_caveat, false, "a competitor's own page is the primary record — no caveat")
  assert.equal(mk('filing').needs_caveat, false, 'a regulatory filing is self-attesting')
  assert.equal(mk('news').needs_caveat, true, 'a lone press item is a claim, not a fact')
  assert.equal(mk('social').needs_caveat, true, 'a lone community post is a claim, not a fact')
  assert.equal(mk(null).needs_caveat, true, 'an unclassified source gets the caveat, not the benefit of the doubt')

  const letter = buildLetter({
    report: {
      ...report,
      brief: { ...brief, what_changed: [{ text: 'A lone report', evidence_refs: ['https://n.example.com/1'], source_class: 'news' }] },
      signals: [{ source_url: 'https://n.example.com/1', source_class: 'news', corroborating_urls: [] }],
    },
  })
  assert.ok(letter.text.includes('one source only'), 'a single unconfirmed source must say so in words')

  // Corroboration counts read as English, not as a template. "1 other source agree" is the
  // kind of seam that tells a reader a machine wrote this without re-reading it.
  const mkCorroborated = (n) => buildLetter({
    report: {
      ...report,
      brief: { ...brief, what_changed: [{ text: 'A corroborated move', evidence_refs: ['https://n.example.com/1'], source_class: 'news' }] },
      signals: [{ source_url: 'https://n.example.com/1', source_class: 'news', corroborating_urls: Array.from({ length: n }, (_, i) => `https://o${i}.example.com/x`) }],
    },
  }).text
  assert.ok(mkCorroborated(1).includes('1 other source agrees'), 'one corroborating source takes a singular verb')
  assert.ok(mkCorroborated(3).includes('3 other sources agree'), 'several corroborating sources take a plural verb')
  assert.ok(!/\d other sources agrees|1 other source agree\b/.test(mkCorroborated(1) + mkCorroborated(3)), 'no mismatched agreement')
}
console.log('  ✓ the "one source only" caveat lands where it belongs')

// ── 5. URL matching survives normalisation ──────────────────────────────────
{
  // attachSourceClass matched URLs by exact string, almost never hit, and cost this
  // codebase source_class for months. Same join, so the same trap is available here.
  const { movements } = selectClaimAndMovements(
    { what_changed: [{ text: 't', evidence_refs: ['https://holisol.in/pricing'] }] },
    [{ source_url: 'https://WWW.Holisol.in/pricing/?utm_source=newsletter#top', source_class: 'primary_company', date: '2026-09-02', date_confidence: 'high', corroborating_urls: ['https://x.example.com/1'] }]
  )
  assert.equal(movements[0].source_class, 'primary_company', 'host case, www, trailing slash, tracking params and fragment must not break the join')
  assert.equal(movements[0].corroboration, 1, 'corroboration must survive the same normalisation')
}
console.log('  ✓ URL join survives case, www, slashes, tracking params and fragments')

// ── 6. the taxonomy has no gaps ─────────────────────────────────────────────
{
  for (const cls of SOURCE_CLASSES) {
    assert.ok(SOURCE_CLASS_LABELS[cls], `${cls} has no singular label`)
    assert.ok(SOURCE_CLASS_LABELS_PLURAL[cls], `${cls} has no plural label`)
    assert.ok(SOURCE_CLASS_PROVENANCE[cls], `${cls} has no first-person provenance phrase`)
  }
  assert.equal(SOURCE_CLASSES[0], 'primary_company', 'the strength ordering EvidenceBase renders must start with the primary record')
  assert.equal(SOURCE_CLASSES[SOURCE_CLASSES.length - 1], 'news', 'the strength ordering must end with the weakest class')
  assert.equal(isSelfAttesting('nonexistent_class'), false, 'an unknown class must not be treated as self-attesting')
}
console.log(`  ✓ all ${SOURCE_CLASSES.length} source classes have every rendering`)

// ── 7. recognition, and its gap-beats-a-guess rule ──────────────────────────
{
  const line = buildRecognitionLine(context)
  assert.ok(line.includes('warehouse management software'), 'the recognition line must name what they sell')
  assert.ok(line.includes('Maharashtra'), 'the recognition line must name where they sell')
  assert.ok(line.endsWith('.'), 'the recognition line is a sentence')

  assert.equal(buildRecognitionLine({}), '', 'an empty context must yield no line rather than a generic one')
  assert.equal(buildContextSentences({}).length, 0, 'an empty context must yield no sentences')

  const sentences = buildContextSentences(context)
  assert.equal(sentences.length, 5, 'a full context resolves all five sentences')
  for (const s of sentences) {
    assert.ok(s.field, `sentence ${s.id} must name the field it edits, or a correction cannot be recorded`)
    assert.ok(!/\s\./.test(s.text), `sentence ${s.id} has a space before its full stop: "${s.text}"`)
    assert.ok(s.text.startsWith(s.lead), 'text must be the joined form of lead + value + tail')
  }

  // Partial context degrades by dropping sentences, never by printing blanks.
  const partial = buildContextSentences({ strategic_anchors: { operational_reality: 'Logistics software' } })
  assert.equal(partial.length, 1, 'only the resolvable sentence survives')
  assert.ok(partial.length < MIN_SENTENCES_FOR_CONFIRM, 'and the caller can tell it is below the threshold to show the screen')
}
console.log('  ✓ recognition drops what it cannot resolve')

// ── 8. subject line ─────────────────────────────────────────────────────────
{
  const letter = buildLetter({ report })
  assert.ok(letter.subject.length <= 79, `subject must fit an inbox: got ${letter.subject.length}`)
  assert.ok(!/weekly|brief|report|intelligence/i.test(letter.subject), 'the subject is the claim, never a generic label')

  const empty = buildLetter({ report: { ...report, brief: { what_changed: [] } } })
  assert.ok(empty.subject.length > 0, 'a quiet week still needs a subject')
  assert.equal(empty.movementCount, 0, 'a quiet week serves no movements rather than padding')
}
console.log('  ✓ subject is the claim, and a quiet week is not padded')

// ── 9. HTML is email-safe ───────────────────────────────────────────────────
{
  const letter = buildLetter({
    report: {
      ...report,
      brief: { ...brief, headline: 'Rivals <script>alert(1)</script> & "friends" moved' },
    },
    recipient: { name: 'Priya Sharma' },
    evidenceUrl: 'https://app.bahirjee.com/read',
    unsubscribeUrl: 'https://app.bahirjee.com/unsubscribe?t=abc',
  })

  assert.ok(!letter.html.includes('<script>'), 'brief text must be escaped, not injected')
  assert.ok(letter.html.includes('&lt;script&gt;'), 'the escaped form must be present')
  assert.ok(!/display:\s*flex|display:\s*grid/.test(letter.html), 'flex and grid do not render in Outlook')
  assert.ok(!/@font-face|fonts\.googleapis/.test(letter.html), 'web fonts do not load in mail clients')
  assert.ok(letter.html.includes('Georgia'), 'the judgment voice is set in a serif')
  assert.ok(letter.html.includes('Priya,'), 'the salutation uses the first name only')
  assert.ok(letter.html.includes('max-width:600px'), 'the letter is constrained to a readable column')
  assert.ok(letter.text.includes('https://app.bahirjee.com/read'), 'the plain-text part must carry the link as a URL')
}
console.log('  ✓ HTML escapes input and avoids what mail clients drop')

// ── 10. mail fails soft ─────────────────────────────────────────────────────
{
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM }
  delete process.env.RESEND_API_KEY
  delete process.env.MAIL_FROM
  __resetMailDisclosureForTests()

  assert.equal(isMailConfigured(), false, 'no key means not configured')
  const result = await sendMail({ to: 'a@b.com', subject: 's', text: 't' })
  assert.equal(result.sent, false, 'a missing provider must not report a send')
  assert.equal(result.reason, 'no_provider', 'and must say why')

  // Configured but nonsense input still fails soft rather than throwing.
  process.env.RESEND_API_KEY = 'test-key'
  process.env.MAIL_FROM = 'bahirjee@example.com'
  assert.equal((await sendMail({ to: 'not-an-email', subject: 's', text: 't' })).reason, 'no_recipients')
  assert.equal((await sendMail({ to: 'a@b.com', subject: '', text: 't' })).reason, 'no_subject')
  assert.equal((await sendMail({ to: 'a@b.com', subject: 's' })).reason, 'no_body')

  if (saved.key) process.env.RESEND_API_KEY = saved.key; else delete process.env.RESEND_API_KEY
  if (saved.from) process.env.MAIL_FROM = saved.from; else delete process.env.MAIL_FROM
}
console.log('  ✓ mail fails soft and says why')

// ── 11. where the links point ───────────────────────────────────────────────
{
  // auth-link.js used to own this priority chain inline; the worker and the letter need
  // the same answer, so it moved to lib/_siteUrl.js. These cases are that chain, pinned —
  // a link resolving to the wrong deployment is a sign-in that dead-ends.
  const ENV_KEYS = ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL']
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  const setEnv = (env) => {
    for (const k of ENV_KEYS) delete process.env[k]
    Object.assign(process.env, env)
  }

  const cases = [
    [{ SITE_URL: 'https://a.com', VERCEL_PROJECT_PRODUCTION_URL: 'b.com', VERCEL_URL: 'c.com' }, '', 'https://a.com', 'SITE_URL wins'],
    [{ SITE_URL: 'http://localhost:5173', VERCEL_PROJECT_PRODUCTION_URL: 'b.com' }, '', 'https://b.com', 'a localhost SITE_URL is ignored, not honoured'],
    [{ VERCEL_URL: 'c.com' }, '', 'https://c.com', 'the deployment URL is the last env fallback'],
    [{}, 'https://origin.com', 'https://origin.com', "the caller's origin is used when no env is set"],
    [{}, 'http://localhost:3000', 'http://localhost:5173', 'a localhost origin must not leak into a production link'],
  ]
  for (const [env, requestOrigin, expected, why] of cases) {
    setEnv(env)
    assert.equal(resolveSiteOrigin({ requestOrigin }), expected, why)
  }

  // A letter is about to leave the building. No origin is better than a localhost one.
  setEnv({})
  assert.equal(absoluteUrl('/read/abc'), null, 'an unresolvable origin must yield no link rather than a localhost link')
  setEnv({ SITE_URL: 'https://app.bahirjee.com/' })
  assert.equal(absoluteUrl('/read/abc'), 'https://app.bahirjee.com/read/abc', 'trailing slashes must not double up')
  assert.equal(isLocalOrigin('https://app.bahirjee.com'), false)
  assert.equal(isLocalOrigin(''), true, 'an empty origin counts as unsafe')

  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
}
console.log('  ✓ links resolve to the right deployment, or to nothing')

// ── 12. completion happens exactly once ─────────────────────────────────────
{
  // The stepped worker re-triggers itself and an expired lock lets a job be re-claimed, so
  // completion IS observed more than once in production. While completion had no side
  // effects that was harmless; now the letter rides on it, so exactly one caller may win.
  //
  // A minimal fake of the PostgREST builder — enough to prove the compare-and-set, without
  // pretending to be a database.
  function fakeSupabase(initialStatus = 'processing') {
    const row = { id: 'job-1', status: initialStatus, client_id: 'c1' }
    const state = { updates: 0, readbacks: 0 }

    const builder = () => {
      const q = { _guardStatus: null, _isUpdate: false }
      q.update = (patch) => { q._isUpdate = true; q._patch = patch; return q }
      q.select = () => q
      q.eq = () => q
      q.neq = (col, value) => { q._guardStatus = { col, value }; return q }
      q.maybeSingle = async () => { state.readbacks += 1; return { data: { ...row }, error: null } }
      // An update resolves to the rows it actually changed — [] when the guard excluded it.
      q.then = (resolve) => {
        if (!q._isUpdate) return resolve({ data: [{ ...row }], error: null })
        const blocked = q._guardStatus && row[q._guardStatus.col] === q._guardStatus.value
        if (blocked) return resolve({ data: [], error: null })
        state.updates += 1
        Object.assign(row, q._patch)
        return resolve({ data: [{ ...row }], error: null })
      }
      return q
    }
    return { from: builder, _state: state, _row: row }
  }

  const db = fakeSupabase('processing')
  const first = await completeIntelligenceJob(db, 'job-1', 'report-1')
  assert.equal(first.didComplete, true, 'the first caller must win the transition')
  assert.equal(first.job.report_id, 'report-1', 'and must get the updated job back')

  const second = await completeIntelligenceJob(db, 'job-1', 'report-1')
  assert.equal(second.didComplete, false, 'a second observation of the same completion must NOT win')
  assert.ok(second.job, 'the loser still gets the job — losing the race is a normal outcome, not an error')
  assert.equal(db._state.updates, 1, 'the row must be written exactly once')

  // The loser reads the row back rather than throwing. .single() here would turn "somebody
  // else got there first" into a failure on a job that succeeded.
  assert.equal(db._state.readbacks, 1, 'the loser reads back instead of erroring')
}
console.log('  ✓ completion is a compare-and-set, so only one caller may send')

console.log('letter tests passed')

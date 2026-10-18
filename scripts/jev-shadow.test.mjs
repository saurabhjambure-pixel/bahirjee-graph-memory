/**
 * Jev shadow harness tests.
 *
 * The harness exists to catch a gate that quietly deletes evidence. That only works if the
 * harness itself never quietly deletes evidence — so the invariants pinned here are the
 * ones that would let it lie to us:
 *
 *   - An observation whose request would exceed Jev's limits must be REPORTED, never skipped
 *     in silence. A missing request reads downstream as an unscored observation, an unscored
 *     observation is never gated, and the curve would show a gate as safer than it is.
 *   - The harness must ask the question the pipeline ships. A harness that measures its own
 *     private wording says nothing about the triage step.
 *   - URL comparison must use the pipeline's own normalizer. `attachSourceClass` already
 *     cost this codebase months of empty provenance by comparing raw strings; grading an
 *     observation as "produced nothing" because the brief wrote `https://` and the
 *     observation stored `http://` would understate every loss on the curve.
 *   - The gate must be able to fail. A curve whose worst threshold still loses nothing is
 *     measuring nothing.
 *
 * Run: npm run test:jev-shadow
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    THRESHOLDS,
    analyzedPopulation,
    buildRequests,
    outcomeIndex,
    gradeObservation,
    regretCurve,
    stubScore,
} from './jev-shadow.mjs';
import { compactContext, MATERIALITY_LEVELS } from '../src/services/jevService.js';
import { estimateTokens, validateRequest } from '../lib/_jevWire.js';

let passed = 0;
let failed = 0;
const check = (name, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
    }
};

const obs = (i, over = {}) => ({
    url: `https://example${i}.com/a`,
    title: `Title ${i}`,
    data: `TITLE: Title ${i}\nURL: https://example${i}.com/a\nCONTENT: ${'word '.repeat(60)}`,
    ...over,
});

console.log('\njev shadow harness');

// ─── requests ───────────────────────────────────────────────────────────────

const CONTEXT = { company_name: 'Acme', competitive_map: { named_competitors: ['Rival A'] } };

check('every observation gets exactly one valid request', () => {
    const list = Array.from({ length: 40 }, (_, i) => obs(i));
    const { requests, skipped } = buildRequests(list, CONTEXT);
    assert.equal(requests.length, list.length, 'requests must line up with observations');
    assert.equal(skipped.length, 0);
    for (const r of requests) assert.equal(validateRequest(r).ok, true);
});

check('one observation per request: the state is the company plus that observation only', () => {
    // Jev judges one state per request and its accuracy falls as the state carries
    // unrelated content — packing several observations into one state is the old harness's
    // mistake this rewrite removes.
    const { requests } = buildRequests([obs(1), obs(2)], CONTEXT);
    assert.match(requests[0].state, /COMPANY: Acme/);
    assert.match(requests[0].state, /Rival A/);
    assert.match(requests[0].state, /example1\.com/);
    assert.doesNotMatch(requests[0].state, /example2\.com/, 'another observation leaked into this state');
});

check('the harness asks the pipeline\'s own materiality question', () => {
    const { requests } = buildRequests([obs(1)], CONTEXT);
    const q = requests[0].questions.material;
    assert.equal(q.type, 'score');
    assert.deepEqual(q.criteria, [...MATERIALITY_LEVELS], 'a private copy of the scale would measure a question that never ships');
    assert.equal(MATERIALITY_LEVELS.length, THRESHOLDS.length, 'one threshold per level of the scale');
});

check('an observation larger than the budget is judged on its leading text, not skipped', () => {
    // A search row with no line breaks reaches the model whole (compressObservation only
    // bounds the snippet after the first line). itemState bounds what Jev is shown, so the
    // row still gets a score instead of silently reading as "never gated".
    const huge = obs(99, { data: 'x'.repeat(400000) });
    const { requests, skipped } = buildRequests([obs(1), huge], CONTEXT);
    assert.equal(skipped.length, 0);
    assert.equal(validateRequest(requests[1]).ok, true);
});

check('a request Jev would refuse is reported with its URL, never silently dropped', () => {
    // Nothing in a real context is this large; the point is the accounting. Any request the
    // wire module rejects must surface in `skipped`, or the curve reads it as a safe row.
    const { requests, skipped } = buildRequests([obs(1), obs(2)], { company_name: 'A'.repeat(200000) });
    assert.deepEqual(requests, [null, null]);
    assert.equal(skipped.length, 2);
    assert.deepEqual(skipped.map(s => s.url), ['https://example1.com/a', 'https://example2.com/a'], 'a skipped observation must carry its URL');
    assert.match(skipped[0].reason, /tokens/);
});

// ─── outcome grading ────────────────────────────────────────────────────────

const report = {
    brief: { what_changed: [{ text: 'x', evidence_refs: ['http://Example1.com/a/'] }] },
    signals: [{ source_url: 'https://www.example2.com/a' }],
};

check('grading reads evidence_refs and signal source_url', () => {
    const outcome = outcomeIndex(report);
    assert.equal(gradeObservation(obs(1), outcome), 'brief');
    assert.equal(gradeObservation(obs(2), outcome), 'signal');
    assert.equal(gradeObservation(obs(3), outcome), 'nothing');
});

check('grading survives scheme, host-case and trailing-slash differences', () => {
    // The brief stored `http://Example1.com/a/`; the observation stored
    // `https://example1.com/a`. Raw string compare grades this "nothing" and hides a loss.
    const outcome = outcomeIndex(report);
    assert.equal(gradeObservation({ url: 'https://example1.com/a' }, outcome), 'brief');
    assert.equal(gradeObservation({ url: 'https://example2.com/a/' }, outcome), 'signal');
});

check('an observation with no URL grades as nothing rather than throwing', () => {
    const outcome = outcomeIndex(report);
    assert.equal(gradeObservation({ url: null }, outcome), 'nothing');
    assert.equal(gradeObservation({}, outcome), 'nothing');
});

check('an empty or string brief does not break grading', () => {
    const outcome = outcomeIndex({ brief: 'No material shifts detected this run.', signals: [] });
    assert.equal(outcome.brief.size, 0);
    assert.equal(outcome.signal.size, 0);
});

// ─── the curve ──────────────────────────────────────────────────────────────

// obs(1) reached the brief, obs(2) became a signal, obs(3) and obs(4) produced nothing.
const observations = [obs(1), obs(2), obs(3), obs(4)];
const fractions = [1, 2 / 3, 0, 0];
const curve = (thresholds, f = fractions) => regretCurve({ observations, fractions: f, outcome: outcomeIndex(report), thresholds }).rows;

check('the lowest threshold drops nothing', () => {
    const [row] = curve([0]);
    assert.equal(row.dropped, 0);
    assert.equal(row.briefLost, 0);
});

check('the gate keeps an observation scoring exactly at the threshold', () => {
    // The gate is `score < t`, not `<=`. The brief row scores 1 and must survive threshold 1,
    // or the top level of the scale would be unreachable.
    const [row] = curve([1]);
    assert.equal(row.dropped, 3);
    assert.equal(row.briefLost, 0);
});

check('the gate can fail — a threshold above the top level destroys brief evidence', () => {
    const worst = curve([0, 1 / 3, 1.01]).at(-1);
    assert.equal(worst.dropped, 4, 'a threshold above the top level should drop everything scored');
    assert.ok(worst.briefLost > 0, 'a curve where the worst threshold loses no brief evidence is measuring nothing');
});

check('a mid threshold cuts waste before it cuts evidence', () => {
    const [row] = curve([1 / 3]);
    assert.equal(row.dropped, 2, 'the two rows Jev placed at "unrelated"');
    assert.equal(row.briefLost, 0);
    assert.equal(row.signalLost, 0);
    assert.equal(row.wasteCut, 2);
});

check('an unscored observation is never dropped', () => {
    // Absent evidence is not evidence of absence: a request that failed, was skipped or
    // came back malformed must not read as "Jev rated this irrelevant".
    const [row] = curve([1], [1, null, null, undefined]);
    assert.equal(row.dropped, 0, 'only the brief row was scored, and it scores at the threshold');
});

check('totals account for every observation exactly once, unscored included', () => {
    const { totals } = regretCurve({ observations, fractions: [1, null, 0, 0], outcome: outcomeIndex(report) });
    assert.equal(totals.brief + totals.signal + totals.nothing, totals.n);
    assert.equal(totals.n, observations.length);
    assert.equal(totals.unscored, 1);
});

check('the default thresholds are the levels of the materiality scale', () => {
    // scoreFraction maps level k of 4 to k/3; a threshold between levels would only
    // ever be reached by a fractional score and would read as a level it isn't.
    assert.deepEqual(THRESHOLDS, MATERIALITY_LEVELS.map((_, k) => k / (MATERIALITY_LEVELS.length - 1)));
});

// ─── fidelity to production ─────────────────────────────────────────────────

check('only rows analysis would receive are scored — a deep read and its snippet count once', () => {
    // Every deep read shares its URL with the search result it came from. Scoring both
    // would price a row production never pays for and double every loss on the curve.
    const url = 'https://analyst.example.com/report.pdf';
    const rows = [
        { id: 'a', url, score: 0.6, data: `TITLE: Report\nURL: ${url}\nCONTENT: ${'text '.repeat(40)}` },
        { id: 'b', url: 'http://www.analyst.example.com/report.pdf/', score: null, isDeepRead: true, data: 'full page '.repeat(40) },
        { id: 'c', url: 'https://other.example.com/x', score: 0.6, data: `TITLE: X\nURL: x\nCONTENT: ${'text '.repeat(40)}` },
        { id: 'd', url: 'https://empty.example.com/y', score: 0.6, data: 'too short' },
    ];
    const ids = analyzedPopulation(rows).map(o => o.id);
    assert.equal(ids.filter(id => id === 'a' || id === 'b').length, 1, 'same page, two rows: exactly one reaches analysis');
    assert.ok(ids.includes('b'), 'the deep read, not its snippet, is the row that reaches analysis');
    assert.ok(ids.includes('c'));
    assert.ok(!ids.includes('d'), 'rows the gate drops for having no content are not analyzed');
});

check('the population step does not swallow the harness\'s own logging', () => {
    const log = console.log;
    analyzedPopulation([{ id: 'a', url: 'https://e.com', score: 0.6, data: 'x'.repeat(80) }]);
    assert.equal(console.log, log, 'console.log must be restored after silencing the pipeline');
});

const prodSource = readFileSync(new URL('../src/services/observationService.js', import.meta.url), 'utf8');
const harnessSource = readFileSync(new URL('./jev-shadow.mjs', import.meta.url), 'utf8');

check('the harness maps observation rows the way production does', () => {
    // The harness keeps its own mapper (it needs a service-role client), and a copied mapper
    // is exactly how source_class went missing for months. So pin the copy to the original.
    const isDeepRead = (src) => src.match(/isDeepRead:\s*([^\n,]+)/)?.[1].trim();
    assert.ok(isDeepRead(prodSource), 'getObservationsForRun no longer sets isDeepRead — update this test');
    assert.equal(
        isDeepRead(harnessSource), isDeepRead(prodSource),
        'jev-shadow.mjs must classify deep reads exactly as getObservationsForRun does'
    );
});

check('the harness selects every column production selects', () => {
    const cols = (s) => s.split(',').map(c => c.trim()).filter(Boolean);
    const prod = [...cols(prodSource.match(/const BASE_COLUMNS = '([^']+)'/)[1]), 'source_class'];
    const harness = cols(harnessSource.match(/from\('observations'\)\s*\.select\('([^']+)'\)/)[1]);
    const missing = prod.filter(c => !harness.includes(c));
    assert.deepEqual(missing, [], `the harness never selects: ${missing.join(', ')}`);
});

check('the harness has no wire format of its own', () => {
    // lib/_jevWire.js is the single place to correct the vendor shape once the real docs
    // are reachable. A second copy here would keep measuring the wrong one.
    for (const re of [/\bfetch\(/, /Bearer/, /\/v1\/systemone/, /JEV_API_URL/]) {
        assert.ok(!re.test(harnessSource), `jev-shadow.mjs talks to the vendor directly (${re}) — go through createJevClient`);
    }
});

// ─── context compaction ─────────────────────────────────────────────────────

check('compaction keeps the discriminating fields and drops the rest', () => {
    const out = compactContext({
        company_name: 'Acme',
        operating_geography: 'India',
        competitive_map: { named_competitors: ['Rival A', { name: 'Rival B' }] },
        dependency_map: { infra_dependencies: ['AWS'] },
        brand_voice: 'warm and authoritative',
        funding_history: 'Series A 2019, Series B 2021',
    });
    assert.match(out, /COMPANY: Acme/);
    assert.match(out, /Rival A/);
    assert.match(out, /Rival B/);
    assert.match(out, /AWS/);
    assert.doesNotMatch(out, /warm and authoritative/, 'brand voice does not discriminate relevance');
    assert.doesNotMatch(out, /Series A/, 'funding history does not discriminate relevance');
});

check('compaction survives a missing or malformed context', () => {
    assert.equal(typeof compactContext(), 'string');
    assert.equal(typeof compactContext(null), 'string');
    assert.match(compactContext({}), /COMPANY: unknown/);
});

check('compaction stays small enough to leave the budget to evidence', () => {
    const bloated = {
        company_name: 'Acme',
        _trackedEntities: Array.from({ length: 500 }, (_, i) => ({ name: `Entity ${i}` })),
        competitive_map: { named_competitors: Array.from({ length: 200 }, (_, i) => `Rival ${i}`) },
    };
    assert.ok(estimateTokens(compactContext(bloated)) < 1000, 'compacted state must not crowd out the evidence');
});

// ─── stub ───────────────────────────────────────────────────────────────────

check('the stub is deterministic and lands on a level of the scale', () => {
    const list = Array.from({ length: 30 }, (_, i) => obs(i, { isDeepRead: i % 3 === 0 }));
    const a = list.map(stubScore);
    const b = list.map(stubScore);
    assert.deepEqual(a, b, 'the same input must produce the same scores across runs');
    for (const f of a) assert.ok(THRESHOLDS.includes(f), `stub score ${f} is not a level of the scale`);
    assert.ok(new Set(a).size > 1, 'a stub that gives every row one score cannot exercise the curve');
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
process.exit(failed ? 1 : 0);

/**
 * Ask the Track 2 memory graph a question from the terminal — the same
 * askGraph() loop /api/graph runs, without the browser or a Supabase login.
 *
 *   node --env-file=.env scripts/graph-ask.mjs "What breaks if AWS goes down?"
 *   node --env-file=.env scripts/graph-ask.mjs --client <uuid> "…"
 *
 * Defaults to the synthetic tenant scripts/graph-seed.mjs writes. Prints the
 * outcome, the tool trace (which fixed tool ran with which args) and the
 * answer, so the graph's part in the answer is visible, not asserted.
 */

import { askGraph } from '../lib/_graphAgent.js';

const args = process.argv.slice(2);
const clientFlag = args.indexOf('--client');
const CLIENT_ID = clientFlag >= 0
    ? args.splice(clientFlag, 2)[1]
    : (process.env.SEED_CLIENT_ID || '00000000-0000-4000-8000-00000000000d');
const question = args.join(' ').trim();

if (!question) {
    console.error('usage: node --env-file=.env scripts/graph-ask.mjs [--client <uuid>] "<question>"');
    process.exit(2);
}

const result = await askGraph(CLIENT_ID, question);

console.log(`\noutcome: ${result.outcome}`);
for (const t of result.tool_trace || []) {
    console.log(`  step ${t.step}: ${t.tool}(${JSON.stringify(t.args || {})}) → ${t.outcome}${t.forced ? '  [forced recall-first]' : ''}`);
}
for (const p of (result.paths || []).slice(0, 5)) {
    console.log(`  path: ${p.join(' → ')}`);
}
console.log(`\n${result.answer || '(no answer — falls through to the non-graph ladder in the app)'}\n`);
process.exit(0);

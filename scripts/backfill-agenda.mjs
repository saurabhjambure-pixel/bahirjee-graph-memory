/**
 * Seed the Agenda from briefs that already exist.
 *
 * v28 gave Bahirjee somewhere to keep its open questions, but the harvest only runs at the
 * END of a run — so until each company's next full run, the Desk truthfully reports that
 * nothing is open. Meanwhile every brief already on file is carrying the falsifiers that
 * were generated and thrown away: `what_could_change_our_view[].watch_for`, ≥2 per brief
 * because gate B3 blocks without them, plus the founder's stated bets and the run's
 * unknowns.
 *
 * This reads those and opens them. No LLM, no scraping, no search — pure derivation from
 * rows that already exist.
 *
 * IDEMPOTENT. `openQuestion` upserts on a normalised question_key and refuses to re-open
 * anything retired, so running this twice opens nothing the second time and can never
 * resurrect a question the founder has already dismissed.
 *
 * Usage:
 *   node scripts/backfill-agenda.mjs --dry     # print what would happen, write nothing
 *   node scripts/backfill-agenda.mjs           # write
 *   node scripts/backfill-agenda.mjs --client <uuid>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env into process.env before importing anything that builds a Supabase client —
// src/lib/supabase.js resolves its key at module load, and on the server that must be the
// service role (the anon key cannot satisfy auth.uid()-gated RLS from a script).
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const { supabase } = await import('../src/lib/supabase.js');
const { harvestQuestions, openQuestion, listAgenda } = await import('../src/services/agendaService.js');
const { extractTargetDomain } = await import('../src/services/reportService.js');

const DRY = process.argv.includes('--dry');
// `indexOf` returns -1 when the flag is absent, and argv[-1 + 1] is the node binary path —
// which then filtered every client out and reported "0 active client(s)" with no error.
const clientFlagAt = process.argv.indexOf('--client');
const onlyClient = clientFlagAt === -1 ? null : process.argv[clientFlagAt + 1] || null;

if (!supabase) {
    console.error('No Supabase client — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
}

const { data: clients, error: cErr } = await supabase
    .from('clients')
    .select('id, name, status')
    .eq('status', 'active');
if (cErr) { console.error('clients:', cErr.message); process.exit(1); }

const targets = onlyClient ? clients.filter(c => c.id === onlyClient) : clients;
if (onlyClient && targets.length === 0) {
    console.error(`No active client with id ${onlyClient}`);
    process.exit(1);
}

console.log(`${DRY ? 'DRY RUN — nothing will be written\n' : ''}${targets.length} active client(s)\n`);

let openedTotal = 0;
let skippedTotal = 0;

for (const client of targets) {
    // The LATEST report per company is the only one worth harvesting: an older brief's
    // falsifiers were either answered by the runs since or are restated in the newest one,
    // and question_key would collapse the duplicates anyway.
    const { data: reports, error } = await supabase
        .from('reports')
        .select('id, website_url, created_at, brief, context')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(1);
    if (error) { console.error(`  ${client.name}: ${error.message}`); continue; }

    const report = reports?.[0];
    if (!report) { console.log(`  ${client.name}: no reports yet — nothing to harvest`); continue; }

    const targetDomain = extractTargetDomain(report.website_url);
    if (!targetDomain) { console.log(`  ${client.name}: no resolvable domain — skipped`); continue; }

    const questions = harvestQuestions(report.brief, report.context, { reportId: report.id });
    const existing = await listAgenda(client.id, targetDomain, { status: null });

    console.log(`  ${client.name} — ${targetDomain} (brief of ${report.created_at.slice(0, 10)})`);
    console.log(`    harvestable: ${questions.length}  |  already on the agenda: ${existing.length}`);

    if (questions.length === 0) {
        console.log('    nothing to open\n');
        continue;
    }

    for (const q of questions) {
        const label = `${q.origin.padEnd(10)} ${q.question.slice(0, 78)}`;
        if (DRY) { console.log(`    would open  ${label}`); continue; }
        const row = await openQuestion({ ...q, clientId: client.id, targetDomain });
        if (row) { openedTotal++; console.log(`    opened      ${label}`); }
        else { skippedTotal++; console.log(`    skipped     ${label}  (retired, or write failed)`); }
    }
    console.log('');
}

console.log(DRY
    ? 'DRY RUN complete — re-run without --dry to write.'
    : `Done. ${openedTotal} question(s) open, ${skippedTotal} skipped.`);

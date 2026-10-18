/**
 * The ordered pipeline step labels, split out so the browser can render progress
 * without importing intelligenceService (which pulls the whole pipeline, its
 * prompts and every provider gateway into the client bundle).
 *
 * `intelligenceService.PIPELINE_STEPS` is the executable list and imports its
 * labels from here, so the two cannot drift.
 *
 * The worker writes `stepDef.label` to `job.current_step` on every step
 * (lib/_intelligenceWorker.js), so matching a poll response against `label` is
 * what turns "one line of status text" into a real checklist with a count.
 *
 * TOTAL_PIPELINE_STEPS below is derived from this array's length — add a step
 * here and the count updates itself; nothing elsewhere needs editing.
 */
export const PIPELINE_STEP_LABELS = [
  { name: 'context', label: 'Building company context' },
  { name: 'memory', label: 'Loading company memory' },
  // Runs before competitor discovery on purpose: everything it needs is in the context
  // the founder just confirmed, so it can put grounded signals on screen in ~60s.
  { name: 'express', label: 'First pass on your context' },
  { name: 'discover_competitors', label: 'Discovering competitors' },
  { name: 'validate_exa', label: 'Validating competitors' },
  { name: 'generate_queries', label: 'Generating search patterns' },
  { name: 'search', label: 'Executing reconnaissance' },
  { name: 'watch', label: 'Checking tracked sources' },
  { name: 'collect', label: 'Querying structured sources' },
  { name: 'v6_pipeline', label: 'Detecting patterns and shifts' },
  // Scores only when the observation cap binds; otherwise it returns at once.
  { name: 'triage', label: 'Ranking evidence' },
  { name: 'analyze', label: 'Analyzing intelligence' },
  { name: 'verify', label: 'Verifying coverage' },
  { name: 'summary', label: 'Generating strategic brief' },
  // Immediately after `summary`, because it corrects the brief's confidence in place and
  // everything downstream should see the corrected value. It cannot live in `verify` —
  // that runs before any brief exists. See the G6 note in verifierPolicy.js.
  { name: 'attest', label: 'Checking the brief against its evidence' },
  // Advisory only, after the deterministic gates: Jev flags instructions and restated
  // falsifiers attest's phrase lists cannot see. Never a verdict. (JEV_REVIEW)
  { name: 'review', label: 'Reviewing the brief' },
  { name: 'interpret', label: 'Interpreting findings' },
  { name: 'news', label: 'Curating news' },
  { name: 'persist', label: 'Saving report' }
];

export const TOTAL_PIPELINE_STEPS = PIPELINE_STEP_LABELS.length;

/**
 * Resolve a status string to a zero-based step index.
 * Falls back to -1 when the message is a fine-grained sub-step (e.g.
 * "Reading top sources in depth...") that doesn't name a step.
 */
export function resolveStepIndex(statusMsg) {
  if (!statusMsg) return -1;
  const s = String(statusMsg).toLowerCase().replace(/\.+$/, '').trim();
  // Exact-ish match first, then prefix — the worker appends "..." to labels.
  const exact = PIPELINE_STEP_LABELS.findIndex(x => s === x.label.toLowerCase());
  if (exact !== -1) return exact;
  return PIPELINE_STEP_LABELS.findIndex(x => s.startsWith(x.label.toLowerCase()));
}

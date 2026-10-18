import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { PIPELINE_STEP_LABELS, TOTAL_PIPELINE_STEPS, resolveStepIndex } from '../../services/pipelineSteps';

const fmtElapsed = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0s';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
};

/**
 * LiveActivityRail — the engine's own voice while the report assembles around it.
 *
 * This replaces AnalyzingScreen, which was a full-page waiting room. The founder is now
 * already on the report, so progress becomes ambient: a docked strip that says what is
 * being read right now, and collapses into a one-line receipt when the run finishes.
 *
 * Elapsed time is derived from the job's own `started_at` rather than a local counter.
 * AnalyzingScreen counted from mount, so a reload four minutes into a run restarted the
 * clock at zero and told the founder a plain untruth about their own run.
 *
 * @prop {string} statusMsg      latest status line from the poll loop
 * @prop {string|null} startedAt job.started_at, ISO
 * @prop {number} signalCount    signals streamed so far
 * @prop {boolean} isComplete    run finished; render the receipt instead of the rail
 * @prop {number|null} sourceCount distinct source hosts, when known
 */
export default function LiveActivityRail({
  statusMsg,
  startedAt = null,
  signalCount = 0,
  isComplete = false,
  sourceCount = null
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Tick off the job's own start time so a reload mid-run reports the true duration.
  useEffect(() => {
    if (isComplete) return undefined;
    const base = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - base) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAt, isComplete]);

  // -1 when the status is a fine-grained sub-step ("Reading top sources in depth…")
  // rather than a step label; hold the last known step in that case.
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    const i = resolveStepIndex(statusMsg);
    if (i >= 0) setStepIdx(i);
  }, [statusMsg]);

  const done = Math.max(0, stepIdx);
  const pct = Math.round((done / TOTAL_PIPELINE_STEPS) * 100);

  if (isComplete) {
    return (
      <div className="bah-panel bah-sweep px-4 py-3 flex items-center gap-3 text-sm">
        <span className="w-6 h-6 rounded-full bg-bah-accent-soft flex items-center justify-center shrink-0">
          <Check className="w-3.5 h-3.5 text-bah-accent" />
        </span>
        <p className="text-bah-strong font-medium">
          Analysis complete
          <span className="text-bah-muted font-normal">
            {' · '}<span className="font-num">{signalCount}</span> signal{signalCount === 1 ? '' : 's'}
            {sourceCount ? <>{' · '}<span className="font-num">{sourceCount}</span> sources</> : null}
            {elapsed ? <>{' · '}<span className="font-num">{fmtElapsed(elapsed)}</span></> : null}
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="bah-panel overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-bah-accent animate-spin shrink-0" />

        <div className="min-w-0 flex-1">
          {/* The founder's primary read: what is happening right now. */}
          <p className="text-sm text-bah-strong truncate">{statusMsg || 'Starting analysis…'}</p>
          <p className="text-xs text-bah-muted mt-0.5">
            Step <span className="font-num">{Math.min(done + 1, TOTAL_PIPELINE_STEPS)}</span> of{' '}
            <span className="font-num">{TOTAL_PIPELINE_STEPS}</span>
            {' · '}<span className="font-num">{fmtElapsed(elapsed)}</span>
            {signalCount > 0 && (
              <>
                {' · '}
                <span className="text-bah-accent font-medium">
                  <span className="font-num">{signalCount}</span> signal{signalCount === 1 ? '' : 's'} in
                </span>
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="bah-button-ghost text-xs px-2 py-1 flex items-center gap-1 shrink-0"
          aria-expanded={expanded}
        >
          Details
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <div
        className="h-1 bg-bah-accent transition-all duration-500"
        style={{ width: `${Math.max(pct, 3)}%` }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Analysis progress"
      />

      {expanded && (
        <ol className="px-4 py-3 border-t border-bah space-y-1.5 max-h-64 overflow-y-auto">
          {PIPELINE_STEP_LABELS.map((s, i) => (
            <li key={s.name} className="flex items-center gap-2 text-xs">
              {i < done ? (
                <Check className="w-3.5 h-3.5 text-bah-accent shrink-0" />
              ) : i === done ? (
                <Loader2 className="w-3.5 h-3.5 text-bah-accent animate-spin shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                  <span className="w-1 h-1 rounded-full bg-bah-muted opacity-50" />
                </span>
              )}
              <span className={i <= done ? 'text-bah-strong' : 'text-bah-muted'}>{s.label}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The screen-reader half of the arrival choreography. A signal landing is a real event;
 * announcing it politely means the founder using a screen reader gets the same information
 * as the one watching cards slide in, rather than a silent visual-only flourish.
 */
export function LiveAnnouncer({ signalCount, isComplete }) {
  const [message, setMessage] = useState('');
  const [lastCount, setLastCount] = useState(0);

  useEffect(() => {
    if (isComplete) {
      setMessage('Analysis complete. Your brief is ready.');
      return;
    }
    if (signalCount > lastCount) {
      const added = signalCount - lastCount;
      setMessage(`${added} new signal${added === 1 ? '' : 's'}. ${signalCount} so far.`);
      setLastCount(signalCount);
    }
  }, [signalCount, isComplete, lastCount]);

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

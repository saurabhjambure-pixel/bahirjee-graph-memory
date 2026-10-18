import React, { useState } from 'react';
import { Brain, Check, Plus } from 'lucide-react';

/**
 * "This judgment rests on these assumptions — track them?"
 *
 * Bet capture belongs HERE, not in onboarding, for one reason: before the first run
 * Bahirjee has nothing to show, so asking what someone believes is a cold form standing
 * between them and their report. After the run it can show which assumptions its own read
 * depends on and ask which are worth watching — a warm ask, at the only moment the
 * question is obviously worth answering.
 *
 * It is also the honest argument for why run N beats run 1. A tracked bet only pays off
 * across runs spread over time, which is exactly what the weekly cron is for and exactly
 * what a single free run cannot demonstrate.
 *
 * `status` comes from the brief's own `assumption_status`:
 *   supported  — this run found evidence consistent with the bet
 *   pressured  — this run found evidence pressing against it
 *   untested   — nothing this run found bears on it either way
 */

const STATUS_STYLE = {
  supported: { label: 'Supported', cls: 'bg-bah-accent-soft text-bah-accent border-[var(--bah-accent)]/30' },
  pressured: { label: 'Pressured', cls: 'bg-amber-500/10 text-bah-warning border-amber-500/30' },
  untested: { label: 'Untested', cls: 'bg-bah-panel-soft text-bah-muted border-bah' },
};

export default function AssumptionTracker({ assumptionStatus = [], onTrack, isViewerMode = false }) {
  const [draft, setDraft] = useState('');
  const [added, setAdded] = useState([]);
  const [saved, setSaved] = useState(false);

  const judged = Array.isArray(assumptionStatus) ? assumptionStatus.filter(a => a?.statement) : [];

  // Nothing judged and no way to save means there is nothing to show. A "track your
  // assumptions" panel that cannot track anything is worse than no panel.
  if (isViewerMode || (judged.length === 0 && !onTrack)) return null;

  const addDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setAdded(prev => [...prev, text]);
    setDraft('');
    setSaved(false);
  };

  const save = () => {
    onTrack?.([
      ...judged.map(a => ({ statement: a.statement, domain: a.domain || 'Demand', sensitivity: 'High' })),
      ...added.map(statement => ({ statement, domain: 'Demand', sensitivity: 'High' })),
    ]);
    setSaved(true);
  };

  return (
    <div className="mt-10 rounded-2xl border border-bah bg-bah-panel/60 p-6">
      <div className="flex items-center gap-2 mb-2">
        <Brain className="w-4 h-4 text-bah-accent" />
        <h3 className="text-sm font-bold uppercase tracking-widest text-bah-muted">What this rests on</h3>
      </div>

      {judged.length > 0 ? (
        <>
          <p className="text-sm text-bah-muted leading-relaxed mb-4">
            This read depends on the assumptions below. Bahirjee checked each against what it found
            this run — track them and every future run reports what moved.
          </p>
          <ul className="space-y-2.5 mb-5">
            {judged.map((item, i) => {
              const style = STATUS_STYLE[String(item.status || 'untested').toLowerCase()] || STATUS_STYLE.untested;
              return (
                <li key={i} className="rounded-xl border border-bah bg-bah-panel px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-bah leading-relaxed">{item.statement}</p>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${style.cls}`}>
                      {style.label}
                    </span>
                  </div>
                  {item.note && <p className="mt-1.5 text-[11px] text-bah-muted">{item.note}</p>}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-sm text-bah-muted leading-relaxed mb-4">
          Add what you are betting on and every future run will report whether the evidence
          moved for or against it.
        </p>
      )}

      {added.length > 0 && (
        <ul className="space-y-2 mb-4">
          {added.map((text, i) => (
            <li key={i} className="rounded-lg border border-dashed border-bah px-3 py-2 text-sm text-bah">{text}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
          placeholder="Add one of your own…"
          className="bah-input flex-1 rounded-lg px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={!draft.trim()}
          className="bah-button-secondary px-3 py-2 text-xs disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {onTrack && (
        <button
          type="button"
          onClick={save}
          disabled={saved || (judged.length === 0 && added.length === 0)}
          className="mt-4 bah-button-primary px-4 py-2 text-xs disabled:opacity-40"
        >
          {saved ? <><Check className="w-3.5 h-3.5" /> Tracking</> : 'Track these'}
        </button>
      )}
    </div>
  );
}

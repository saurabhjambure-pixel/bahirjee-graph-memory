import React from 'react';
import { History, ArrowRight, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';

export default function RecentRunsTimeline({ compositeRuns = [], onOpenOverview }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <History className="w-4 h-4 text-bah-accent-text" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-bah-muted font-display">
          Recent Composite Runs
        </h3>
        <span className="text-xs text-bah-muted font-normal">
          (Multi-target intelligence scans and cross-scope judgments)
        </span>
      </div>

      <div className="bah-panel rounded-[20px] divide-y divide-bah overflow-hidden">
        {compositeRuns.length === 0 ? (
          <div className="p-8 text-center text-sm text-bah-muted">
            No composite runs completed yet. Click "Run intelligence" above to evaluate your targets.
          </div>
        ) : (
          compositeRuns.map(run => {
            const isComplete = run.status_key === 'completed' || run.status === 'Complete';
            const isPartial = run.status_key === 'partial' || run.status === 'Partial';
            const isRunning = run.status_key === 'running' || run.status === 'Running';

            return (
              <div
                key={run.id}
                className="p-4 md:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-bah-panel-strong transition-colors"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-bah-strong">
                      {run.date}
                    </span>

                    {isComplete && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-accent-soft text-bah-accent-strong border border-[var(--bah-accent)]/20 inline-flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" />
                        Complete
                      </span>
                    )}

                    {isPartial && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-warning-soft text-bah-warning border border-amber-500/30 inline-flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Partial
                      </span>
                    )}

                    {isRunning && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bah-cyan-soft text-bah-cyan border border-[var(--bah-cyan)]/20 inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running
                      </span>
                    )}
                  </div>

                  <div className="text-xs text-bah font-medium flex items-center gap-1.5 flex-wrap">
                    <span className="text-bah-muted font-normal">Scope:</span>
                    <span className="px-2 py-0.5 rounded bg-bah-panel-soft border border-bah text-bah-strong">
                      {run.scope_label}
                    </span>
                  </div>

                  {run.degradations?.length > 0 && (
                    <p className="text-[11px] text-bah-warning flex items-center gap-1 pt-0.5">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      {run.degradations[0].message}
                    </p>
                  )}
                </div>

                <div className="self-start sm:self-center shrink-0">
                  <button
                    onClick={() => onOpenOverview?.(run)}
                    className="bah-button-secondary px-3.5 py-1.5 text-xs inline-flex items-center gap-1.5 font-medium group"
                  >
                    <span>Open overview</span>
                    <ArrowRight className="w-3.5 h-3.5 text-bah-muted group-hover:translate-x-0.5 transition-transform" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

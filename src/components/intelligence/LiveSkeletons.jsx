import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';

/**
 * Placeholders for content the pipeline has not produced yet.
 *
 * These exist so a live run reads as "assembling" rather than "empty". The distinction
 * matters: an empty ring mid-run is *not* the same claim as "no material shifts detected",
 * and rendering the latter would state a conclusion the run has not reached.
 */

export function SignalSkeleton() {
  return (
    <div className="bah-panel p-6 space-y-3" aria-hidden="true">
      <div className="bah-skeleton h-3 w-24" />
      <div className="bah-skeleton h-5 w-3/4" />
      <div className="bah-skeleton h-3 w-full" />
      <div className="bah-skeleton h-3 w-5/6" />
      <div className="flex gap-2 pt-1">
        <div className="bah-skeleton h-6 w-20 rounded-full" />
        <div className="bah-skeleton h-6 w-16 rounded-full" />
      </div>
    </div>
  );
}

/**
 * The judgment is the product. It is also the last thing the pipeline produces, because it
 * has to read everything first. Rather than leave a hole where the brief will go, say
 * plainly what is happening and what it is being built from — the wait becomes legible.
 *
 * @prop {number} signalCount  signals gathered so far
 * @prop {boolean} briefReady  synthesis has run; the brief is moments away
 */
export function JudgmentForming({ signalCount = 0, briefReady = false }) {
  return (
    <div className="bah-panel-strong p-8 relative overflow-hidden">
      <div className="flex items-start gap-4">
        <span className="w-9 h-9 rounded-full bg-bah-accent-soft flex items-center justify-center shrink-0">
          {briefReady
            ? <Sparkles className="w-4 h-4 text-bah-accent" />
            : <Loader2 className="w-4 h-4 text-bah-accent animate-spin" />}
        </span>

        <div className="flex-1 min-w-0">
          <h3 className="font-display font-semibold text-bah-strong text-lg">
            {briefReady ? 'Writing the judgment' : 'Forming judgment'}
          </h3>
          <p className="text-sm text-bah-muted mt-1">
            {signalCount > 0 ? (
              <>
                Reading <span className="font-num text-bah-accent font-medium">{signalCount}</span>{' '}
                signal{signalCount === 1 ? '' : 's'} gathered so far.
                {' '}The brief lands once the evidence is in — it is the last thing written,
                because it has to read everything first.
              </>
            ) : (
              <>Gathering evidence. The judgment is written last, once there is something to weigh.</>
            )}
          </p>

          <div className="mt-5 space-y-2.5" aria-hidden="true">
            <div className="bah-skeleton h-3 w-full" />
            <div className="bah-skeleton h-3 w-11/12" />
            <div className="bah-skeleton h-3 w-4/5" />
          </div>
        </div>
      </div>
    </div>
  );
}

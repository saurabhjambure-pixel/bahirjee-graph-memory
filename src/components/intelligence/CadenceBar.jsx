import React, { useState } from 'react';
import { Check, ChevronDown, Clock, Eye, RefreshCw } from 'lucide-react';
import { describeCadence, isActiveCadence, nextScheduledRead, relativeDays } from '../../services/cadence';
import { CADENCE_OPTIONS } from '../../services/cadenceService';

/**
 * Bahirjee's shift, made visible.
 *
 * `auto_run_cadence` has existed since v18 and appeared in exactly two places: the cron
 * handler and the admin screen. The person it serves could not see it. That is the
 * difference between a scheduled job and a colleague — telling someone "I check every
 * Monday at six, I last checked two days ago, I am watching nineteen sources" is what
 * makes an agent present between runs rather than only during them.
 *
 * It answers three of the seven questions a colleague can always answer: when did you last
 * work, what are you watching, when will you work next.
 *
 * ── Voice ────────────────────────────────────────────────────────────────────
 * This is chrome, so it speaks ABOUT Bahirjee in the third person. Bahirjee speaks in the
 * first person in the letter and in its reads; the interface does not impersonate it.
 *
 * ── Honesty ──────────────────────────────────────────────────────────────────
 * Every field is omitted rather than guessed. A workspace with no cadence says "Not
 * watching yet" instead of inventing a next read; a client that has never been read shows
 * no "last read" instead of a date derived from nothing.
 */
export default function CadenceBar({
  client,
  lastReadAt,
  sourcesWatched,
  onCheckNow,
  onSetCadence,
  cadenceError = null,
  isSettingCadence = false,
  isChecking = false,
  canCheckNow = true,
  className = '',
}) {
  const [picking, setPicking] = useState(false);
  const cadence = client?.auto_run_cadence;
  const watching = isActiveCadence(cadence);
  const nextRead = watching ? nextScheduledRead(client) : null;

  const lastRelative = relativeDays(lastReadAt);
  const nextRelative = relativeDays(nextRead);

  const choose = async (value) => {
    setPicking(false);
    await onSetCadence?.(value);
  };

  return (
    <div
      className={`flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 bg-bah-panel border-b border-bah ${className}`}
    >
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap min-w-0 text-xs text-bah-muted">
        {/* The shift itself is the control. `auto_run_cadence` has been readable since v18
            and settable by nobody, which is why it is NULL on every client and why nothing
            scheduled has ever run. "Not watching yet" must be an invitation, not a label. */}
        <span className="relative flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${watching ? 'bg-bah-accent' : 'bg-bah-muted-2'}`}
            aria-hidden="true"
          />
          {onSetCadence ? (
            <button
              type="button"
              onClick={() => setPicking(v => !v)}
              disabled={isSettingCadence}
              aria-expanded={picking}
              aria-haspopup="listbox"
              className="flex items-center gap-1 font-medium text-bah hover:text-bah-accent transition-colors disabled:opacity-50"
            >
              {isSettingCadence ? 'Saving…' : describeCadence(cadence)}
              <ChevronDown className={`w-3 h-3 transition-transform ${picking ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          ) : (
            <span className="font-medium text-bah">{describeCadence(cadence)}</span>
          )}

          {picking && (
            <>
              {/* Click-away. A picker that only closes by re-clicking its own trigger
                  strands a touch user who opened it by accident. */}
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPicking(false)}
                className="fixed inset-0 z-40 cursor-default"
              />
              <ul
                role="listbox"
                className="absolute top-full left-0 mt-2 z-50 w-64 bah-panel-strong p-1.5 shadow-xl"
              >
                {CADENCE_OPTIONS.map(opt => {
                  const active = (cadence ?? 'off') === opt.value;
                  return (
                    <li key={opt.value}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => choose(opt.value)}
                        className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-bah-accent-soft transition-colors"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm text-bah-strong">{opt.label}</span>
                          {active && <Check className="w-3.5 h-3.5 text-bah-accent shrink-0" aria-hidden="true" />}
                        </span>
                        <span className="block text-xs text-bah-muted-2 mt-0.5">{opt.detail}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </span>

        {/* Why it did not save, in the founder's terms. Rendered inline rather than as a
            toast: the reason is usually "this is part of a paid workspace", which is a
            fact about their account, not a transient event. */}
        {cadenceError && (
          <span className="text-bah-warning" role="status">{cadenceError}</span>
        )}

        {lastRelative && (
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            Last read <span className="text-bah font-num">{lastRelative}</span>
          </span>
        )}

        {/* Only shown when there is a real cadence — otherwise there is no next read to
            promise, and naming one would be a small lie told every week. */}
        {nextRelative && (
          <span className="flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            Next <span className="text-bah font-num">{nextRelative}</span>
          </span>
        )}

        {sourcesWatched > 0 && (
          <span className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="text-bah font-num">{sourcesWatched}</span>
            {sourcesWatched === 1 ? 'source watched' : 'sources watched'}
          </span>
        )}
      </div>

      {/* Secondary on purpose. A run is a heartbeat the founder can see, not an event they
          have to remember to start — the moment "Check now" is the loudest control on the
          page, the product is a tool again. */}
      {onCheckNow && canCheckNow && (
        <button
          type="button"
          onClick={onCheckNow}
          disabled={isChecking}
          className="text-xs px-2.5 py-1 rounded-lg border border-bah text-bah-muted hover:text-bah-strong hover:border-[var(--bah-accent)]/40 transition-colors disabled:opacity-50 shrink-0"
        >
          {isChecking ? 'Reading…' : 'Check now'}
        </button>
      )}
    </div>
  );
}

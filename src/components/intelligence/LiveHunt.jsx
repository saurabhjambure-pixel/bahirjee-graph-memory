import React, { useEffect, useRef, useState } from 'react';
import { Building2, Check, Globe, Loader2, Radar, Search, Target } from 'lucide-react';

/**
 * LiveHunt — what the founder watches for the ~2 minutes before the first signal exists.
 *
 * Nothing here is invented progress. The watchlist is the entities actually being tracked,
 * the queries are the exact strings being sent to the search provider, and the domains are
 * the ones actually being read. That honesty is the point: a fake progress bar and a real
 * feed of work cost the same to build, and only one of them is true.
 *
 * The context card exists because the founder had just spent time reviewing and confirming
 * their context, and the moment they confirmed it the screen threw it away. It is the single
 * highest-value thing on screen at t=0, and it is free — we already have it.
 *
 * Collapses to a one-line summary once real signals arrive; it must never compete with them.
 */

function ContextCard({ context, watchlist }) {
  const question = context?._decision?.raw_input
    || context?._decision?.decision_statement
    || null;

  const facts = [
    { icon: Building2, label: 'Company', value: context?.company_name },
    { icon: Target, label: 'Industry', value: context?.industry },
    { icon: Globe, label: 'Geography', value: context?.operating_geography }
  ].filter(f => f.value);

  if (!facts.length && !watchlist.length && !question) return null;

  return (
    <div className="bah-panel-strong p-6">
      <h3 className="text-[10px] uppercase tracking-wider text-bah-muted font-bold mb-4">
        Analyzing against your context
      </h3>

      {facts.length > 0 && (
        <div className="grid sm:grid-cols-3 gap-4 mb-5">
          {facts.map(({ icon: Icon, label, value }) => (
            <div key={label}>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-bah-muted mb-1">
                <Icon className="w-3 h-3" /> {label}
              </div>
              <p className="text-sm text-bah-strong font-medium leading-snug">{value}</p>
            </div>
          ))}
        </div>
      )}

      {question && (
        <div className="mb-5 pl-3 border-l-2 border-[var(--bah-accent)]">
          <div className="text-[10px] uppercase tracking-wide text-bah-muted mb-1">Your question</div>
          <p className="text-sm text-bah leading-relaxed">{question}</p>
        </div>
      )}

      {watchlist.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-bah-muted mb-2">
            Tracking <span className="font-num text-bah-accent font-semibold">{watchlist.length}</span> entities
          </div>
          <div className="flex flex-wrap gap-1.5">
            {watchlist.map((e, i) => (
              <span key={`${e.name}-${i}`} className="bah-tag text-xs">{e.name}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QueryStream({ queries, progress }) {
  if (!queries.length) return null;
  const done = progress?.cursor ?? 0;

  return (
    <div className="bah-panel p-5">
      <h4 className="text-[10px] uppercase tracking-wider text-bah-muted font-bold mb-3 flex items-center gap-1.5">
        <Search className="w-3 h-3" /> Searching
        {progress && (
          <span className="ml-auto font-num text-bah-accent normal-case tracking-normal">
            {Math.min(done, progress.total)}/{progress.total}
          </span>
        )}
      </h4>
      <ol className="space-y-1.5 max-h-56 overflow-y-auto">
        {queries.map((q, i) => {
          const state = i < done ? 'done' : i === done ? 'active' : 'pending';
          return (
            <li key={q} className="flex items-start gap-2 text-xs">
              <span className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center">
                {state === 'done' ? <Check className="w-3 h-3 text-bah-accent" />
                  : state === 'active' ? <Loader2 className="w-3 h-3 text-bah-accent animate-spin" />
                  : <span className="w-1 h-1 rounded-full bg-bah-muted opacity-50" />}
              </span>
              <span className={state === 'pending' ? 'text-bah-muted' : 'text-bah'}>{q}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SourceTicker({ hosts, total }) {
  // Remember which hosts are new this tick so only those animate in.
  const shownRef = useRef(0);
  const [alreadyShown, setAlreadyShown] = useState(0);
  useEffect(() => {
    shownRef.current = hosts.length;
    setAlreadyShown(hosts.length);
  }, [hosts.length]);

  if (!hosts.length) return null;

  return (
    <div className="bah-panel p-5">
      <h4 className="text-[10px] uppercase tracking-wider text-bah-muted font-bold mb-3 flex items-center gap-1.5">
        <Radar className="w-3 h-3" /> Reading sources
        <span className="ml-auto font-num text-bah-accent normal-case tracking-normal">{total || hosts.length}</span>
      </h4>
      <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
        {hosts.map((h, i) => (
          <span
            key={h}
            className={`bah-tag text-xs font-mono ${i >= alreadyShown ? 'bah-signal-enter' : ''}`}
            style={i >= alreadyShown ? { '--bah-stagger': `${Math.min(i - alreadyShown, 8) * 50}ms` } : undefined}
          >
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function LiveHunt({ context, hunt }) {
  const watchlist = hunt?.watchlist || [];
  const queries = hunt?.queries || [];
  const hosts = hunt?.sourceHosts || [];
  const watch = hunt?.watch;

  return (
    <div className="space-y-4">
      <ContextCard context={context} watchlist={watchlist} />

      {(queries.length > 0 || hosts.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-4">
          <QueryStream queries={queries} progress={hunt?.queryProgress} />
          <SourceTicker hosts={hosts} total={hunt?.sourceHostTotal} />
        </div>
      )}

      {watch && watch.checked > 0 && (
        <div className="bah-panel px-5 py-3 text-xs text-bah-muted">
          Checked <span className="font-num text-bah">{watch.checked}</span> tracked pages directly —{' '}
          <span className="font-num text-bah-accent">{watch.changed}</span> changed since the last run.
        </div>
      )}
    </div>
  );
}

/** The one-line receipt the hunt leaves behind once real signals take the screen. */
export function HuntSummary({ hunt }) {
  const q = hunt?.queryProgress?.total || hunt?.queries?.length || 0;
  const s = hunt?.sourceHostTotal || hunt?.sourceHosts?.length || 0;
  if (!q && !s) return null;
  return (
    <p className="text-xs text-bah-muted">
      {q > 0 && <><span className="font-num">{q}</span> queries</>}
      {q > 0 && s > 0 && ' · '}
      {s > 0 && <><span className="font-num">{s}</span> sources read</>}
    </p>
  );
}

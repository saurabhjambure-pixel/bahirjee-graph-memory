import React, { useCallback, useEffect, useState } from 'react';
import { FileText, Scale } from 'lucide-react';
import CadenceBar from './CadenceBar';
import AgendaPanel from './AgendaPanel';
import ReadCard from './ReadCard';
import TargetList from './TargetList';
import TargetSetupScreen from './TargetSetupScreen';
import { listAgenda, openQuestion, retireQuestion, pinQuestion, recordFeedback } from '../../services/agendaService';
import { listReads, listRecentChecks, describeLastCheck } from '../../services/readsService';
import { setClientCadence } from '../../services/cadenceService';
import { listTargets, archiveTarget } from '../../services/targetService';
import { supabase } from '../../lib/supabase';

/**
 * The Desk — where a founder lands once Bahirjee knows their company.
 *
 * Before this, the product had exactly one founder route and it opened on a form asking
 * what to analyse. That is a tool. A colleague's desk is the opposite: you arrive and
 * find out what they have been doing since you last looked.
 *
 * Five bands, in the order a person actually reads them:
 *
 *   1. HEARTBEAT   proof Bahirjee was awake this morning, derived from the check ledger
 *   2. TODAY       a Read, or — far more often — a quiet-day greeting with two invitations
 *   3. TARGETS     what I'm watching: the company, and each product
 *   4. AGENDA      what Bahirjee is trying to find out, and the controls to redirect it
 *   5. STREAM      the dated Reads and briefs behind today
 *
 * ── The quiet day is the input day ───────────────────────────────────────────
 * Most mornings nothing clears the bar, and that silence is the product working. But
 * silence alone reads as a broken app, so a quiet day is where Bahirjee has spare capacity
 * and says so: here is what I read, nothing moved, what do you want me pointed at? The
 * feedback and steering loop lives on exactly the days there is no news to report.
 *
 * ── Honesty over decoration ──────────────────────────────────────────────────
 * Every claim on this screen traces to a recorded number. The heartbeat line is built from
 * daily_checks and is omitted entirely when there is nothing to back it — letterService
 * already refuses to claim pages-read it did not measure, and this screen holds the same
 * line.
 */
export default function Desk({
    client: clientProp = null,
    clientId,
    targetDomain,
    lastReadAt,
    sourcesWatched,
    onOpenBrief,
    onAskDecision,
    onCheckNow,
    isChecking = false,
    onRunTarget = null,
}) {
    const [agenda, setAgenda] = useState([]);
    const [reads, setReads] = useState([]);
    const [checks, setChecks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState({});
    const [client, setClient] = useState(clientProp);
    const [sourceCount, setSourceCount] = useState(0);
    const [cadenceError, setCadenceError] = useState(null);
    const [settingCadence, setSettingCadence] = useState(false);
    const [targets, setTargets] = useState([]);
    const [addingProduct, setAddingProduct] = useState(false);
    const [runningTargetId, setRunningTargetId] = useState(null);

    const load = useCallback(async () => {
        if (!clientId || !targetDomain) { setLoading(false); return; }
        const [a, r, c, t] = await Promise.all([
            listAgenda(clientId, targetDomain),
            listReads(clientId, targetDomain),
            listRecentChecks(clientId, targetDomain),
            listTargets(clientId),
        ]);
        setAgenda(a);
        setReads(r);
        setChecks(c);
        setTargets(t);
        setLoading(false);
    }, [clientId, targetDomain]);

    useEffect(() => { load(); }, [load]);

    // The cadence and the watched-source count are loaded here rather than threaded down
    // from the dashboard, because they exist only to make the heartbeat true and nothing
    // above needs them. Both fail soft: CadenceBar already renders "Not watching yet" for a
    // null client, and a source count of 0 is simply omitted — a gap beats a guess.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!supabase || !clientId) return;
            if (!clientProp) {
                const { data } = await supabase
                    .from('clients')
                    .select('id, auto_run_cadence, auto_run_last_queued_at')
                    .eq('id', clientId)
                    .maybeSingle();
                if (!cancelled && data) setClient(data);
            }
            const { count } = await supabase
                .from('entity_sources')
                .select('id, tracked_entities!inner(company_id)', { count: 'exact', head: true })
                .eq('tracked_entities.company_id', clientId)
                .eq('is_active', true);
            if (!cancelled && typeof count === 'number') setSourceCount(count);
        })().catch(() => { /* the Desk renders without either */ });
        return () => { cancelled = true; };
    }, [clientId, clientProp]);

    const lastCheck = checks[0] || null;
    const heartbeat = describeLastCheck(lastCheck);

    // "Today" is a Read from this morning's check, not merely the newest Read — a Read
    // from nine days ago is stream, not news, and presenting it as today's would be the
    // first small lie this screen tells.
    const todaysRead = lastCheck?.readId
        ? reads.find(r => r.id === lastCheck.readId) || null
        : null;
    const stream = reads.filter(r => r.id !== todaysRead?.id);

    const handleAdd = async (question) => {
        setBusy(true);
        // origin 'founder' outranks every other origin in the priority function: they asked
        // for it by name, which is the strongest signal of relevance the system can get.
        await openQuestion({ clientId, targetDomain, question, origin: 'founder' });
        await load();
        setBusy(false);
    };

    const handleRetire = async (item) => {
        // Optimistic: retiring is the control most likely to feel fake if it lags, and
        // agendaService guarantees it sticks even when a run regenerates the same question.
        setAgenda(prev => prev.filter(i => i.id !== item.id));
        await retireQuestion(item.id);
        load();
    };

    const handlePin = async (item, pinned) => {
        setAgenda(prev => prev.map(i => (i.id === item.id ? { ...i, pinned } : i)));
        await pinQuestion(item.id, pinned);
        load();
    };

    const handleSetCadence = async (value) => {
        setSettingCadence(true);
        setCadenceError(null);
        const result = await setClientCadence(clientId, value);
        if (result.ok) {
            // Reflect the saved row, not the requested value — the RPC is the authority on
            // what was actually stored, and showing the request would hide a silent no-op.
            setClient(prev => ({ ...(prev || {}), ...result.client }));
        } else {
            setCadenceError(result.message);
        }
        setSettingCadence(false);
    };

    const handleFeedback = async (read, verdict) => {
        setFeedback(prev => ({ ...prev, [read.id]: verdict }));
        // The loop that matters: this moves the priority of the Agenda question the Read
        // served, and sustained irrelevance retires it. A Read with no question behind it
        // still records the founder's reaction in the UI, but has nothing to steer.
        if (read.questionId) {
            await recordFeedback(read.questionId, verdict);
            load();
        }
    };

    const companyTarget = targets.find(t => t.type === 'company') || null;

    const handleRunTarget = async (target) => {
        if (!onRunTarget) return;
        setRunningTargetId(target.id);
        try {
            await onRunTarget(target);
        } finally {
            setRunningTargetId(null);
        }
    };

    const handleArchiveTarget = async (target) => {
        // Optimistic, like retiring an agenda item: archiving is a control that feels
        // fake if it lags, and it never deletes the briefs already produced.
        setTargets(prev => prev.filter(t => t.id !== target.id));
        await archiveTarget(target.id);
        load();
    };

    if (addingProduct && companyTarget) {
        return (
            <TargetSetupScreen
                clientId={clientId}
                targetDomain={targetDomain}
                parentTargetId={companyTarget.id}
                onCancel={() => setAddingProduct(false)}
                onSaved={() => { setAddingProduct(false); load(); }}
            />
        );
    }

    return (
        <div className="min-h-dvh flex flex-col">
            {/* 1. HEARTBEAT */}
            <CadenceBar
                client={client}
                lastReadAt={lastReadAt}
                sourcesWatched={sourcesWatched ?? sourceCount}
                onCheckNow={onCheckNow}
                isChecking={isChecking}
                onSetCadence={handleSetCadence}
                cadenceError={cadenceError}
                isSettingCadence={settingCadence}
            />

            <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 space-y-6">
                {/* 2. TODAY */}
                <section aria-labelledby="today-heading">
                    <h2 id="today-heading" className="text-[10px] uppercase tracking-widest text-bah-muted mb-2">
                        Today
                    </h2>

                    {loading ? (
                        <div className="bah-panel p-4">
                            <div className="bah-skeleton h-4 w-2/3 mb-2" />
                            <div className="bah-skeleton h-3 w-full" />
                        </div>
                    ) : todaysRead ? (
                        <ReadCard
                            read={todaysRead}
                            onFeedback={handleFeedback}
                            feedbackGiven={feedback[todaysRead.id]}
                        />
                    ) : (
                        <div className="bah-panel p-4">
                            {/* First person: this is Bahirjee talking, not chrome. */}
                            <p className="text-sm text-bah leading-relaxed">
                                {heartbeat
                                    ? `${heartbeat} Nothing worth interrupting you for.`
                                    : 'Nothing new to report this morning.'}
                            </p>
                            {lastCheck?.note && (
                                <p className="text-sm text-bah-muted leading-relaxed mt-1">{lastCheck.note}</p>
                            )}

                            <p className="text-sm text-bah-muted leading-relaxed mt-3">
                                Anything you want me pointed at?
                            </p>
                            <div className="flex items-center gap-2 flex-wrap mt-3">
                                {onAskDecision && (
                                    <button
                                        type="button"
                                        onClick={onAskDecision}
                                        className="bah-button-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
                                    >
                                        <Scale className="w-3.5 h-3.5" aria-hidden="true" />
                                        Help me decide something
                                    </button>
                                )}
                                {onOpenBrief && (
                                    <button
                                        type="button"
                                        // Explicitly no-arg: onClick would otherwise hand onOpenBrief the
                                        // DOM click event as its "target" argument. This invitation is
                                        // always about the COMPANY's own latest brief, never a product's.
                                        onClick={() => onOpenBrief()}
                                        className="bah-button-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
                                    >
                                        <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                                        Read the latest brief
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </section>

                {/* 3. TARGETS — conditional, so an un-migrated deployment renders a clean
                    Desk rather than an empty heading, and so a half-loaded/failed fetch
                    (targets still []) never shows a bare "Only your company so far" line
                    with no company card above it. Same discipline as the heartbeat and the
                    stream band below. */}
                {targets.length > 0 && (
                    <TargetList
                        targets={targets}
                        onRun={handleRunTarget}
                        // Forward TargetCard's target argument rather than discarding it —
                        // otherwise a click on ANY card (company or product) always opens
                        // the company's own latest report, presented under whichever
                        // card's name the founder clicked.
                        onOpenBrief={onOpenBrief}
                        onArchive={handleArchiveTarget}
                        onAddProduct={companyTarget ? () => setAddingProduct(true) : null}
                        runningTargetId={runningTargetId}
                    />
                )}

                {/* 4. AGENDA */}
                <AgendaPanel
                    items={agenda}
                    onAdd={handleAdd}
                    onRetire={handleRetire}
                    onPin={handlePin}
                    busy={busy}
                />

                {/* 5. STREAM */}
                {stream.length > 0 && (
                    <section aria-labelledby="stream-heading">
                        <h2 id="stream-heading" className="text-[10px] uppercase tracking-widest text-bah-muted mb-2">
                            Earlier
                        </h2>
                        <div className="space-y-3">
                            {stream.map((read, i) => (
                                <ReadCard
                                    key={read.id}
                                    read={read}
                                    index={i}
                                    onFeedback={handleFeedback}
                                    feedbackGiven={feedback[read.id]}
                                />
                            ))}
                        </div>
                    </section>
                )}
            </main>
        </div>
    );
}

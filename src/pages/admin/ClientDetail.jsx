import React, { useState, useEffect, useRef } from 'react';
import { CADENCE_OPTIONS, setClientCadence } from '../../services/cadenceService';
import { describeCadence, nextScheduledRead, relativeDays } from '../../services/cadence';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { ArrowLeft, User, Shield, CheckCircle, XCircle, Loader2, Trash2, FileText, Zap, Eye, ChevronDown, Ban, Inbox } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { getIntelligenceJob, submitIntelligenceJob, resumeIntelligenceJob } from '../../services/intelligenceJobService';
import ContextReviewScreen from '../../components/intelligence/ContextReviewScreen';
import { postJson } from '../../services/apiClient';
import {
    getAccessLogByClient,
    getBlockedEmails,
    blockEmail,
    unblockEmail,
    getAccessRequests,
    approveAccessRequest,
    denyAccessRequest
} from '../../services/briefAccessService';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

export default function ClientDetail() {
    const { clientId } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();

    const [client, setClient] = useState(null);
    const [cadenceBusy, setCadenceBusy] = useState(false);
    const [cadenceMsg, setCadenceMsg] = useState(null);

    // Admins bypass the entitlement gate in the v29 RPC (`is_admin()` short-circuits it),
    // which is deliberate: an admin turning a cadence on for a client is a provisioning
    // decision, not a purchase. The founder-facing control in the Desk is the one the
    // paywall applies to.
    const handleCadence = async (value) => {
        setCadenceBusy(true);
        setCadenceMsg(null);
        const result = await setClientCadence(clientId, value);
        if (result.ok) setClient(prev => ({ ...prev, ...result.client }));
        else setCadenceMsg(result.message);
        setCadenceBusy(false);
    };
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [allowlist, setAllowlist] = useState([]);
    const [allowlistLoading, setAllowlistLoading] = useState(true);

    // New User Form State
    const [isCreatingUser, setIsCreatingUser] = useState(false);
    const [newUserEmail, setNewUserEmail] = useState('');
    const [newUserName, setNewUserName] = useState('');
    const [isAddingAllowlist, setIsAddingAllowlist] = useState(false);
    const [allowlistEmail, setAllowlistEmail] = useState('');
    const [allowlistRole, setAllowlistRole] = useState('client_user');

    // Reports & Intelligence State
    const [reports, setReports] = useState([]);
    const [reportsLoading, setReportsLoading] = useState(true);
    const [isRunningIntelligence, setIsRunningIntelligence] = useState(false);
    const [intelligenceUrl, setIntelligenceUrl] = useState('');
    const [activeJobId, setActiveJobId] = useState(null);
    const [intelligencePhase, setIntelligencePhase] = useState('idle'); // idle | context | review | analyzing | done | error
    // The server now pauses admin runs for context review too, so an admin can see and
    // correct what a run is about to be built on instead of being the one person who cannot.
    const [reviewContext, setReviewContext] = useState(null);
    const [isConfirmingContext, setIsConfirmingContext] = useState(false);
    // The poll effect stops when the job parks for review. Bumping this restarts it —
    // re-setting activeJobId to the same value is a no-op React bails out of.
    const [pollNonce, setPollNonce] = useState(0);
    const [intelligenceProgress, setIntelligenceProgress] = useState([]);
    const progressEndRef = useRef(null);

    // Brief sharing: who opened what, who's blocked, who's asking for access.
    const [accessLog, setAccessLog] = useState({});
    const [expandedReportId, setExpandedReportId] = useState(null);
    const [blockedEmails, setBlockedEmails] = useState([]);
    const [isAddingBlock, setIsAddingBlock] = useState(false);
    const [blockEmailInput, setBlockEmailInput] = useState('');
    const [blockReasonInput, setBlockReasonInput] = useState('');
    const [accessRequests, setAccessRequests] = useState([]);

    useEffect(() => {
        fetchClientData();
        fetchAllowlist();
        fetchReports();
        fetchSharingData();
    }, [clientId]);

    useEffect(() => {
        if (!activeJobId) return;

        let cancelled = false;
        let timerId = null;

        const pollJob = async () => {
            try {
                const job = await getIntelligenceJob(activeJobId);
                if (cancelled) return;

                setIntelligenceProgress((job.progress_log || []).map(entry => entry.message));

                if (job.status === 'completed') {
                    setIsRunningIntelligence(false);
                    setIntelligencePhase('done');
                    toast.success('Intelligence analysis complete!');
                    setIntelligenceUrl('');
                    fetchReports();
                    return;
                }

                // Without this branch the job sits in awaiting_context_review and the page
                // spins until the tab is closed — the pause has no meaning if nothing
                // surfaces it.
                if (job.status === 'awaiting_context_review') {
                    setReviewContext(job.context_for_review || null);
                    setIntelligencePhase('review');
                    setIsRunningIntelligence(false);
                    return;
                }

                if (job.status === 'failed') {
                    setIsRunningIntelligence(false);
                    setIntelligencePhase('error');
                    toast.error(job.error_message || 'Analysis failed');
                    return;
                }
            } catch (error) {
                if (cancelled) return;
                setIsRunningIntelligence(false);
                setIntelligencePhase('error');
                addProgress(`Error: ${error.message}`);
                toast.error(error.message || 'Analysis failed');
                return;
            }

            timerId = setTimeout(pollJob, 3000);
        };

        void pollJob();

        return () => {
            cancelled = true;
            if (timerId) clearTimeout(timerId);
        };
    }, [activeJobId, pollNonce]);

    const callAdminUserApi = async (action, payload) => {
        // Routed through the shared apiClient so auth headers + 401 handling are consistent.
        const response = await postJson(`${API_BASE}/admin-users`, { action, payload });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(json.error || `Admin API failed (${response.status})`);
        return json;
    };

    const fetchClientData = async () => {
        try {
            if (!supabase) throw new Error('Supabase not configured');
            // 1. Fetch Client Details
            const { data: clientData, error: clientError } = await supabase
                .from('clients')
                .select('*')
                .eq('id', clientId)
                .single();

            if (clientError) throw clientError;
            setClient(clientData);

            // 2. Fetch Associated Users
            const { data: userData, error: userError } = await supabase
                .from('profiles')
                .select('*')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false });

            if (userError) throw userError;
            setUsers(userData);

        } catch (error) {
            toast.error('Failed to load client details');
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const fetchAllowlist = async () => {
        setAllowlistLoading(true);
        try {
            if (!supabase) throw new Error('Supabase not configured');
            const { data, error } = await supabase
                .from('email_allowlist')
                .select('*')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setAllowlist(data || []);
        } catch (error) {
            console.error(error);
            toast.error('Failed to load allowlist');
        } finally {
            setAllowlistLoading(false);
        }
    };

    const addAllowlistEntry = async (e) => {
        e.preventDefault();
        try {
            if (!supabase) throw new Error('Supabase not configured');
            const email = allowlistEmail.trim().toLowerCase();
            if (!email) throw new Error('Email is required');

            // email is a GLOBAL primary key, so a blind upsert would silently move an
            // address that already belongs to another client. Check first and refuse.
            const { data: existing, error: lookupError } = await supabase
                .from('email_allowlist')
                .select('email, client_id')
                .eq('email', email)
                .maybeSingle();
            if (lookupError) throw lookupError;
            if (existing && existing.client_id && existing.client_id !== clientId) {
                throw new Error('That email is already assigned to a different client.');
            }

            const { error } = await supabase
                .from('email_allowlist')
                .upsert({
                    email,
                    client_id: clientId,
                    role: allowlistRole,
                    is_active: true
                }, { onConflict: 'email' });

            if (error) throw error;
            toast.success('Allowlist entry saved');
            setAllowlistEmail('');
            setAllowlistRole('client_user');
            setIsAddingAllowlist(false);
            fetchAllowlist();
        } catch (error) {
            toast.error(error.message || 'Failed to save allowlist entry');
        }
    };

    const toggleAllowlistStatus = async (email, isActive) => {
        try {
            // Scope to this client so an address owned by another client can't be touched.
            const { error } = await supabase
                .from('email_allowlist')
                .update({ is_active: !isActive })
                .eq('email', email)
                .eq('client_id', clientId);
            if (error) throw error;
            setAllowlist(allowlist.map(entry => entry.email === email ? { ...entry, is_active: !isActive } : entry));
            toast.success(`Allowlist ${!isActive ? 'enabled' : 'disabled'}`);
        } catch (error) {
            toast.error(error.message || 'Failed to update allowlist');
        }
    };

    const removeAllowlistEntry = async (email) => {
        if (!window.confirm("Remove this allowlist entry?")) return;
        try {
            const { error } = await supabase
                .from('email_allowlist')
                .delete()
                .eq('email', email)
                .eq('client_id', clientId);
            if (error) throw error;
            setAllowlist(allowlist.filter(entry => entry.email !== email));
            toast.success('Allowlist entry removed');
        } catch (error) {
            toast.error(error.message || 'Failed to remove allowlist entry');
        }
    };

    const fetchReports = async () => {
        setReportsLoading(true);
        try {
            if (!supabase) throw new Error('Supabase not configured');
            const { data, error } = await supabase
                .from('reports')
                .select('*')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setReports((data || []).map(report => ({
                ...report,
                company_name: report.context?.company_name || report.company_name || report.title || report.website_url,
                status: 'completed'
            })));
        } catch (error) {
            console.error('Failed to fetch reports:', error);
            toast.error('Failed to load reports');
        } finally {
            setReportsLoading(false);
        }
    };

    const fetchSharingData = async () => {
        const [log, blocks, requests] = await Promise.all([
            getAccessLogByClient(clientId),
            getBlockedEmails(clientId),
            getAccessRequests(clientId)
        ]);
        setAccessLog(log);
        setBlockedEmails(blocks);
        setAccessRequests(requests);
    };

    const handleBlockEmail = async (e) => {
        e.preventDefault();
        try {
            await blockEmail(clientId, blockEmailInput, blockReasonInput.trim() || null);
            toast.success('Email blocked from this client\'s briefs');
            setBlockEmailInput('');
            setBlockReasonInput('');
            setIsAddingBlock(false);
            fetchSharingData();
        } catch (error) {
            toast.error(error.message || 'Failed to block email');
        }
    };

    const handleUnblockEmail = async (email) => {
        try {
            await unblockEmail(clientId, email);
            toast.success('Block removed');
            fetchSharingData();
        } catch (error) {
            toast.error(error.message || 'Failed to remove block');
        }
    };

    const handleApproveRequest = async (request) => {
        try {
            await approveAccessRequest(request);
            toast.success(`${request.email} can now view this client's briefs`);
            fetchSharingData();
            fetchAllowlist();
        } catch (error) {
            toast.error(error.message || 'Failed to approve request');
        }
    };

    const handleDenyRequest = async (request) => {
        try {
            await denyAccessRequest(request);
            toast.success('Request denied');
            fetchSharingData();
        } catch (error) {
            toast.error(error.message || 'Failed to deny request');
        }
    };

    const addProgress = (msg) => {
        setIntelligenceProgress(prev => [...prev, msg]);
        // Auto-scroll to latest message
        setTimeout(() => progressEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    const runIntelligence = async (e) => {
        e.preventDefault();
        const url = intelligenceUrl.trim();
        if (!url) {
            toast.error('Please enter a company website URL');
            return;
        }
        // Basic URL validation / normalization
        const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
        try { new URL(normalizedUrl); } catch {
            toast.error('Please enter a valid URL (e.g. https://acme.com)');
            return;
        }

        if (!user) {
            toast.error('No active session — please refresh and try again');
            return;
        }

        setIsRunningIntelligence(true);
        setActiveJobId(null);
        setIntelligencePhase('context');
        setIntelligenceProgress([]);

        try {
            addProgress('Submitting server-side intelligence job...');
            const job = await submitIntelligenceJob({
                websiteUrl: normalizedUrl,
                clientId,
                buildContextOnServer: true
            });
            setActiveJobId(job.id);
            setIntelligencePhase('analyzing');
            setIntelligenceProgress((job.progress_log || []).map(entry => entry.message));
        } catch (error) {
            setIntelligencePhase('error');
            addProgress(`Error: ${error.message}`);
            toast.error(error.message || 'Analysis failed');
            console.error(error);
        }
    };

    const confirmAdminContext = async () => {
        if (!activeJobId || isConfirmingContext) return;
        setIsConfirmingContext(true);
        try {
            await resumeIntelligenceJob(activeJobId, reviewContext);
            setReviewContext(null);
            setIntelligencePhase('analyzing');
            setIsRunningIntelligence(true);
            addProgress('Context confirmed — analysis resumed.');
            setPollNonce(n => n + 1);
        } catch (error) {
            setIntelligencePhase('error');
            toast.error(error.message || 'Could not resume the analysis');
        } finally {
            setIsConfirmingContext(false);
        }
    };

    const createUser = async (e) => {
        e.preventDefault();
        try {
            await callAdminUserApi('createUser', {
                email: newUserEmail,
                fullName: newUserName,
                clientId
            });

            toast.success('User invited — they can now sign in with a magic link');
            setNewUserEmail('');
            setNewUserName('');
            setIsCreatingUser(false);
            fetchClientData(); // Refresh list
        } catch (error) {
            toast.error(error.message || 'Failed to create user');
            console.error(error);
        }
    };

    const toggleUserStatus = async (userId, currentStatus) => {
        try {
            await callAdminUserApi('setUserStatus', {
                userId,
                isActive: !currentStatus
            });

            toast.success(`User ${!currentStatus ? 'activated' : 'suspended'}`);
            // Optimistic update
            setUsers(users.map(u => u.id === userId ? { ...u, is_active: !currentStatus } : u));
        } catch (error) {
            toast.error('Failed to update user status');
        }
    };

    const deleteUser = async (userId) => {
        if (!window.confirm("Are you sure? This will remove the user's access profile.")) return;
        try {
            await callAdminUserApi('deleteUser', { userId });

            toast.success('User removed from organization');
            setUsers(users.filter(u => u.id !== userId));
        } catch (error) {
            toast.error('Failed to delete user');
            console.error(error);
        }
    };

    if (loading) return <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-bah-accent" /></div>;
    if (!client) return <div className="p-8 text-slate-400">Client not found</div>;

    // A paused run takes over the page. It is a blocking decision — the job is parked
    // server-side until it is answered — so burying it in a panel below the fold would
    // just reproduce the old "it seems stuck" behaviour with extra steps.
    if (intelligencePhase === 'review' && reviewContext) {
        return (
            <ContextReviewScreen
                contextData={reviewContext}
                setContextData={setReviewContext}
                onboardingData={reviewContext._onboardingData || null}
                finalReport={null}
                setPhase={() => { setReviewContext(null); setIntelligencePhase('idle'); setActiveJobId(null); }}
                handleConfirmContext={confirmAdminContext}
                isConfirming={isConfirmingContext}
                analysisMode={reviewContext._decision ? 'decision' : 'company'}
            />
        );
    }

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <button
                onClick={() => navigate('/admin/clients')}
                className="flex items-center gap-2 text-slate-400 hover:text-white mb-6 transition-colors"
            >
                <ArrowLeft size={16} /> Back to Clients
            </button>

            {/* Header */}
            <div className="bah-panel p-6 mb-8">
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-display font-semibold text-white mb-2">{client.name}</h1>
                        <div className="flex items-center gap-4 text-slate-400">
                            <span className="bg-slate-800 px-2 py-1 rounded text-xs font-mono">{client.domain}</span>
                            <span className="text-sm">ID: {client.id}</span>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-xs text-slate-500 uppercase font-medium mb-1">Status</div>
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide border ${client.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                            }`}>
                            {client.status === 'active' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                            {client.status}
                        </span>
                    </div>
                </div>

                {/* ── Reading cadence ──────────────────────────────────────────
                    This column has existed since v18 and nothing has ever written it,
                    which is why /api/cron-runs has fired every Monday since and queued
                    nothing. Both crons filter on it, so until it is set here (or by the
                    founder on their Desk) NOTHING scheduled runs for this client. */}
                <div className="mt-6 pt-6 border-t border-bah">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="min-w-0">
                            <div className="text-xs text-bah-muted uppercase font-medium mb-1">Reading cadence</div>
                            <p className="text-sm text-bah">
                                {describeCadence(client.auto_run_cadence)}
                                {nextScheduledRead(client) && (
                                    <span className="text-bah-muted-2"> · next {relativeDays(nextScheduledRead(client))}</span>
                                )}
                            </p>
                            <p className="text-xs text-bah-muted-2 mt-1">
                                {client.auto_run_cadence && client.auto_run_cadence !== 'off'
                                    ? 'A full run is queued on schedule, and the daily ladder checks watched pages each morning.'
                                    : 'Nothing scheduled runs for this client until a cadence is set.'}
                            </p>
                            {cadenceMsg && <p className="text-xs text-bah-warning mt-1" role="status">{cadenceMsg}</p>}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            {CADENCE_OPTIONS.map(opt => {
                                const active = (client.auto_run_cadence ?? 'off') === opt.value;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => handleCadence(opt.value)}
                                        disabled={cadenceBusy || active}
                                        title={opt.detail}
                                        className={active ? 'bah-button-primary px-3 py-1.5 text-xs' : 'bah-button-secondary px-3 py-1.5 text-xs disabled:opacity-50'}
                                    >
                                        {opt.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            {/* Users Section */}
            <div>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <User className="text-bah-accent" size={20} />
                        Team Members ({users.length})
                    </h2>
                    <button
                        onClick={() => setIsCreatingUser(!isCreatingUser)}
                        className="bah-button-primary px-4 py-2 text-sm"
                    >
                        <User size={16} />
                        {isCreatingUser ? 'Cancel' : 'Add Team Member'}
                    </button>
                </div>

                {/* Create User Form */}
                {isCreatingUser && (
                    <div className="bah-panel p-6 mb-6">
                        <h3 className="text-lg font-display font-semibold text-white mb-1">Invite Team Member</h3>
                        <p className="text-xs text-slate-500 mb-4">They'll sign in passwordlessly with a magic link — no password needed.</p>
                        <form onSubmit={createUser} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Full Name</label>
                                <input
                                    type="text"
                                    value={newUserName}
                                    onChange={(e) => setNewUserName(e.target.value)}
                                    placeholder="John Doe"
                                    required
                                    className="bah-input-strong"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Email</label>
                                <input
                                    type="email"
                                    value={newUserEmail}
                                    onChange={(e) => setNewUserEmail(e.target.value)}
                                    placeholder={`user@${client.domain}`}
                                    required
                                    className="bah-input-strong"
                                />
                            </div>
                            <div className="md:col-span-2 flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIsCreatingUser(false)}
                                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="bah-button-primary px-4 py-2"
                                >
                                    Invite User
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                <div className="bah-panel overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-bah-panel-strong-50 border-b border-bah text-xs text-slate-500 uppercase tracking-wider">
                                <th className="p-4 font-medium">User</th>
                                <th className="p-4 font-medium">Role</th>
                                <th className="p-4 font-medium">Joined</th>
                                <th className="p-4 font-medium">Status</th>
                                <th className="p-4 font-medium text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--bah-border)]">
                            {users.map(user => (
                                <tr key={user.id} className="hover:bg-[rgba(24,32,29,0.5)] transition-colors">
                                    <td className="p-4">
                                        <div className="flex flex-col">
                                            <span className="font-medium text-slate-200">{user.full_name || 'Unknown Name'}</span>
                                            {/* Note: Email is in auth.users, profiles linked by ID. 
                                                For simply showing email here, we'd need to join auth.users which needs admin privileges or special RLS.
                                                Assuming profiles might copy email or we rely on name for now. 
                                                Supabase Auth API usually required for email listing.
                                            */}
                                            <span className="text-xs text-slate-500 font-mono text-ellipsis overflow-hidden w-48">{user.id}</span>
                                        </div>
                                    </td>
                                    <td className="p-4">
                                        <span className={`${user.role === 'admin'
                                            ? 'bah-badge-cyan'
                                            : 'bg-slate-800 text-slate-400 border-slate-700'
                                            } inline-flex px-2 py-1 rounded text-xs font-medium border`}>
                                            {user.role}
                                        </span>
                                    </td>
                                    <td className="p-4 text-sm text-slate-400">
                                        {new Date(user.created_at).toLocaleDateString()}
                                    </td>
                                    <td className="p-4">
                                        <button
                                            onClick={() => toggleUserStatus(user.id, user.is_active)}
                                            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded border transition-colors ${user.is_active
                                                ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10'
                                                : 'text-red-400 border-red-500/20 bg-red-500/5 hover:bg-red-500/10'
                                                }`}
                                        >
                                            {user.is_active ? <CheckCircle size={12} /> : <Shield size={12} />}
                                            {user.is_active ? 'Active' : 'Suspended'}
                                        </button>
                                    </td>
                                    <td className="p-4 text-right">
                                        <button
                                            onClick={() => deleteUser(user.id)}
                                            className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                                            title="Revoke Access (Delete Profile)"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {users.length === 0 && (
                                <tr>
                                    <td colSpan="5" className="p-8 text-center text-slate-500">
                                        No users have joined this organization yet.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Allowlist Exceptions */}
            <div className="mt-10">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Shield className="text-bah-cyan" size={20} />
                        Email Exceptions ({allowlist.length})
                    </h2>
                    <button
                        onClick={() => setIsAddingAllowlist(!isAddingAllowlist)}
                        className="bah-button-primary px-4 py-2 text-sm"
                    >
                        {isAddingAllowlist ? 'Cancel' : 'Add Exception'}
                    </button>
                </div>

                <p className="text-xs text-slate-500 mb-3">
                    Use this to grant access to individual emails that should bypass domain whitelisting.
                </p>

                {isAddingAllowlist && (
                    <div className="bah-panel p-6 mb-6">
                        <h3 className="text-lg font-display font-semibold text-white mb-4">Add Allowlist Email</h3>
                        <form onSubmit={addAllowlistEntry} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Email</label>
                                <input
                                    type="email"
                                    value={allowlistEmail}
                                    onChange={(e) => setAllowlistEmail(e.target.value)}
                                    placeholder="person@example.com"
                                    required
                                    className="bah-input-strong"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Role</label>
                                <select
                                    value={allowlistRole}
                                    onChange={(e) => setAllowlistRole(e.target.value)}
                                    className="bah-input-strong"
                                >
                                    <option value="client_user">Client User</option>
                                    <option value="admin">Admin</option>
                                </select>
                            </div>
                            <div className="md:col-span-3 flex justify-end gap-3">
                                <button type="submit" className="bah-button-primary px-4 py-2 text-sm">
                                    Save Exception
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                <div className="bah-panel p-4">
                    {allowlistLoading ? (
                        <div className="text-slate-500 text-sm">Loading allowlist…</div>
                    ) : allowlist.length === 0 ? (
                        <div className="text-slate-500 text-sm">No email exceptions yet.</div>
                    ) : (
                        <div className="space-y-3">
                            {allowlist.map(entry => (
                                <div key={entry.email} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-white/5 rounded-lg p-3">
                                    <div>
                                        <div className="text-slate-200 text-sm">{entry.email}</div>
                                        <div className="text-xs text-slate-500 uppercase tracking-wide">{entry.role}</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => toggleAllowlistStatus(entry.email, entry.is_active)}
                                            className={`px-3 py-1 rounded text-xs font-medium border ${entry.is_active ? 'text-emerald-400 border-emerald-500/30' : 'text-slate-400 border-slate-600/50'}`}
                                        >
                                            {entry.is_active ? 'Active' : 'Inactive'}
                                        </button>
                                        <button
                                            onClick={() => removeAllowlistEntry(entry.email)}
                                            className="px-3 py-1 rounded text-xs font-medium border border-red-500/30 text-red-400"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Access Requests — people outside the client domain asking to see a brief */}
            {accessRequests.filter(r => r.status === 'pending').length > 0 && (
                <div className="mt-10">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <Inbox className="text-bah-cyan" size={20} />
                            Access Requests ({accessRequests.filter(r => r.status === 'pending').length})
                        </h2>
                    </div>
                    <p className="text-xs text-slate-500 mb-3">
                        People whose email domain doesn't match this client have asked to open a brief.
                        Approving grants them view-only access to this client's briefs.
                    </p>
                    <div className="bah-panel p-4">
                        <div className="space-y-3">
                            {accessRequests.filter(r => r.status === 'pending').map(request => (
                                <div key={request.id} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-white/5 rounded-lg p-3">
                                    <div className="min-w-0">
                                        <div className="text-slate-200 text-sm truncate">{request.email}</div>
                                        <div className="text-xs text-slate-500">
                                            Requested {new Date(request.created_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button
                                            onClick={() => handleApproveRequest(request)}
                                            className="px-3 py-1 rounded text-xs font-medium border text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10 transition-colors"
                                        >
                                            Approve
                                        </button>
                                        <button
                                            onClick={() => handleDenyRequest(request)}
                                            className="px-3 py-1 rounded text-xs font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                                        >
                                            Deny
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Blocked Emails — always wins over domain match and any grant */}
            <div className="mt-10">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <Ban className="text-bah-cyan" size={20} />
                        Blocked Emails ({blockedEmails.length})
                    </h2>
                    <button
                        onClick={() => setIsAddingBlock(!isAddingBlock)}
                        className="bah-button-primary px-4 py-2 text-sm"
                    >
                        {isAddingBlock ? 'Cancel' : 'Block Email'}
                    </button>
                </div>
                <p className="text-xs text-slate-500 mb-3">
                    Denies these addresses access to this client's briefs — even if their email domain
                    matches, and even if they were previously granted access.
                </p>

                {isAddingBlock && (
                    <div className="bah-panel p-6 mb-6">
                        <form onSubmit={handleBlockEmail} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Email</label>
                                <input
                                    type="email"
                                    value={blockEmailInput}
                                    onChange={(e) => setBlockEmailInput(e.target.value)}
                                    placeholder={`someone@${client.domain || 'example.com'}`}
                                    required
                                    className="bah-input-strong"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-2 uppercase font-medium">Reason (optional)</label>
                                <input
                                    type="text"
                                    value={blockReasonInput}
                                    onChange={(e) => setBlockReasonInput(e.target.value)}
                                    placeholder="Left the company"
                                    className="bah-input-strong"
                                />
                            </div>
                            <div className="md:col-span-3 flex justify-end">
                                <button type="submit" className="bah-button-primary px-4 py-2 text-sm">
                                    Block Email
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                <div className="bah-panel p-4">
                    {blockedEmails.length === 0 ? (
                        <p className="text-slate-500 text-sm">No blocked emails.</p>
                    ) : (
                        <div className="space-y-3">
                            {blockedEmails.map(block => (
                                <div key={block.email} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-white/5 rounded-lg p-3">
                                    <div className="min-w-0">
                                        <div className="text-slate-200 text-sm truncate">{block.email}</div>
                                        <div className="text-xs text-slate-500">
                                            {block.reason || 'No reason given'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleUnblockEmail(block.email)}
                                        className="px-3 py-1 rounded text-xs font-medium border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
                                    >
                                        Unblock
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Reports History Section */}
            <div className="mt-10">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <FileText className="text-emerald-400" size={20} />
                            Generated Reports ({reports.length})
                        </h2>
                        <div className="group relative">
                            <div className="w-5 h-5 rounded-full bg-bah-cyan/20 border border-bah-cyan/50 flex items-center justify-center text-xs text-bah-cyan font-bold cursor-help">?</div>
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-slate-950 border border-bah-cyan/30 rounded-lg p-3 text-xs text-slate-300 whitespace-nowrap z-10">
                                <p className="mb-1 font-semibold text-bah-cyan">Report Status:</p>
                                <ul className="space-y-1 text-slate-400">
                                    <li><span className="text-amber-400">⏳ Pending</span> - Analysis in queue</li>
                                    <li><span className="text-amber-400">⚙️ Processing</span> - Currently analyzing</li>
                                    <li><span className="text-emerald-400">✓ Completed</span> - Ready to view</li>
                                    <li><span className="text-red-400">✕ Failed</span> - Error occurred</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={fetchReports}
                        className="bah-button-secondary px-4 py-2 text-sm"
                        disabled={reportsLoading}
                    >
                        {reportsLoading ? <Loader2 className="animate-spin" size={16} /> : 'Refresh'}
                    </button>
                </div>

                <div className="bah-panel overflow-hidden">
                    {reportsLoading ? (
                        <div className="flex justify-center items-center h-32 text-slate-500">
                            <Loader2 className="animate-spin mr-2" size={18} />
                            Loading reports…
                        </div>
                    ) : reports.length === 0 ? (
                        <div className="p-8 text-center text-slate-500">
                            <FileText size={36} className="mx-auto mb-3 opacity-30" />
                            <p>No reports generated yet for this client.</p>
                        </div>
                    ) : (
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-bah-panel-strong-50 border-b border-bah text-xs text-slate-500 uppercase tracking-wider">
                                    <th className="p-4 font-medium">Company</th>
                                    <th className="p-4 font-medium">Generated</th>
                                    <th className="p-4 font-medium">Viewers</th>
                                    <th className="p-4 font-medium">Status</th>
                                    <th className="p-4 font-medium text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--bah-border)]">
                                {reports.map(report => {
                                  const viewers = accessLog[report.id] || [];
                                  const isExpanded = expandedReportId === report.id;
                                  return (
                                    <React.Fragment key={report.id}>
                                    <tr className="hover:bg-[rgba(24,32,29,0.5)] transition-colors">
                                        <td className="p-4">
                                            <div className="flex flex-col">
                                                <span className="font-medium text-slate-200">{report.company_name || report.title || 'Untitled'}</span>
                                                <span className="text-xs text-slate-500 font-mono">{report.id.slice(0, 12)}…</span>
                                            </div>
                                        </td>
                                        <td className="p-4 text-sm text-slate-400">
                                            {new Date(report.created_at).toLocaleDateString()} {new Date(report.created_at).toLocaleTimeString()}
                                        </td>
                                        <td className="p-4">
                                            {viewers.length === 0 ? (
                                                <span className="text-xs text-slate-600">No views yet</span>
                                            ) : (
                                                <button
                                                    onClick={() => setExpandedReportId(isExpanded ? null : report.id)}
                                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-bah-accent transition-colors"
                                                    title="Show the emails that opened this brief"
                                                >
                                                    <Eye size={13} />
                                                    {viewers.length} {viewers.length === 1 ? 'viewer' : 'viewers'}
                                                    <ChevronDown size={13} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                                </button>
                                            )}
                                        </td>
                                        <td className="p-4">
                                            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border ${report.status === 'completed'
                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                : report.status === 'processing'
                                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                                : report.status === 'pending'
                                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                                : 'bg-red-500/10 text-red-400 border-red-500/20'
                                                }`}>
                                                {report.status === 'completed' && <CheckCircle size={12} />}
                                                {report.status === 'processing' && <Loader2 className="animate-spin" size={12} />}
                                                {report.status === 'pending' && <Loader2 className="animate-spin" size={12} />}
                                                {report.status === 'failed' && <XCircle size={12} />}
                                                {report.status || 'pending'}
                                            </span>
                                        </td>
                                        <td className="p-4 text-right">
                                            {report.status === 'completed' ? (
                                                <a
                                                    href={report.share_token ? `/report/${report.share_token}` : '#'}
                                                    target={report.share_token ? '_blank' : undefined}
                                                    rel={report.share_token ? 'noopener noreferrer' : undefined}
                                                    className="inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-bah-cyan border border-bah-cyan/30 hover:bg-bah-cyan/10 transition-colors"
                                                >
                                                    <Eye size={14} />
                                                    View
                                                </a>
                                            ) : (
                                                <button
                                                    disabled
                                                    className="inline-flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-slate-500 border border-slate-700/50 bg-slate-900/30 cursor-not-allowed"
                                                    title={`Report is ${report.status}. Check back when processing completes.`}
                                                >
                                                    <Eye size={14} />
                                                    {report.status === 'processing' ? 'Processing...' : 'Not Ready'}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                    {isExpanded && (
                                        <tr className="bg-[rgba(24,32,29,0.4)]">
                                            <td colSpan="5" className="px-4 pb-4 pt-0">
                                                <div className="rounded-lg border border-bah overflow-hidden">
                                                    <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-slate-500 bg-bah-panel-strong-50 flex justify-between">
                                                        <span>Email</span>
                                                        <span>Opens · First · Last</span>
                                                    </div>
                                                    {viewers.map(v => (
                                                        <div key={v.email} className="px-4 py-2 flex items-center justify-between gap-4 border-t border-bah text-sm">
                                                            <span className="text-slate-300 truncate">{v.email}</span>
                                                            <div className="flex items-center gap-3 shrink-0">
                                                                <span className="text-xs text-slate-500">
                                                                    {v.count}× · {new Date(v.firstSeen).toLocaleDateString()} · {new Date(v.lastSeen).toLocaleDateString()}
                                                                </span>
                                                                <button
                                                                    onClick={async () => {
                                                                        try {
                                                                            await blockEmail(clientId, v.email);
                                                                            toast.success(`${v.email} blocked`);
                                                                            fetchSharingData();
                                                                        } catch (err) {
                                                                            toast.error(err.message || 'Failed to block');
                                                                        }
                                                                    }}
                                                                    className="px-2 py-1 rounded text-[11px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                                                                >
                                                                    Block
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                    </React.Fragment>
                                  );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {/* Run Intelligence Section */}
            <div className="mt-10">
                <div className="bah-panel p-6">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2 mb-4">
                        <Zap className="text-amber-400" size={20} />
                        Run Intelligence Analysis
                    </h2>
                    <p className="text-sm text-slate-400 mb-4">
                        Generate a new intelligence brief for any company. The job runs server-side in the background while this page polls for progress. The completed report will appear in this client's report history.
                    </p>
                    <form onSubmit={runIntelligence} className="flex gap-3">
                        <input
                            type="text"
                            value={intelligenceUrl}
                            onChange={(e) => setIntelligenceUrl(e.target.value)}
                            placeholder="Company website URL (e.g., https://acme.com)"
                            className="bah-input-strong flex-1"
                            disabled={isRunningIntelligence}
                        />
                        <button
                            type="submit"
                            className="bah-button-primary px-6 py-2 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={isRunningIntelligence}
                        >
                            {isRunningIntelligence ? (
                                <>
                                    <Loader2 className="animate-spin" size={16} />
                                    {intelligencePhase === 'context' ? 'Queueing Job…' : 'Analyzing…'}
                                </>
                            ) : (
                                <>
                                    <Zap size={16} />
                                    Run Analysis
                                </>
                            )}
                        </button>
                    </form>

                    {/* Live Progress Log */}
                    {intelligenceProgress.length > 0 && (
                        <div className="mt-5">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Live Progress</span>
                                {intelligencePhase === 'done' && <span className="text-xs text-emerald-400 font-medium">✓ Complete</span>}
                                {intelligencePhase === 'error' && <span className="text-xs text-red-400 font-medium">✕ Failed</span>}
                                {(intelligencePhase === 'context' || intelligencePhase === 'analyzing') && (
                                    <Loader2 className="animate-spin text-bah-accent" size={12} />
                                )}
                            </div>
                            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-4 max-h-56 overflow-y-auto font-mono text-xs space-y-1">
                                {intelligenceProgress.map((msg, i) => (
                                    <div
                                        key={i}
                                        className={`leading-relaxed ${
                                            msg.toLowerCase().startsWith('error')
                                                ? 'text-red-400'
                                                : i === intelligenceProgress.length - 1 && intelligencePhase !== 'done'
                                                ? 'text-bah-accent'
                                                : 'text-slate-400'
                                        }`}
                                    >
                                        <span className="text-slate-600 mr-2 select-none">{String(i + 1).padStart(2, '0')}</span>
                                        {msg}
                                    </div>
                                ))}
                                <div ref={progressEndRef} />
                            </div>
                            {intelligencePhase === 'done' && (
                                <button
                                    onClick={() => { setIntelligenceProgress([]); setIntelligencePhase('idle'); }}
                                    className="mt-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    Clear log
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

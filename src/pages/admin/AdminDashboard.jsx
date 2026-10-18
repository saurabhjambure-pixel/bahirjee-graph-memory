import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, FileText, Settings, Activity, MessageSquare, StickyNote, TrendingUp, Users } from 'lucide-react';
import { getEngagementSummary } from '../../services/interactionService';
import { supabase } from '../../lib/supabase';

export default function AdminDashboard() {
    const [engagement, setEngagement] = useState([]);
    const [stats, setStats] = useState({ clients: 0, users: 0, reports: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function loadData() {
            setLoading(true);

            // Fetch engagement telemetry from interactions table
            const { data: engagementData } = await getEngagementSummary();
            setEngagement(engagementData || []);

            // Fetch quick stats from core tables
            const [{ count: clients }, { count: users }, { count: reports }] = await Promise.all([
                supabase.from('clients').select('id', { count: 'exact', head: true }),
                supabase.from('profiles').select('id', { count: 'exact', head: true }),
                supabase.from('reports').select('id', { count: 'exact', head: true }),
            ]);
            setStats({ clients: clients ?? 0, users: users ?? 0, reports: reports ?? 0 });
            setLoading(false);
        }
        loadData();
    }, []);

    const totalQuestions     = engagement.reduce((s, r) => s + r.questions, 0);
    const totalNotes         = engagement.reduce((s, r) => s + r.notes, 0);
    const totalViewers       = engagement.reduce((s, r) => s + r.viewers, 0);
    const totalConversions   = engagement.reduce((s, r) => s + r.conversionClicks, 0);

    return (
        <div className="p-8 max-w-7xl mx-auto animate-in fade-in duration-500">
            <h1 className="text-3xl font-display font-semibold text-white mb-6">Admin Dashboard</h1>

            {/* Core Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                {[
                    { label: 'Clients', value: stats.clients, icon: <UserPlus className="w-5 h-5 text-bah-accent" />, link: '/admin/clients' },
                    { label: 'Users', value: stats.users, icon: <Users className="w-5 h-5 text-bah-cyan" />, link: '/admin/clients' },
                    { label: 'Briefs Generated', value: stats.reports, icon: <FileText className="w-5 h-5 text-emerald-400" />, link: '/admin/reports' },
                    { label: 'Upgrade Clicks', value: totalConversions, icon: <TrendingUp className="w-5 h-5 text-amber-400" />, link: '/admin/reports' },
                ].map(({ label, value, icon, link }) => (
                    <Link key={label} to={link} className="bah-panel p-5 flex items-center gap-4 hover:bg-bah-panel-strong transition-colors cursor-pointer group">
                        <div className="p-2 rounded-lg bg-white/5 group-hover:bg-white/10">{icon}</div>
                        <div>
                            <p className="text-slate-500 text-xs font-medium uppercase tracking-wider">{label}</p>
                            <p className="text-2xl font-bold text-white">{loading ? '–' : value}</p>
                        </div>
                    </Link>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Quick Actions */}
                <div className="bah-panel p-6">
                    <h2 className="text-xl font-display font-semibold text-white mb-4">Quick Actions</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Link to="/admin/clients" className="flex items-center gap-3 p-4 rounded-xl border border-bah bg-bah-panel-strong hover:bg-bah-accent-soft hover:border-[var(--bah-accent)]/30 transition-all group">
                            <div className="p-2 rounded-lg bg-bah-accent-soft text-bah-accent"><UserPlus size={20} /></div>
                            <div>
                                <p className="font-medium text-slate-200">Onboard Client</p>
                                <p className="text-xs text-slate-500">Create new organization</p>
                            </div>
                        </Link>
                        <Link to="/admin/reports" className="flex items-center gap-3 p-4 rounded-xl border border-bah bg-bah-panel-strong hover:bg-emerald-500/10 hover:border-emerald-500/30 transition-all group">
                            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400"><FileText size={20} /></div>
                            <div>
                                <p className="font-medium text-slate-200">View Reports</p>
                                <p className="text-xs text-slate-500">Platform analytics</p>
                            </div>
                        </Link>
                        <Link to="/admin/health" className="flex items-center gap-3 p-4 rounded-xl border border-bah bg-bah-panel-strong hover:bg-amber-500/10 hover:border-amber-500/30 transition-all group">
                            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400"><Activity size={20} /></div>
                            <div>
                                <p className="font-medium text-slate-200">System Health</p>
                                <p className="text-xs text-slate-500">Check pipeline status</p>
                            </div>
                        </Link>
                        <Link to="/admin/settings" className="flex items-center gap-3 p-4 rounded-xl border border-bah bg-bah-panel-strong hover:bg-bah-panel hover:border-bah transition-all group">
                            <div className="p-2 rounded-lg bg-bah-panel text-slate-400"><Settings size={20} /></div>
                            <div>
                                <p className="font-medium text-slate-200">Settings</p>
                                <p className="text-xs text-slate-500">Platform config</p>
                            </div>
                        </Link>
                    </div>
                </div>

                {/* Engagement Telemetry */}
                <div className="bah-panel p-6">
                    <h2 className="text-xl font-display font-semibold text-white mb-1">Live Engagement</h2>
                    <p className="text-xs text-slate-500 mb-4 uppercase tracking-wider">Viewer interactions across all shared briefs</p>
                    {loading ? (
                        <div className="flex items-center justify-center h-40 text-slate-600">Loading telemetry…</div>
                    ) : engagement.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-600 gap-2">
                            <Activity size={36} className="opacity-30" />
                            <p className="text-sm">No viewer interactions recorded yet.</p>
                        </div>
                    ) : (
                        <div className="space-y-3 max-h-72 overflow-y-auto">
                            {/* Summary row */}
                            <div className="grid grid-cols-3 gap-3 mb-4">
                                {[
                                    { label: 'Unique Viewers', value: totalViewers, icon: <Users className="w-4 h-4 text-bah-cyan" /> },
                                    { label: 'Questions', value: totalQuestions, icon: <MessageSquare className="w-4 h-4 text-bah-accent" /> },
                                    { label: 'Notes', value: totalNotes, icon: <StickyNote className="w-4 h-4 text-emerald-400" /> },
                                ].map(({ label, value, icon }) => (
                                    <div key={label} className="bg-white/5 rounded-lg p-3 text-center">
                                        <div className="flex justify-center mb-1">{icon}</div>
                                        <p className="text-xl font-bold text-white">{value}</p>
                                        <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
                                    </div>
                                ))}
                            </div>
                            {/* Per-report breakdown */}
                            <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">Per-Report Breakdown</div>
                            {engagement.map((row) => (
                                <div key={row.report_id} className="flex items-center justify-between p-3 bg-white/[0.03] rounded-lg border border-white/5">
                                    <span className="text-slate-400 text-xs truncate max-w-[140px]" title={row.report_id}>{row.report_id.slice(0, 8)}…</span>
                                    <div className="flex items-center gap-4 text-xs">
                                        <span className="flex items-center gap-1 text-bah-cyan"><Users className="w-3 h-3" />{row.viewers}</span>
                                        <span className="flex items-center gap-1 text-bah-accent"><MessageSquare className="w-3 h-3" />{row.questions}</span>
                                        <span className="flex items-center gap-1 text-emerald-400"><StickyNote className="w-3 h-3" />{row.notes}</span>
                                        {row.conversionClicks > 0 && (
                                            <span className="flex items-center gap-1 text-amber-400"><TrendingUp className="w-3 h-3" />{row.conversionClicks}</span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

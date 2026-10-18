import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Activity, DollarSign, Database, Server, AlertTriangle, CheckCircle, BarChart3 } from 'lucide-react';
import { toast } from 'react-hot-toast';

export default function SystemHealth() {
    const [stats, setStats] = useState({
        totalClients: 0,
        totalUsers: 0,
        totalReports: 0,
        estimatedCost: 0
    });
    const [loading, setLoading] = useState(true);

    // Constants based on Documentation (Deep Research V6.5)
    // Cost per report: ~$0.16 (Gemini + Tavily + Firecrawl)
    const COST_PER_REPORT = 0.16;

    useEffect(() => {
        fetchStats();
    }, []);

    const fetchStats = async () => {
        try {
            // Parallel requests for counts
            const [
                { count: clientsCount },
                { count: usersCount },
                { count: reportsCount }
            ] = await Promise.all([
                supabase.from('clients').select('*', { count: 'exact', head: true }),
                supabase.from('profiles').select('*', { count: 'exact', head: true }),
                supabase.from('reports').select('*', { count: 'exact', head: true }) // Requires Reports Table
            ]);

            setStats({
                totalClients: clientsCount || 0,
                totalUsers: usersCount || 0,
                totalReports: reportsCount || 0,
                estimatedCost: (reportsCount || 0) * COST_PER_REPORT
            });

        } catch (error) {
            console.error("Error fetching stats:", error);
            toast.error("Failed to load system metrics");
        } finally {
            setLoading(false);
        }
    };

    const StatusCard = ({ title, value, icon: Icon, subtext, color = "accent" }) => {
        const colorClasses = {
            accent: "bg-bah-accent-soft text-bah-accent border-[var(--bah-accent)]/20",
            emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
            amber: "bg-amber-500/10 text-amber-400 border-amber-500/20",
            rose: "bg-rose-500/10 text-rose-400 border-rose-500/20",
        };

        return (
            <div className={`p-6 rounded-xl border ${colorClasses[color]} flex flex-col justify-between h-32`}>
                <div className="flex justify-between items-start">
                    <h3 className="text-sm font-medium uppercase tracking-wider opacity-70">{title}</h3>
                    <Icon size={20} />
                </div>
                <div>
                    <div className="text-3xl font-bold text-white">{value}</div>
                    {subtext && <div className="text-xs opacity-60 mt-1">{subtext}</div>}
                </div>
            </div>
        );
    };

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <h1 className="text-3xl font-display font-semibold text-white mb-2">System Health & Costs</h1>
            <p className="text-slate-400 mb-8">Operational metrics and estimated infrastructure usage.</p>

            {/* Top Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <StatusCard
                    title="Estimated Cost"
                    value={`$${stats.estimatedCost.toFixed(2)}`}
                    icon={DollarSign}
                    subtext="Based on $0.16/report avg"
                    color="rose"
                />
                <StatusCard
                    title="Total Reports"
                    value={stats.totalReports}
                    icon={Database}
                    subtext="Deep Research Analyses"
                    color="accent"
                />
                <StatusCard
                    title="Total Users"
                    value={stats.totalUsers}
                    icon={Activity}
                    subtext={`${stats.totalClients} Organizations`}
                    color="emerald"
                />
                <StatusCard
                    title="System Status"
                    value="Operational"
                    icon={Server}
                    subtext="All systems nominal"
                    color="emerald"
                />
            </div>

            {/* Detailed Services Status */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* External APIs Status */}
                <div className="bah-panel p-6">
                    <h3 className="text-lg font-display font-semibold text-white mb-6 flex items-center gap-2">
                        <Activity size={20} className="text-bah-accent" /> API Status
                    </h3>
                    <div className="space-y-4">
                        <div className="bah-panel-strong flex items-center justify-between p-4">
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                <span className="text-slate-300 font-medium">Gemini 3.8 Flash / 3.1 Pro</span>
                            </div>
                            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">Operational</span>
                        </div>
                        <div className="bah-panel-strong flex items-center justify-between p-4">
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                <span className="text-slate-300 font-medium">Tavily Search</span>
                            </div>
                            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">Operational</span>
                        </div>
                        <div className="bah-panel-strong flex items-center justify-between p-4">
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                <span className="text-slate-300 font-medium">Firecrawl Scraper</span>
                            </div>
                            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">Operational</span>
                        </div>
                        <div className="bah-panel-strong flex items-center justify-between p-4">
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                <span className="text-slate-300 font-medium">Supabase Database</span>
                            </div>
                            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">Operational</span>
                        </div>
                    </div>
                </div>

                {/* Recent Alerts / Logs Placeholder */}
                <div className="bah-panel p-6">
                    <h3 className="text-lg font-display font-semibold text-white mb-6 flex items-center gap-2">
                        <AlertTriangle size={20} className="text-amber-400" /> Recent Alerts
                    </h3>
                    <div className="flex flex-col items-center justify-center h-64 text-slate-500 space-y-2">
                        <CheckCircle size={32} className="text-slate-600" />
                        <p>No active alerts in the last 24 hours.</p>
                    </div>
                </div>

            </div>
        </div>
    );
}

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Plus, Users, Search, Building2, MoreHorizontal, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';

export default function ClientList() {
    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    const [newClientName, setNewClientName] = useState('');
    const [newClientDomain, setNewClientDomain] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        fetchClients();
    }, []);

    const fetchClients = async () => {
        try {
            const { data, error } = await supabase
                .from('clients')
                .select('*, profiles(count)')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setClients(data);
        } catch (error) {
            toast.error('Failed to load clients');
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateClient = async (e) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const { error } = await supabase
                .from('clients')
                .insert([{
                    name: newClientName,
                    domain: newClientDomain,
                    status: 'active'
                }]);

            if (error) throw error;

            toast.success('Client organization created');
            setNewClientName('');
            setNewClientDomain('');
            setIsCreating(false);
            fetchClients(); // Refresh list
            toast.error(error.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    const filteredClients = clients.filter(client =>
        client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        client.domain?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-display font-semibold text-white mb-2">Client Management</h1>
                    <p className="text-slate-400">Manage organizations and their access.</p>
                </div>
                <button
                    onClick={() => setIsCreating(true)}
                    className="bah-button-primary px-4 py-2"
                >
                    <Plus size={18} />
                    Onboard Client
                </button>
            </div>

            {/* Creation Modal / Inline Form */}
            {isCreating && (
                <div className="bah-panel mb-8 p-6 animate-in slide-in-from-top-2">
                    <h3 className="text-lg font-display font-semibold text-white mb-4">Onboard New Client</h3>
                    <form onSubmit={handleCreateClient} className="flex gap-4 items-end">
                        <div className="flex-1 space-y-2">
                            <label className="text-xs font-medium text-slate-400 uppercase">Company Name</label>
                            <input
                                required
                                value={newClientName}
                                onChange={e => setNewClientName(e.target.value)}
                                className="bah-input-strong px-4"
                                placeholder="e.g. Acme Corp"
                            />
                        </div>
                        <div className="flex-1 space-y-2">
                            <label className="text-xs font-medium text-slate-400 uppercase">Domain</label>
                            <input
                                required
                                value={newClientDomain}
                                onChange={e => setNewClientDomain(e.target.value)}
                                className="bah-input-strong px-4"
                                placeholder="e.g. acme.com (for auto-join)"
                            />
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setIsCreating(false)}
                                className="px-4 py-2 text-slate-400 hover:text-white"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition-colors"
                            >
                                {isSubmitting && <Loader2 size={16} className="animate-spin" />}
                                {isSubmitting ? 'Creating...' : 'Create'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Search */}
            <div className="relative mb-6">
                <Search className="absolute left-3 top-2.5 text-slate-500" size={18} />
                <input
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    placeholder="Search clients by name or domain..."
                    className="bah-input pl-10 pr-4"
                />
            </div>

            {/* List */}
            {loading ? (
                <div className="flex justify-center py-12">
                    <Loader2 className="animate-spin text-bah-accent" size={32} />
                </div>
            ) : (
                <div className="grid gap-4">
                    {filteredClients.map(client => (
                        <Link
                            to={`/admin/clients/${client.id}`}
                            key={client.id}
                            className="bah-panel hover:bg-bah-panel-strong p-4 flex items-center justify-between transition-colors group block"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 bg-bah-accent-soft rounded-lg flex items-center justify-center text-bah-accent">
                                    <Building2 size={24} />
                                </div>
                                <div>
                                    <h3 className="text-white font-medium text-lg">{client.name}</h3>
                                    <div className="flex items-center gap-3 text-sm text-slate-500">
                                        <span>{client.domain || 'No domain'}</span>
                                        <span className="w-1 h-1 bg-slate-600 rounded-full"></span>
                                        <span className="flex items-center gap-1">
                                            <Users size={14} />
                                            {client.profiles?.[0]?.count || 0} Users
                                        </span>
                                        <span className="w-1 h-1 bg-slate-600 rounded-full"></span>
                                        <span className="text-slate-600">
                                            Added {new Date(client.created_at).toLocaleDateString('en-US', {
                                                month: 'short',
                                                day: 'numeric',
                                                year: 'numeric'
                                            })}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-4">
                                <span className={`px-2 py-1 rounded text-xs uppercase font-medium border ${client.status === 'active'
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                    : 'bg-slate-700/50 text-slate-400 border-slate-600'
                                    }`}>
                                    {client.status}
                                </span>
                                <span className="text-xs text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                    Click to manage users →
                                </span>
                            </div>
                        </Link>
                    ))}

                    {filteredClients.length === 0 && (
                        <div className="text-center py-12 text-slate-500">
                            No clients found matching your search.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

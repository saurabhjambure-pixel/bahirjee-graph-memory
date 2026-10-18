import React from 'react'; // turbo
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Users, BarChart3, Settings, ShieldAlert, FileText, LayoutDashboard } from 'lucide-react';

export default function AdminLayout() {
    const { signOut, user } = useAuth();
    const location = useLocation();

    const isActive = (path) => location.pathname.startsWith(path);

    const navItems = [
        { name: 'Dashboard', path: '/admin', icon: LayoutDashboard },
        { name: 'Clients', path: '/admin/clients', icon: Users },
        { name: 'Reports', path: '/admin/reports', icon: FileText },
        { name: 'System Health', path: '/admin/health', icon: BarChart3 },
        { name: 'Settings', path: '/admin/settings', icon: Settings },
    ];

    return (
        <div className="min-h-screen bg-bah-bg text-slate-100 flex font-sans">
            {/* Sidebar */}
            <aside className="w-64 border-r border-bah bg-bah-panel flex-shrink-0 flex flex-col">
                <div className="h-16 flex items-center px-6 border-b border-bah">
                    <Link to="/admin" className="text-xl font-display font-bold bg-clip-text text-transparent brand-gradient hover:opacity-80 transition-opacity">
                        bahirjee <span className="text-slate-500 text-xs uppercase tracking-wider ml-1">Admin</span>
                    </Link>
                </div>

                <nav className="flex-1 overflow-y-auto py-4">
                    <ul className="space-y-1 px-3">
                        {navItems.map((item) => {
                            const active = item.path === '/admin'
                                ? location.pathname === '/admin'
                                : isActive(item.path);

                            const Icon = item.icon;

                            return (
                                <li key={item.name}>
                                    <Link
                                        to={item.path}
                                        className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${active
                                            ? 'bg-bah-accent-soft text-bah-accent'
                                            : 'text-slate-400 hover:bg-bah-panel-strong hover:text-slate-200'
                                            }`}
                                    >
                                        <Icon size={18} />
                                        <span className="font-medium">{item.name}</span>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </nav>

                <div className="p-4 border-t border-bah">
                    <div className="flex items-center gap-3 mb-4 px-2">
                        <div className="w-8 h-8 rounded-full bg-bah-accent-soft flex items-center justify-center text-bah-accent text-sm font-bold">
                            A
                        </div>
                        <div className="overflow-hidden">
                            <p className="text-sm font-medium text-slate-200 truncate">{user?.email}</p>
                            <p className="text-xs text-slate-500">Super Admin</p>
                        </div>
                    </div>
                    <button
                        onClick={signOut}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:bg-bah-panel-strong hover:text-bah-danger transition-colors text-sm"
                    >
                        <ShieldAlert size={16} />
                        Sign Out
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto bg-bah-bg">
                <Outlet />
            </main>
        </div>
    );
}

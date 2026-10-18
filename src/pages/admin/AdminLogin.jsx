import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Lock, Loader2 } from 'lucide-react';

// Admin login is PASSWORD-based (founders use magic link on `/`). The
// signInWithPassword plumbing lives in AuthContext.signIn.
export default function AdminLogin() {
    const { user, profile, loading, signIn, signOut } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [attempted, setAttempted] = useState(false);

    // Once a session + profile resolve, route by role. A non-admin who reaches
    // this page (e.g. a founder with a password) is signed out with a clear message.
    useEffect(() => {
        if (loading || !user || !profile) return;
        if (profile.role === 'admin') {
            const dest = location.state?.from?.pathname || '/admin';
            navigate(dest, { replace: true });
        } else if (attempted) {
            setError('This is not an admin account. Founders sign in from the main page.');
            setSubmitting(false);
            signOut();
        }
    }, [user, profile, loading, attempted, navigate, location.state, signOut]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSubmitting(true);
        setAttempted(true);
        try {
            await signIn(email.trim().toLowerCase(), password);
            // Role-based redirect is handled by the effect above once profile loads.
        } catch (err) {
            setError(err.message || 'Invalid email or password');
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen bg-bah-bg flex items-center justify-center p-4">
            <div className="w-full max-w-sm bah-panel p-8 rounded-2xl shadow-2xl space-y-6">
                <div className="w-16 h-16 rounded-2xl brand-gradient flex items-center justify-center mx-auto shadow-lg">
                    <Lock className="w-8 h-8 text-white" />
                </div>
                <div className="text-center">
                    <h1 className="text-2xl font-display font-semibold text-bah tracking-tight">
                        bahirjee <span className="text-bah-muted">Admin</span>
                    </h1>
                    <p className="text-bah-muted text-sm mt-2">Sign in with your admin credentials</p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="Admin email"
                        required
                        autoComplete="username"
                        className="w-full bg-black/20 border border-bah rounded-xl px-4 py-3 text-bah placeholder-slate-600 focus:border-[var(--bah-accent)] outline-none transition-all"
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Password"
                        required
                        autoComplete="current-password"
                        className="w-full bg-black/20 border border-bah rounded-xl px-4 py-3 text-bah placeholder-slate-600 focus:border-[var(--bah-accent)] outline-none transition-all"
                    />
                    {error && <p className="text-red-400 text-xs text-center">{error}</p>}
                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full bah-button-primary py-3 rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {submitting ? 'Signing in…' : 'Sign In'}
                    </button>
                </form>
                <div className="flex items-center justify-between text-xs text-slate-600">
                    <Link to="/admin/reset" className="hover:text-bah-accent transition-colors">Forgot password?</Link>
                    <Link to="/" className="hover:text-bah-accent transition-colors">Founder sign-in →</Link>
                </div>
            </div>
        </div>
    );
}

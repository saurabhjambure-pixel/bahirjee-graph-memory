import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { KeyRound, Loader2 } from 'lucide-react';

// Handles both halves of the admin password-recovery flow:
//  1. "request" — enter email, we send a reset link (redirects back here).
//  2. "set" — arriving from the email link, Supabase establishes a recovery
//     session and fires PASSWORD_RECOVERY; we then let the admin set a password.
// This is also how a freshly-seeded admin (random password) sets their first one.
export default function AdminResetPassword() {
    const navigate = useNavigate();
    const [mode, setMode] = useState('request'); // 'request' | 'set'
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!supabase) return;
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
            if (event === 'PASSWORD_RECOVERY') {
                setMode('set');
                setError('');
                setMessage('');
            }
        });
        return () => subscription?.unsubscribe();
    }, []);

    const redirectTo = `${window.location.origin}/admin/reset`;

    const requestReset = async (e) => {
        e.preventDefault();
        if (!supabase) { setError('Supabase not configured.'); return; }
        setSubmitting(true);
        setError('');
        setMessage('');
        try {
            const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
                email.trim().toLowerCase(),
                { redirectTo }
            );
            if (resetErr) throw resetErr;
            setMessage('If that admin account exists, a reset link is on its way.');
        } catch (err) {
            setError(err.message || 'Unable to send reset link');
        } finally {
            setSubmitting(false);
        }
    };

    const setNewPassword = async (e) => {
        e.preventDefault();
        if (!supabase) { setError('Supabase not configured.'); return; }
        if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
        setSubmitting(true);
        setError('');
        try {
            const { error: updErr } = await supabase.auth.updateUser({ password });
            if (updErr) throw updErr;
            setMessage('Password updated. Redirecting to sign in…');
            await supabase.auth.signOut();
            setTimeout(() => navigate('/admin/login', { replace: true }), 1200);
        } catch (err) {
            setError(err.message || 'Unable to update password');
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen bg-bah-bg flex items-center justify-center p-4">
            <div className="w-full max-w-sm bah-panel p-8 rounded-2xl shadow-2xl space-y-6">
                <div className="w-16 h-16 rounded-2xl brand-gradient flex items-center justify-center mx-auto shadow-lg">
                    <KeyRound className="w-8 h-8 text-white" />
                </div>
                <div className="text-center">
                    <h1 className="text-2xl font-display font-semibold text-bah tracking-tight">
                        {mode === 'set' ? 'Set a new password' : 'Reset admin password'}
                    </h1>
                    <p className="text-bah-muted text-sm mt-2">
                        {mode === 'set'
                            ? 'Choose a password for your admin account.'
                            : 'We’ll email you a secure link to set a new password.'}
                    </p>
                </div>

                {mode === 'set' ? (
                    <form onSubmit={setNewPassword} className="space-y-4">
                        <input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="New password (min 8 chars)"
                            required
                            autoComplete="new-password"
                            className="w-full bg-black/20 border border-bah rounded-xl px-4 py-3 text-bah placeholder-slate-600 focus:border-[var(--bah-accent)] outline-none transition-all"
                        />
                        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
                        {message && <p className="text-emerald-400 text-xs text-center">{message}</p>}
                        <button type="submit" disabled={submitting} className="w-full bah-button-primary py-3 rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
                            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                            Update password
                        </button>
                    </form>
                ) : (
                    <form onSubmit={requestReset} className="space-y-4">
                        <input
                            type="email"
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="Admin email"
                            required
                            autoComplete="username"
                            className="w-full bg-black/20 border border-bah rounded-xl px-4 py-3 text-bah placeholder-slate-600 focus:border-[var(--bah-accent)] outline-none transition-all"
                        />
                        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
                        {message && <p className="text-emerald-400 text-xs text-center">{message}</p>}
                        <button type="submit" disabled={submitting} className="w-full bah-button-primary py-3 rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
                            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                            Send reset link
                        </button>
                    </form>
                )}

                <div className="text-center text-xs text-slate-600">
                    <Link to="/admin/login" className="hover:text-bah-accent transition-colors">← Back to admin sign in</Link>
                </div>
            </div>
        </div>
    );
}

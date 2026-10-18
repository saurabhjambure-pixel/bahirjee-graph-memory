import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ children, role }) {
    const { user, profile, loading, signOut } = useAuth();
    const location = useLocation();
    const [isTimedOut, setIsTimedOut] = useState(false);

    useEffect(() => {
        // Fallback: if loading takes too long (e.g. 5s), show error or redirect
        const timer = setTimeout(() => {
            if (loading) setIsTimedOut(true);
        }, 5000);
        return () => clearTimeout(timer);
    }, [loading]);

    if (loading && !isTimedOut) {
        return (
            <div className="min-h-screen bg-bah-bg flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[var(--bah-accent)]"></div>
            </div>
        );
    }

    // Admin area is password-gated: send unauthenticated visitors to /admin/login.
    if (!user) {
        return <Navigate to="/admin/login" state={{ from: location }} replace />;
    }

    // Deactivated accounts must not reach protected content, even mid-session.
    if (profile && profile.is_active === false) {
        return (
            <div className="min-h-screen bg-bah-bg flex flex-col items-center justify-center gap-4 text-slate-400">
                <p>Your account has been deactivated. Contact an administrator.</p>
                <button onClick={signOut} className="text-bah-accent hover:underline text-sm font-medium">Sign out</button>
            </div>
        );
    }

    // Role-based protection.
    if (role && profile?.role !== role) {
        return (
            <div className="min-h-screen bg-bah-bg flex flex-col items-center justify-center gap-4 text-slate-400">
                <p>Access denied. You do not have permission to view this page.</p>
                <Link to="/" className="text-bah-accent hover:underline text-sm font-medium">Return to your workspace</Link>
            </div>
        );
    }

    return children;
}

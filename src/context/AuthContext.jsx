import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

// LOCAL DEV ONLY: dead code in a production build (import.meta.env.DEV is false there).
const DEV_AUTH_BYPASS = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTH_BYPASS === 'true';
const DEV_MOCK_USER = { id: '00000000-0000-0000-0000-0000000000de', email: 'dev@bahirjee.local' };
const DEV_MOCK_PROFILE = {
    id: '00000000-0000-0000-0000-0000000000de',
    role: 'client_user',
    full_name: 'Dev Tester',
    client_id: null, is_active: true, is_premium: true, run_count: 0, client: null
};

export function AuthProvider({ children }) {
    const [user, setUser] = useState(DEV_AUTH_BYPASS ? DEV_MOCK_USER : null);
    const [profile, setProfile] = useState(DEV_AUTH_BYPASS ? DEV_MOCK_PROFILE : null); // [NEW] Store profile data (role)
    const [profileError, setProfileError] = useState(null);
    const [loading, setLoading] = useState(!DEV_AUTH_BYPASS);
    // The user whose profile is currently loaded or in flight. getSession() and
    // onAuthStateChange (INITIAL_SESSION + SIGNED_IN) all land in fetchProfile on load with
    // the same user; this dedups them to a single query instead of 2-3 identical ones.
    const profileUserIdRef = useRef(null);

    useEffect(() => {
        if (DEV_AUTH_BYPASS) {
            console.warn('[DEV] Auth bypass active — mock session, no Supabase login.');
            return;
        }
        if (!supabase) {
            console.warn("Supabase client not initialized.");
            setLoading(false);
            return;
        }

        const fetchProfile = async (userId) => {
            if (!userId) {
                profileUserIdRef.current = null;
                setProfile(null);
                setProfileError(null);
                return;
            }
            // Already loaded (or loading) this user's profile — skip the duplicate query.
            if (profileUserIdRef.current === userId) return;
            profileUserIdRef.current = userId;
            try {
                const { data, error } = await supabase
                    .from('profiles')
                    .select(`
                        *,
                        clients(id, name, domain, exempt_from_freemium)
                    `)
                    .eq('id', userId)
                    .single();

                if (error) {
                    console.error("Error fetching profile:", error);
                    profileUserIdRef.current = null; // allow a later auth event to retry
                    setProfile(null);
                    setProfileError(error.message || 'Unable to load your profile.');
                    return;
                }

                // Deactivated accounts are signed out immediately — no partial access.
                if (data.is_active === false) {
                    console.warn('[Auth] Inactive account — signing out.');
                    profileUserIdRef.current = null;
                    setProfile(null);
                    setProfileError('Your account has been deactivated.');
                    await supabase.auth.signOut();
                    return;
                }

                // Flatten client data onto profile for easier access
                if (data.clients) {
                    data.client = data.clients;
                }
                delete data.clients;
                setProfile(data);
                setProfileError(null);
            } catch (err) {
                console.error("Unexpected error fetching profile:", err);
                profileUserIdRef.current = null; // allow a later auth event to retry
                setProfile(null);
                setProfileError(err.message || 'Unable to load your profile.');
            }
        };

        // Check active session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setUser(session?.user ?? null);
            if (session?.user) {
                fetchProfile(session.user.id);
            }
            setLoading(false);
        });

        // Listen for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            const currentUser = session?.user ?? null;
            setUser(currentUser);
            if (currentUser) {
                // fetchProfile dedups repeat calls for the same user id internally.
                fetchProfile(currentUser.id);
            } else {
                profileUserIdRef.current = null;
                setProfile(null);
            }
        });

        return () => subscription?.unsubscribe();
    }, []);

    // The three actions below are useCallback([])-stable on purpose: each closes over only
    // module-level values (supabase, DEV_AUTH_BYPASS), its own arguments, and setState
    // setters — never over `user`/`profile`/`loading` — so there is no stale-closure risk,
    // and the memoized context value below can stay referentially stable across renders.

    // Sets the current user's display name via a narrow SECURITY DEFINER RPC
    // (direct profile UPDATEs are blocked by RLS). Updates local state on success.
    const updateFullName = useCallback(async (name) => {
        if (!supabase) throw new Error("Supabase not configured. Check env vars.");
        const trimmed = (name || '').trim();
        const { error } = await supabase.rpc('set_full_name', { new_name: trimmed });
        if (error) throw error;
        // Functional update — reads no captured `profile`, so [] deps stay correct.
        setProfile(prev => (prev ? { ...prev, full_name: trimmed } : prev));
    }, []);

    const requestAuthLink = useCallback(async (email) => {
        const response = await fetch('/api/auth-link', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || 'Unable to sign in');
        }

        // The server minted a magic-link token for the one allowed account — verify it
        // right away to establish a session (no email click). onAuthStateChange then
        // loads the profile and the app re-renders signed in.
        if (data.autoAccess && data.tokenHash && supabase) {
            const { error } = await supabase.auth.verifyOtp({
                token_hash: data.tokenHash,
                type: 'magiclink',
            });
            if (error) throw error;
            return { ...data, signedIn: true };
        }

        return data;
    }, []);

    const signOut = useCallback(async () => {
        if (DEV_AUTH_BYPASS) {
            // Bypass mode never establishes a real Supabase session — user/profile are
            // plain React state seeded from DEV_MOCK_USER/PROFILE, and the effect above
            // returns before subscribing to onAuthStateChange. supabase.auth.signOut() has
            // no session to clear, so it was a silent no-op and the screen never changed.
            // Clear the mock state directly; a page refresh re-applies the bypass.
            setUser(null);
            setProfile(null);
            return;
        }
        if (!supabase) return;
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
    }, []);

    // Memoized: this was a fresh object literal on every render, so every AuthProvider
    // render pushed a new context value and forced *every* consumer to re-render even when
    // nothing had actually changed. With the actions stable above, this now changes only
    // when real auth state does.
    const value = useMemo(() => ({
        user,
        profile,
        profileError,
        loading,
        requestAuthLink,
        updateFullName,
        signOut
    }), [user, profile, profileError, loading, requestAuthLink, updateFullName, signOut]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

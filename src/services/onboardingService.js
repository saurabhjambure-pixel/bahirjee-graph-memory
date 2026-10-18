import { supabase } from '../lib/supabase.js';

// Founder onboarding answers (Business Core / Sensitivity Snapshot / Market Bets)
// are persisted per client in `startup_contexts.onboarding_inputs` so returning
// founders don't re-enter everything each run. RLS scopes rows to the caller's
// client_id (see "clients all startup_contexts" policy in schema.sql).

// Fields we never want to round-trip back into the form as defaults.
const TRANSIENT_KEYS = new Set(['_autoInferred']);

function stripTransient(inputs) {
    if (!inputs || typeof inputs !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(inputs)) {
        if (!TRANSIENT_KEYS.has(k)) clean[k] = v;
    }
    return clean;
}

export async function saveOnboardingInputs(companyId, inputs) {
    if (!supabase || !companyId || !inputs) return { data: null, error: null };
    try {
        const { data, error } = await supabase
            .from('startup_contexts')
            .insert({ company_id: companyId, onboarding_inputs: stripTransient(inputs) })
            .select('id')
            .single();
        if (error) {
            console.warn('[onboarding] save failed:', error.message);
            return { data: null, error };
        }
        return { data, error: null };
    } catch (err) {
        console.warn('[onboarding] unexpected save error:', err.message);
        return { data: null, error: err };
    }
}

export async function getLatestOnboardingInputs(companyId) {
    if (!supabase || !companyId) return null;
    try {
        const { data, error } = await supabase
            .from('startup_contexts')
            .select('onboarding_inputs')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            console.warn('[onboarding] load failed:', error.message);
            return null;
        }
        const inputs = data?.onboarding_inputs;
        return inputs && Object.keys(inputs).length ? inputs : null;
    } catch (err) {
        console.warn('[onboarding] unexpected load error:', err.message);
        return null;
    }
}

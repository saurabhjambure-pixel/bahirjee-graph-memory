/**
 * Context Builder — Bahirjee Context Building Layer
 * 
 * Merges structured onboarding inputs (founder-provided) with
 * Gemini auto-inferred context into a unified Startup_Context object.
 * 
 * Derives exposure weights deterministically from:
 *   - Revenue profile (Block A)
 *   - Sensitivity snapshot (Block B)
 *   - Dependency map (auto-inferred)
 */

import { supabase } from '../lib/supabase.js';

/**
 * Build the unified Startup_Context from onboarding + auto-inferred data.
 * 
 * @param {Object} params
 * @param {Object} params.onboardingData - Structured form data from OnboardingForm
 * @param {Object} params.autoInferred - Gemini-generated context JSON
 * @returns {Object} Startup_Context
 */
export function buildStartupContext({ onboardingData, autoInferred }) {
    const ob = onboardingData || {};
    const ai = autoInferred || {};

    const revenueProfile = {
        model: ob.revenueModel || 'Unknown',
        customer_type: ob.customerType || 'Unknown',
        sales_motion: ob.salesMotion || 'Unknown',
        geography: ob.geography || ai.operating_geography || 'Global',
        funding_stage: ob.fundingStage || ai.company_dna?.funding_stage || 'Unknown'
    };

    const marketProfile = {
        industry: ai.industry || 'Technology',
        category: ai.strategic_anchors?.operational_reality || ai.industry || 'Technology',
        vertical: ai.vertical_specialization || null,
        target_persona: ai.target_persona || extractPersonaFromBuyerType(ai.strategic_anchors?.buyer_type)
    };

    const dependencyMap = extractDependencyMap(ai);
    const competitiveMap = extractCompetitiveMap(ai);

    const sensitivitySnapshot = {
        infra_cost: ob.infraCost || 'Medium',
        revenue_slowdown: ob.revenueSlowdown || 'Medium',
        hiring_dependency: ob.hiringDependency || 'Medium',
        competitive_pressure: ob.competitivePressure || 'Medium',
        regulatory_exposure: ob.regulatoryExposure || 'Medium',
        platform_dependency: ob.platformDependency || 'Medium'
    };

    const strategicAssumptions = (ob.assumptions || [])
        .filter(a => a.statement && a.statement.trim())
        .slice(0, 5)
        .map(a => ({
            statement: a.statement.trim(),
            domain: a.domain || 'Demand',
            sensitivity: a.sensitivity || 'Medium'
        }));

    const exposureWeights = deriveExposureWeights(revenueProfile, sensitivitySnapshot, dependencyMap);

    const contextVersionId = `ctx_${Date.now()}_${randomSuffix()}`;

    return {
        revenue_profile: revenueProfile,
        market_profile: marketProfile,
        dependency_map: dependencyMap,
        competitive_map: competitiveMap,
        strategic_assumptions: strategicAssumptions,
        exposure_weights: exposureWeights,
        sensitivity_snapshot: sensitivitySnapshot,
        context_version_id: contextVersionId,
        // Preserve original auto-inferred fields for backward compatibility
        _auto_inferred_keys: Object.keys(ai)
    };
}

/**
 * Derive exposure weights deterministically.
 * Each weight is 0.0 - 1.0.
 */
export function deriveExposureWeights(revenueProfile, sensitivity, dependencyMap) {
    const sensLevel = (val) => ({ 'High': 0.9, 'Medium': 0.5, 'Low': 0.2 }[val] || 0.5);

    // Capital: High if early-stage + revenue slowdown risk
    const isEarlyStage = ['Pre-Seed', 'Seed', 'Series A'].includes(revenueProfile.funding_stage);
    const capital = clamp(
        (isEarlyStage ? 0.7 : 0.3) * 0.5 +
        sensLevel(sensitivity.revenue_slowdown) * 0.5
    );

    // Demand: Driven by revenue slowdown risk + customer type
    const isEnterprise = revenueProfile.customer_type === 'Enterprise';
    const demand = clamp(
        sensLevel(sensitivity.revenue_slowdown) * 0.6 +
        (isEnterprise ? 0.3 : 0.1) + 0.1
    );

    // Cost: Driven by infra sensitivity + number of infra dependencies
    const infraCount = (dependencyMap.infra_dependencies || []).length;
    const cost = clamp(
        sensLevel(sensitivity.infra_cost) * 0.6 +
        Math.min(infraCount * 0.1, 0.4)
    );

    // Distribution: Combines PLG/marketplace signals + platform deps + founder's platform dependency input
    const isPLG = revenueProfile.sales_motion === 'PLG';
    const isMarketplace = revenueProfile.model === 'Marketplace';
    const platformCount = (dependencyMap.platform_dependencies || []).length;
    const distribution = clamp(
        ((isPLG || isMarketplace) ? 0.3 : 0.1) +
        Math.min(platformCount * 0.1, 0.2) +
        sensLevel(sensitivity.platform_dependency) * 0.4 + 0.05
    );

    // Regulation: Combines auto-detected regulatory exposure + founder's direct input
    const hasRegExposure = (dependencyMap.regulatory_exposure || []).length > 0;
    const regulation = clamp(
        (hasRegExposure ? 0.3 : 0.1) +
        sensLevel(sensitivity.regulatory_exposure) * 0.5 +
        (isEnterprise ? 0.1 : 0) + 0.05
    );

    // Talent: Driven by hiring dependency sensitivity
    const talent = clamp(
        sensLevel(sensitivity.hiring_dependency) * 0.7 +
        (isEarlyStage ? 0.2 : 0.1)
    );

    // Competition: New — directly from founder's competitive pressure input
    const competition = clamp(
        sensLevel(sensitivity.competitive_pressure) * 0.7 +
        Math.min((dependencyMap.infra_dependencies || []).length * 0.05, 0.2) + 0.1
    );

    return { capital, demand, cost, distribution, regulation, talent, competition };
}

/**
 * Extract dependency map from auto-inferred context.
 */
function extractDependencyMap(ai) {
    // If Gemini returned a dedicated dependency_map, use it
    if (ai.dependency_map && typeof ai.dependency_map === 'object') {
        return {
            infra_dependencies: ai.dependency_map.infra_dependencies || [],
            platform_dependencies: ai.dependency_map.platform_dependencies || [],
            major_integrations: ai.dependency_map.major_integrations || [],
            regulatory_exposure: ai.dependency_map.regulatory_exposure || [],
            capital_posture: ai.dependency_map.capital_posture || ai.company_dna?.funding_stage || 'Unknown'
        };
    }

    // Fallback: extract from tech_stack and other fields
    const techStack = ai.company_dna?.tech_stack || [];
    const infraKeywords = ['aws', 'gcp', 'azure', 'openai', 'anthropic', 'vercel', 'supabase', 'firebase', 'mongodb', 'postgresql', 'redis', 'docker', 'kubernetes'];
    const platformKeywords = ['shopify', 'stripe', 'twilio', 'salesforce', 'hubspot', 'app store', 'play store', 'marketplace'];

    const infraDeps = techStack.filter(t => infraKeywords.some(k => t.toLowerCase().includes(k)));
    const platformDeps = techStack.filter(t => platformKeywords.some(k => t.toLowerCase().includes(k)));

    return {
        infra_dependencies: infraDeps,
        platform_dependencies: platformDeps,
        major_integrations: techStack.filter(t => !infraDeps.includes(t) && !platformDeps.includes(t)),
        regulatory_exposure: extractRegulatoryExposure(ai),
        capital_posture: ai.company_dna?.funding_stage || 'Unknown'
    };
}

/**
 * Extract competitive map from auto-inferred context.
 */
function extractCompetitiveMap(ai) {
    const competitors = (ai.key_competitors || []).slice(0, 15).map(c => {
        if (typeof c === 'object') return c;
        return { name: c };
    });

    return {
        named_competitors: competitors,
        category_peers: ai.category_peers || [],
        adjacent_solutions: ai.adjacent_solutions || []
    };
}

/**
 * Extract regulatory exposure hints.
 */
function extractRegulatoryExposure(ai) {
    const hints = [];
    const sensMap = ai.sensitivity_map || {};

    // New taxonomy: regulatory_exposure (with backward-compat for the old regulation_sensitivity key).
    const reg = sensMap.regulatory_exposure || sensMap.regulation_sensitivity;
    if (reg?.level === 'High' || reg?.level === 'Medium') {
        hints.push(reg.reasoning || 'Regulatory sensitivity detected');
    }

    // Check industry for regulated sectors
    const industry = (ai.industry || '').toLowerCase();
    const regulatedTerms = ['health', 'fintech', 'finance', 'insurance', 'pharma', 'medical', 'food', 'edu', 'legal', 'banking'];
    if (regulatedTerms.some(t => industry.includes(t))) {
        hints.push(`${ai.industry} — regulated industry`);
    }

    return hints;
}

function extractPersonaFromBuyerType(buyerType) {
    const mapping = {
        'Enterprise': 'CTO / VP Engineering',
        'Mid-Market': 'Head of Product / VP Ops',
        'SMB': 'Founder / CEO',
        'Gov': 'Procurement Officer',
        'Consumer': 'End User'
    };
    return mapping[buyerType] || null;
}

function clamp(val) {
    return Math.round(Math.min(1, Math.max(0, val)) * 100) / 100;
}

function randomSuffix() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Store a Startup_Context to Supabase.
 *
 * ⚠️ UNUSED as of the company-context consolidation (v27 follow-up): stepPersist no longer
 * calls this. startup_contexts was a second writer for this exact data with an incompatible
 * row shape (see v26_company_contexts.sql's header) and, worse, a snapshot that could go
 * stale between runs — every field it holds is a pure function of a context object that is
 * already fully persisted in company_contexts. intelligenceService.stepMemory derives the
 * structured layer on demand via enrichContextWithOnboarding instead. Kept, not deleted:
 * the startup_contexts table still holds historical rows and this function is the only
 * documented shape for them. Slated for removal alongside the table itself once that
 * history is no longer needed (see the plan's "retire redundant stores" phase).
 */
export async function storeStartupContext(companyId, startupContext, onboardingData, autoInferred) {
    if (!supabase || !companyId) {
        console.warn('[ContextBuilder] No supabase or companyId — context not persisted.');
        return null;
    }

    try {
        const { data, error } = await supabase
            .from('startup_contexts')
            .insert({
                company_id: companyId,
                version_id: startupContext.context_version_id,
                revenue_profile: startupContext.revenue_profile,
                market_profile: startupContext.market_profile,
                dependency_map: startupContext.dependency_map,
                competitive_map: startupContext.competitive_map,
                strategic_assumptions: startupContext.strategic_assumptions,
                exposure_weights: startupContext.exposure_weights,
                sensitivity_snapshot: startupContext.sensitivity_snapshot,
                onboarding_inputs: onboardingData || {},
                auto_inferred: autoInferred || {}
            })
            .select()
            .single();

        if (error) {
            console.error('[ContextBuilder] Store error:', error.message);
            return null;
        }

        console.log(`[ContextBuilder] ✅ Context stored: version=${startupContext.context_version_id}`);
        return data;
    } catch (err) {
        console.error('[ContextBuilder] Unexpected store error:', err);
        return null;
    }
}

/**
 * Get the latest Startup_Context for a company.
 *
 * ⚠️ UNUSED as of the company-context consolidation (v27 follow-up): companyMemoryService's
 * loadCompanyMemory no longer calls this — see the comment there. Kept for the same reason
 * as storeStartupContext above: historical rows still exist and this is their documented
 * read shape.
 */
export async function getLatestStartupContext(companyId) {
    if (!supabase || !companyId) return null;

    try {
        const { data, error } = await supabase
            .from('startup_contexts')
            .select('*')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error) {
            if (error.code === 'PGRST116') { // Not found is expected
                return null;
            }
            if (error.status === 406 || error.code === 'PGRST301') { // RLS violation
                console.warn('[ContextBuilder] ⚠️ RLS denied access to startup_contexts. User may not have client_id assigned.');
                return null;
            }
            console.error('[ContextBuilder] Fetch error:', error.message);
            return null;
        }

        return data;
    } catch (err) {
        console.error('[ContextBuilder] Unexpected fetch error:', err.message);
        return null;
    }
}

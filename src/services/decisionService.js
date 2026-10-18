/**
 * Shared decision-brief primitives.
 *
 * This module deliberately keeps the decision frame small and provider-neutral. The
 * LLM may propose a frame, but the founder confirms the frame before a run starts.
 */

export const DECISION_MODE = 'decision';
export const COMPANY_MODE = 'company';

/**
 * What KIND of question the founder actually asked.
 *
 * Three of the five questions this product is built for are not decisions:
 *   "Should we enter the US market?"                     → decision
 *   "What's changing in our competitive landscape?"      → situation
 *   "Is this market becoming more attractive?"           → assessment
 *   "What are our competitors doing that we may be missing?" → situation
 *
 * `kind` lives INSIDE the frame rather than in `report_kind`, which carries a DB CHECK
 * constraint and is read in eight places. A frame persisted before this existed has no
 * `kind` and normalizes to `decision` — which is exactly what it was — so every existing
 * row keeps rendering identically with no migration.
 */
export const INQUIRY_KINDS = ['decision', 'situation', 'assessment'];

/**
 * Phrasings that mark a sentence as proposing a COURSE OF ACTION rather than asking about
 * the world. Shared with inferOptions so the two cannot disagree about what a decision is.
 */
const DECISION_LEAD_IN_RE = /^(?:so\s+)?(?:should|shall|do|can|must|ought)\s+(?:we|i)\s+|^(?:is\s+it\s+time\s+to|whether\s+(?:to|we\s+should)|are\s+we\s+better\s+off)\s+/i;
const SITUATION_RE = /\b(?:why\s+(?:is|are|has|did)|what(?:'s|\s+is|\s+are)\s+(?:happening|changing|going\s+on)|what\s+changed|how\s+(?:is|are)\s+.*\bchang|what\s+are\s+(?:our|the)\s+competitors|what\s+should\s+we\s+know|what\s+(?:are\s+we|am\s+i)\s+missing)\b/i;
const ASSESSMENT_RE = /\b(?:how\s+(?:good|strong|risky|healthy|big|defensible|attractive)|is\s+.*\b(?:becoming|worth|attractive|viable|big\s+enough)|evaluate|assess|due\s+diligence|size\s+(?:of|up)\s+the)\b/i;

/**
 * Classify an inquiry, deterministically.
 *
 * ⚠️  The default is `situation`, NOT `decision`. That flip is the entire point: an
 * unclassifiable input used to fall through to the decision path, where `inferOptions`
 * fabricated a pair of options and rendered them into the founder-facing frame editor.
 * Defaulting to `situation` means an ambiguous question is researched as a question.
 */
export function inferInquiryKind(rawText) {
    const text = clean(rawText, MAX_DECISION_CHARS);
    if (!text) return 'situation';

    // A stated choice between two courses of action beats every other signal, because the
    // founder has already named the alternatives.
    const splitsOnChoice = /\s+(?:vs\.?|versus|or)\s+/i.test(text) && DECISION_LEAD_IN_RE.test(text);
    if (splitsOnChoice || DECISION_LEAD_IN_RE.test(text)) return 'decision';

    if (SITUATION_RE.test(text)) return 'situation';
    if (ASSESSMENT_RE.test(text)) return 'assessment';
    return 'situation';
}

function normalizeKind(value) {
    const k = String(value || '').trim().toLowerCase();
    return INQUIRY_KINDS.includes(k) ? k : null;
}

const MAX_DECISION_CHARS = 6000;
const MAX_OPTIONS = 6;
const MAX_SUB_QUESTIONS = 5;

function newDecisionId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch { /* fall through */ }
    const hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function clean(value, limit = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function uniqueStrings(values, limit = 10) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => clean(value, 300))
        .filter(Boolean))].slice(0, limit);
}

function optionId(label, index) {
    return `option_${index + 1}_${clean(label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'choice'}`;
}

const STATUS_QUO = /wait|current|status quo|nothing|not proceed|stay put|hold/i;

function titleCase(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Derive the options a founder is actually weighing from their own words.
 *
 * This used to fabricate `Proceed with the proposed direction / Do not proceed yet`
 * whenever it could not split the text, and those invented options were rendered straight
 * into the founder-facing editable frame. Bahirjee inventing someone's choices is the
 * precise inverse of its job, so an input that names no course of action now yields no
 * options and fails validation with a message that says so.
 */
function inferOptions(rawText) {
    const text = clean(rawText, MAX_DECISION_CHARS);
    const candidates = text
        .split(/\s+(?:vs\.?|versus|or)\s+/i)
        .map(part => part.replace(DECISION_LEAD_IN_RE, '').replace(/[?.]+$/, '').trim())
        .filter(part => part.length > 2 && part.length < 180)
        .map(titleCase);

    // Two or more named courses of action — the founder stated the choice themselves.
    if (candidates.length >= 2) {
        const options = candidates.slice(0, 3);
        if (!options.some(option => STATUS_QUO.test(option))) options.push('Hold the current path');
        return options.slice(0, MAX_OPTIONS);
    }

    // One named course of action ("should we enter the US market?"). The second option is
    // real rather than invented: it is not doing the thing they named.
    if (candidates.length === 1 && DECISION_LEAD_IN_RE.test(text)) {
        return [candidates[0], 'Hold the current path'];
    }

    return [];
}

export function buildFallbackDecisionFrame(rawText, context = {}, kindHint = null) {
    const statement = clean(rawText, MAX_DECISION_CHARS);
    const companyName = clean(context.company_name, 120);
    const kind = normalizeKind(kindHint) || inferInquiryKind(statement);

    // Options are a DECISION concept. Deriving them for a situation or an assessment is
    // how "what's changing in our landscape?" used to acquire two invented courses of
    // action it never mentioned.
    const options = kind === 'decision'
        ? inferOptions(statement).map((label, index) => ({ id: optionId(label, index), label, description: '' }))
        : [];

    const objectiveByKind = {
        decision: companyName ? `Choose the path that best serves ${companyName}'s current position.` : '',
        situation: companyName ? `Understand what is changing around ${companyName} and what it means.` : '',
        assessment: companyName ? `Judge this against ${companyName}'s position on the evidence available.` : '',
    };
    const unresolvedByKind = {
        decision: ['What outcome would make this decision successful?'],
        situation: ['Which of these changes actually bears on your position?'],
        assessment: ['What would make this good enough to act on?'],
    };

    return normalizeDecisionFrame({
        id: context._decision?.id || newDecisionId(),
        kind,
        raw_input: statement,
        decision_statement: statement,
        decision_type: kind === 'decision' ? 'strategic choice' : kind,
        objective: objectiveByKind[kind] || '',
        options,
        constraints: [],
        time_horizon: '',
        geography: context.operating_geography || '',
        stakeholders: [],
        success_criteria: [],
        // A situation is researched through its sub-questions the way a decision is
        // researched through its options, so the frame must carry at least one.
        sub_questions: kind === 'decision' ? [] : (statement ? [statement] : []),
        unresolved_questions: unresolvedByKind[kind] || [],
    }, statement, true);
}

/**
 * `isFallback` stops the option-recovery retry below from re-entering
 * `buildFallbackDecisionFrame`, which calls back into this function. That was safe only
 * while `inferOptions` always returned two options; now that it can honestly return none,
 * an un-guarded retry would recurse until the stack blew.
 */
export function normalizeDecisionFrame(frame = {}, fallbackRawText = '', isFallback = false) {
    const source = frame && typeof frame === 'object' ? frame : {};
    const rawInput = clean(source.raw_input || source.rawText || fallbackRawText, MAX_DECISION_CHARS);
    const rawOptions = Array.isArray(source.options) ? source.options : [];
    const options = rawOptions
        .map((option, index) => {
            const item = typeof option === 'string' ? { label: option } : (option || {});
            const label = clean(item.label || item.name || item.title, 180);
            if (!label) return null;
            return {
                id: clean(item.id, 80) || optionId(label, index),
                label,
                description: clean(item.description, 400),
            };
        })
        .filter(Boolean)
        .slice(0, MAX_OPTIONS);

    // Absent on every frame persisted before inquiry kinds existed — and those were all
    // decisions, so the fallback is correct rather than merely safe.
    const kind = normalizeKind(source.kind) || 'decision';

    const normalized = {
        id: clean(source.id, 80) || null,
        kind,
        raw_input: rawInput,
        decision_statement: clean(source.decision_statement || source.statement || rawInput, 600),
        decision_type: clean(source.decision_type || source.type || 'strategic choice', 100),
        objective: clean(source.objective || source.desired_outcome || source.goal, 500),
        options,
        constraints: uniqueStrings(source.constraints, 10),
        time_horizon: clean(source.time_horizon || source.deadline, 160),
        geography: clean(source.geography, 160),
        stakeholders: uniqueStrings(source.stakeholders, 10),
        success_criteria: uniqueStrings(source.success_criteria, 8),
        sub_questions: uniqueStrings(source.sub_questions || source.subquestions, MAX_SUB_QUESTIONS),
        unresolved_questions: uniqueStrings(source.unresolved_questions, MAX_SUB_QUESTIONS),
    };

    // An LLM decision frame that came back without options may still have options
    // recoverable from the founder's own words. If it doesn't, the frame keeps zero options
    // and validation says so — it does not get a pair invented for it.
    //
    // Only for a DECISION: a situation or assessment having no options is the correct
    // outcome, not a defect to recover from.
    if (kind === 'decision' && !normalized.options.length && rawInput && !isFallback) {
        return normalizeDecisionFrame(buildFallbackDecisionFrame(rawInput, {}, 'decision'), rawInput, true);
    }
    return normalized;
}

/**
 * Validate an inquiry frame according to what its KIND actually requires.
 *
 * The old single rule — "at least two options" — is right for a decision and nonsense for
 * a situation. Applying it to every input is what made "what's changing in our landscape?"
 * either fail validation or acquire fabricated options. A situation is researched through
 * its sub-questions, an assessment through its criteria; each needs at least one of its own
 * handle, and none of them needs the others'.
 *
 * Only `errors` block a run. `warnings` flow to the readiness gate, which has a
 * proceed-anyway escape hatch.
 */
export function validateDecisionFrame(frame) {
    const normalized = normalizeDecisionFrame(frame);
    const errors = [];
    const warnings = [];
    const kind = normalized.kind || 'decision';
    const noun = kind === 'decision' ? 'decision' : 'question';

    if (!normalized.raw_input) errors.push(`Describe the ${noun} you are trying to work through.`);
    if (normalized.decision_statement.length < 12) errors.push(`Make the ${noun} more specific.`);

    if (kind === 'decision') {
        if (normalized.options.length < 2) {
            errors.push('This reads as a question about your situation rather than a choice between courses of action. Add the options you are weighing, or rephrase it as a question.');
        }
        if (!normalized.time_horizon) warnings.push('No decision timeframe is specified.');
        if (!normalized.success_criteria.length) warnings.push('No success criteria are specified.');
    } else if (kind === 'situation') {
        if (!normalized.sub_questions.length) {
            errors.push('Add at least one specific question you want answered — it is what Bahirjee searches against.');
        }
    } else if (kind === 'assessment') {
        if (!normalized.success_criteria.length && !normalized.sub_questions.length) {
            errors.push('Add what you are judging this against — a criterion or a specific question.');
        }
        if (!normalized.success_criteria.length) warnings.push('No explicit criteria; the assessment will use its own.');
    }

    if (!normalized.objective) warnings.push('No desired outcome is specified.');
    return { ok: errors.length === 0, errors, warnings, frame: normalized };
}

/**
 * Turn the frame into the queries that answer it.
 *
 * A decision is researched through its OPTIONS, a situation through what has CHANGED, an
 * assessment against its CRITERIA. Running option-shaped queries for a situation searches
 * for alternatives the founder never proposed.
 *
 * The four shared queries stay first: whatever the kind, the founder's own market, its
 * competitors, its regulation and its cost base all bear on the answer.
 */
export function buildDecisionQueries({ frame, context = {}, year = new Date().getFullYear(), entities = [] }) {
    const decision = normalizeDecisionFrame(frame);
    const kind = decision.kind || 'decision';
    const industry = clean(context.strategic_anchors?.operational_reality || context.industry || 'the market', 100);
    const geography = clean(decision.geography || context.operating_geography || 'global', 80);
    const company = clean(context.company_name || 'the company', 100);
    const statement = clean(decision.decision_statement, 180);

    // ⚠️  ORDER IS LOAD-BEARING. Only the first `inquiryQueryFloor` of these survive the
    // pin in stepGenerateQueries at a shallow budget, so the queries that actually chase
    // the founder's question must come FIRST. These four generic context queries used to
    // lead, which meant the reserved slots went to searches the normal query generator
    // already produces and the question itself was never searched at all.
    const queries = [];

    if (kind === 'decision') {
        decision.options.map(o => o.label).slice(0, 4).forEach(option => {
            queries.push(`"${option}" ${industry} ${geography} adoption outcomes risks ${year}`);
        });
    } else if (kind === 'situation') {
        queries.push(`${statement} ${industry} ${geography} ${year}`);
        queries.push(`${industry} ${geography} what changed shift drivers ${year}`);
        // A situation is usually "what are THEY doing", so name the actual rivals.
        (Array.isArray(entities) ? entities : [])
            .filter(e => e?.category === 'competitor' && e?.name)
            .slice(0, 3)
            .forEach(e => queries.push(`"${clean(e.name, 80)}" recent moves announcement ${year}`));
    } else if (kind === 'assessment') {
        queries.push(`${statement} ${industry} ${geography} evidence ${year}`);
        queries.push(`${industry} ${geography} market size growth outlook ${year}`);
        decision.success_criteria.slice(0, 3).forEach(criterion => {
            queries.push(`${clean(criterion, 140)} ${industry} ${geography} benchmark ${year}`);
        });
    }

    decision.sub_questions.slice(0, 3).forEach(question => {
        queries.push(`${clean(question, 180)} ${industry} ${geography} evidence ${year}`);
    });

    // Shared context, appended LAST. Whatever the kind, the founder's own market, its
    // competitors, its regulation and its cost base all bear on the answer — but these
    // overlap heavily with what the deterministic generator already produces, so they are
    // the right things to lose when the budget is thin.
    queries.push(
        `"${company}" ${industry} market demand customer buying signals ${year}`,
        `${industry} ${geography} competitor moves pricing positioning ${year}`,
        `${industry} ${geography} regulation compliance risks ${year}`,
        `${industry} ${geography} funding hiring cost trends ${year}`,
    );

    return [...new Set(queries.map(query => query.replace(/\s+/g, ' ').trim()))].slice(0, 14);
}

// ── Inquiry-named aliases ───────────────────────────────────────────────────
// The `decision`-named exports stay as the canonical implementation so every existing
// import and test keeps working unchanged; these read correctly for the other two kinds.
export const normalizeInquiryFrame = normalizeDecisionFrame;
export const validateInquiryFrame = validateDecisionFrame;
export const buildInquiryQueries = buildDecisionQueries;
export const buildFallbackInquiryFrame = buildFallbackDecisionFrame;

export function decisionContextForReport(frame, mode = COMPANY_MODE) {
    if (mode !== DECISION_MODE) return null;
    return normalizeDecisionFrame(frame);
}

export function buildDecisionBriefFallback(frame, signals = []) {
    const decision = normalizeDecisionFrame(frame);
    const sourceUrls = [...new Set((Array.isArray(signals) ? signals : []).map(signal => signal?.source_url).filter(Boolean))].slice(0, 5);
    return {
        decision_snapshot: decision.decision_statement,
        current_read: 'The evidence is not strong enough to select an option automatically. Compare the tradeoffs below and validate the unresolved questions before committing.',
        confidence: signals.length >= 5 ? 'Medium' : 'Low',
        option_assessments: decision.options.map(option => ({
            option_id: option.id,
            option_label: option.label,
            case_for: [],
            case_against: [],
            key_risks: ['Evidence was insufficient for a reliable option-specific assessment.'],
            assumptions: decision.constraints,
            evidence_refs: sourceUrls,
            confidence: 'Low'
        })),
        tradeoffs: ['The current scan did not produce enough verified evidence to rank the options.'],
        unknowns: decision.unresolved_questions.length ? decision.unresolved_questions : ['Which option best satisfies the stated success criteria?'],
        what_would_change_assessment: ['New evidence tied to the decision timeframe, success criteria, and options.'],
        validation_steps: ['Collect direct customer or stakeholder evidence for each option.', 'Re-run the brief after the most important unknown is resolved.'],
        follow_up_questions: decision.sub_questions,
    };
}

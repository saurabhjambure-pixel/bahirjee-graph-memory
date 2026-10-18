import React, { useState, useEffect, useRef } from 'react';
import {
    ChevronRight, ChevronLeft, CheckCircle, Building2,
    Gauge, Brain, Sparkles, Info
} from 'lucide-react';

// ── Options Constants ──
const REVENUE_MODELS = ['Subscription', 'Usage-based', 'Enterprise contracts', 'Marketplace', 'Hybrid'];
const CUSTOMER_TYPES = ['SMB', 'Mid-market', 'Enterprise'];
const SALES_MOTIONS = ['PLG', 'Sales-led', 'Hybrid'];
const FUNDING_STAGES = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C+', 'Bootstrapped', 'Public'];
const SENSITIVITY_LEVELS = ['Low', 'Medium', 'High'];
const ASSUMPTION_DOMAINS = ['Demand', 'Cost', 'Capital', 'Distribution', 'Regulation', 'Talent'];

// Two steps, not three. "Your Market Bets" was step 3 of 3 and optional, so most founders
// arrived at it having already decided they were done — and it sat between them and their
// first report. One bet is enough to steer run 1; the rest are collected AFTER the brief,
// where Bahirjee can show which assumptions its own judgment rests on and ask which to
// track. That is a warm ask after value rather than a cold form before it.
const STEPS = [
    { id: 'business', label: 'Business Core', icon: Building2, description: 'Revenue, customers, and go-to-market' },
    { id: 'sensitivity', label: 'Sensitivity Snapshot', icon: Gauge, description: 'Calibrate your exposure signals' },
];

// ── Step Progress ──
function StepIndicator({ steps, currentIndex }) {
    return (
        <div className="flex items-center gap-2 mb-8">
            {steps.map((step, i) => {
                const isActive = i === currentIndex;
                const isDone = i < currentIndex;
                const Icon = step.icon;
                return (
                    <div key={step.id} className="flex items-center gap-2">
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-300 ${isActive ? 'bg-bah-accent-soft border border-[var(--bah-accent)]/40 text-bah-accent' :
                                isDone ? 'bg-emerald-500/10 border border-emerald-500/30 text-bah-accent-strong' :
                                    'bg-bah-panel-soft border border-bah text-bah-muted'
                            }`}>
                            {isDone ? <CheckCircle className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                            <span className="text-xs font-medium tracking-wide hidden sm:inline">{step.label}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div className={`w-6 h-px ${isDone ? 'bg-bah-accent-soft' : 'bg-bah-panel-soft'}`} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ── Auto-Detected Badge ──
function AutoDetectedBadge({ show }) {
    if (!show) return null;
    return (
        <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded bg-bah-accent-soft border border-[var(--bah-accent)]/20 text-[9px] text-bah-accent font-medium uppercase tracking-wider">
            <Sparkles className="w-2.5 h-2.5" />
            Auto-detected
        </span>
    );
}

// ── Bahirjee Understood Card ──
function AutoInferredCard({ autoInferred }) {
    if (!autoInferred) return null;
    const { companyName, industry, vertical, teamSize, growthSignals } = autoInferred;
    if (!companyName && !industry) return null;

    return (
        <div className="bg-bah-accent-soft rounded-xl p-4 border border-[var(--bah-accent)]/15 mb-5">
            <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 rounded-lg bg-bah-cyan-soft">
                    <Sparkles className="w-3.5 h-3.5 text-bah-cyan" />
                </div>
                <span className="text-xs font-bold uppercase tracking-widest text-bah-accent">Bahirjee understood</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
                {companyName && (
                    <div>
                        <span className="text-bah-muted text-xs">Company</span>
                        <p className="text-bah font-medium">{companyName}</p>
                    </div>
                )}
                {industry && (
                    <div>
                        <span className="text-bah-muted text-xs">Industry</span>
                        <p className="text-bah font-medium">{industry}</p>
                    </div>
                )}
                {vertical && (
                    <div>
                        <span className="text-bah-muted text-xs">Vertical</span>
                        <p className="text-bah font-medium">{vertical}</p>
                    </div>
                )}
                {teamSize && teamSize !== 'unknown' && (
                    <div>
                        <span className="text-bah-muted text-xs">Team Size</span>
                        <p className="text-bah font-medium">{teamSize}</p>
                    </div>
                )}
            </div>
            <p className="text-[11px] text-bah-muted mt-3 flex items-center gap-1">
                <Info className="w-3 h-3" />
                Review and adjust below if anything looks off.
            </p>
        </div>
    );
}

// ── Select Component ──
function SelectField({ label, value, onChange, options, required = false, placeholder, autoDetected = false }) {
    // Every <label> in this form was unassociated, so screen readers announced the
    // controls as unlabelled. One id here covers all five required selects.
    const id = React.useId();
    return (
        <div>
            <label htmlFor={id} className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2">
                {label} {required && <span className="text-bah-danger">*</span>}
                <AutoDetectedBadge show={autoDetected && value} />
            </label>
            <select
                id={id}
                value={value}
                onChange={e => onChange(e.target.value)}
                className={`w-full bg-bah-panel-soft border rounded-xl px-4 py-3 text-sm text-bah focus:border-[var(--bah-accent)] focus:ring-1 focus:ring-[var(--bah-accent)]/30 outline-none transition-all appearance-none cursor-pointer ${
                    autoDetected && value ? 'border-[var(--bah-accent)]/30' : 'border-bah'
                }`}
                required={required}
            >
                <option value="" className="text-bah-muted-2">{placeholder || `Select ${label.toLowerCase()}`}</option>
                {options.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                ))}
            </select>
        </div>
    );
}

// ── Sensitivity Selector ──
function SensitivityField({ label, description, value, onChange }) {
    return (
        <div className="bg-bah-panel-soft rounded-xl p-5 border border-bah">
            <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                    <h4 className="text-sm font-medium text-bah">{label}</h4>
                    <p className="text-xs text-bah-muted mt-1">{description}</p>
                </div>
                <div className="flex gap-1">
                    {SENSITIVITY_LEVELS.map(level => {
                        const isActive = value === level;
                        const colors = {
                            Low: isActive ? 'bg-emerald-500/20 text-bah-accent-strong border-emerald-500/40' : '',
                            Medium: isActive ? 'bg-amber-500/20 text-bah-warning border-amber-500/40' : '',
                            High: isActive ? 'bg-red-500/20 text-bah-danger border-red-500/40' : '',
                        };
                        return (
                            <button
                                key={level}
                                type="button"
                                onClick={() => onChange(level)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all duration-200 ${isActive
                                        ? colors[level]
                                        : 'bg-bah-panel-soft text-bah-muted border-bah hover:border-bah-light hover:text-bah'
                                    }`}
                            >
                                {level}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════
// MAIN ONBOARDING FORM COMPONENT
// ═══════════════════════════════════════════════════
export default function OnboardingForm({ onComplete, initialData = {}, autoInferred = null }) {
    const [step, setStep] = useState(0);

    // Track which fields were auto-detected
    const hasAutoData = autoInferred !== null;

    // Block A — Business Core
    const [revenueModel, setRevenueModel] = useState(initialData.revenueModel || '');
    const [customerType, setCustomerType] = useState(initialData.customerType || '');
    const [salesMotion, setSalesMotion] = useState(initialData.salesMotion || '');
    const [geography, setGeography] = useState(initialData.geography || '');
    const [fundingStage, setFundingStage] = useState(initialData.fundingStage || '');
    // Seeded from the inferred industry rather than falling back to it at render time.
    // With `value={industryOverride || autoInferred.industry}` clearing the field just
    // re-rendered the inferred value, so the founder could not rewrite a field whose own
    // helper text invites correction.
    const [industryOverride, setIndustryOverride] = useState(autoInferred?.industry || '');
    const industryTouched = useRef(false);

    // If the inferred industry lands after mount, seed the field once — but never
    // overwrite what the founder has already typed.
    useEffect(() => {
        if (!industryTouched.current && autoInferred?.industry) {
            setIndustryOverride(autoInferred.industry);
        }
    }, [autoInferred?.industry]);

    // Block B — Sensitivity Snapshot (6 factors)
    const [infraCost, setInfraCost] = useState(initialData.infraCost || 'Medium');
    const [revenueSlowdown, setRevenueSlowdown] = useState(initialData.revenueSlowdown || 'Medium');
    const [hiringDependency, setHiringDependency] = useState(initialData.hiringDependency || 'Medium');
    const [competitivePressure, setCompetitivePressure] = useState(initialData.competitivePressure || 'Medium');
    const [regulatoryExposure, setRegulatoryExposure] = useState(initialData.regulatoryExposure || 'Medium');
    const [platformDependency, setPlatformDependency] = useState(initialData.platformDependency || 'Medium');

    // One bet, captured inline on the Sensitivity step. Prefilled from whatever a previous
    // run (or an uploaded deck) already recorded, so a returning founder is not re-asked.
    const [primaryBet, setPrimaryBet] = useState(initialData.assumptions?.[0]?.statement || '');
    const [primaryBetDomain, setPrimaryBetDomain] = useState(initialData.assumptions?.[0]?.domain || '');
    // Bets beyond the first are preserved untouched — they come from the post-brief
    // tracking step and must survive a re-run through onboarding.
    const carriedBets = (initialData.assumptions || []).slice(1);

    // ── Validation ──
    const isBlockAValid = revenueModel && customerType && salesMotion && geography && fundingStage;

    const handleSubmit = () => {
        const formData = {
            // Block A
            revenueModel,
            customerType,
            salesMotion,
            geography,
            fundingStage,
            industryOverride: industryOverride.trim() || null,
            // Block B (6 factors)
            infraCost,
            revenueSlowdown,
            hiringDependency,
            competitivePressure,
            regulatoryExposure,
            platformDependency,
            // A bet stated here is High sensitivity by definition — the founder typed it
            // when they could have skipped it. Only High-sensitivity bets reserve a query.
            assumptions: [
                ...(primaryBet.trim()
                    ? [{ statement: primaryBet.trim(), domain: primaryBetDomain || 'Demand', sensitivity: 'High' }]
                    : []),
                ...carriedBets,
            ],
        };
        onComplete(formData);
    };

    const canProceed = () => {
        if (step === 0) return isBlockAValid;
        return true; // B and C have defaults/are optional
    };

    const goNext = () => {
        if (step < STEPS.length - 1) setStep(step + 1);
        else handleSubmit();
    };

    const goPrev = () => {
        if (step > 0) setStep(step - 1);
    };

    return (
        // Flex column bounded by the parent screen's height, so the step body scrolls
        // internally instead of pushing the page. The Continue button must stay reachable
        // without scrolling — it is the only way forward in the funnel.
        <div className="w-full max-w-2xl mx-auto space-y-3 tall:space-y-5 flex flex-col max-h-full min-h-0">
            {/* Header */}
            <div className="text-center space-y-1 shrink-0">
                <h2 className="text-xl font-medium text-bah-strong tracking-tight">Startup Intelligence Profile</h2>
                <p className="hidden tall:block text-sm text-bah-muted">
                    {hasAutoData
                        ? 'Bahirjee has pre-filled these from your website. Review and adjust.'
                        : 'This drives what Bahirjee watches and how it scores exposure.'
                    }
                </p>
            </div>

            {/* Step Indicator */}
            <StepIndicator steps={STEPS} currentIndex={step} />

            {/* Step Content */}
            {/* min-h-0 lets this shrink below its content so the overflow scrolls here,
                not on the page. The old min-h-[320px] floor forced the opposite. */}
            <div className="bg-bah-panel-soft rounded-2xl border border-bah p-4 tall:p-6 space-y-4 tall:space-y-6 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                {/* BLOCK A — Business Core */}
                {step === 0 && (
                    <div className="space-y-5 animate-in fade-in duration-300">
                        {/* Bahirjee Understood Card */}
                        <AutoInferredCard autoInferred={autoInferred} />

                        <div className="flex items-center gap-2 mb-4">
                            <Building2 className="w-5 h-5 text-bah-accent" />
                            <h3 className="text-lg font-medium text-bah-strong">Business Core</h3>
                        </div>

                        {/* Industry Override (only if auto-detected) */}
                        {autoInferred?.industry && (
                            <div>
                                <label htmlFor="onboarding-industry" className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2">
                                    Industry
                                    <AutoDetectedBadge show={true} />
                                </label>
                                <input
                                    id="onboarding-industry"
                                    value={industryOverride}
                                    onChange={e => { industryTouched.current = true; setIndustryOverride(e.target.value); }}
                                    placeholder={autoInferred.industry}
                                    className="w-full bg-bah-panel-soft border border-[var(--bah-accent)]/30 rounded-xl px-4 py-3 text-sm text-bah placeholder-bah-muted-2 focus:border-[var(--bah-accent)] focus:ring-1 focus:ring-[var(--bah-accent)]/30 outline-none transition-all"
                                />
                                <p className="text-[10px] text-bah-muted-2 mt-1 pl-1">Edit if Bahirjee got your industry wrong — this impacts all signal targeting.</p>
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <SelectField
                                label="Revenue Model"
                                value={revenueModel}
                                onChange={setRevenueModel}
                                options={REVENUE_MODELS}
                                required
                                placeholder="How do you monetize?"
                                autoDetected={hasAutoData && !!initialData.revenueModel}
                            />
                            <SelectField
                                label="Primary Customer"
                                value={customerType}
                                onChange={setCustomerType}
                                options={CUSTOMER_TYPES}
                                required
                                placeholder="Who buys from you?"
                                autoDetected={hasAutoData && !!initialData.customerType}
                            />
                            <SelectField
                                label="Sales Motion"
                                value={salesMotion}
                                onChange={setSalesMotion}
                                options={SALES_MOTIONS}
                                required
                                placeholder="How do you sell?"
                                autoDetected={hasAutoData && !!initialData.salesMotion}
                            />
                            <SelectField
                                label="Funding Stage"
                                value={fundingStage}
                                onChange={setFundingStage}
                                options={FUNDING_STAGES}
                                required
                                placeholder="Where are you?"
                                autoDetected={hasAutoData && !!initialData.fundingStage}
                            />
                        </div>
                        <div>
                            <label htmlFor="onboarding-geography" className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2">
                                Geography Focus <span className="text-bah-danger">*</span>
                                <AutoDetectedBadge show={hasAutoData && !!initialData.geography} />
                            </label>
                            <input
                                id="onboarding-geography"
                                value={geography}
                                onChange={e => setGeography(e.target.value)}
                                placeholder="e.g., India, US, Global, Southeast Asia"
                                className={`w-full bg-bah-panel-soft border rounded-xl px-4 py-3 text-sm text-bah placeholder-bah-muted-2 focus:border-[var(--bah-accent)] focus:ring-1 focus:ring-[var(--bah-accent)]/30 outline-none transition-all ${
                                    hasAutoData && initialData.geography ? 'border-[var(--bah-accent)]/30' : 'border-bah'
                                }`}
                                required
                            />
                        </div>
                    </div>
                )}

                {/* BLOCK B — Sensitivity Snapshot (6 factors) */}
                {step === 1 && (
                    <div className="space-y-5 animate-in fade-in duration-300">
                        <div className="flex items-center gap-2 mb-2">
                            <Gauge className="w-5 h-5 text-bah-warning" />
                            <h3 className="text-lg font-medium text-bah-strong">Sensitivity Snapshot</h3>
                        </div>
                        <p className="text-xs text-bah-muted -mt-3">These calibrate how Bahirjee weights exposure signals. They influence what news reaches you.</p>
                        <SensitivityField
                            label="Infra Cost Sensitivity"
                            description="How much would a 30% cost increase from your cloud/AI provider impact your unit economics?"
                            value={infraCost}
                            onChange={setInfraCost}
                        />
                        <SensitivityField
                            label="Revenue Slowdown Risk"
                            description="How vulnerable is your current revenue to macroeconomic slowdown or buyer budget cuts?"
                            value={revenueSlowdown}
                            onChange={setRevenueSlowdown}
                        />
                        <SensitivityField
                            label="Hiring Dependency"
                            description="How dependent is your next growth phase on hiring key talent?"
                            value={hiringDependency}
                            onChange={setHiringDependency}
                        />
                        <SensitivityField
                            label="Competitive Pressure"
                            description="How aggressively are competitors encroaching on your core market right now?"
                            value={competitivePressure}
                            onChange={setCompetitivePressure}
                        />
                        <SensitivityField
                            label="Regulatory Exposure"
                            description="How likely is a regulatory change to significantly disrupt your operations or go-to-market?"
                            value={regulatoryExposure}
                            onChange={setRegulatoryExposure}
                        />
                        <SensitivityField
                            label="Platform Dependency Risk"
                            description="How dependent is your distribution or revenue on a single platform (App Store, marketplace, API provider)?"
                            value={platformDependency}
                            onChange={setPlatformDependency}
                        />

                        {/* The one bet worth asking for up front: it reserves a search query
                            on this run. Everything else waits until after the brief. */}
                        <div className="bg-bah-panel-soft rounded-xl p-5 border border-bah space-y-3">
                            <div className="flex items-center gap-2">
                                <Brain className="w-4 h-4 text-violet-400" />
                                <h4 className="text-sm font-medium text-bah">One bet you are making <span className="text-bah-muted-2 font-normal">(optional)</span></h4>
                            </div>
                            <p className="text-xs text-bah-muted -mt-1">
                                Something you believe about your market that this run should test. Bahirjee spends a
                                search looking for evidence <em>against</em> it, and says whether it found any.
                            </p>
                            <input
                                value={primaryBet}
                                onChange={e => setPrimaryBet(e.target.value)}
                                placeholder="e.g., Enterprise buyers will increase SaaS budgets in 2026"
                                className="bah-input rounded-lg px-3 py-2.5 text-sm"
                            />
                            <select
                                value={primaryBetDomain}
                                onChange={e => setPrimaryBetDomain(e.target.value)}
                                className="bah-input rounded-lg px-3 py-2 text-xs cursor-pointer"
                            >
                                <option value="">Which domain does it sit in?</option>
                                {ASSUMPTION_DOMAINS.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                    </div>
                )}

            </div>

            {/* Navigation — shrink-0 so it stays pinned and reachable while the step
                body above scrolls. */}
            <div className="flex items-center justify-between shrink-0">
                <button
                    type="button"
                    onClick={goPrev}
                    disabled={step === 0}
                    className="flex items-center gap-2 px-5 py-2.5 bg-bah-panel-soft hover:bg-bah-panel-soft text-bah-muted hover:text-bah-strong rounded-xl transition-all disabled:opacity-30 disabled:hover:bg-bah-panel-soft disabled:hover:text-bah-muted"
                >
                    <ChevronLeft className="w-4 h-4" />
                    Back
                </button>

                <button
                    type="button"
                    onClick={goNext}
                    disabled={!canProceed()}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium transition-all shadow-lg ${step === STEPS.length - 1
                            ? 'bg-bah-accent-strong hover:brightness-110 text-bah-strong shadow-emerald-900/30 disabled:opacity-50'
                            : 'bg-bah-accent-strong hover:brightness-110 text-bah-strong shadow-emerald-900/30 disabled:opacity-50'
                        }`}
                >
                    {step === STEPS.length - 1 ? (
                        <>
                            <CheckCircle className="w-4 h-4" />
                            Start Intelligence Scan
                        </>
                    ) : (
                        <>
                            Continue
                            <ChevronRight className="w-4 h-4" />
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}

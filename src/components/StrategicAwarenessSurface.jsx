/**
 * What's moving — the cross-run layer.
 *
 * Named for what a founder sees, not for the subsystem that produces it. The internal
 * shape (shifts, patterns, blind spots, opportunities) is unchanged; only the words on
 * screen are, because "Strategic Awareness Surface" is four syllables of nothing to the
 * person reading it.
 * 
 * Replaces Signal Cards as the primary intelligence display.
 * Shows: what's moving, emerging patterns, what you're not watching, openings.
 * 
 * Constraints:
 *   - Max 3 surfaced items per category
 *   - Explicit "No structural changes detected" empty state
 *   - Shows lifecycle/maturity for each finding
 *   - Shows confidence reasoning from interpretation
 */

import React, { useState } from 'react';
import {
    Activity, Eye, Target, Lightbulb,
    ChevronDown, ChevronUp, AlertTriangle,
    ThumbsUp, ThumbsDown, Flame, Sparkles, Share2
} from 'lucide-react';

// Max items surfaced per section
const MAX_SURFACED = 3;

// ─── Section Header ───
const SectionHeader = ({ icon, title, count, color }) => (
    <div className="flex items-center gap-2 mb-4">
        <div className={`p-1.5 rounded-lg ${color}`}>{icon}</div>
        <h3 className="text-sm font-semibold text-bah uppercase tracking-wider">{title}</h3>
        {count > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${color}`}>{count}</span>
        )}
    </div>
);

// ─── Empty State ───
const EmptyState = ({ message }) => (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center border border-dashed border-bah rounded-xl bg-bah-panel-soft">
        <div className="w-10 h-10 rounded-full bg-bah-panel-soft flex items-center justify-center text-bah-muted mb-3 animate-pulse">
            <Activity className="w-5 h-5 opacity-50" />
        </div>
        <p className="text-bah-muted text-xs italic max-w-xs">{message || 'Nothing structural has moved.'}</p>
    </div>
);

const ShiftCard = ({ shift, interpretation, onReact }) => {
    const [expanded, setExpanded] = useState(false);
    const [activeReaction, setActiveReaction] = useState(null);

    const handleReactionClick = (type) => {
        setActiveReaction(type);
        onReact?.(shift.id, type);
    };

    const typeConfig = {
        emerging: { label: 'Emerging', color: 'text-bah-warning bg-amber-500/10 border-amber-500/20', icon: '🔺' },
        structural: { label: 'Structural', color: 'text-bah-cyan bg-blue-500/10 border-blue-500/20', icon: '🔷' },
        anomaly: { label: 'Anomaly', color: 'text-bah-danger bg-red-500/10 border-red-500/20', icon: '⚠️' }
    };

    const config = typeConfig[shift.shift_type] || typeConfig.emerging;
    const interp = interpretation?.find(i => i.theme === shift.theme && i.finding_type === 'shift');

    return (
        <div className={`rounded-xl border ${config.color} p-4 transition-all hover:scale-[1.01]`}>
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-lg">{config.icon}</span>
                    <div>
                        <span className={`text-[10px] uppercase tracking-wider font-bold ${config.color.split(' ')[0]}`}>
                            {config.label} Shift
                        </span>
                        <h4 className="text-sm text-bah font-medium mt-0.5">
                            {shift.theme?.replace(/_/g, ' ')}
                        </h4>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${shift.confidence === 'High' ? 'border-emerald-500/30 text-bah-accent-strong' :
                        shift.confidence === 'Medium' ? 'border-amber-500/30 text-bah-warning' :
                            'border-red-500/30 text-bah-danger'
                        } uppercase tracking-wider`}>
                        {shift.confidence}
                    </span>
                </div>
            </div>

            {/* Velocity metrics */}
            <div className="flex items-center gap-4 mt-3 text-[10px] text-bah-muted border-t border-bah pt-3">
                <span>Velocity: {shift.current_velocity?.toFixed(1)}x</span>
                <span>Δ {shift.velocity_delta > 0 ? '+' : ''}{shift.velocity_delta?.toFixed(1)}</span>
                <span>Since: {new Date(shift.detected_at).toLocaleDateString()}</span>
            </div>

            {/* Interpretation (expand/collapse) */}
            {interp && (
                <div className="mt-3">
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="flex items-center gap-1 text-[10px] text-bah-accent hover:text-bah-accent-strong transition-colors"
                    >
                        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {expanded ? 'Hide' : 'View'} Interpretation
                    </button>
                    {expanded && (
                        <div className="mt-2 bg-bah-panel-soft rounded-lg p-3 space-y-2 animate-in fade-in text-xs">
                            <div><span className="text-bah-muted font-medium">Indication:</span> <span className="text-bah">{interp.indication}</span></div>
                            <div><span className="text-bah-muted font-medium">Relevance:</span> <span className="text-bah">{interp.company_relevance}</span></div>
                            <div><span className="text-bah-muted font-medium">Stability:</span> <span className={`${interp.stability_assessment === 'structural' ? 'text-bah-cyan' :
                                interp.stability_assessment === 'temporary' ? 'text-bah-warning' : 'text-bah-muted'
                                }`}>{interp.stability_assessment}</span></div>
                            <div><span className="text-bah-muted font-medium">Uncertainty:</span> <span className="text-bah-muted italic">{interp.uncertainty_notes}</span></div>
                        </div>
                    )}
                </div>
            )}

            {/* Reactions & Actions */}
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-bah">
                <div className="flex items-center gap-1">
                    {['thumbs_up', 'fire', 'insight', 'thumbs_down'].map(type => {
                        const isActive = activeReaction === type;
                        return (
                            <button
                                key={type}
                                onClick={() => handleReactionClick(type)}
                                className={`p-1.5 rounded transition-all duration-300 transform ${isActive ? 'bg-bah-accent-soft text-bah-accent scale-110' : 'text-bah-muted hover:bg-bah-panel-soft hover:text-bah'}`}
                                title={type.replace('_', ' ')}
                            >
                                {type === 'thumbs_up' ? <ThumbsUp className="w-3.5 h-3.5" /> :
                                    type === 'fire' ? <Flame className="w-3.5 h-3.5" /> :
                                        type === 'insight' ? <Lightbulb className="w-3.5 h-3.5" /> :
                                            <ThumbsDown className="w-3.5 h-3.5" />}
                            </button>
                        );
                    })}
                    {activeReaction && (
                        <span className="ml-2 text-[9px] text-bah-accent uppercase tracking-wider animate-in fade-in slide-in-from-left-2">
                            Recorded
                        </span>
                    )}
                </div>

                <button
                    className="p-1.5 rounded hover:bg-bah-panel-soft text-bah-muted hover:text-bah transition-colors flex items-center gap-1.5 text-[10px] uppercase font-medium"
                    title="Export Insight"
                >
                    <Share2 className="w-3.5 h-3.5" /> Share
                </button>
            </div>
        </div>
    );
};

// ─── What you're not watching ───
const BlindSpotCard = ({ blindSpot, interpretation }) => {
    const [expanded, setExpanded] = useState(false);
    const interp = interpretation?.find(i => i.theme === blindSpot.theme && i.finding_type === 'blind_spot');

    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
            <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-bah-danger" />
                <h4 className="text-sm text-bah-danger font-medium">
                    {blindSpot.theme?.replace(/_/g, ' ')}
                </h4>
            </div>
            <p className="text-xs text-bah-muted mt-2">
                Competitors <span className="text-bah-danger font-medium">{blindSpot.competitor_entities?.join(', ')}</span> are active in this space. Your presence was not detected.
            </p>
            {interp && (
                <div className="mt-2">
                    <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-bah-accent hover:text-bah-accent-strong flex items-center gap-1">
                        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        Interpretation
                    </button>
                    {expanded && (
                        <div className="mt-2 bg-bah-panel-soft rounded-lg p-3 text-xs space-y-1">
                            <div className="text-bah">{interp.indication}</div>
                            <div className="text-bah-muted italic text-[10px] mt-1">{interp.uncertainty_notes}</div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ─── Opportunity Card ───
const OpportunityCard = ({ opportunity, interpretation }) => {
    const [expanded, setExpanded] = useState(false);
    const interp = interpretation?.find(i => i.theme === opportunity.theme && i.finding_type === 'opportunity');

    const isEmerging = opportunity.opportunity_type === 'emerging';

    return (
        <div className={`rounded-xl border p-4 ${isEmerging
            ? 'border-emerald-500/20 bg-emerald-500/5'
            : 'border-amber-500/20 bg-amber-500/5'
            }`}>
            <div className="flex items-center gap-2">
                <Target className={`w-4 h-4 ${isEmerging ? 'text-bah-accent-strong' : 'text-bah-warning'}`} />
                <span className={`text-[10px] uppercase tracking-wider font-bold ${isEmerging ? 'text-bah-accent-strong' : 'text-bah-warning'}`}>
                    {isEmerging ? 'Emerging' : 'Missed'}
                </span>
                <h4 className="text-sm text-bah font-medium">
                    {opportunity.theme?.replace(/_/g, ' ')}
                </h4>
            </div>
            {opportunity.evidence && (
                <p className="text-xs text-bah-muted mt-2">{opportunity.evidence}</p>
            )}
            {interp && (
                <div className="mt-2">
                    <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-bah-accent hover:text-bah-accent-strong flex items-center gap-1">
                        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        Interpretation
                    </button>
                    {expanded && (
                        <div className="mt-2 bg-bah-panel-soft rounded-lg p-3 text-xs text-bah">
                            {interp.indication}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════

export default function StrategicAwarenessSurface({ v6Data, onReact }) {
    if (!v6Data) return null;

    const { shifts = [], blindSpots = [], opportunities = [], patterns = [], interpretation } = v6Data;
    const interpretations = interpretation?.interpretations || [];
    const landscapeSummary = interpretation?.landscape_summary;

    const hasFindings = shifts.length > 0 || blindSpots.length > 0 || opportunities.length > 0;

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-bah-accent-soft text-bah-accent border border-[var(--bah-accent)]/20">
                        <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-lg font-display font-semibold text-bah-strong">Strategic Awareness</h2>
                        <p className="text-[10px] text-bah-muted uppercase tracking-wider">
                            {v6Data.jevScored ? 'v6.0 • Deterministic Engine • Jev-checked confidence' : 'v6.0 • Deterministic Engine'}
                        </p>
                    </div>
                </div>
            </div>

            {/* Landscape Summary */}
            {landscapeSummary && (
                <div className="bg-bah-accent-soft rounded-xl p-4 border-l-2 border-[var(--bah-accent)]/50">
                    <p className="text-sm text-bah-accent-strong leading-relaxed italic">"{landscapeSummary}"</p>
                </div>
            )}

            {!hasFindings ? (
                <EmptyState message="I need more than one reading to tell a change from a blip. I compare each week against the ones before it, so this fills in as I keep watching." />
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Active Shifts */}
                    <div>
                        <SectionHeader
                            icon={<Activity className="w-4 h-4" />}
                            title="What's moving"
                            count={shifts.length}
                            color="text-bah-warning bg-amber-500/10"
                        />
                        {shifts.length === 0 ? (
                            <EmptyState message="Nothing is moving yet." />
                        ) : (
                            <div className="space-y-3">
                                {shifts.slice(0, MAX_SURFACED).map(shift => (
                                    <ShiftCard key={shift.id} shift={shift} interpretation={interpretations} onReact={onReact} />
                                ))}
                                {shifts.length > MAX_SURFACED && (
                                    <p className="text-[10px] text-bah-muted-2 text-center">
                                        +{shifts.length - MAX_SURFACED} more shift(s)
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    {/* What you're not watching */}
                    <div>
                        <SectionHeader
                            icon={<Eye className="w-4 h-4" />}
                            title="What you're not watching"
                            count={blindSpots.length}
                            color="text-bah-danger bg-red-500/10"
                        />
                        {blindSpots.length === 0 ? (
                            <EmptyState message="Nothing here that I think you are missing." />
                        ) : (
                            <div className="space-y-3">
                                {blindSpots.slice(0, MAX_SURFACED).map(bs => (
                                    <BlindSpotCard key={bs.id} blindSpot={bs} interpretation={interpretations} />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Openings */}
                    <div>
                        <SectionHeader
                            icon={<Target className="w-4 h-4" />}
                            title="Openings"
                            count={opportunities.length}
                            color="text-bah-accent-strong bg-emerald-500/10"
                        />
                        {opportunities.length === 0 ? (
                            <EmptyState message="No openings this week." />
                        ) : (
                            <div className="space-y-3">
                                {opportunities.slice(0, MAX_SURFACED).map(opp => (
                                    <OpportunityCard key={opp.id} opportunity={opp} interpretation={interpretations} />
                                ))}
                            </div>
                        )}
                    </div>

                </div>
            )}
        </div>
    );
}

import React from 'react';
import { ArrowRight, Eye, Scale, ShieldQuestion, TrendingUp } from 'lucide-react';

/**
 * The judgment surface — one component, one order, for every kind of run.
 *
 * Company mode and decision mode used to render structurally different things, so the
 * product looked like two products. This is the unification made visible:
 *
 *     what changed → why it matters → our read (+ how confident, and why)
 *                  → what could change our view → what to consider
 *
 * Option assessments render ADDITIONALLY for a decision, rather than instead of this.
 *
 * The section that carries the positioning is "What could change our view". Every
 * intelligence product will tell you what happened; almost none will tell you what would
 * make them wrong, because it makes the output look less authoritative. That is exactly
 * why it earns its place above "what to consider" and is never collapsed by default.
 */

const CONFIDENCE_STYLES = {
  High: 'bg-bah-accent-soft text-bah-accent border-[var(--bah-accent)]/30',
  Medium: 'bg-bah-cyan-soft text-bah-cyan border-[var(--bah-cyan)]/30',
  Low: 'bg-amber-500/10 text-bah-warning border-amber-500/30',
};

function SectionHeading({ icon: Icon, children, tone = 'text-bah-muted' }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`w-3.5 h-3.5 ${tone}`} />
      <h3 className={`text-[10px] font-bold uppercase tracking-widest ${tone}`}>{children}</h3>
    </div>
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export default function BriefJudgment({ brief, decisionFrame }) {
  if (!brief || typeof brief !== 'object') return null;

  const {
    headline,
    what_changed = [],
    why_it_matters,
    our_read,
    confidence,
    what_could_change_our_view = [],
    what_to_consider = [],
    option_assessments = [],
    kind,
  } = brief;

  const isDecision = kind === 'decision';
  const confidenceLevel = confidence?.level || 'Low';

  // A v1 brief has no explicit headline, so normalizeBrief derives one from the first
  // sentence of the read. Rendering both then prints the same sentence twice.
  const headlineEchoesRead = Boolean(
    headline && our_read && our_read.trim().toLowerCase().startsWith(headline.trim().toLowerCase().replace(/[.…]+$/, ''))
  );
  const showHeadline = Boolean(headline) && !headlineEchoesRead;

  return (
    <div className="space-y-8 mb-10">
      {/* Headline + our read */}
      <div className="rounded-2xl border border-bah bg-bah-panel p-6">
        {isDecision && decisionFrame?.decision_statement && (
          <div className="text-[10px] uppercase tracking-widest text-bah-cyan mb-2">Decision under review</div>
        )}
        {showHeadline && (
          <h3 className="text-xl font-semibold text-bah-strong leading-snug">{headline}</h3>
        )}
        {isDecision && decisionFrame?.objective && (
          <p className="text-sm text-bah-muted mt-2">Desired outcome: {decisionFrame.objective}</p>
        )}

        {our_read && (
          <div className={showHeadline || (isDecision && decisionFrame?.objective) ? 'mt-5 pt-5 border-t border-bah' : ''}>
            <SectionHeading icon={Eye} tone="text-bah-accent">Our read</SectionHeading>
            <p className="text-sm text-bah leading-relaxed">{our_read}</p>
          </div>
        )}

        {confidence && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider ${CONFIDENCE_STYLES[confidenceLevel] || CONFIDENCE_STYLES.Low}`}>
              Confidence: {confidenceLevel}
            </span>
            {confidence.basis && (
              <span className="text-[11px] text-bah-muted-2">{confidence.basis}</span>
            )}
          </div>
        )}
      </div>

      {/* What changed — deterministic, every item carries its source */}
      {what_changed.length > 0 && (
        <div>
          <SectionHeading icon={TrendingUp}>What changed</SectionHeading>
          <ul className="space-y-2.5">
            {what_changed.map((item, i) => {
              const host = hostOf(item?.evidence_refs?.[0]);
              return (
                <li key={i} className="rounded-xl border border-bah bg-bah-panel/60 px-4 py-3">
                  <p className="text-sm text-bah leading-relaxed">{item.text}</p>
                  {(host || item.source_class) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {host && (
                        <a
                          href={item.evidence_refs[0]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-bah-muted-2 hover:text-bah-accent transition-colors"
                        >
                          {host}
                        </a>
                      )}
                      {item.source_class && (
                        <span className="text-[10px] uppercase tracking-wider text-bah-muted-2">{item.source_class.replace(/_/g, ' ')}</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {why_it_matters && (
        <div>
          <SectionHeading icon={ArrowRight}>Why it matters</SectionHeading>
          <p className="text-sm text-bah leading-relaxed">{why_it_matters}</p>
        </div>
      )}

      {/* Decision-only: the option comparison, in addition to the judgment above. */}
      {isDecision && option_assessments.length > 0 && (
        <div>
          <SectionHeading icon={Scale} tone="text-bah-cyan">Option tradeoffs</SectionHeading>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {option_assessments.map((option, index) => (
              <div key={option.option_id || index} className="rounded-xl border border-bah bg-bah-panel p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-base font-semibold text-bah-strong">{option.option_label || `Option ${index + 1}`}</h4>
                  {option.confidence && <span className="text-[10px] uppercase tracking-wider text-bah-muted">{option.confidence}</span>}
                </div>
                {option.case_for?.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-bah-accent mb-1">Case for</div>
                    <ul className="space-y-1 text-sm text-bah">{option.case_for.map((it, i) => <li key={i}>• {it}</li>)}</ul>
                  </div>
                )}
                {option.case_against?.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-bah-warning mb-1">Case against</div>
                    <ul className="space-y-1 text-sm text-bah">{option.case_against.map((it, i) => <li key={i}>• {it}</li>)}</ul>
                  </div>
                )}
                {option.key_risks?.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-bah-danger mb-1">Key risks</div>
                    <ul className="space-y-1 text-sm text-bah-muted">{option.key_risks.map((it, i) => <li key={i}>• {it}</li>)}</ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The section competitors will not ship. Never collapsed. */}
      {what_could_change_our_view.length > 0 && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
          <SectionHeading icon={ShieldQuestion} tone="text-bah-warning">What could change our view</SectionHeading>
          <ul className="space-y-2.5">
            {what_could_change_our_view.map((item, i) => (
              <li key={i} className="text-sm text-bah leading-relaxed">
                <span className="text-bah-warning mr-2">•</span>
                {item.text}
                {item.watch_for && (
                  <span className="block ml-4 mt-0.5 text-[11px] text-bah-muted-2">Watch: {item.watch_for}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Deliberately NOT "what you should do". Bahirjee's job is to make the human's
          judgment better, not to replace it. */}
      {what_to_consider.length > 0 && (
        <div>
          <SectionHeading icon={Scale}>What to consider</SectionHeading>
          <ul className="space-y-2.5">
            {what_to_consider.map((item, i) => (
              <li key={i} className="rounded-xl border border-bah bg-bah-panel/60 px-4 py-3">
                <p className="text-sm text-bah leading-relaxed">{item.text}</p>
                {item.tradeoff && (
                  <p className="mt-1 text-[11px] text-bah-muted">Trade-off: {item.tradeoff}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

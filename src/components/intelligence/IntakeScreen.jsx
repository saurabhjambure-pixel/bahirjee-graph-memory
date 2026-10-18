import React, { useState } from 'react';
import DocumentDropzone from './DocumentDropzone';
import { validateWebsiteUrl } from '../../utils/urlValidation';
import { inferInquiryKind } from '../../services/decisionService';
import {
  History,
  Loader2,
  Search,
  Info,
  Lock,
  Send,
  Sparkles,
  GitBranch,
  Target,
  ArrowLeft
} from 'lucide-react';
import SignOutLink from './SignOutLink';

// Mirrors the server-side limits in lib/handlers/upload.js. Vercel caps a request body at
// ~4.5 MB, which is why each file is uploaded in its own request rather than batched.
const SUPPORT_EMAIL = import.meta.env.VITE_UPGRADE_CONTACT_EMAIL || 'hello@bahirjee.com';

// How each inferred kind is described back to the founder. Naming the reading out loud is
// what makes the frame editor that follows feel like a correction rather than a form.
const KIND_COPY = {
  decision: { label: 'a decision', hint: 'Bahirjee will weigh the options you named.' },
  situation: { label: 'a question about your situation', hint: 'Bahirjee will research what is changing.' },
  assessment: { label: 'an assessment', hint: 'Bahirjee will judge it against the evidence.' },
};

export default function IntakeScreen({
  signOut,
  urlInput,
  setUrlInput,
  linkedinInput,
  setLinkedinInput,
  uploadedFiles,
  setUploadedFiles,
  handleUrlSubmit,
  analysisMode = 'company',
  setAnalysisMode,
  decisionText = '',
  setDecisionText,
  phase,
  statusMsg,
  profile,
  recentBriefs = [],
  loadReport,
  onBackToDesk = null
}) {
  const files = uploadedFiles || [];
  const [urlError, setUrlError] = useState('');

  // Classified client-side purely to read the reading back. The server re-infers it and the
  // founder confirms the frame, so this is a label, never a decision.
  const inquiryKind = decisionText.trim().length >= 12 ? inferInquiryKind(decisionText) : null;

  // Keep the parent's mode in step with the text. The pipeline branches on
  // `analysisMode === DECISION_MODE || context._decision` in a dozen places; deriving the
  // flag here means the front door changed and none of that had to.
  React.useEffect(() => {
    const shouldFrame = decisionText.trim().length >= 12;
    const next = shouldFrame ? 'decision' : 'company';
    if (analysisMode !== next) setAnalysisMode?.(next);
  }, [decisionText, analysisMode, setAnalysisMode]);

  // The only gate here used to be `!urlInput`, so "asdf" started a full analysis and
  // consumed the founder's single free run before anything could tell them otherwise.
  const submitIfValid = () => {
    if (phase !== 'idle') return;
    const { ok, message } = validateWebsiteUrl(urlInput);
    if (!ok) {
      setUrlError(message);
      return;
    }
    setUrlError('');
    handleUrlSubmit();
  };

  
  // Set defaults from profile if locked
  React.useEffect(() => {
     if (profile?.locked_website_url && !urlInput) {
         setUrlInput(profile.locked_website_url);
     }
     if (profile?.locked_linkedin_url && !linkedinInput) {
         setLinkedinInput(profile.locked_linkedin_url);
     }
  }, [profile, setUrlInput, setLinkedinInput]);

  const isLocked = !!profile?.locked_website_url;

  return (
    // Sized to fit one screen without scrolling. Spacing is compact by default and only
    // opens up via `tall:`/`taller:` when the viewport can afford it — a fixed reduction
    // would just push the overflow onto the next shorter laptop. min-h-dvh (not h-dvh)
    // is deliberate: if it still cannot fit (zoom, large text), it scrolls rather than
    // clipping the submit button.
    <div className="min-h-dvh text-bah font-sans flex flex-col items-center justify-center gap-3 tall:gap-6 px-4 py-4 tall:py-8 taller:py-12 relative">
      {/* Present only when the intake was opened FROM the desk. A first-time founder has no
          desk to go back to, so no button is rendered rather than one that does nothing. */}
      {onBackToDesk && (
        <button
          type="button"
          onClick={onBackToDesk}
          disabled={phase !== 'idle'}
          className="absolute top-5 left-5 z-20 bah-button-ghost px-3 py-1.5 text-xs inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to desk
        </button>
      )}
      <div className="absolute top-5 right-5 z-20">
        <SignOutLink signOut={signOut} />
      </div>

      <div className="w-full max-w-2xl relative z-10 space-y-3 tall:space-y-6 text-center animate-in fade-in duration-1000 slide-in-from-bottom-5">
        <div className="flex flex-col items-center gap-2 tall:gap-4">
          <div className="w-11 h-11 tall:w-16 tall:h-16 rounded-2xl brand-gradient flex items-center justify-center shadow-2xl ring-1 ring-bah shrink-0">
            <Sparkles className="w-6 h-6 tall:w-8 tall:h-8 text-bah-strong" />
          </div>
          <h1 className="text-display-sm taller:text-display font-display font-semibold text-bah-strong">
            <span className="font-medium">
              b<span className="text-bah-accent">a</span>h<span className="text-bah-cyan">i</span>rjee
            </span>{' '}
            <span className="text-bah-muted">Intelligence</span>
          </h1>
          {/* The tagline is the first thing to go when vertical space is scarce — the
              headline already carries the product name. */}
          <p className="hidden tall:block text-bah-muted text-base max-w-md mx-auto leading-relaxed">
            Turning information into judgment.
          </p>
        </div>
        
        {!isLocked && (
            <div className="bg-amber-500/10 border border-amber-500/20 text-bah-warning p-3 rounded-lg text-xs flex items-start gap-2 text-left mb-6">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <p>Welcome to your workspace. The domain and LinkedIn URL you enter here will be <strong>locked to your account</strong> for future analyses. Make sure they are correct.</p>
            </div>
        )}

        {/* No mt-8 here: it stacked on top of the parent's space-y and double-gapped. */}
        <div className="relative group text-left">
          {/* The question is the front door. The 50/50 toggle that used to sit here made
              "think through a decision" look like a side feature, and it was unclickable
              anyway — a decorative overlay swallowed its clicks, so the whole path was
              unreachable. `analysisMode` is now DERIVED from whether there is question
              text, which keeps every downstream branch in the pipeline untouched. */}
          <div className="mb-6">
            <label htmlFor="inquiry-input" className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2 ml-1">
              What are you trying to figure out? <span className="text-bah-muted-2 font-normal normal-case">(optional)</span>
            </label>
            <textarea
              id="inquiry-input"
              autoFocus={!isLocked}
              value={decisionText}
              onChange={(e) => setDecisionText?.(e.target.value)}
              placeholder={'e.g. Should we enter the US market?\ne.g. What are our competitors doing that we may be missing?\ne.g. Is this market becoming more attractive?'}
              className="bah-input min-h-24 rounded-xl p-3 text-sm resize-y"
              maxLength={6000}
            />
            <div className="flex items-start justify-between gap-3 mt-2 ml-1">
              <p className="text-[11px] text-bah-muted">
                {inquiryKind
                  ? <>Reading this as <strong className="text-bah-accent">{KIND_COPY[inquiryKind].label}</strong>. {KIND_COPY[inquiryKind].hint} You can correct the frame before Bahirjee searches.</>
                  : 'Leave it blank for a general scan of what is changing around your company.'}
              </p>
              {decisionText.trim().length > 0 && decisionText.trim().length < 12 && (
                <span className="text-[11px] text-bah-warning shrink-0">A bit more detail</span>
              )}
            </div>
          </div>

          <div className="flex justify-between items-end mb-3 ml-1">
             <label className="block text-xs font-bold uppercase tracking-widest text-bah-muted">Company Website</label>
             {isLocked && <span className="text-[10px] uppercase font-bold text-bah-accent bg-bah-accent-soft px-2 py-0.5 rounded flex items-center gap-1"><Lock className="w-3 h-3" /> Locked Domain</span>}
          </div>
          {/* Decorative hover halo for the URL field. It is `absolute inset-0` inside the
              `relative group` wrapper, so it spans the whole block — including the mode
              toggles above it — and being later in DOM order it painted on top of them.
              Without pointer-events-none it swallowed every click on "Think through a
              decision", which made the entire decision mode unreachable from the UI. */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[rgba(136,194,162,0.18)] to-[rgba(118,183,207,0.18)] rounded-2xl blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
          <div className={`relative bah-panel rounded-2xl shadow-2xl flex items-center p-2 focus-within:ring-1 focus-within:ring-[var(--bah-accent)]/50 ${isLocked ? 'opacity-70 pointer-events-none' : ''}`}>
            <Search className="w-5 h-5 text-bah-muted ml-4" />
            <input
              autoFocus={!isLocked}
              value={urlInput}
              disabled={isLocked}
              aria-invalid={Boolean(urlError)}
              aria-describedby={urlError ? 'url-error' : undefined}
              onChange={(e) => { setUrlInput(e.target.value); if (urlError) setUrlError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitIfValid();
                }
              }}
              placeholder="Example - companywebsite.com"
              className="bg-transparent border-none outline-none text-lg text-bah w-full p-4 placeholder-bah-muted-2 font-light disabled:text-bah-muted-2"
            />
            {isLocked ? (
                <div className="p-3 mr-2"><Lock className="w-5 h-5 text-bah-muted" /></div>
            ) : (
                <button
                onClick={submitIfValid}
                disabled={phase !== 'idle' || !urlInput || (decisionText.trim().length > 0 && decisionText.trim().length < 12)}
                className="bah-button-primary p-3 rounded-xl shadow-lg"
                >
                {phase === 'generating_context' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
            )}
          </div>
          {urlError && (
            <p id="url-error" className="text-bah-danger text-xs mt-2 ml-1 text-left">{urlError}</p>
          )}
        </div>

        <div className="text-left space-y-3 tall:space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2 ml-1">Company LinkedIn <span className="text-bah-muted-2 font-normal normal-case">(optional)</span></label>
            <div className={`bah-panel rounded-xl flex items-center p-2 ${isLocked ? 'opacity-70 pointer-events-none' : ''}`}>
              <span className="text-bah-muted-2 ml-3 text-sm">linkedin.com/company/</span>
              <input
                value={linkedinInput}
                disabled={isLocked}
                onChange={(e) => setLinkedinInput(e.target.value)}
                placeholder="company-name"
                className="bg-transparent border-none outline-none text-sm text-bah w-full p-2 placeholder-bah-muted-2 disabled:text-bah-muted-2"
              />
            </div>
            {isLocked && (
                <div className="mt-2 ml-1">
                    {/* Was a button with no handler. A mailto is a real route; there is no
                        in-app domain-change flow to point at yet. */}
                    <a
                      href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Domain change request')}`}
                      className="text-[10px] text-bah-muted hover:text-bah-accent transition-colors"
                    >
                      Need to update domain settings? Request a change.
                    </a>
                </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-bah-muted mb-2 ml-1">Upload Documents <span className="text-bah-muted-2 font-normal normal-case">(optional — deck, board update, strategy memo)</span></label>
            {/* A <label htmlFor> rather than a click-handling <div>: the input was
                `hidden`, which removes it from the tab order, so with the div owning the
                click there was no keyboard path to upload a document at all. `sr-only`
                keeps the input focusable; the label makes Enter/Space open the picker. */}
            <DocumentDropzone files={files} setFiles={setUploadedFiles} />
          </div>
        </div>

        {phase === 'generating_context' && (
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-bah-accent-soft border border-emerald-500/20 text-bah-accent-strong text-xs font-mono animate-fade-in mt-6">
            <Loader2 className="w-3 h-3 animate-spin" /> {statusMsg}
          </div>
        )}

        {/* Past briefs previously had no front door: the Memory Ledger lives inside the
            report header, which only renders once a report is open. A returning founder
            landing here saw a URL box and no way back to work they'd already paid for. */}
        {phase === 'idle' && recentBriefs.length > 0 && loadReport && (
          <div className="text-left pt-4 tall:pt-6 border-t border-bah">
            <div className="flex items-center gap-2 mb-3 ml-1">
              <History className="w-3.5 h-3.5 text-bah-muted" />
              <span className="text-xs font-bold uppercase tracking-widest text-bah-muted">Recent briefs</span>
            </div>
            {/* Rows scale with available height: one is enough to make history reachable
                (which is the strip's purpose), more when there's room. */}
            <div className="space-y-2
                            [&>*:nth-child(2)]:hidden tall:[&>*:nth-child(2)]:flex
                            [&>*:nth-child(3)]:hidden taller:[&>*:nth-child(3)]:flex">
              {recentBriefs.slice(0, 3).map((brief) => (
                <button
                  key={brief.id}
                  onClick={() => loadReport(brief)}
                  className="w-full bah-panel rounded-xl px-4 py-2 tall:py-2.5 flex items-center justify-between gap-3 text-left hover:border-[var(--bah-accent)]/40 transition-colors group"
                >
                  <span className="text-sm text-bah truncate">
                    {brief.inputs?.websiteUrl || brief.target_domain || 'Intelligence Brief'}
                  </span>
                  <span className="text-[10px] text-bah-muted shrink-0 group-hover:text-bah-accent transition-colors">
                    {brief.timestamp ? new Date(brief.timestamp).toLocaleDateString() : ''} →
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* mix-blend-plus-lighter was a dark-theme trick; on a light base it blows the
          text out to near-white and the footer disappears. */}
      <footer className="text-bah-muted-2 text-[10px] uppercase tracking-[0.2em] font-medium shrink-0">
        bahirjee • your intelligence officer
      </footer>
    </div>
  );
}

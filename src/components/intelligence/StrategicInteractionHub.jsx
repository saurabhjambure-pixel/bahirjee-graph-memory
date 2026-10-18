import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Send, Plus, Search, FileText, Globe, Image as ImageIcon, CheckCircle, Lock, Sparkles } from 'lucide-react';
import { trackQuestion, trackNote, getInteractionCount, saveQuestionAnswer } from '../../services/interactionService';
import { getFriendlyError } from '../../utils/errorMessages';

/**
 * StrategicInteractionHub
 *
 * This component is the SINGLE WRITER for question/note interactions — it owns the
 * free-tier limits, so it is the only place that calls trackQuestion/trackNote.
 * `onShareSignal` is a post-commit callback (confirmation / routing), NOT a second
 * persistence path; both callers used to write again and produced duplicate rows.
 *
 * Props:
 *  onAsk(signal, question): async fn — handles QnA via Gemini
 *  onShareSignal({ type, content }): async fn — post-commit notification only
 *  isPremium: boolean
 *  reportId: UUID of the current report (for backend interaction logging)
 *  userId: UUID of the current authenticated user
 *  onUpgrade(gateName): opens the upgrade modal (owned by ReportWorkspace)
 */
export default function StrategicInteractionHub({ onAsk, onShareSignal, isPremium, reportId, userId, onUpgrade }) {
  const [mode, setMode] = useState('ask');
  const [askInput, setAskInput] = useState('');
  const [shareInput, setShareInput] = useState('');
  const [shareType, setShareType] = useState('text');

  const [askAnswer, setAskAnswer] = useState(null);
  const [isAsking, setIsAsking] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareSuccess, setShareSuccess] = useState(false);

  // Backend-driven counts (fetched on mount)
  const [askCount, setAskCount] = useState(0);
  const [shareCount, setShareCount] = useState(0);
  const ASK_LIMIT = 3;
  const SHARE_LIMIT = 3;

  // Load existing interaction counts from Supabase on mount
  useEffect(() => {
    if (!reportId || !userId || isPremium) return;
    let cancelled = false;
    async function loadCounts() {
      try {
        const [q, n] = await Promise.all([
          getInteractionCount(reportId, userId, 'question'),
          getInteractionCount(reportId, userId, 'note'),
        ]);
        if (cancelled) return;
        setAskCount(q);
        setShareCount(n);
      } catch (e) {
        // Counts failing shouldn't break the hub — the server still enforces the limit.
        console.warn('[InteractionHub] Could not load interaction counts:', e?.message);
      }
    }
    loadCounts();
    return () => { cancelled = true; };
  }, [reportId, userId, isPremium]);

  const handleAsk = async () => {
    if (!askInput.trim()) return;
    if (!isPremium && askCount >= ASK_LIMIT) return;
    setIsAsking(true);

    try {
      let interactionId = null;
      if (reportId && userId) {
        const result = await trackQuestion(reportId, userId, askInput, { bypassLimit: isPremium });
        if (!result.allowed) {
          // Was a silent return: the typed question sat orphaned in the box while the UI
          // swapped to a lock state with no explanation of what had happened.
          if (!isPremium) setAskCount(ASK_LIMIT);
          toast.error(
            result.error === 'limit_reached'
              ? `You've used all ${ASK_LIMIT} free questions for this brief.`
              : getFriendlyError(result.error).friendly
          );
          return;
        }
        interactionId = result.interactionId;
        if (!isPremium) setAskCount(prev => prev + 1);
      }

      const answer = await onAsk(null, askInput);
      setAskAnswer(answer);
      // Persist the answer so the Q&A history survives unmount (non-blocking).
      if (interactionId && answer) saveQuestionAnswer(interactionId, answer);
    } catch (e) {
      console.error('[InteractionHub] Ask failed:', e);
      setAskAnswer("I couldn't process that question right now.");
    } finally {
      // Always releases the spinner — trackQuestion used to sit outside the try, so a
      // rejection left the button disabled for the rest of the session.
      setIsAsking(false);
    }
  };

  const handleShare = async () => {
    if (!shareInput.trim()) return;
    if (!isPremium && shareCount >= SHARE_LIMIT) return;
    setIsSharing(true);

    try {
      if (reportId && userId) {
        const result = await trackNote(reportId, userId, shareInput, { bypassLimit: isPremium });
        if (!result.allowed) {
          if (!isPremium) setShareCount(SHARE_LIMIT);
          toast.error(
            result.error === 'limit_reached'
              ? `You've used all ${SHARE_LIMIT} free shared signals for this brief.`
              : getFriendlyError(result.error).friendly
          );
          return;
        }
        if (!isPremium) setShareCount(prev => prev + 1);
      }

      // Post-commit only — the write above is the single source of persistence.
      await onShareSignal?.({ type: shareType, content: shareInput });
      setShareSuccess(true);
      setShareInput('');
      setTimeout(() => setShareSuccess(false), 3000);
    } catch (e) {
      console.error('[InteractionHub] Share failed:', e);
      toast.error(getFriendlyError(e?.message).friendly);
    } finally {
      setIsSharing(false);
    }
  };

  const askLocked  = !isPremium && askCount  >= ASK_LIMIT;
  const shareLocked = !isPremium && shareCount >= SHARE_LIMIT;

  return (
    <div className="bg-bah-panel rounded-xl border border-bah overflow-hidden mb-8">
      <div className="flex border-b border-bah">
        <button
          onClick={() => setMode('ask')}
          className={`flex-1 py-4 text-sm font-semibold tracking-wide flex items-center justify-center gap-2 transition-colors ${mode === 'ask' ? 'text-bah-accent bg-bah-panel-soft border-b-2 border-bah-accent' : 'text-bah-muted hover:bg-bah-panel-soft'}`}
        >
          <Search className="w-4 h-4" /> Ask Bahirjee
        </button>
        <button
          onClick={() => setMode('share')}
          className={`flex-1 py-4 text-sm font-semibold tracking-wide flex items-center justify-center gap-2 transition-colors ${mode === 'share' ? 'text-bah-accent-strong bg-bah-panel-soft border-b-2 border-emerald-400' : 'text-bah-muted hover:bg-bah-panel-soft'}`}
        >
          <Plus className="w-4 h-4" /> Share a signal with Bahirjee
        </button>
      </div>

      <div className="p-6">
        {mode === 'ask' && (
          <div className="space-y-4 animate-in fade-in">
            {askLocked ? (
              <div className="text-center py-4">
                <Lock className="w-5 h-5 text-bah-accent opacity-50 mx-auto mb-2" />
                <p className="text-bah-muted text-sm mb-3">You've reached your free limit of {ASK_LIMIT} questions.</p>
                <button
                  onClick={() => onUpgrade?.('ask_limit_upgrade')}
                  className="bg-bah-accent text-bah-strong font-medium px-4 py-2 text-xs rounded-full flex items-center justify-center gap-2 mx-auto hover:bg-bah-accent-strong transition-colors"
                >
                  <Sparkles className="w-3 h-3" /> Upgrade to Premium
                </button>
              </div>
            ) : (
              <>
                {!isPremium && askCount > 0 && (
                  <div className="text-right text-[10px] text-bah-muted mb-2 uppercase tracking-wider">
                    {ASK_LIMIT - askCount} question{ASK_LIMIT - askCount !== 1 ? 's' : ''} remaining
                  </div>
                )}
                {askAnswer && (
                  <div className="bg-bah-panel-soft p-4 rounded-lg border border-bah text-sm text-bah">
                    <div className="font-bold text-bah-accent text-xs mb-2 uppercase tracking-widest">Bahirjee Answered</div>
                    <p className="leading-relaxed">{askAnswer}</p>
                    <button onClick={() => setAskAnswer(null)} className="mt-3 text-xs text-bah-muted hover:text-bah-strong">Ask another question</button>
                  </div>
                )}
                {!askAnswer && (
                  <div className="relative group">
                    <div className="absolute inset-0 bg-bah-accent-soft rounded-lg blur opacity-0 group-focus-within:opacity-100 transition-opacity" />
                    <div className="relative flex items-center bg-bah-panel-soft border border-bah rounded-lg p-2 focus-within:border-bah-accent/50 transition-colors">
                      <Search className="w-5 h-5 text-bah-muted ml-2" />
                      <input
                        value={askInput}
                        onChange={(e) => setAskInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
                        placeholder="Ask about competitors, patterns, or specific data..."
                        className="w-full bg-transparent border-none text-bah px-3 py-2 outline-none text-sm placeholder-bah-muted-2"
                      />
                      <button
                        onClick={handleAsk}
                        disabled={isAsking || !askInput.trim()}
                        className="bah-button-primary p-2 rounded-md shrink-0 focus:outline-none"
                      >
                        {isAsking ? <span className="w-5 h-5 border-2 border-bah-light border-t-white rounded-full animate-spin block" /> : <Send className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {mode === 'share' && (
          <div className="space-y-4 animate-in fade-in">
            {shareLocked ? (
              <div className="text-center py-4">
                <Lock className="w-5 h-5 text-bah-accent-strong mx-auto mb-2" />
                <p className="text-bah-muted text-sm mb-3">You've reached your free limit of {SHARE_LIMIT} shared signals.</p>
                <button
                  onClick={() => onUpgrade?.('share_limit_upgrade')}
                  className="bg-bah-accent-strong text-bah-strong font-medium px-4 py-2 text-xs rounded-full flex items-center justify-center gap-2 mx-auto hover:brightness-110 transition-colors"
                >
                  <Sparkles className="w-3 h-3" /> Upgrade to Premium
                </button>
              </div>
            ) : shareSuccess ? (
              <div className="bg-bah-accent-soft border border-emerald-500/30 text-bah-accent-strong p-4 rounded-lg flex items-center justify-center gap-3 animate-in zoom-in-95">
                <CheckCircle className="w-5 h-5" />
                <span className="font-medium">Thanks. I'll track this.</span>
              </div>
            ) : (
              <>
                {!isPremium && shareCount > 0 && (
                  <div className="text-right text-[10px] text-bah-muted mb-2 uppercase tracking-wider">
                    {SHARE_LIMIT - shareCount} shared signal{SHARE_LIMIT - shareCount !== 1 ? 's' : ''} remaining
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setShareType('text')} className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded ${shareType === 'text' ? 'bg-emerald-500/20 text-bah-accent-strong' : 'text-bah-muted hover:bg-bah-panel-soft'}`}><FileText className="w-3 h-3 inline mr-1 -mt-0.5" />Text</button>
                  <button onClick={() => setShareType('url')} className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded ${shareType === 'url' ? 'bg-emerald-500/20 text-bah-accent-strong' : 'text-bah-muted hover:bg-bah-panel-soft'}`}><Globe className="w-3 h-3 inline mr-1 -mt-0.5" />URL</button>
                  <button onClick={() => setShareType('image')} className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded ${shareType === 'image' ? 'bg-emerald-500/20 text-bah-accent-strong' : 'text-bah-muted hover:bg-bah-panel-soft'}`}><ImageIcon className="w-3 h-3 inline mr-1 -mt-0.5" />Image</button>
                </div>
                <div className="relative group">
                  <div className="absolute inset-0 bg-emerald-500/10 rounded-lg blur opacity-0 group-focus-within:opacity-100 transition-opacity" />
                  <div className="relative flex items-center bg-bah-panel-soft border border-bah rounded-lg p-2 focus-within:border-emerald-500/50 transition-colors">
                    <Plus className="w-5 h-5 text-bah-accent-strong ml-2" />
                    <input
                      value={shareInput}
                      onChange={(e) => setShareInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleShare()}
                      placeholder={
                        shareType === 'text' ? 'Paste a snippet of intelligence...' :
                        shareType === 'url'  ? 'Paste an article or post URL...' :
                        'Paste image URL...'
                      }
                      className="w-full bg-transparent border-none text-bah px-3 py-2 outline-none text-sm placeholder-bah-muted-2"
                    />
                    <button
                      onClick={handleShare}
                      disabled={isSharing || !shareInput.trim()}
                      className="bg-bah-accent-strong hover:brightness-110 text-bah-strong p-2 rounded-md shrink-0 transition-colors disabled:opacity-50"
                    >
                      {isSharing ? <span className="w-5 h-5 border-2 border-bah-light border-t-white rounded-full animate-spin block" /> : <Send className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

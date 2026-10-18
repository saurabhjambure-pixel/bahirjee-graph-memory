import React, { useMemo, useState } from 'react';
import { Check, Loader2, Pencil, Sliders } from 'lucide-react';
import {
  buildContextSentences,
  applySentenceEdit,
  MIN_SENTENCES_FOR_CONFIRM,
} from '../../services/recognition';

/**
 * "Is this you?" — the front door, rebuilt.
 *
 * It replaces a 573-line field editor that asked a founder to review and correct fields
 * named `narrative_lens`, `leadership_tone`, `operational_reality` and
 * `current_optimization`, plus a six-chip risk grid, a "Buyer Type" prompting
 * `Enterprise | Mid-Market | SMB | Gov | Consumer`, and a confidence rating THEY were asked
 * to set. That was an analyst's intake form wearing a founder's clothes, and it was the
 * second screen of the product.
 *
 * ── Why this works where the form did not ────────────────────────────────────
 * It moves the cognitive job from RECALL to RECOGNITION. Nobody can describe their own
 * positioning into a blank field labelled `narrative_lens`. Everybody can tell you
 * instantly whether a sentence about their own business is wrong. It also does the trust
 * handshake here, on the second screen: the founder sees Bahirjee already knows three real
 * competitors by name before being asked for anything.
 *
 * ── What must not break ──────────────────────────────────────────────────────
 * Corrections land in `_userEdits.{fields,removed}` in EXACTLY the shape
 * ContextReviewScreen has always written, because `applyContextPatch` refuses to overwrite
 * those paths and `stepMemory` refuses to re-add those names. If this screen recorded edits
 * differently, founder corrections would silently stop being honoured on the next merge and
 * nothing would error — which is this codebase's characteristic failure. Both the write and
 * its inverse live in `src/services/recognition.js` so they cannot drift apart.
 *
 * Shipped behind VITE_CONTEXT_CONFIRM_V2. The full editor stays reachable from here for
 * anyone who wants every field, and for the case where too little of the context resolved
 * to make five sentences worth showing.
 */
export default function ContextConfirmScreen({
  contextData,
  setContextData,
  handleConfirmContext,
  isConfirming = false,
  storedMeta = null,
  onShowFullEditor,
}) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  // Re-derived from the context on every change, so an edit to one sentence is reflected
  // in any other sentence that reads the same field.
  const sentences = useMemo(() => buildContextSentences(contextData), [contextData]);

  const startEditing = (sentence) => {
    setEditingId(sentence.id);
    setDraft(sentence.value);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraft('');
  };

  const commitEditing = (sentence) => {
    const trimmed = draft.trim();
    // An unchanged value is not a correction. Recording it would tell applyContextPatch to
    // protect a field the founder never actually disagreed with, quietly freezing it
    // against every future run.
    if (trimmed && trimmed !== sentence.value) {
      setContextData(applySentenceEdit(contextData, sentence, trimmed));
    }
    cancelEditing();
  };

  const onKeyDown = (event, sentence) => {
    if (event.key === 'Enter') { event.preventDefault(); commitEditing(sentence); }
    if (event.key === 'Escape') { event.preventDefault(); cancelEditing(); }
  };

  const tooThin = sentences.length < MIN_SENTENCES_FOR_CONFIRM;

  return (
    <div className="min-h-dvh bg-bah-bg text-bah font-sans flex items-center justify-center p-4 py-8">
      <div className="w-full max-w-xl bah-panel-strong rounded-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">

        <div className="p-6 tall:p-8 border-b border-bah">
          <h1 className="text-2xl tall:text-3xl font-display font-semibold text-bah-strong tracking-tight">
            Is this you?
          </h1>
          <p className="text-bah-muted text-sm mt-2 leading-relaxed">
            I read your site and LinkedIn. Correct anything that&rsquo;s off &mdash; tap a line to edit it.
          </p>
          {storedMeta?.updatedAt && (
            <p className="text-bah-muted-2 text-xs mt-2">
              Last confirmed {new Date(storedMeta.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.
            </p>
          )}
        </div>

        {tooThin ? (
          // Asking "is this you?" about two facts reads as an admission that Bahirjee
          // learned nothing. Better to say so and hand over the full editor.
          <div className="p-6 tall:p-8">
            <p className="text-sm text-bah leading-relaxed">
              I couldn&rsquo;t read enough from your site to describe your business back to you
              properly. Rather than guess, let&rsquo;s fill it in together.
            </p>
            <button type="button" onClick={onShowFullEditor} className="bah-button-primary mt-5 w-full justify-center">
              Fill in the details
            </button>
          </div>
        ) : (
          <>
            <ul className="px-6 tall:px-8 py-2">
              {sentences.map((sentence) => {
                const isEditing = editingId === sentence.id;
                return (
                  <li key={sentence.id} className="border-b border-bah last:border-b-0">
                    {isEditing ? (
                      <div className="py-4 flex items-center gap-2">
                        <input
                          id={`confirm-${sentence.id}`}
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => onKeyDown(e, sentence)}
                          onBlur={() => commitEditing(sentence)}
                          aria-label={`${sentence.lead} …`}
                          className="bah-input flex-1 rounded-lg px-3 py-2 text-[15px]"
                        />
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => commitEditing(sentence)}
                          aria-label="Save this line"
                          className="p-2 rounded-lg text-bah-accent hover:bg-bah-panel-soft transition-colors shrink-0"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEditing(sentence)}
                        className="w-full text-left py-4 flex items-start gap-3 group"
                      >
                        <p className="flex-1 text-[15px] leading-relaxed text-bah">
                          {sentence.lead}{' '}
                          <span className="text-bah-accent border-b border-dashed border-[var(--bah-accent)]/45">
                            {sentence.value}
                          </span>
                          {sentence.tail}
                        </p>
                        <Pencil className="w-3.5 h-3.5 mt-1 text-bah-muted-2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity shrink-0" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="p-6 tall:p-8 pt-5 bg-bah-panel-soft border-t border-bah">
              <button
                type="button"
                onClick={handleConfirmContext}
                disabled={isConfirming}
                className="bah-button-primary w-full justify-center disabled:opacity-60"
              >
                {isConfirming
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting&hellip;</>
                  : 'Looks right — start watching'}
              </button>
              <p className="text-xs text-bah-muted mt-3 leading-relaxed">
                I&rsquo;ll read your market and write to you every Monday morning.
              </p>
              {onShowFullEditor && (
                <button
                  type="button"
                  onClick={onShowFullEditor}
                  className="mt-4 inline-flex items-center gap-1.5 text-xs text-bah-muted-2 hover:text-bah-strong transition-colors"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  Edit every detail
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

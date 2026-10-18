import React, { useState } from 'react';
import { UserRound, Loader2 } from 'lucide-react';
import { getFriendlyError } from '../../utils/errorMessages';
import SignOutLink from './SignOutLink';

// One-time gate: magic-link signups arrive with no name. We capture it once so
// profiles are complete. Also backfills existing null-name accounts.
export default function NameGateScreen({ onSubmit, signOut }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Please enter your name.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(getFriendlyError(err.message).friendly || 'Could not save your name. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-bah-bg flex items-center justify-center p-4 relative">
      <div className="absolute top-5 right-5">
        <SignOutLink signOut={signOut} />
      </div>
      <div className="w-full max-w-sm bah-panel p-8 rounded-2xl shadow-2xl space-y-6">
        <div className="w-16 h-16 rounded-2xl brand-gradient flex items-center justify-center mx-auto shadow-lg">
          <UserRound className="w-8 h-8 text-bah-strong" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-display font-semibold text-bah tracking-tight">Welcome</h1>
          <p className="text-bah-muted text-sm mt-2">What should we call you?</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Your full name"
            required
            autoFocus
            autoComplete="name"
            className="w-full bg-bah-panel-soft border border-bah rounded-xl px-4 py-3 text-bah placeholder-bah-muted-2 focus:border-[var(--bah-accent)] outline-none transition-all"
          />
          {error && <p className="text-bah-danger text-xs text-center">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bah-button-primary py-3 rounded-xl shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

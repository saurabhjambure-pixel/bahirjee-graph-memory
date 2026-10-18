import React from 'react';
import { Lock } from 'lucide-react';

export default function AuthScreen({
  email,
  authError,
  authNotice,
  setEmail,
  handleLogin
}) {
  return (
    <div className="min-h-dvh bg-bah-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm bah-panel p-8 rounded-2xl shadow-2xl space-y-6">
        <div className="w-16 h-16 rounded-2xl brand-gradient flex items-center justify-center mx-auto shadow-lg">
          <Lock className="w-8 h-8 text-bah-strong" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-display font-semibold text-bah tracking-tight">
            b<span className="text-bah-accent font-medium">a</span>h<span className="text-bah-cyan font-medium">i</span>rjee <span className="text-bah-muted">Intelligence</span>
          </h1>
          <p className="text-bah-muted text-sm mt-2">Enter your email to continue</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Email"
            required
            autoComplete="email"
            className="w-full bg-bah-panel-soft border border-bah rounded-xl px-4 py-3 text-bah placeholder-bah-muted-2 focus:border-[var(--bah-accent)] outline-none transition-all"
          />
          {authError && <p className="text-bah-danger text-xs text-center">{authError}</p>}
          {authNotice && <p className="text-bah-accent-strong text-xs text-center">{authNotice}</p>}
          <button type="submit" className="w-full bah-button-primary py-3 rounded-xl shadow-lg">
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

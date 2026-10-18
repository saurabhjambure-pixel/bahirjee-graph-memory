import React from 'react';
import { ChevronLeft } from 'lucide-react';
import OnboardingForm from '../Onboarding/OnboardingForm';
import SignOutLink from './SignOutLink';

export default function OnboardingScreen({
  signOut,
  resetToIdle,
  onComplete,
  onboardingData
}) {
  return (
    // The chrome was absolutely positioned at top-6, which overlapped the centred form
    // once the viewport got short. In normal flow it reserves its own row, and the form
    // area takes the remainder — so the step body scrolls inside the card rather than
    // the page scrolling as a whole.
    <div className="h-dvh bg-bah-bg text-bah font-sans flex flex-col p-3 tall:p-4 overflow-hidden">
      <div className="shrink-0 flex items-center justify-between gap-3">
        <button
          onClick={resetToIdle}
          className="flex items-center gap-2 px-3 py-2 bg-bah-panel-soft hover:bg-bah-panel-soft text-bah-muted hover:text-bah rounded-lg transition-colors text-sm"
        >
          <ChevronLeft size={16} />
          Start Over
        </button>
        <SignOutLink signOut={signOut} />
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center py-2 tall:py-4">
        <div className="w-full max-w-2xl max-h-full min-h-0 flex flex-col animate-in fade-in duration-500">
          <OnboardingForm
            onComplete={onComplete}
            initialData={onboardingData || {}}
            autoInferred={onboardingData?._autoInferred || null}
          />
        </div>
      </div>
    </div>
  );
}

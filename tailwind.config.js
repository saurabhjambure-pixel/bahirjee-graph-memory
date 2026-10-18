/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      // Height-aware breakpoints. The funnel screens (auth → intake → onboarding →
      // context review) are single-purpose pages that should not scroll, but a fixed
      // spacing reduction just moves the overflow to the next shorter laptop. These
      // invert the usual mobile-first idea onto the vertical axis: compact spacing is
      // the default, and `tall:` / `taller:` restore generous rhythm when the viewport
      // can actually afford it. Content still scrolls if it genuinely cannot fit
      // (small screens, browser zoom, large-text settings) — nothing is clipped.
      // Thresholds are the height at which the NEXT tier's content still fits, measured
      // on the intake screen (the tallest funnel page). Raising them is safe; lowering
      // them re-introduces the scroll.
      screens: {
        tall: { raw: '(min-height: 880px)' },
        taller: { raw: '(min-height: 1000px)' }
      },
      // Surfaced as utilities so components stop hardcoding hex values and raw
      // slate/white scales. Everything resolves to the CSS variables in
      // src/index.css, which stay the single source of truth.
      colors: {
        bah: {
          bg: 'var(--bah-bg)',
          panel: 'var(--bah-panel)',
          'panel-strong': 'var(--bah-panel-strong)',
          'panel-soft': 'var(--bah-panel-soft)',
          border: 'var(--bah-border)',
          text: 'var(--bah-text)',
          'text-strong': 'var(--bah-text-strong)',
          muted: 'var(--bah-muted)',
          'muted-2': 'var(--bah-muted-2)',
          accent: 'var(--bah-accent)',
          'accent-text': 'var(--bah-accent-text)',
          'accent-strong': 'var(--bah-accent-strong)',
          cyan: 'var(--bah-cyan)',
          'cyan-text': 'var(--bah-cyan-text)',
          warning: 'var(--bah-warning)',
          'warning-text': 'var(--bah-warning-text)',
          danger: 'var(--bah-danger)',
          'danger-text': 'var(--bah-danger-text)'
        }
      },
      // Two radii only: controls vs cards. Resolves the brief's tension between
      // "large rounded corners" (clay) and "subtle 6-8px".
      borderRadius: {
        clay: 'var(--bah-radius-sm)',
        'clay-lg': 'var(--bah-radius-lg)'
      },
      boxShadow: {
        clay: 'var(--bah-shadow-clay)',
        'clay-lg': 'var(--bah-shadow-clay-lg)',
        'glow-accent': 'var(--bah-glow-accent)'
      },
      fontFamily: {
        display: ['Poppins', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        num: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace']
      },
      // Oversized display headline (~3x body) with a mobile step-down, so the
      // intake hero stops overflowing a 375px screen.
      fontSize: {
        'display-sm': ['2rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        'display': ['2.75rem', { lineHeight: '1.05', letterSpacing: '-0.025em' }],
        'display-lg': ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em' }]
      }
    }
  },
  plugins: []
}

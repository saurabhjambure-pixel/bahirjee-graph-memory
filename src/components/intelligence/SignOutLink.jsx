import React from 'react';
import { LogOut } from 'lucide-react';

/**
 * Signing out, at the weight signing out deserves.
 *
 * This was a filled pill pinned to the top-right of every founder screen — four bespoke
 * copies of the same button, and collectively the most prominent persistent control in the
 * product. Meanwhile the thing a founder is actually paying for, the cadence, had no
 * surface at all. That ranking is the clearest single tell that a build is a prototype:
 * the only always-visible action is the one that ends the session.
 *
 * So: one definition, no fill, no border, muted until hovered, and the label hidden on
 * small screens where horizontal space belongs to the content. It is still one tap and
 * still reachable by keyboard — demoted, not hidden. A control people occasionally need
 * should be findable; it should not be the loudest thing on the page.
 *
 * Phase 3 gives this a proper home in the cadence bar alongside the account. Until then
 * this keeps the four screens consistent and quiet.
 */
export default function SignOutLink({ signOut, className = '' }) {
    return (
        <button
            type="button"
            onClick={signOut}
            title="Sign out"
            className={`flex items-center gap-1.5 px-2 py-1.5 -mr-2 rounded-lg text-xs text-bah-muted-2 hover:text-bah-danger hover:bg-bah-panel-soft transition-colors ${className}`}
        >
            <LogOut size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
            <span className="sr-only sm:hidden">Sign out</span>
        </button>
    );
}

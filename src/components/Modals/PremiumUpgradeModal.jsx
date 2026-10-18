import React from 'react';
import { Lock, Sparkles } from 'lucide-react';
import Modal from '../common/Modal';

export default function PremiumUpgradeModal({ open, onClose, onUpgrade, title = 'Premium Intelligence' }) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={title}
            description="Unlock deep-dive market signals, competitor moves, and unlimited strategic tracking."
        >
            <div className="w-12 h-12 rounded-full bg-bah-accent-soft flex items-center justify-center mx-auto mb-5 border border-[var(--bah-accent)]/40">
                <Lock className="w-6 h-6 text-bah-accent" />
            </div>

            <button onClick={onUpgrade} className="w-full bah-button-primary py-3 text-sm">
                <Sparkles className="w-4 h-4" />
                Upgrade to Premium
            </button>

            <button onClick={onClose} className="mt-3 w-full bah-button-secondary py-2 text-sm">
                Not now
            </button>
        </Modal>
    );
}

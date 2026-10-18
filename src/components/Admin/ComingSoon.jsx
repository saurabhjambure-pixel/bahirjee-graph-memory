import React from 'react';
import { Construction } from 'lucide-react';

export default function ComingSoon({ title, description }) {
    return (
        <div className="p-8 max-w-7xl mx-auto flex flex-col items-center justify-center min-h-[70vh] animate-in fade-in duration-500">
            <div className="w-20 h-20 bg-bah-accent-soft rounded-2xl flex items-center justify-center text-bah-accent mb-6 border border-[var(--bah-accent)]/20 shadow-[0_0_30px_rgba(136,194,162,0.1)]">
                <Construction size={40} />
            </div>
            <h2 className="text-3xl font-display font-semibold text-white mb-3 text-center">
                {title || 'Under Construction'}
            </h2>
            <p className="text-slate-400 text-center max-w-md mx-auto mb-8 text-lg">
                {description || 'We are working hard to bring you this feature in an upcoming release.'}
            </p>
            <button className="bah-button-secondary px-6 py-2.5 shadow-sm">
                Notify Me When Read
            </button>
        </div>
    );
}

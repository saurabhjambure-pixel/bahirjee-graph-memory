import React from 'react';

export default function TermsOfService() {
    return (
        <div className="min-h-screen bg-bah-bg text-slate-300 p-8">
            <div className="max-w-2xl mx-auto">
                <h1 className="text-3xl font-display font-semibold text-white mb-6">Terms of Service</h1>
                <p className="mb-4">Last Updated: 2026-01-31</p>
                <section className="space-y-4">
                    <h2 className="text-xl text-bah-accent">1. Acceptance</h2>
                    <p>By using Bahirjee Intelligence, you agree to these terms.</p>
                    {/* Add more legal filler if needed */}
                </section>
            </div>
        </div>
    );
}

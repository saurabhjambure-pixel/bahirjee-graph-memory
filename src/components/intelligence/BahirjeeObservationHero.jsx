import React from 'react';
import { Sparkles, BrainCircuit } from 'lucide-react';

export default function BahirjeeObservationHero({ observation }) {
  if (!observation) return null;
  
  return (
    <div className="bah-panel bg-gradient-to-br from-bah-accent/10 via-transparent to-bah-cyan/10 border-bah-accent/30 p-8 relative overflow-hidden mb-10 group">
      {/* Decorative background elements */}
      <div className="absolute top-0 right-0 p-8 opacity-10 blur-xl pointer-events-none group-hover:opacity-20 transition-opacity duration-700">
        <BrainCircuit className="w-64 h-64 text-bah-accent" />
      </div>
      
      <div className="relative z-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-bah-accent/20 rounded-xl border border-bah-accent/40 shadow-[0_0_15px_rgba(var(--bah-accent-rgb),0.3)]">
            <Sparkles className="w-5 h-5 text-bah-accent" />
          </div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-bah-accent/90">
            Bahirjee Observation
          </h2>
        </div>
        
        <p className="text-xl md:text-2xl font-light text-bah leading-relaxed max-w-4xl tracking-wide">
          "{observation}"
        </p>
      </div>
    </div>
  );
}

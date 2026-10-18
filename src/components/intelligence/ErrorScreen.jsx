import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getFriendlyError } from '../../utils/errorMessages';

export default function ErrorScreen({ statusMsg, setPhase, contextData, handleConfirmContext, handleStart }) {
  const { friendly, technical } = getFriendlyError(statusMsg);

  // Raw DB/driver errors still land in the console for debugging, just not on-screen.
  useEffect(() => {
    if (technical) console.error('[Analysis error]', technical);
  }, [technical]);

  return (
    <div className="min-h-dvh bg-bah-bg flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-bah-panel-strong p-8 rounded-2xl border border-red-500/20 text-center">
        <div className="w-12 h-12 bg-bah-danger-soft rounded-full flex items-center justify-center mx-auto mb-4 text-bah-danger"><AlertTriangle className="w-6 h-6" /></div>
        <h3 className="text-bah-strong text-lg font-medium mb-2">Analysis Interrupted</h3>
        <p className="text-bah text-sm mb-4">{friendly}</p>
        {technical && (
          <details className="mb-6 text-left">
            <summary className="text-bah-muted text-xs cursor-pointer hover:text-bah-muted select-none">Technical details</summary>
            <p className="text-bah-danger font-mono text-xs mt-2 bg-bah-danger-soft p-3 rounded break-words">{technical}</p>
          </details>
        )}
        <div className="flex gap-4 justify-center">
          <button onClick={() => setPhase('idle')} className="px-4 py-2 bg-bah-panel-soft hover:bg-bah-panel-soft text-bah rounded-lg">Home</button>
          <button onClick={contextData ? handleConfirmContext : handleStart} className="bah-button-primary px-4 py-2 rounded-lg">Retry</button>
        </div>
      </div>
    </div>
  );
}

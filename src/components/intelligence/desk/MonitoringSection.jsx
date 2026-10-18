import React from 'react';
import { Eye, Plus, Calendar, Clock, CheckCircle2, PauseCircle } from 'lucide-react';

export default function MonitoringSection({
  monitoringSetups = [],
  onToggleActive,
  onViewSetup,
  onCreateSetup
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-bah-accent-text" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-bah-muted font-display">
            Monitoring Setups ({monitoringSetups.length})
          </h3>
          <span className="text-xs text-bah-muted font-normal">
            (Continuous autonomous intelligence on scheduled cadences)
          </span>
        </div>

        <button
          onClick={onCreateSetup}
          className="bah-button-secondary px-3 py-1 text-xs inline-flex items-center gap-1 font-medium text-bah"
        >
          <Plus className="w-3 h-3 text-bah-accent-text" />
          <span>Create monitoring setup</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {monitoringSetups.map(setup => (
          <div
            key={setup.id}
            className={`bah-panel p-5 rounded-[20px] transition-all flex flex-col justify-between ${
              setup.is_active ? 'hover:border-[var(--bah-accent)]/30' : 'opacity-65 bg-bah-panel-soft'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <h4 className="text-base font-semibold text-bah-strong font-display">
                    {setup.name}
                  </h4>
                  <span className="text-xs text-bah-accent-text font-medium mt-0.5 inline-flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {setup.cadence}
                  </span>
                </div>

                {/* Active Toggle Switch */}
                <button
                  onClick={() => onToggleActive?.(setup.id)}
                  className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                    setup.is_active ? 'bg-bah-accent' : 'bg-gray-300 dark:bg-gray-700'
                  }`}
                  title={setup.is_active ? 'Monitoring is active. Click to pause.' : 'Monitoring is paused. Click to activate.'}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                      setup.is_active ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Scope pill */}
              <div className="mt-3">
                <span className="text-[10px] uppercase font-semibold text-bah-muted tracking-wider block mb-1">
                  Selected Scope:
                </span>
                <span className="px-2 py-1 rounded bg-bah-panel-strong border border-bah text-xs text-bah font-medium block truncate">
                  {setup.scope_label || 'Company perimeter'}
                </span>
              </div>

              {/* Recent Read / Status */}
              {setup.recent_read_summary && (
                <div className="mt-3 text-xs text-bah-muted line-clamp-2">
                  <span className="font-medium text-bah">Recent read:</span> {setup.recent_read_summary}
                </div>
              )}
            </div>

            {/* Timestamps & Action */}
            <div className="mt-4 pt-3 border-t border-bah flex items-center justify-between gap-2 text-[11px] text-bah-muted">
              <div>
                <span className="block">Last: {setup.last_check_at ? new Date(setup.last_check_at).toLocaleDateString() : 'Pending'}</span>
                <span className="block text-bah-accent-text font-medium">
                  Next: {setup.next_check_at ? new Date(setup.next_check_at).toLocaleDateString() : 'Tomorrow'}
                </span>
              </div>

              <button
                onClick={() => onViewSetup?.(setup)}
                className="bah-button-secondary px-2.5 py-1 text-xs"
              >
                View setup
              </button>
            </div>
          </div>
        ))}

        {/* Quick Add Setup Card */}
        <button
          onClick={onCreateSetup}
          className="border-2 border-dashed border-bah hover:border-[var(--bah-accent)] rounded-[20px] p-6 flex flex-col items-center justify-center text-center gap-2 group transition-all bg-bah-panel-soft hover:bg-bah-panel"
        >
          <div className="w-10 h-10 rounded-full bg-bah-accent-soft text-bah-accent-strong flex items-center justify-center group-hover:scale-105 transition-transform">
            <Plus className="w-5 h-5" />
          </div>
          <span className="text-sm font-semibold text-bah-strong font-display">
            Create monitoring setup
          </span>
          <span className="text-xs text-bah-muted max-w-[200px]">
            Configure autonomous alerts on a daily, weekly, or monthly pulse.
          </span>
        </button>
      </div>
    </div>
  );
}

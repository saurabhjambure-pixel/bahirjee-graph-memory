import React from 'react';
import { Link } from 'react-router-dom';
import { FileText, ExternalLink, Eye } from 'lucide-react';
import SignOutLink from './SignOutLink';

// Landing screen for `brief_viewer` users — people who reached the product because
// their email domain matches a client, rather than being invited. They can read the
// organisation's briefs but cannot run analyses, so they never see the intake form.
export default function BriefListScreen({ briefs = [], profile, signOut }) {
  const clientName = profile?.client?.name;

  return (
    <div className="min-h-dvh bg-bah-bg text-bah font-sans p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start justify-between mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-display font-semibold text-bah tracking-tight">
              b<span className="text-bah-accent font-medium">a</span>h<span className="text-bah-cyan font-medium">i</span>rjee <span className="text-bah-muted">Intelligence</span>
            </h1>
            <p className="text-bah-muted text-sm mt-2">
              {clientName ? `Briefs shared with ${clientName}` : 'Briefs shared with your organization'}
            </p>
          </div>
          <SignOutLink signOut={signOut} className="shrink-0" />
        </div>

        <div className="flex items-center gap-2 text-xs text-bah-muted mb-4 bg-bah-panel-soft rounded-lg px-3 py-2">
          <Eye size={14} />
          <span>You have view-only access. Ask an admin if you need to run your own analyses.</span>
        </div>

        {briefs.length === 0 ? (
          <div className="bah-panel p-10 text-center">
            <FileText className="w-10 h-10 text-bah-muted-2 mx-auto mb-4" />
            <p className="text-bah-muted text-sm">No briefs have been shared with your organization yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {briefs.map((brief) => (
              <Link
                key={brief.id}
                to={`/report/${brief.share_token}`}
                className="block bah-panel p-5 hover:border-[var(--bah-accent)]/40 transition-colors group"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-bah font-medium truncate">
                      {/* `context` is JSONB and deliberately not fetched by the history query,
                          so company_name can never resolve here — target_domain is the label. */}
                      {brief.target_domain || brief.inputs?.websiteUrl || 'Intelligence Brief'}
                    </div>
                    <div className="text-xs text-bah-muted mt-1">
                      {brief.created_at ? new Date(brief.created_at).toLocaleDateString(undefined, {
                        year: 'numeric', month: 'short', day: 'numeric'
                      }) : ''}
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-bah-muted-2 group-hover:text-bah-accent transition-colors shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

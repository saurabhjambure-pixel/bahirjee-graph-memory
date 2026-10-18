/**
 * Workspace Service for Bahirjee Intelligence.
 * Manages the real Company Anchor, Products, Decisions, Monitoring Setups,
 * and Composite Runs with reactive state and durable persistence for real users.
 */

const STORAGE_PREFIX = 'bahirjee_ws_';

export const workspaceService = {
  // Clear any legacy mock data from localStorage
  cleanupLegacyMocks: () => {
    try {
      const old = localStorage.getItem('bahirjee_workspace_v1');
      if (old && old.includes('Acme Health')) {
        localStorage.removeItem('bahirjee_workspace_v1');
      }
      localStorage.removeItem('bahirjee_intelligence_workspace_v1');
    } catch (e) {
      // ignore in SSR or blocked localStorage
    }
  },

  // Get local user-added products for a specific company scope
  getLocalProducts: (scopeKey) => {
    try {
      const stored = localStorage.getItem(`${STORAGE_PREFIX}products_${scopeKey}`);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  },

  // Save local user-added products
  saveLocalProducts: (scopeKey, products) => {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}products_${scopeKey}`, JSON.stringify(products));
    } catch (e) {
      console.warn('[workspaceService] Failed to persist local products', e);
    }
  },

  // Get local user-added decisions for a specific company scope
  getLocalDecisions: (scopeKey) => {
    try {
      const stored = localStorage.getItem(`${STORAGE_PREFIX}decisions_${scopeKey}`);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  },

  // Save local user-added decisions
  saveLocalDecisions: (scopeKey, decisions) => {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}decisions_${scopeKey}`, JSON.stringify(decisions));
    } catch (e) {
      console.warn('[workspaceService] Failed to persist local decisions', e);
    }
  },

  // Get local monitoring setups
  getLocalMonitoring: (scopeKey, companyName) => {
    try {
      const stored = localStorage.getItem(`${STORAGE_PREFIX}monitoring_${scopeKey}`);
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore
    }
    return [
      {
        id: `mon_pulse_${scopeKey}`,
        name: `${companyName || 'Company'} Market Pulse`,
        scope_label: 'Company Perimeter',
        cadence: 'Every Monday',
        cadence_key: 'weekly',
        last_check_at: new Date().toISOString(),
        is_active: true
      }
    ];
  },

  saveLocalMonitoring: (scopeKey, setups) => {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}monitoring_${scopeKey}`, JSON.stringify(setups));
    } catch (e) {
      console.warn('[workspaceService] Failed to persist local monitoring setups', e);
    }
  },

  // Build reactive workspace data from live sources + local additions
  buildWorkspaceData: ({
    clientId = null,
    companyDomain = '',
    companyName = '',
    history = [],
    dbTargets = [],
    dbAgenda = [],
    customCompany = null
  }) => {
    workspaceService.cleanupLegacyMocks();

    const scopeKey = companyDomain || clientId || 'default';

    // 1. Resolve Company Anchor
    let company = null;
    const dbCompanyTarget = (dbTargets || []).find(t => t.type === 'company');
    const latestReport = history && history.length > 0 ? history[0] : null;

    if (customCompany && (customCompany.domain || customCompany.name)) {
      const dom = customCompany.domain || companyDomain;
      const nom = customCompany.name || (dom ? dom.split('.')[0] : 'Company');
      company = {
        id: customCompany.id || `comp_${scopeKey}`,
        name: nom.charAt(0).toUpperCase() + nom.slice(1),
        domain: dom,
        canonical_url: customCompany.canonical_url || (dom ? `https://${dom}` : ''),
        tagline: customCompany.tagline || (dom ? `Market intelligence perimeter for ${dom}` : ''),
        industry: customCompany.industry || 'Technology & Services',
        operating_geography: customCompany.operating_geography || 'Global',
        regulatory_profile: customCompany.regulatory_profile || 'Standard compliance',
        status: 'active',
        monitored_status: 'Monitored (Active perimeter)'
      };
    } else if (dbCompanyTarget) {
      company = {
        id: dbCompanyTarget.id,
        name: dbCompanyTarget.name,
        domain: dbCompanyTarget.targetDomain || companyDomain,
        canonical_url: dbCompanyTarget.sources?.canonicalUrl || (dbCompanyTarget.targetDomain ? `https://${dbCompanyTarget.targetDomain}` : ''),
        tagline: latestReport?.context?.positioning || latestReport?.context?.tagline || `Market intelligence perimeter for ${dbCompanyTarget.name}`,
        industry: latestReport?.context?.industry || 'Technology & Innovation',
        operating_geography: latestReport?.context?.geography || 'Global',
        regulatory_profile: latestReport?.context?.regulatory_exposure || 'Standard compliance',
        status: 'active',
        monitored_status: 'Monitored (Active perimeter)'
      };
    } else if (latestReport) {
      const domain = latestReport.target_domain || companyDomain || '';
      const rawName = latestReport.context?.company_name || latestReport.inputs?.companyName || (domain ? domain.split('.')[0] : 'Company');
      const formattedName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      company = {
        id: `comp_${domain || 'primary'}`,
        name: formattedName,
        domain: domain,
        canonical_url: latestReport.inputs?.websiteUrl || (domain ? `https://${domain}` : ''),
        tagline: latestReport.context?.positioning || latestReport.context?.tagline || `Market intelligence perimeter for ${formattedName}`,
        industry: latestReport.context?.industry || 'Technology & Innovation',
        operating_geography: latestReport.context?.geography || 'Global',
        regulatory_profile: latestReport.context?.regulatory_exposure || 'Standard compliance',
        status: 'active',
        monitored_status: 'Monitored (Active perimeter)'
      };
    } else if (companyDomain) {
      const rawName = companyName || companyDomain.split('.')[0];
      const formattedName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
      company = {
        id: `comp_${companyDomain}`,
        name: formattedName,
        domain: companyDomain,
        canonical_url: `https://${companyDomain}`,
        tagline: `Market intelligence perimeter for ${formattedName}`,
        industry: 'Enterprise',
        operating_geography: 'Global',
        regulatory_profile: 'Standard',
        status: 'active',
        monitored_status: 'Ready for initial scan'
      };
    }

    // 2. Resolve Products
    const dbProducts = (dbTargets || [])
      .filter(t => t.type === 'product')
      .map(p => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline || p.description || (p.sources?.canonicalUrl ? p.sources.canonicalUrl.replace(/^https?:\/\//, '') : ''),
        description: p.description || '',
        canonical_url: p.sources?.canonicalUrl || p.canonical_url || '',
        status: p.status || 'active',
        is_monitored: true,
        source_freshness: 'verified_today',
        sources_count: p.sources?.supportingUrls?.length || 1,
        latest_intelligence: 'Product target configured. Ready for intelligence scan.'
      }));

    const localProducts = workspaceService.getLocalProducts(scopeKey);
    const productMap = new Map();
    dbProducts.forEach(p => productMap.set(p.id, p));
    // The Desk used to save every product twice: a local `prod_<timestamp>` copy plus the
    // server target. A local copy whose name matches a server product is that duplicate.
    const dbNames = new Set(dbProducts.map(p => String(p.name || '').trim().toLowerCase()));
    localProducts.forEach(p => {
      if (dbNames.has(String(p.name || '').trim().toLowerCase())) return;
      if (!productMap.has(p.id)) productMap.set(p.id, p);
    });
    const products = Array.from(productMap.values());

    // 3. Resolve Decisions
    const dbDecisions = (dbAgenda || []).map(a => ({
      id: a.id,
      question: a.question,
      status: a.status || 'active',
      latest_judgment: a.answer || a.judgment || 'Active inquiry registered on agenda.',
      confidence: 'Evaluated against evidence',
      sources: { url: null, documents: [] }
    }));
    const localDecisions = workspaceService.getLocalDecisions(scopeKey);
    const decisionMap = new Map();
    dbDecisions.forEach(d => decisionMap.set(d.id, d));
    localDecisions.forEach(d => {
      if (!decisionMap.has(d.id)) decisionMap.set(d.id, d);
    });
    const decisions = Array.from(decisionMap.values());

    // 4. Resolve Monitoring Setups
    const monitoringSetups = workspaceService.getLocalMonitoring(scopeKey, company?.name);

    // 5. Resolve Today's Read
    let todayRead = null;
    if (latestReport) {
      const signals = latestReport.signals || [];
      const primarySignal = signals[0] || null;
      todayRead = {
        headline: latestReport.brief?.executiveSummary || primarySignal?.headline || primarySignal?.claim || `Latest intelligence for ${company?.name || 'your company'}`,
        what_moved: primarySignal?.the_move || primarySignal?.sentence || latestReport.brief?.summary || 'Recent competitive and regulatory shifts identified.',
        what_it_means: primarySignal?.implication || primarySignal?.why_it_matters || latestReport.brief?.implications?.[0] || 'Market movement signals evaluated against your strategic perimeter.',
        confidence: 'High Confidence',
        evidence_count: signals.length || 1,
        checked_timestamp: latestReport.timestamp ? `Analyzed on ${new Date(latestReport.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Checked recently',
        related_scope: `${company?.name || 'Company'} Strategic Perimeter`,
        source_citations: signals.slice(0, 3).map(s => ({
          title: s.source?.domain || s.source?.name || s.headline?.slice(0, 32) || 'Verified source',
          url: s.source?.url || s.url || '#'
        }))
      };
    }

    // 6. Resolve Composite Runs from real report history
    const compositeRuns = (history || []).map(h => ({
      id: h.id,
      date: h.timestamp || h.created_at ? new Date(h.timestamp || h.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent scan',
      scope_label: h.context?.company_name || h.inputs?.companyName || h.target_domain || company?.name || 'Company Scan',
      status: 'Complete',
      status_key: 'completed',
      run_tier: 'full',
      main_judgment: h.brief?.executiveSummary || h.signals?.[0]?.headline || 'Strategic intelligence completed.',
      overview_synthesis: {
        important_movement: (h.signals || []).slice(0, 3).map(s => s.the_move || s.headline || s.claim).filter(Boolean),
        strategic_implications: h.brief?.implications || (h.signals || []).slice(0, 2).map(s => s.implication || s.why_it_matters).filter(Boolean),
        tensions: h.brief?.tensions || [],
        decisions_affected: [],
        unknowns: h.brief?.blindSpots || h.brief?.unknowns || []
      },
      company_view: {
        name: h.context?.company_name || company?.name || 'Company',
        headline: h.brief?.positioning || 'Positioning and defensive moat',
        signals: (h.signals || []).map(s => ({
          headline: s.headline || s.claim,
          category: s.category || 'Strategic',
          the_move: s.the_move || s.sentence,
          implication: s.implication || s.why_it_matters,
          source: s.source?.url || s.url || '',
          confidence: s.confidence || 'Verified'
        }))
      },
      product_views: {},
      decision_views: {},
      rawReport: h
    }));

    return {
      company,
      products,
      decisions,
      monitoringSetups,
      todayRead,
      todayReadQuiet: null,
      compositeRuns,
      isQuietDay: false
    };
  }
};

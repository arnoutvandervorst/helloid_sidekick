/* Who may see what, asked in one place.

   The app has no accounts and cannot authenticate; a dashboard is a preset for one
   audience. What that audience must not see used to be decided spot by spot — a tile
   here, a column there — and the drawers and shared widgets were never told. So every
   sensitive thing belongs to a facet, a role says which facets an audience has, and the
   shared building blocks (tiles, tables, tabs, drawers, the money and score formatters)
   ask here before they draw. Two nets catch what nobody marked: the formatters blank
   out, and a sweep removes anything carrying data-facet for a hidden facet.

     money       prices, spend, waste, €/head, cost tabs
     risk        risk scores, bands, bars, outliers, why-score, toxic pairs
     governance  findings, controls, SoD, attestation, exclusions, evidence
     audit       who did what, engine health, admin access (the HelloID audit log)
     admin       imports, settings, data points, workspaces, collectors, rollback */
(function (HR) {
  'use strict';

  const FACETS = ['money', 'risk', 'governance', 'audit', 'admin'];
  const ROLES = {
    full: { facets: FACETS.slice() },
    hr: { facets: [] },
    manager: { facets: ['governance'] },
    auditor: { facets: ['risk', 'governance', 'audit'] }
  };

  let current = 'full';

  /** Set the role; unknown names fall back to hr — the safe side. */
  function set(role) { current = ROLES[role] ? role : 'hr'; }
  const role = () => current;
  /** A facet-less thing is always visible; an unknown facet name is treated as sensitive. */
  const can = facet => !facet || (ROLES[current].facets.includes(facet));
  const hidden = () => FACETS.filter(f => !can(f));

  /** Remove every element marked with a facet the role does not have. */
  function sweep(root) {
    const off = hidden();
    if (!off.length || !root || !root.querySelectorAll) return 0;
    let n = 0;
    root.querySelectorAll('[data-facet]').forEach(node => {
      const facets = String(node.dataset.facet || '').split(/[\s,]+/).filter(Boolean);
      if (facets.some(f => off.includes(f))) { node.remove(); n++; }
    });
    return n;
  }

  HR.access = { FACETS, ROLES, set, role, can, hidden, sweep };
})(window.HR);

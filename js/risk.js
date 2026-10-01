/* Risk scoring. Every account gets an explainable 0-100 score built from named
   components, so the drawer can show exactly why an account ranks where it does. */
(function (HR) {
  'use strict';

  const U = HR.util, T = (k, p) => HR.i18n.t(k, p);

  function score(model) {
    const cfg = HR.config.get();
    const R = cfg.risk;

    for (const a of model.accountList) scoreAccount(a, cfg, R, model);
    for (const p of model.permissionList) scorePermission(p, model, cfg);

    /* The organisation's exposure follows its worst accounts, not its average one: an
       average over five thousand clean users made twenty unowned domain admins read
       as "low". Three terms —
         tail      mean score of the riskiest 0.5 % of enabled accounts (at least ten)
         exposure  how many enabled accounts sit at high or critical, as an absolute
                   number on a saturating curve (10 → 63, 20 → 86, 40 → 98)
         coverage  the share of accounts nobody owns */
    const accs = model.accountList;
    const live = accs.filter(a => a.enabled !== false);
    const bands = U.counts(accs, a => a.riskBand);
    const tailN = Math.max(10, Math.ceil(live.length * 0.005));
    const tailSet = live.map(a => a.riskScore).sort((x, y) => y - x).slice(0, tailN);
    const tail = tailSet.length ? U.sum(tailSet, x => x) / tailN : 0;
    const highLive = live.filter(a => a.riskBand === 'critical' || a.riskBand === 'high').length;
    const exposure = 100 * (1 - Math.exp(-highLive / 10));
    const coverage = accs.length ? accs.filter(a => !a.orphan).length / accs.length : 1;
    const W = { tail: 0.45, exposure: 0.35, coverage: 0.20 };

    const overall = U.clamp(Math.round(
      W.tail * tail + W.exposure * exposure + W.coverage * (100 * (1 - coverage))
    ) || 0, 0, 100);

    model.risk = {
      overall,
      formula: [
        { key: 'tail', label: T('rk.formulaTail', { n: tailN }), weight: W.tail, value: tail },
        { key: 'exposure', label: T('rk.formulaExposure', { n: highLive }), weight: W.exposure, value: exposure },
        { key: 'coverage', label: T('rk.formulaCoverage'), weight: W.coverage, value: 100 * (1 - coverage) }
      ],
      highLive, tailN,
      bands: Object.fromEntries(bands),
      byClass: rollup(accs, a => a.clsLabel),
      byEmployeeCategory: rollup(accs, a => a.ecatLabel || '—'),
      bySystem: rollup(accs, a => a.system),
      topAccounts: accs.slice().sort((x, y) => y.riskRaw - x.riskRaw).slice(0, 25),
      topPermissions: model.permissionList.slice().sort((x, y) => y.riskScore - x.riskScore).slice(0, 25)
    };
    return model.risk;
  }

  function rollup(accs, keyFn) {
    const m = U.by(accs, keyFn);
    return Array.from(m.entries()).map(([k, list]) => ({
      key: k,
      accounts: list.length,
      meanRisk: U.sum(list, a => a.riskScore) / list.length,
      maxRisk: list.reduce((mx, a) => Math.max(mx, a.riskScore), 0),
      critical: list.filter(a => a.riskBand === 'critical').length,
      high: list.filter(a => a.riskBand === 'high').length,
      monthlyCost: U.sum(list, a => a.monthlyCost)
    })).sort((a, b) => b.meanRisk - a.meanRisk);
  }

  function scoreAccount(a, cfg, R, model) {
    const parts = [];
    const add = (label, value, detail, noMult) => { if (value > 0.01) parts.push({ label, value, detail, noMult }); };

    /* --- identity-level exposure (scaled by account class) --- */
    let identity = 0;
    /* An owner confirmed by hand outranks the export's "account unmanaged" row. */
    const confirmed = a.matchSource === 'manual';
    if (a.flagged.accountUnmanaged && !confirmed) identity += R.issueWeights['Account unmanaged'] || 0;
    if (a.orphan && a.enabled !== false) identity += R.orphanEnabledBonus;
    const hasPriv = a.privileged.length > 0;
    if (a.orphan && hasPriv) identity += R.privilegedOrphanBonus;
    if (identity > 0) {
      const scaled = identity * a.clsWeight;
      add(T('rc.identity'), scaled,
        [a.flagged.accountUnmanaged && !confirmed ? T('rc.identityUnmanaged') : null,
         a.orphan && a.enabled !== false ? T('rc.identityEnabled') : null,
         a.orphan && hasPriv ? T('rc.identityPriv') : null,
         a.clsWeight !== 1 ? a.clsLabel + ' ×' + a.clsWeight : null].filter(Boolean).join(', '), true);
    }

    /* --- dormant-but-entitled --- */
    if (a.enabled === false && a.permCount > 0) {
      add(T('rc.disabledEntitled'), R.disabledWithEntitlementsBonus,
        T('rc.disabledEntitledD', { n: a.permCount }));
      if (a.licences.length) add(T('rc.disabledLicensed'), R.disabledWithLicenceBonus,
        a.licences.map(l => l.name).join(', '));
    }

    /* --- privileged access: holding it is exposure, owned and managed or not --- */
    if (hasPriv) {
      const extra = Math.max(0, a.privileged.length - 1);
      let v = Math.min((R.privilegedBonus ?? 12) + (R.privilegedPerExtra ?? 3) * extra, R.privilegedCap ?? 20);
      const unmanagedPriv = a.privileged.some(p => a.unmanagedPermKeys && a.unmanagedPermKeys.has(p.key));
      if (unmanagedPriv) v *= (R.privilegedUnmanagedMult ?? 1.5);
      add(T('rc.privileged'), v, T(unmanagedPriv ? 'rc.privilegedUnmanagedD' : 'rc.privilegedD',
        { n: a.privileged.length, list: a.privileged.slice(0, 4).map(p => p.name).join(', ') }));
    }

    /* --- entitlements held outside the model, with diminishing returns: distinct
       entitlements (not rows), weighed by the account's average sensitivity. An admin
       group among fifty ordinary ones is not lost in that average any more: the
       privileged component above carries it, ×1.5 when it is the unmanaged one. --- */
    const un = a.unmanagedPermCount;
    if (un > 0) {
      const w = R.issueWeights['Permission unmanaged'] || 0;
      const base = w * Math.min(un, 5) + w * Math.sqrt(Math.max(0, un - 5));
      const sens = a.perms.length ? U.sum(a.perms, p => p.sensitivity) / a.perms.length : 1;
      const sensMult = U.clamp(sens, 0.6, 2.5);
      add(T('rc.drift'), Math.min(base * sensMult, R.unmanagedPermCap ?? 22),
        T('rc.driftD2', { n: un, s: sens.toFixed(1) }));
    }
    /* Missing access is not exposure — it is a service problem, kept as a finding. */

    /* --- rarity: entitlements almost nobody else holds --- */
    if (a.permCount) {
      const rare = a.perms.filter(p => p.rare);
      if (rare.length) {
        const shareRare = rare.length / a.permCount;
        add(T('rc.rare'), R.rarityBonus * Math.min(1, shareRare * 2),
          T('rc.rareD', { n: rare.length, t: cfg.rarityThreshold, list: rare.slice(0, 5).map(p => p.name).join(', ') }));
      }
    }

    /* --- peer-group outlier --- */
    if (a.permCount >= 3 && a.peerBest != null && a.outlier > 0.4) {
      add(T('rc.outlier'), R.outlierBonus * ((a.outlier - 0.4) / 0.6),
        T('rc.outlierD', { p: Math.round((a.peerBest || 0) * 100) }));
    }

    /* --- toxic combination: two things one account should never hold together --- */
    if (HR.sod && model && model._sod && (R.toxicBonus || 0) > 0) {
      const w = HR.sod.weightOf(model, a);
      if (w > 0) add(T('rc.toxic'), R.toxicBonus * w, T('rc.toxicD', { n: model._sod.perAccount.get(a.key).length }));
    }

    /* --- duplicate licence SKUs on one account --- */
    if (a.licences.length > 1) {
      add(T('rc.stacked'), R.stackedLicenceBonus,
        a.licences.map(l => l.name).join(' + '));
    }

    /* Who the account works for scales what it holds: the employee-category
       multiplier applies to the entitlement components, not to the identity
       component — ownership risk is the same whoever the owner would be. */
    const mult = a.ecatMult || 1;
    if (mult !== 1) for (const p of parts) if (!p.noMult) p.value *= mult;

    const raw = U.sum(parts, p => p.value);
    a.riskParts = parts.sort((x, y) => y.value - x.value);
    a.riskRaw = raw;
    a.riskScore = Math.round(U.clamp(raw, 0, R.accountCap ?? 100));
    a.riskBand = HR.config.severityOf(a.riskScore);
    return a.riskScore;
  }

  function scorePermission(p, model, cfg) {
    const orphanShare = p.holderCount ? p.holdersOrphan / p.holderCount : 0;
    const disabledShare = p.holderCount ? p.holdersDisabled / p.holderCount : 0;
    const unmanaged = p.issues[model.ISSUE_PERM_UNMANAGED] || 0;
    const reach = Math.log2(1 + p.holderCount) / Math.log2(1 + Math.max(2, model.accountList.length));

    const parts = [
      { label: T('dr.pSensitivity'), value: (p.sensitivity / 3) * 45 },
      { label: T('dr.pUnmanaged'), value: p.holderCount ? 25 * (unmanaged / p.holderCount) : 0 },
      { label: T('dr.pUnowned'), value: 20 * orphanShare },
      { label: T('dr.pDisabled'), value: 10 * disabledShare },
      { label: T('dr.pReach'), value: 15 * reach },
      { label: T('dr.pRare'), value: p.rare && p.sensitivity >= 1.5 ? 8 : 0 }
    ].filter(x => x.value > 0.01);

    p.riskParts = parts.sort((a, b) => b.value - a.value);
    p.riskScore = Math.round(U.clamp(U.sum(parts, x => x.value), 0, 100));
    p.riskBand = HR.config.severityOf(p.riskScore);
    p.orphanShare = orphanShare;
    p.disabledShare = disabledShare;
    return p.riskScore;
  }

  HR.risk = { score, scoreAccount, scorePermission };
})(window.HR);

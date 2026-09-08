/* Compares two builds of the model — "what changed since the last reconciliation run".
   Both sides are full models, so the diff can speak in accounts and entitlements
   rather than in row counts. */
(function (HR) {
  'use strict';

  const U = HR.util, T = (k, p) => HR.i18n.t(k, p);

  function compare(current, baseline) {
    const acc = diffAccounts(current, baseline);
    const perm = diffPermissions(current, baseline);
    const findings = diffFindings(current, baseline);
    const persons = (current.vault && baseline.vault) ? diffPersons(current.vault, baseline.vault) : null;
    const summary = diffSummary(current.summary, baseline.summary);
    const cost = {
      totalMonthly: delta(current.cost.totalMonthly, baseline.cost.totalMonthly),
      wasteMonthly: delta(current.cost.wasteMonthly, baseline.cost.wasteMonthly),
      unmanagedSpend: delta(current.cost.unmanagedSpend, baseline.cost.unmanagedSpend),
      remediationCost: delta(current.cost.remediationCost, baseline.cost.remediationCost)
    };
    return {
      summary, accounts: acc, permissions: perm, findings, persons, cost,
      risk: delta(current.risk.overall, baseline.risk.overall),
      headline: headline(acc, perm, summary, persons)
    };
  }

  /* Two vaults, one question: who joined, who left, who moved. Keyed by the HR
     external id (the person id when HR has none). "Left" is absence from the later
     vault; a contract that ended shows as a lifecycle change, not as a leaver. */
  function diffPersons(cur, base) {
    const key = p => p.externalId || p.personId;
    const byKey = list => new Map(list.map(p => [key(p), p]));
    const baseMap = byKey(base.persons), curMap = byKey(cur.persons);
    const joined = [], left = [], changed = [];
    const pc = p => p.primaryContract || p.contracts[0] || null;
    const name = r => (r && r.name) || '';
    const life = p => HR.vault.lifecycle(p).state;
    const fields = (a, b) => {
      const ca = pc(a), cb = pc(b), out = [];
      const push = (field, from, to) => { if ((from || '') !== (to || '')) out.push({ field, from: from || '—', to: to || '—' }); };
      push('lifecycle', life(b), life(a));
      push('department', cb && name(cb.department), ca && name(ca.department));
      push('title', cb && name(cb.title), ca && name(ca.title));
      push('employer', cb && name(cb.employer), ca && name(ca.employer));
      push('manager', cb && cb.manager.displayName, ca && ca.manager.displayName);
      push('contractEnd', cb && cb.endDate ? U.fmtDate(cb.endDate).split(',')[0] : '', ca && ca.endDate ? U.fmtDate(ca.endDate).split(',')[0] : '');
      push('contracts', String(b.contracts.length), String(a.contracts.length));
      push('accounts', String(b.accounts.length), String(a.accounts.length));
      if (a.blocked !== b.blocked) out.push({ field: 'blocked', from: String(b.blocked), to: String(a.blocked) });
      return out;
    };
    for (const p of cur.persons) {
      const b = baseMap.get(key(p));
      if (!b) { joined.push({ person: p, lifecycle: life(p) }); continue; }
      const changes = fields(p, b);
      if (changes.length) changed.push({ person: p, previous: b, changes, lifecycle: life(p) });
    }
    for (const b of base.persons) if (!curMap.has(key(b))) left.push({ person: b, lifecycle: life(b) });
    const byName = (x, y) => x.person.displayName.localeCompare(y.person.displayName);
    joined.sort(byName); left.sort(byName);
    changed.sort((x, y) => y.changes.length - x.changes.length || byName(x, y));
    return { joined, left, changed,
      lifecycleMoves: changed.filter(c => c.changes.some(x => x.field === 'lifecycle')).length };
  }

  const delta = (a, b) => ({ now: a, was: b, change: (a || 0) - (b || 0),
    pct: b ? ((a - b) / Math.abs(b)) : (a ? 1 : 0) });

  function diffSummary(a, b) {
    const keys = ['rows', 'accounts', 'enabledAccounts', 'disabledAccounts', 'persons', 'permissions',
      'orphanAccounts', 'orphanEnabled', 'unmanagedPermissionRows', 'unmanagedAccountRows',
      'missingPermissionRows', 'riskScore', 'governanceScore', 'monthlyCost', 'wasteMonthly', 'policyScore', 'policyCritical', 'leaverBreaches'];
    const out = {};
    keys.forEach(k => out[k] = delta(a[k], b[k]));
    return out;
  }

  function diffAccounts(cur, base) {
    const added = [], removed = [], changed = [];
    for (const a of cur.accountList) {
      const b = base.accounts.get(a.key);
      if (!b) { added.push({ account: a, reason: T('df.reasonNew') }); continue; }
      const permsAdded = a.perms.filter(p => !b.permKeys.has(p.key));
      const permsRemoved = b.perms.filter(p => !a.permKeys.has(p.key));
      const changes = [];
      if (a.enabled !== b.enabled) changes.push({ field: T('df.fieldEnabled'), from: b.enabled, to: a.enabled });
      if ((a.personRaw || '') !== (b.personRaw || '')) changes.push({ field: T('df.fieldPerson'), from: b.personRaw || '—', to: a.personRaw || '—' });
      if (permsAdded.length) changes.push({ field: T('df.fieldGranted'), from: '', to: permsAdded.map(p => p.name).join(', ') });
      if (permsRemoved.length) changes.push({ field: T('df.fieldRevoked'), from: permsRemoved.map(p => p.name).join(', '), to: '' });
      if (a.riskScore !== b.riskScore) changes.push({ field: T('df.fieldRisk'), from: b.riskScore, to: a.riskScore });
      if (changes.length) changed.push({
        account: a, previous: b, changes,
        permsAdded, permsRemoved,
        riskDelta: a.riskScore - b.riskScore,
        costDelta: a.monthlyCost - b.monthlyCost
      });
    }
    for (const b of base.accountList) if (!cur.accounts.has(b.key)) removed.push({ account: b, reason: T('df.reasonGone') });

    changed.sort((x, y) => Math.abs(y.riskDelta) - Math.abs(x.riskDelta) ||
      (y.permsAdded.length + y.permsRemoved.length) - (x.permsAdded.length + x.permsRemoved.length));
    added.sort((x, y) => y.account.riskScore - x.account.riskScore);
    removed.sort((x, y) => y.account.riskScore - x.account.riskScore);
    return { added, removed, changed };
  }

  function diffPermissions(cur, base) {
    const added = [], removed = [], moved = [];
    for (const p of cur.permissionList) {
      const q = base.permissions.get(p.key);
      if (!q) { added.push(p); continue; }
      if (p.holderCount !== q.holderCount) moved.push({ perm: p, was: q.holderCount, now: p.holderCount, change: p.holderCount - q.holderCount });
    }
    for (const q of base.permissionList) if (!cur.permissions.has(q.key)) removed.push(q);
    moved.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    return { added, removed, moved };
  }

  function diffFindings(cur, base) {
    const baseById = new Map(base.findings.map(f => [f.id, f]));
    const rows = cur.findings.map(f => {
      const b = baseById.get(f.id);
      return {
        id: f.id, title: f.title, severity: f.severity,
        now: f.count, was: b ? b.count : 0, change: f.count - (b ? b.count : 0),
        impactNow: f.impactMonthly || 0, impactWas: b ? (b.impactMonthly || 0) : 0,
        isNew: !b
      };
    });
    for (const b of base.findings) if (!cur.findings.some(f => f.id === b.id)) {
      rows.push({ id: b.id, title: b.title, severity: b.severity, now: 0, was: b.count,
        change: -b.count, impactNow: 0, impactWas: b.impactMonthly || 0, resolved: true });
    }
    return rows.sort((a, b) => U.severityRank(a.severity) - U.severityRank(b.severity) || Math.abs(b.change) - Math.abs(a.change));
  }

  function headline(acc, perm, summary, persons) {
    const bits = [];
    if (persons) {
      if (persons.joined.length) bits.push(T('df.hlJoined', { n: persons.joined.length }));
      if (persons.left.length) bits.push(T('df.hlLeft', { n: persons.left.length }));
      if (persons.changed.length) bits.push(T('df.hlMoved', { n: persons.changed.length }));
    }
    if (acc.added.length) bits.push(T('df.hlNewAccounts', { n: acc.added.length }));
    if (acc.removed.length) bits.push(T('df.hlGone', { n: acc.removed.length }));
    if (acc.changed.length) bits.push(T('df.hlChanged', { n: acc.changed.length }));
    const grants = U.sum(acc.changed, c => c.permsAdded.length);
    const revokes = U.sum(acc.changed, c => c.permsRemoved.length);
    if (grants) bits.push(T('df.hlGrants', { n: grants }));
    if (revokes) bits.push(T('df.hlRevokes', { n: revokes }));
    if (perm.added.length) bits.push(T('df.hlNewGroups', { n: perm.added.length }));
    return bits.length ? bits.join(' · ') : T('df.hlNothing');
  }

  HR.diff = { compare, diffPersons };
})(window.HR);

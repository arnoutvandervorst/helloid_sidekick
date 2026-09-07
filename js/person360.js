/* Person 360: everything Sidekick knows about one person, assembled once.

   The model already computes each piece — contracts and lifecycle from the vault, the
   accounts the correlation attaches, what the rules say the person should hold, what the
   history and the audit log record, the products they requested, their outlier score,
   their peers, the findings that name them, the pairs they break, what they cost and what
   depends on them. This gathers those into one object per person, so one page (and one
   JSON export) can show it the way an administrator asks for it: "show me everything
   about Milan". Cached on the model per person. */
(function (HR) {
  'use strict';

  const U = HR.util;
  const T = (k, p) => HR.i18n.t(k, p);
  const DAY = 86400000;
  const day = d => d ? U.fmtDate(d).split(',')[0] : '—';

  /** A person by vault id, employee id or "Name (id)" — whatever the link carried. */
  function find(m, id) {
    if (!m || !m.vault || !id) return null;
    const s = String(id).toLowerCase();
    return m.vault.persons.find(p => p.personId === id || String(p.externalId).toLowerCase() === s
      || String(p.displayName).toLowerCase() === s) || null;
  }

  function build(m, person) {
    m._p360 = m._p360 || new Map();
    if (m._p360.has(person.personId)) return m._p360.get(person.personId);

    const index = HR.correlate.personAccountIndex(m, m.vault, m.correlation);
    const entry = index.get(person.personId) || { person, accounts: [] };
    const accounts = entry.accounts;
    const now = new Date();
    const life = HR.vault.lifecycle(person, now);
    const contracts = person.contracts.slice().sort((a, b) => (a.startDate || 0) - (b.startDate || 0));
    const running = contracts.filter(c => (!c.startDate || c.startDate <= now) && (!c.endDate || c.endDate >= now));
    const primary = person.primaryContract || running[0] || contracts[contracts.length - 1] || null;
    const byId = new Map(m.vault.persons.map(p => [p.personId, p]));
    const byExt = new Map(m.vault.persons.map(p => [String(p.externalId), p]));
    const byName = new Map(m.vault.persons.map(p => [String(p.displayName).toLowerCase(), p]));
    const personOf = ref => ref ? (byId.get(ref.personId) || byExt.get(String(ref.externalId)) || byName.get(String(ref.displayName || '').toLowerCase()) || null) : null;

    /* --- org path and manager chain --- */
    let path = [];
    try {
      const tree = HR.org.tree(m.vault);
      const dept = primary && (primary.department.externalId || primary.department.name);
      const node = dept ? tree.byId(dept) : null;
      if (node) path = tree.pathOf(node).map(n => ({ id: n.id, label: n.name }));
    } catch (e) { path = []; }
    const managers = [];
    let cur = primary ? personOf(primary.manager) : null;
    const seen = new Set([person.personId]);
    while (cur && !seen.has(cur.personId) && managers.length < 4) {
      seen.add(cur.personId);
      managers.push(cur);
      const pc = cur.primaryContract || cur.contracts[0];
      cur = pc ? personOf(pc.manager) : null;
    }

    /* --- access: what is held, what should be, and where each came from --- */
    const prov = m.provisioning ? m.provisioning.rows.find(r => r.person.personId === person.personId) : null;
    const heldMap = new Map();
    accounts.forEach(a => a.perms.forEach(p => { if (!heldMap.has(p.key)) heldMap.set(p.key, { perm: p, accounts: [] }); heldMap.get(p.key).accounts.push(a); }));
    let baseline = new Set();
    try { const py = HR.pyramid.build(m); if (py && py.baseline) py.baseline.grants.forEach(g => baseline.add(g.ent)); } catch (e) { /* optional */ }
    const expected = new Map((prov ? prov.expected : []).map(x => [x.perm.key, x]));
    const held = Array.from(heldMap.values()).map(h => {
      const exp = expected.get(h.perm.key);
      let product = null;
      if (m.productMapping) for (const a of h.accounts) { const hit = a.personRaw && m.productMapping.lookup(a.personRaw, h.perm.key); if (hit) { product = hit; break; } }
      const provenance = exp ? 'rule' : product ? 'product' : baseline.has(h.perm.key) ? 'baseline' : 'nobody';
      return Object.assign(h, { provenance, rules: exp ? exp.rules : [], product });
    });
    const access = {
      held, missing: prov ? prov.missing : [], extra: prov ? prov.extra : [],
      counts: { rule: held.filter(h => h.provenance === 'rule').length, product: held.filter(h => h.provenance === 'product').length,
        baseline: held.filter(h => h.provenance === 'baseline').length, nobody: held.filter(h => h.provenance === 'nobody').length },
      matchedRules: prov ? prov.matchedRules : []
    };

    /* --- products --- */
    const logins = accounts.map(a => String(a.userName).toLowerCase());
    const products = [];
    if (m.assignments) {
      m.assignments.rows.forEach(a => {
        const local = String(a.userName).toLowerCase().split('@')[0];
        if (!logins.includes(String(a.userName).toLowerCase()) && !logins.includes(local)) return;
        const link = m.productHolders && m.productHolders.byUser.get(String(a.userName).toLowerCase());
        if (link && link.person && link.person.personId && link.person.personId !== person.personId) return;
        products.push(a);
      });
      /* Also the holders the linker resolved to this person by name rather than login. */
      if (m.productHolders) m.productHolders.byUser.forEach((link, key) => {
        if (link.person && link.person.personId === person.personId) {
          (m.assignments.byUser.get(key) || []).forEach(a => { if (!products.includes(a)) products.push(a); });
        }
      });
    }

    /* --- history and audit rows for this person --- */
    const dn = String(person.displayName).toLowerCase();
    const historyRows = m.history ? m.history.rows.filter(r => String(r.personRaw).toLowerCase() === dn) : [];
    const auditRows = m.audit ? m.audit.provisioning.filter(r => String(r.personDisplayName || '').toLowerCase() === dn && !/SendNotification/i.test(r.action || '')) : [];
    const exclusions = m.audit ? accounts.flatMap(a => HR.audit.evidenceFor(m.audit, a).map(x => Object.assign({ account: a }, x))) : [];

    /* --- attestation decisions on this person's entitlements --- */
    const decisions = HR.attest ? HR.attest.decisions() : {};
    const attest = held.map(h => {
      const a = h.accounts[0];
      const d = decisions[HR.attest.decisionKey(a, h.perm)];
      return { perm: h.perm, account: a, decision: d || null };
    });

    /* --- governance --- */
    const accountKeys = new Set(accounts.map(a => a.key));
    const findings = m.findings.filter(f => f.entities.some(e => (e.type === 'person' && e.key === person.personId)
      || (e.type === 'account' && accountKeys.has(e.key))));
    const sod = HR.sod ? accounts.flatMap(a => HR.sod.evaluate(m).perAccount.get(a.key) || []) : [];
    let outlier = null;
    try { outlier = m.hasRecon && HR.outlier ? HR.outlier.build(m).byPerson.get(person.personId) || null : null; } catch (e) { outlier = null; }

    /* --- lifecycle events --- */
    let moves = [], residue = [], latency = null;
    try {
      moves = HR.workforce.moves(m.vault).filter(x => x.person === person);
      const res = moves.length ? HR.workforce.moverResidue(m, m.vault, { maxDays: null }) : null;
      residue = res ? res.rows.filter(r => r.move.person === person).flatMap(r => r.residue) : [];
      const lat = HR.workforce.onboardingLatency(m.vault, m.history);
      latency = lat ? lat.rows.find(r => r.person === person) || null : null;
    } catch (e) { /* optional */ }

    /* --- cost --- */
    const monthly = U.sum(accounts, a => a.monthlyCost || 0);
    const priced = held.filter(h => h.perm.monthlyPrice > 0).map(h => ({ perm: h.perm, monthly: h.perm.monthlyPrice }));
    let leaverBurn = null, duplicateCost = null;
    try {
      const h = m.cost && m.cost.hidden;
      if (h) {
        leaverBurn = (h.leavers.rows || []).find(r => r.person === person) || null;
        duplicateCost = (h.duplicates.rows || []).find(r => r.person === person) || null;
      }
    } catch (e) { /* optional */ }

    /* --- impact: who depends on this person --- */
    const reports = m.vault.persons.filter(p => p !== person && p.contracts.some(c => {
      const mp = c.manager || {};
      return (mp.personId && mp.personId === person.personId) || (mp.externalId && String(mp.externalId) === String(person.externalId));
    }));
    const approved = m.assignments ? m.assignments.rows.filter(a => a.approvedBy && String(a.approvedBy).toLowerCase() === dn.replace(/\s*\(\d+\)$/, '')
      || a.approvedBy && String(a.approvedBy).toLowerCase() === String(person.displayName).toLowerCase().replace(/\s*\(\d+\)$/, '')) : [];
    let busFactor = [];
    try { busFactor = HR.scorecard.busFactor(m).rows.filter(r => r.person === person); } catch (e) { busFactor = []; }
    const soleHolder = held.filter(h => h.perm.holderCount === 1).map(h => h.perm);

    /* --- directory user --- */
    let directoryUser = null;
    if (m.directory) {
      const users = new Map(m.directory.users.map(u => [String(u.userName).toLowerCase(), u]));
      for (const a of accounts) { const u = users.get(String(a.userName).toLowerCase()) || users.get(HR.fit.localOf(a.userName)); if (u) { directoryUser = u; break; } }
    }

    /* --- the timeline: one stream, newest first --- */
    const tl = [];
    const push = (at, kind, title, detail, ref) => { if (at) tl.push({ at: at instanceof Date ? at : new Date(at), kind, title, detail: detail || '', ref: ref || null }); };
    contracts.forEach(c => {
      const where = (c.department.name || c.department.externalId || '') + (c.title.name ? ' · ' + c.title.name : '');
      push(c.startDate, 'employment', T('p3.tlStart', { type: c.type.name || c.type.code || '' }), where, c);
      if (c.endDate) push(c.endDate, 'employment', c.endDate > now ? T('p3.tlEnds') : T('p3.tlEnded'), where, c);
    });
    moves.forEach(mv => push(mv.date, 'employment', T('p3.tlMove'), (mv.deptChanged ? mv.from.dept + ' → ' + mv.to.dept : '') + (mv.titleChanged ? ' ' + mv.from.title + ' → ' + mv.to.title : ''), mv));
    historyRows.forEach(r => push(r.createdOn, 'access', T('p3.tlHist', { op: r.operation, ent: r.entitlement }),
      r.result + (r.origins.length ? ' · ' + r.origins.join(', ') : '') + ' · ' + r.system, r));
    auditRows.forEach(r => { if (!/Permission$/.test(r.action) || !m.history) push(r.at, /Account$|Access$/.test(r.action) ? 'account' : 'access', r.action.replace(/([a-z])([A-Z])/g, '$1 $2'), (r.state === 'Error' ? T('p3.tlFailed') + ' · ' : '') + (r.message || '') + ' · ' + r.systemName, r); });
    exclusions.forEach(x => push(x.at, 'decision', T('p3.tlExcluded', { what: x.accountLevel ? x.accountUserName : x.permission }),
      T('dr.excludedLine', { who: x.userName || '—', date: day(x.at), until: x.until ? day(x.until) : '—', why: String(x.comment || '').trim() || T('au.noReason') }), x));
    products.forEach(a => {
      push(a.requestedAt, 'product', T('p3.tlRequested', { product: a.productName }), a.userName, a);
      if (a.approvedAt) push(a.approvedAt, 'product', T('p3.tlApproved', { product: a.productName }), (a.approvedBy || '—') + (a.approvalComment ? ' · ' + a.approvalComment : ''), a);
      if (a.returnDate) push(a.returnDate, 'product', T('p3.tlReturned', { product: a.productName }), '', a);
    });
    attest.forEach(x => { if (x.decision && x.decision.at) push(x.decision.at, 'decision', T('p3.tlDecided', { decision: x.decision.decision, ent: x.perm.name }), (x.decision.by || '—') + (x.decision.comment ? ' · ' + x.decision.comment : ''), x); });
    if (directoryUser && directoryUser.lastLogon) push(directoryUser.lastLogon, 'account', T('p3.tlLastLogon'), directoryUser.userName, directoryUser);
    tl.sort((a, b) => b.at - a.at);

    const out = {
      person, life, contracts, running, primary, path, managers, accounts, access, products,
      historyRows, auditRows, exclusions, attest, findings, sod, outlier, moves, residue, latency,
      cost: { monthly, priced, leaverBurn, duplicateCost },
      impact: { reports, approved, busFactor, soleHolder },
      directoryUser, timeline: tl,
      summary: {
        accounts: accounts.length, enabled: accounts.filter(a => a.enabled !== false).length,
        entitlements: held.length, monthly,
        maxRisk: accounts.length ? Math.max.apply(null, accounts.map(a => a.riskScore || 0)) : 0,
        outlier: outlier ? outlier.score : null, findings: findings.length, sod: sod.length
      }
    };
    m._p360.set(person.personId, out);
    return out;
  }

  /** The page as one object — no DOM references, no cycles. */
  function toJson(d) {
    const perm = p => ({ system: p.system, name: p.name, category: p.category, sensitivity: p.sensitivity, monthlyPrice: p.monthlyPrice || 0 });
    return {
      kind: 'helloid-sidekick-person', generatedAt: new Date().toISOString(),
      person: { id: d.person.externalId, personId: d.person.personId, name: d.person.displayName, userName: d.person.userName, state: d.life.state, blocked: d.person.blocked, excluded: d.person.excluded },
      orgPath: d.path.map(p => p.label), managers: d.managers.map(p => p.displayName),
      contracts: d.contracts.map(c => ({ id: c.externalId, start: c.startDate, end: c.endDate, type: c.type.name || c.type.code, department: c.department.name || c.department.externalId, title: c.title.name || c.title.code, location: c.location && c.location.name, manager: c.manager && c.manager.displayName })),
      accounts: d.accounts.map(a => ({ system: a.system, userName: a.userName, enabled: a.enabled !== false, class: a.clsLabel, risk: a.riskScore, monthly: a.monthlyCost || 0, entitlements: a.perms.length })),
      access: { held: d.access.held.map(h => Object.assign(perm(h.perm), { provenance: h.provenance, rules: h.rules.map(r => r.name), product: h.product ? h.product.product : null })),
        missing: d.access.missing.map(x => Object.assign(perm(x.perm), { rules: x.rules.map(r => r.name) })), extra: d.access.extra.map(perm), matchedRules: d.access.matchedRules.map(r => ({ name: r.name, status: r.status })) },
      products: d.products.map(a => ({ product: a.productName, userName: a.userName, requestedAt: a.requestedAt, approvedAt: a.approvedAt, approvedBy: a.approvedBy, comment: a.approvalComment, returnDate: a.returnDate, source: a.source })),
      timeline: d.timeline.map(e => ({ at: e.at, kind: e.kind, title: e.title, detail: e.detail })),
      findings: d.findings.map(f => ({ id: f.id, severity: f.severity, title: f.title })),
      sod: d.sod.map(v => ({ rule: v.rule.label, account: v.account.userName, a: v.a && v.a.name, b: v.b && v.b.name, severity: v.severity })),
      exclusions: d.exclusions.map(x => ({ account: x.accountUserName, permission: x.permission, issue: x.issue, by: x.userName, at: x.at, until: x.until, comment: x.comment })),
      attestation: d.attest.filter(x => x.decision).map(x => ({ entitlement: x.perm.name, decision: x.decision.decision, by: x.decision.by, at: x.decision.at })),
      cost: { monthly: d.cost.monthly, priced: d.cost.priced.map(x => ({ entitlement: x.perm.name, monthly: x.monthly })),
        leaverBurn: d.cost.leaverBurn ? { days: d.cost.leaverBurn.days, monthly: d.cost.leaverBurn.monthly, toDate: d.cost.leaverBurn.toDate } : null },
      impact: { manages: d.impact.reports.map(p => p.displayName), approved: d.impact.approved.length, soleHolder: d.impact.soleHolder.map(p => p.name), busFactor: d.impact.busFactor.map(r => r.perm.name) },
      outlier: d.outlier ? { score: d.outlier.score, peer: d.outlier.factors.peer.value, standalone: d.outlier.factors.standalone.value, rare: d.outlier.factors.rare.value } : null,
      directory: d.directoryUser ? { userName: d.directoryUser.userName, ou: d.directoryUser.ou, lastLogon: d.directoryUser.lastLogon, created: d.directoryUser.created, employeeType: d.directoryUser.employeeType, extensionAttributes: d.directoryUser.extensionAttributes } : null,
      summary: d.summary
    };
  }

  HR.person360 = { find, build, toJson };
})(window.HR);

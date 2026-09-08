/* Person 360: one page per person.

   HelloID shows a person in pieces — the vault, the accounts, the rules, the log — and
   never together. This page is the "show me everything about Milan" screen: who they are
   and where they sit, what they hold and why, what happened to them and when, what they
   cost and what depends on them. Everything comes from HR.person360.build; the page only
   lays it out. Deep-linkable as #people/<employee id>. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el;
  const T = (k, p) => HR.i18n.t(k, p);
  const { card, tile, dl, scoreBar, drawerAccount, drawerPermission, drawerVaultPerson, personRow, entitlementTable,
    tabbed, partialNotice, STATE_SEV, stateLabel, offsetText } = HR.viewkit;
  const C = HR.charts;

  const day = d => d ? U.fmtDate(d).split(',')[0] : '—';
  const rel = d => {
    if (!d) return '';
    const days = Math.round((Date.now() - d) / 86400000);
    if (days === 0) return T('p3.today');
    if (days > 0) return T('wf.daysAgo', { n: U.fmtInt(days) });
    return T('pp.startsIn', { n: U.fmtInt(-days) });
  };
  const goPerson = p => HR.app.go('people', { id: p.externalId || p.personId });
  const permName = (m, key) => { const p = m.permissions.get(key); return p ? p.name : String(key); };

  /* ------------------------------------------------------------------ header */
  function header(m, d) {
    const p = d.person;
    const crumbs = el('div', { class: 'p360-crumbs' });
    d.path.forEach((n, i) => {
      if (i) crumbs.appendChild(el('span', { class: 'note', text: ' › ' }));
      crumbs.appendChild(el('a', { href: '#', text: n.label, onclick: e => { e.preventDefault(); HR.app.go('org', { tab: 'structure', dept: n.id }); } }));
    });
    const managers = el('div', { class: 'p360-managers' }, d.managers.length
      ? [el('span', { class: 'note', text: T('p3.reportsTo') + ' ' })].concat(d.managers.flatMap((mg, i) => [
          i ? el('span', { class: 'note', text: ' → ' }) : null,
          el('a', { href: '#', text: mg.displayName, onclick: e => { e.preventDefault(); goPerson(mg); } })
        ].filter(Boolean)))
      : [el('span', { class: 'note', text: T('p3.noManager') })]);
    const chips = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:6px' }, [
      el('span', { class: 'sev ' + STATE_SEV[d.life.state], text: stateLabel(d.life.state) }),
      el('span', { class: 'pill', text: offsetText(d.life) }),
      p.blocked ? el('span', { class: 'pill removed', text: T('p3.blocked') }) : null,
      p.excluded ? el('span', { class: 'pill removed', text: T('p3.excluded') }) : null
    ].concat(d.running.map(c => el('span', { class: 'pill', text: [c.type.name || c.type.code, c.department.name || c.department.externalId, c.title.name || c.title.code].filter(Boolean).join(' · ') })))
      .concat(d.accounts.map(a => el('span', { class: 'pill ' + (a.enabled === false ? 'removed' : 'ok'), title: a.system, text: a.userName, style: 'cursor:pointer', onclick: () => drawerAccount(a) })))
      .filter(Boolean));
    const actions = el('div', { class: 'slot-actions' }, [
      el('button', { class: 'btn sm', text: '← ' + T('nav.people'), onclick: () => HR.app.go('people') }),
      el('button', { class: 'btn sm', text: T('p3.drawer'), onclick: () => drawerVaultPerson(personRow(m, p), m) }),
      hides('risk') || hides('governance') ? null : el('button', { class: 'btn sm', text: T('p3.exportJson'), onclick: () => {
        U.download('person-' + (p.externalId || p.personId) + '.json', JSON.stringify(HR.person360.toJson(d), null, 2), 'application/json');
        HR.usage.exported('person-360');
      } })
    ]);
    return el('div', { class: 'view-head p360-head' }, [
      el('div', {}, [
        el('h1', { text: p.displayName.replace(/\s*\(\d+\)$/, '') }),
        el('p', {}, [el('span', { class: 'mono', text: (p.externalId || '') }), document.createTextNode(p.userName ? ' · ' + p.userName : '')]),
        d.path.length ? crumbs : null, managers, chips
      ].filter(Boolean)),
      actions
    ]);
  }

  /* A dashboard may hide the money and the risk scores: HR sees identity and access facts. */
  const hides = kind => !!(HR.dashboard && HR.dashboard.hides(kind));

  function tiles(m, d) {
    const s = d.summary;
    /* Every tile opens the tab that explains it. */
    const id = HR.app.state.params && HR.app.state.params.id;
    const open = (tab, extra) => () => HR.app.go('people', Object.assign({ id, tab }, extra || {}));
    const cells = [
      tile(T('p3.kAccounts'), U.fmtInt(s.accounts), T('p3.kAccountsFoot', { n: U.fmtInt(s.enabled) }), { small: true, severity: s.accounts && !s.enabled && d.life.state !== 'past' ? 'medium' : undefined, onClick: open('access') }),
      tile(T('p3.kEnts'), U.fmtInt(s.entitlements), T('p3.kEntsFoot', { nobody: U.fmtInt(d.access.counts.nobody) }), { small: true, severity: d.access.counts.nobody ? 'medium' : 'good', onClick: open('access', d.access.counts.nobody ? { prov: 'nobody' } : {}) }),
      tile(T('c.risk'), String(s.maxRisk), T('p3.kRiskFoot'), { small: true, facet: 'risk', severity: s.maxRisk >= 70 ? 'critical' : s.maxRisk >= 45 ? 'high' : s.maxRisk >= 20 ? 'medium' : 'good', onClick: open('governance') }),
      tile(T('p3.kCost'), U.fmtMoney(s.monthly), T('p3.kCostFoot'), { small: true, facet: 'money', onClick: open('cost') }),
      tile(T('ol.score'), s.outlier == null ? '—' : String(s.outlier), T('p3.kOutlierFoot'), { small: true, facet: 'risk', severity: s.outlier == null ? undefined : s.outlier >= HR.outlier.HIGH ? 'high' : 'good', onClick: open('governance') }),
      tile(T('p3.kFindings'), U.fmtInt(s.findings), T('p3.kFindingsFoot', { sod: U.fmtInt(s.sod) }), { small: true, facet: 'governance', severity: s.findings ? (d.findings.some(f => f.severity === 'critical') ? 'critical' : 'medium') : 'good', onClick: open('governance') })
    ].filter(Boolean);
    return el('div', { class: 'grid g' + cells.length }, cells);
  }

  /* ---------------------------------------------------------------- overview */
  function overviewTab(m, d) {
    const p = d.person, pc = d.primary;
    const wrap = el('div', { class: 'grid g2' });
    const details = card(T('p3.details'), null, dl([
      [T('c.employeeId'), p.externalId || '—'],
      [T('p3.name'), [p.name && p.name.givenName, p.name && p.name.familyName].filter(Boolean).join(' ') || p.displayName],
      [T('p3.userName'), p.userName || '—'],
      [T('p3.employer'), pc && pc.employer ? (pc.employer.name || pc.employer.code || '—') : '—'],
      [T('pp.department'), pc ? (pc.department.name || pc.department.externalId || '—') : '—'],
      [T('pp.jobTitle'), pc ? (pc.title.name || pc.title.code || '—') : '—'],
      [T('p3.location'), pc && pc.location ? (pc.location.name || '—') : '—'],
      [T('p3.costCentre'), pc && pc.costCenter ? (pc.costCenter.code || pc.costCenter.name || '—') : '—'],
      [T('pp.cType'), pc ? (pc.type.name || pc.type.code || '—') : '—'],
      [T('p3.manager'), d.managers[0] ? d.managers[0].displayName : (pc && pc.manager && pc.manager.displayName) || '—'],
      [T('p3.status'), (p.blocked ? T('p3.blocked') : '') + (p.excluded ? ' ' + T('p3.excluded') : '') || T('p3.statusOk')]
    ]));
    wrap.appendChild(details);
    const du = d.directoryUser;
    /* No directory collected: no card telling so, and the details take the width. */
    if (!m.directory) details.style.gridColumn = '1 / -1';
    if (m.directory) wrap.appendChild(card(T('p3.directory'), du ? T('p3.directoryNote', { file: m.directory.meta.fileName }) : T('p3.directoryNone'), du ? dl([
      [T('c.account'), du.userName + (du.upn ? ' · ' + du.upn : '')],
      [T('c.state'), T(du.enabled ? 'c.enabled' : 'c.disabled')],
      [T('p3.ou'), du.ou || '—'],
      [T('p3.created'), du.created ? day(new Date(du.created)) : '—'],
      [T('p3.lastLogon'), du.lastLogon ? day(new Date(du.lastLogon)) + ' (' + rel(new Date(du.lastLogon)) + ')' : T('p3.never')],
      [T('p3.employeeType'), du.employeeType || '—'],
      [T('p3.dirManager'), du.managerName || '—'],
      [T('p3.extAttrs'), Object.keys(du.extensionAttributes || {}).length ? Object.entries(du.extensionAttributes).map(([k, v]) => k.replace('extensionAttribute', 'ext') + '=' + v).join(' · ') : '—']
    ]) : el('p', { class: 'note', text: T('p3.directoryHint') })));

    const contracts = card(T('pp.drawerContracts'), T('dr.groupsN', { n: d.contracts.length }), HR.table.make({
      columns: [
        { key: 'start', label: T('pp.cStart'), value: c => c.startDate ? +c.startDate : 0, render: c => el('span', { text: day(c.startDate) }) },
        { key: 'end', label: T('pp.cEnd'), value: c => c.endDate ? +c.endDate : 0, render: c => el('span', { text: c.endDate ? day(c.endDate) : T('pp.noEnd') }) },
        { key: 'dept', label: T('pp.department'), value: c => c.department.name || c.department.externalId },
        { key: 'title', label: T('pp.jobTitle'), value: c => c.title.name || c.title.code },
        { key: 'type', label: T('pp.cType'), value: c => c.type.name || c.type.code },
        { key: 'manager', label: T('p3.manager'), value: c => (c.manager && c.manager.displayName) || '' },
        { key: 'fte', label: T('pp.cFte'), num: true, value: c => (c.details || {}).Fte || 0 }
      ],
      rows: d.contracts, pageSize: 10, exportName: 'contracts-' + p.externalId, initialSort: { key: 'start', dir: -1 }
    }));
    contracts.style.gridColumn = '1 / -1';
    wrap.appendChild(contracts);

    /* Lifecycle: the employment story in order, with what the access did around it. */
    const events = d.timeline.filter(e => e.kind === 'employment').slice().sort((a, b) => a.at - b.at);
    const life = el('ul', { class: 'p360-life' }, events.map(e => el('li', {}, [
      el('span', { class: 'mono', text: day(e.at) }), el('strong', { text: ' ' + e.title }), el('span', { class: 'note', text: ' ' + e.detail })
    ])));
    if (d.latency) life.appendChild(el('li', {}, [el('span', { class: 'mono', text: day(d.latency.granted) }), el('strong', { text: ' ' + T('p3.firstAccess') }),
      el('span', { class: 'note', text: ' ' + T('p3.firstAccessD', { n: d.latency.days }) })]));
    if (d.residue.length) life.appendChild(el('li', {}, [el('strong', { text: T('wf.careerResidue', { n: d.residue.length }) + ' ' }),
      el('span', { class: 'note', text: d.residue.map(k => permName(m, k)).join(', ') })]));
    if (d.life.state === 'past' && d.summary.enabled) life.appendChild(el('li', { class: 'sev critical', text: T('p3.leaverEnabled', { n: U.fmtInt(d.summary.enabled), days: U.fmtInt(d.life.days || 0) }) }));
    const lifeCard = card(T('p3.lifecycle'), T('p3.lifecycleNote'), events.length || d.latency ? life : el('p', { class: 'note', text: '—' }));
    lifeCard.style.gridColumn = '1 / -1';
    wrap.appendChild(lifeCard);
    return wrap;
  }

  /* ------------------------------------------------------------------ access */
  function accessTab(m, d, params) {
    const wrap = el('div', {});
    const cnt = d.access.counts;
    /* A tapped tile narrows the table to what it counted; tap again, or the pill, to widen.
       The baseline is a fact about everybody, not a list worth opening. */
    const prov = (params && params.prov) || '';
    const id = HR.app.state.params && HR.app.state.params.id;
    const pick = v => HR.app.go('people', { id, tab: 'access', prov: prov === v ? '' : v });
    const tiles = [
      tile(T('p3.viaRule'), U.fmtInt(cnt.rule), T('p3.viaRuleFoot'), { small: true, severity: 'good', onClick: () => pick('rule') }),
      m.assignments ? tile(T('p3.viaProduct'), U.fmtInt(cnt.product), T('p3.viaProductFoot'), { small: true, onClick: () => pick('product') }) : null,
      tile(T('p3.viaBaseline'), U.fmtInt(cnt.baseline), T('p3.viaBaselineFoot'), { small: true }),
      tile(T('p3.viaNobody'), U.fmtInt(cnt.nobody), T('p3.viaNobodyFoot'), { small: true, severity: cnt.nobody ? 'medium' : 'good', onClick: () => pick('nobody') })
    ].filter(Boolean);
    wrap.appendChild(el('div', { class: 'grid g' + tiles.length, style: 'margin-bottom:14px' }, tiles));
    if (!m.hasRecon) wrap.appendChild(partialNotice(['recon']));
    const heldRows = prov ? d.access.held.filter(h => h.provenance === prov) : d.access.held;

    if (d.accounts.length) wrap.appendChild(card(T('pp.accounts'), T('p3.accountsNote'), HR.table.make({
      columns: [
        { key: 'userName', label: T('c.account') },
        { key: 'system', label: T('c.system') },
        { key: 'cls', label: T('c.class'), value: a => a.clsLabel || '' },
        { key: 'enabled', label: T('c.state'), value: a => T(a.enabled === false ? 'c.disabled' : 'c.enabled') },
        { key: 'permCount', label: T('c.perms'), num: true },
        { key: 'sod', label: T('sod.tab'), num: true, facet: 'governance', value: a => d.sod.filter(v => v.account === a).length, render: a => { const n = d.sod.filter(v => v.account === a).length; return n ? el('span', { class: 'sev high', text: String(n) }) : el('span', { class: 'note', text: '0' }); } },
        { key: 'excl', label: T('dr.excludedIn'), num: true, facet: 'governance', value: a => d.exclusions.filter(x => x.account === a).length },
        { key: 'monthlyCost', label: T('c.costMo'), num: true, facet: 'money', render: a => U.fmtMoney(a.monthlyCost || 0) },
        { key: 'riskScore', label: T('c.risk'), num: true, facet: 'risk', render: a => scoreBar(a.riskScore) }
      ].filter(Boolean), rows: d.accounts, pageSize: 10, exportName: 'accounts-' + d.person.externalId, onRowClick: a => drawerAccount(a)
    })));
    const provPill = h => el('span', { class: 'pill ' + (h.provenance === 'rule' ? 'ok' : h.provenance === 'nobody' ? 'warn' : ''), text: T('p3.prov.' + h.provenance)
      + (h.provenance === 'rule' ? ': ' + h.rules.map(r => r.name).join(', ') : h.provenance === 'product' ? ': ' + h.product.product : '') });
    const heldCard = card(T('p3.heldTitle'), T('p3.heldNote', { n: U.fmtInt(d.access.held.length) }), HR.table.make({
      columns: [
        { key: 'name', label: T('c.permission'), value: h => h.perm.name, render: h => el('a', { href: '#', text: h.perm.name, onclick: e => { e.preventDefault(); drawerPermission(h.perm, m); } }) },
        { key: 'system', label: T('c.system'), value: h => h.perm.system },
        { key: 'category', label: T('c.category'), value: h => h.perm.categoryLabel || h.perm.category || '' },
        { key: 'prov', label: T('p3.provenance'), value: h => h.provenance, render: provPill },
        { key: 'sens', label: T('c.sensitivity'), num: true, facet: 'risk', value: h => h.perm.sensitivity || 0, render: h => U.fmtNum(h.perm.sensitivity || 0, 1) },
        { key: 'price', label: T('c.costMo'), num: true, facet: 'money', value: h => h.perm.monthlyPrice || 0, render: h => h.perm.monthlyPrice ? U.fmtMoney(h.perm.monthlyPrice) : el('span', { class: 'note', text: '—' }) },
        { key: 'holders', label: T('c.holders'), num: true, value: h => h.perm.holderCount || 0 },
        { key: 'via', label: T('c.account'), value: h => h.accounts.map(a => a.userName).join(', ') }
      ],
      rows: heldRows, pageSize: 25, exportName: 'held-' + d.person.externalId, initialSort: { key: 'prov', dir: -1 },
      search: (h, q) => (h.perm.name + ' ' + h.perm.system + ' ' + h.provenance).toLowerCase().includes(q),
      filters: prov ? [] : [{ key: 'prov', label: T('p3.provenance'), options: ['rule', 'product', 'baseline', 'nobody'].map(v => ({ value: v, label: T('p3.prov.' + v) })), match: (h, v) => h.provenance === v }]
    }));
    if (prov) heldCard.insertBefore(el('div', { class: 'slot-actions', style: 'margin:4px 0 8px' }, [
      el('span', { class: 'pill solid', text: T('c.filtered', { what: T('p3.prov.' + prov) }) + ' \u00b7 ' + U.fmtInt(heldRows.length) }),
      el('button', { class: 'btn sm ghost', text: T('c.showAll'), onclick: () => pick(prov) })
    ]), heldCard.children[1] || null);
    wrap.appendChild(heldCard);
    if (d.access.missing.length) wrap.appendChild(card(T('pp.missingHere'), T('p3.missingNote', { n: U.fmtInt(d.access.missing.length) }),
      HR.table.make({ columns: [
        { key: 'name', label: T('c.permission'), value: x => x.perm.name, render: x => el('a', { href: '#', text: x.perm.name, onclick: e => { e.preventDefault(); drawerPermission(x.perm, m); } }) },
        { key: 'system', label: T('c.system'), value: x => x.perm.system },
        { key: 'rules', label: T('au.cRule'), value: x => x.rules.map(r => r.name).join(', ') }
      ], rows: d.access.missing, pageSize: 15, exportName: 'missing-' + d.person.externalId })));
    return wrap;
  }

  /* ------------------------------------------------------- rules & products */
  function rulesTab(m, d) {
    const wrap = el('div', { class: 'grid g2' });
    const rules = d.access.matchedRules;
    wrap.appendChild(card(T('pp.drawerRules'), m.provisioning ? T('dr.groupsN', { n: rules.length }) : T('p3.rulesNeed'), rules.length
      ? el('ul', { class: 'clean' }, rules.map(r => {
          const grants = d.access.held.filter(h => h.rules.includes(r)).map(h => h.perm.name);
          const missing = d.access.missing.filter(x => x.rules.includes(r)).map(x => x.perm.name);
          return el('li', {}, [
            el('strong', { text: r.name }), document.createTextNode(' '), el('span', { class: 'pill', text: r.status }),
            el('div', { class: 'note', text: T('p3.ruleGrants', { n: U.fmtInt(grants.length) }) + (grants.length ? ': ' + grants.join(', ') : '') + (missing.length ? ' · ' + T('p3.ruleMissing', { n: U.fmtInt(missing.length) }) + ': ' + missing.join(', ') : '') })
          ]);
        }))
      : el('p', { class: 'note', text: m.provisioning ? T('ru.noRule') : T('p3.rulesNeedHint') })));
    const held = new Set(d.access.held.map(h => h.perm.name.toLowerCase()));
    wrap.appendChild(card(T('p3.productsTitle'), m.assignments ? T('p3.productsNote', { n: U.fmtInt(d.products.length) }) : T('p3.productsNeed'), d.products.length ? HR.table.make({
      columns: [
        { key: 'product', label: T('c.product'), value: a => a.productName },
        { key: 'requested', label: T('p3.requested'), value: a => a.requestedAt ? +a.requestedAt : 0, render: a => el('span', { text: day(a.requestedAt) }) },
        { key: 'approved', label: T('p3.approvedBy'), value: a => a.approvedBy || '', render: a => el('span', { class: a.selfApproved ? 'sev high' : '', text: (a.approvedBy || '—') + (a.approvedAt ? ' · ' + day(a.approvedAt) : '') }) },
        { key: 'comment', label: T('au.cReason'), value: a => a.approvalComment || '' },
        { key: 'returned', label: T('p3.returned'), value: a => a.returnDate ? +a.returnDate : 0, render: a => el('span', { text: a.returnDate ? day(a.returnDate) : '—' }) },
        { key: 'source', label: T('p3.source'), value: a => a.source || '' }
      ], rows: d.products, pageSize: 15, exportName: 'products-' + d.person.externalId, initialSort: { key: 'requested', dir: -1 }
    }) : el('p', { class: 'note', text: m.assignments ? T('p3.noProducts') : T('p3.productsNeedHint') })));
    return wrap;
  }

  /* ---------------------------------------------------------------- timeline */
  const ALL_KINDS = ['employment', 'account', 'access', 'decision', 'product'];
  /* Decisions are governance evidence: a role without that facet does not see them. */
  const KIND_FACET = { decision: 'governance' };
  function timelineTab(m, d, params) {
    const wrap = el('div', {});
    const KINDS = ALL_KINDS.filter(k => !KIND_FACET[k] || !hides(KIND_FACET[k]));
    let on = new Set(KINDS);
    const search = el('input', { type: 'search', placeholder: T('c.search') });
    search.style.minWidth = '220px';
    const chips = el('div', { class: 'slot-actions' });
    const list = el('ol', { class: 'p360-timeline' });
    const counts = U.counts(d.timeline, e => e.kind);
    const draw = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const rows = d.timeline.filter(e => on.has(e.kind) && (!q || (e.title + ' ' + e.detail).toLowerCase().includes(q)));
      rows.slice(0, 400).forEach(e => list.appendChild(el('li', { class: 'tl-' + e.kind }, [
        el('span', { class: 'tl-dot' }),
        el('span', { class: 'tl-when mono', title: U.fmtDate(e.at), text: day(e.at) }),
        el('span', { class: 'tl-body' }, [el('strong', { text: e.title }), e.detail ? el('span', { class: 'note', text: ' · ' + e.detail }) : null].filter(Boolean)),
        el('span', { class: 'pill', text: T('p3.kind.' + e.kind) })
      ])));
      if (!rows.length) list.appendChild(el('li', { class: 'note', text: '—' }));
      if (rows.length > 400) list.appendChild(el('li', { class: 'note', text: T('p3.tlMore', { n: U.fmtInt(rows.length - 400) }) }));
    };
    KINDS.forEach(k => chips.appendChild(el('button', { class: 'btn sm primary', text: T('p3.kind.' + k) + ' ' + U.fmtInt(counts.get(k) || 0), onclick: e => {
      if (on.has(k)) on.delete(k); else on.add(k);
      e.currentTarget.classList.toggle('primary', on.has(k)); draw();
    } })));
    chips.appendChild(el('span', { class: 'spacer' }));
    chips.appendChild(search);
    chips.appendChild(el('button', { class: 'btn sm', text: T('c.exportCsv'), onclick: () => {
      U.download('timeline-' + d.person.externalId + '.csv', U.toCSV(d.timeline.filter(e => on.has(e.kind)).map(e => ({ at: e.at.toISOString(), kind: e.kind, title: e.title, detail: e.detail }))), 'text/csv;charset=utf-8');
    } }));
    search.addEventListener('input', draw);
    draw();
    wrap.appendChild(card(T('p3.tlTitle'), T('p3.tlNote', { n: U.fmtInt(d.timeline.length) }), [chips, list]));
    return wrap;
  }

  /* -------------------------------------------------------------- governance */
  function governanceTab(m, d) {
    const wrap = el('div', { class: 'grid g2' });
    /* Each finding in full, but only this person's rows: what, why, how to fix, and the
       accounts or entitlements it named for them — no detour through Risk & findings. */
    const accountKeys = new Set(d.accounts.map(a => a.key));
    const mine = f => f.entities.filter(e => (e.type === 'person' && e.key === d.person.personId) || (e.type === 'account' && accountKeys.has(e.key)));
    const findingCard = f => {
      const rows = mine(f);
      const det = el('details', { class: 'finding', open: true });
      const sum = el('summary');
      sum.append(...[
        el('span', { class: 'sev ' + f.severity, text: T('c.' + f.severity) }),
        el('span', { class: 'f-title', text: f.title }),
        el('span', { class: 'pill solid', text: T('p3.forThisPerson', { n: U.fmtInt(rows.length) }) }),
        f.impactMonthly ? el('span', { class: 'pill', text: U.fmtMoney(f.impactMonthly) + '/mo' }) : null,
        el('a', { href: '#', class: 'note', text: T('p3.allInFinding', { n: U.fmtInt(f.count) }), onclick: e => { e.preventDefault(); e.stopPropagation(); HR.app.go('risk', { tab: 'findings', finding: f.id }); } })
      ].filter(Boolean));
      det.appendChild(sum);
      const body = el('div', { class: 'f-body' });
      body.appendChild(dl([[T('rk.what'), f.what], [T('rk.why'), f.why], [T('rk.fix'), f.fix]]));
      if (rows.length) body.appendChild(el('div', { style: 'margin-top:8px' }, HR.table.make({
        columns: [
          { key: 'label', label: T(rows[0].type === 'permission' ? 'c.permission' : rows[0].type === 'person' ? 'c.person' : 'c.account'), value: r => r.label },
          { key: 'detail', label: T('rk.detail'), value: r => r.detail || '' }
        ],
        rows, pageSize: 10, exportName: 'finding-' + f.id + '-' + d.person.externalId,
        onRowClick: r => { if (r.type === 'account') { const a = m.accounts.get(r.key); if (a) drawerAccount(a); } else if (r.type === 'permission') { const p = m.permissions.get(r.key); if (p) drawerPermission(p, m); } }
      })));
      det.appendChild(body);
      return det;
    };
    const fCard = card(T('p3.findingsTitle'), T('p3.findingsNote'), d.findings.length
      ? el('div', { class: 'stack' }, d.findings.map(findingCard))
      : el('p', { class: 'note', text: T('p3.noFindings') }));
    fCard.style.gridColumn = '1 / -1';
    wrap.appendChild(fCard);
    wrap.appendChild(card(T('sod.tab'), T('dr.toxicNote'), d.sod.length
      ? el('ul', { class: 'clean' }, d.sod.map(v => el('li', {}, [
          el('span', { class: 'sev ' + v.severity, text: T('c.' + v.severity) }), document.createTextNode(' '),
          el('strong', { text: v.rule.label }), document.createTextNode(': ' + (v.a ? v.a.name : v.account.clsLabel) + ' + ' + (v.b ? v.b.name : v.account.clsLabel) + ' · ' + v.account.userName),
          HR.sod.whyOf(v.rule) ? el('div', { class: 'note', text: HR.sod.whyOf(v.rule) }) : null
        ].filter(Boolean))))
      : el('p', { class: 'note', text: T('p3.noSod') })));
    wrap.appendChild(card(T('dr.excludedIn'), m.audit ? T('dr.excludedInNote') : T('p3.auditNeed'), d.exclusions.length
      ? el('ul', { class: 'clean' }, d.exclusions.map(x => el('li', {}, [
          el('strong', { text: (x.accountLevel ? x.accountUserName : x.permission) + ' — ' + (x.issue || '') }),
          el('div', { class: 'note', text: T('dr.excludedLine', { who: x.userName || '—', date: day(x.at), until: x.until ? day(x.until) : '—', why: String(x.comment || '').trim() || T('au.noReason') }) })
        ])))
      : el('p', { class: 'note', text: m.audit ? T('p3.noExclusions') : T('p3.auditNeedHint') })));
    const decided = d.attest.filter(x => x.decision);
    wrap.appendChild(card(T('p3.attestTitle'), T('p3.attestNote', { n: U.fmtInt(decided.length), of: U.fmtInt(d.attest.length) }), decided.length
      ? HR.table.make({ columns: [
          { key: 'ent', label: T('c.permission'), value: x => x.perm.name },
          { key: 'decision', label: T('p3.decision'), value: x => x.decision.decision, render: x => el('span', { class: 'pill ' + (/revoke/i.test(x.decision.decision) ? 'removed' : 'ok'), text: x.decision.decision }) },
          { key: 'by', label: T('au.cWho'), value: x => x.decision.by || '' },
          { key: 'at', label: T('au.cWhen'), value: x => x.decision.at || '' }
        ], rows: decided, pageSize: 10, exportName: 'attest-' + d.person.externalId })
      : el('p', { class: 'note', text: T('p3.noAttest') })));
    if (!hides('risk')) d.accounts.forEach(a => {
      wrap.appendChild(card(T('dr.whyScore') + ' — ' + a.userName, T('dr.componentsSum', { n: a.riskScore }),
        a.riskParts && a.riskParts.length ? C.barList(a.riskParts.map(p => ({ label: p.label, value: Math.round(p.value), color: C.STATUS[a.riskBand], note: p.detail })), { valueLabel: T('c.points') })
          : el('p', { class: 'note', text: T('dr.clean') })));
    });
    if (d.outlier && !hides('risk')) {
      const ol = d.outlier;
      const list = ents => ents.slice(0, 5).map(k => permName(m, k)).join(', ') + (ents.length > 5 ? ' +' + (ents.length - 5) : '');
      wrap.appendChild(card(T('ol.title'), T('ol.note'), dl([
        [T('ol.score'), scoreBar(ol.score)],
        [T('ol.fPeer'), el('span', {}, [scoreBar(ol.factors.peer.value), el('span', { class: 'note', text: ' ' + (ol.factors.peer.peer ? T('ol.fPeerD', { p: Math.round(100 * ol.factors.peer.similarity), name: ol.factors.peer.peer.person.displayName }) : T('ol.fPeerNone')) })])],
        [T('ol.fStandalone'), el('span', {}, [scoreBar(ol.factors.standalone.value), el('span', { class: 'note', text: ' ' + list(ol.factors.standalone.ents) })])],
        [T('ol.fRare'), el('span', {}, [scoreBar(ol.factors.rare.value), el('span', { class: 'note', text: ' ' + list(ol.factors.rare.ents) })])]
      ])));
    }
    return wrap;
  }

  /* ------------------------------------------------------------ cost & impact */
  function costTab(m, d) {
    const wrap = el('div', { class: 'grid g2' });
    const c = d.cost;
    wrap.appendChild(card(T('p3.costTitle'), T('p3.costNote', { m: U.fmtMoney(c.monthly), y: U.fmtMoney(c.monthly * 12) }), [
      c.priced.length ? C.barList(c.priced.sort((a, b) => b.monthly - a.monthly).map(x => ({ label: x.perm.name, value: x.monthly })), { format: v => U.fmtMoney(v) }) : el('p', { class: 'note', text: T('p3.noPriced') }),
      c.leaverBurn ? el('p', { class: 'sev critical', style: 'margin-top:8px', text: T('p3.leaverBurn', { days: U.fmtInt(c.leaverBurn.days), monthly: U.fmtMoney(c.leaverBurn.monthly), toDate: U.fmtMoney(c.leaverBurn.toDate) }) }) : null,
      c.duplicateCost ? el('p', { class: 'note', text: T('p3.duplicateCost', { n: U.fmtInt(c.duplicateCost.accounts.length), monthly: U.fmtMoney(c.duplicateCost.monthly) }) }) : null
    ].filter(Boolean)));
    const im = d.impact;
    wrap.appendChild(card(T('p3.impactTitle'), T('p3.impactNote'), [
      dl([
        [T('p3.manages'), im.reports.length ? el('span', {}, im.reports.slice(0, 12).flatMap((p, i) => [i ? document.createTextNode(', ') : null,
          el('a', { href: '#', text: p.displayName.replace(/\s*\(\d+\)$/, ''), onclick: e => { e.preventDefault(); goPerson(p); } })].filter(Boolean)).concat(im.reports.length > 12 ? [document.createTextNode(' +' + (im.reports.length - 12))] : [])) : T('p3.nobody')],
        [T('p3.approvedN'), U.fmtInt(im.approved.length)],
        [T('p3.soleHolder'), im.soleHolder.length ? im.soleHolder.map(p => p.name).join(', ') : T('p3.nothing')],
        [T('p3.busFactor'), im.busFactor.length ? im.busFactor.map(r => r.perm.name).join(', ') : T('p3.nothing')]
      ])
    ]));
    if (d.life.state === 'past' || d.life.state === 'current') {
      const leaves = d.access.held.filter(h => h.provenance === 'nobody' || h.perm.holderCount <= 2);
      wrap.appendChild(card(T('p3.leavesTitle'), T('p3.leavesNote'), leaves.length
        ? entitlementTable(leaves.map(h => h.perm), d.accounts, m, 'leaves-' + d.person.externalId)
        : el('p', { class: 'note', text: T('p3.nothing') })));
    }
    return wrap;
  }

  /* -------------------------------------------------------------------- view */
  /** The 360 for one person; the People view calls this when its hash carries an id. */
  function personPage(m, person, params) {
    const d = HR.person360.build(m, person);
    const f = document.createDocumentFragment();
    f.appendChild(header(m, d));
    f.appendChild(tiles(m, d));
    f.appendChild(el('div', { style: 'margin-top:14px' }, tabbed('people', [
      { id: 'overview', label: T('p3.tab.overview'), build: () => overviewTab(m, d) },
      { id: 'access', label: T('p3.tab.access'), count: d.access.held.length, build: p => accessTab(m, d, p) },
      { id: 'rules', label: T('p3.tab.rules'), count: d.access.matchedRules.length + d.products.length, build: () => rulesTab(m, d) },
      { id: 'timeline', label: T('p3.tab.timeline'), count: d.timeline.length, build: p => timelineTab(m, d, p) },
      { id: 'governance', label: T('p3.tab.governance'), count: d.findings.length + d.sod.length, facet: 'governance', build: () => governanceTab(m, d) },
      { id: 'cost', label: T('p3.tab.cost'), facet: 'money', build: () => costTab(m, d) }
    ], Object.assign({}, params))));
    return f;
  }

  HR.views.personPage = personPage;
  /* Old links: #person/<id> is #people/<id> now. */
  HR.views.person = (m, params) => { setTimeout(() => HR.app.go('people', params && params.id ? { id: params.id } : {}), 0); return document.createDocumentFragment(); };
})(window.HR);

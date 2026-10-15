/* Scripts & forms: the Service Automation quality check over one tenant.

   Reads the helloid-sa-export.py file (HR.salint does the analysis) and answers, in
   this order: what to fix first, where it sits (per delegated form and product), which
   scripts are copies of each other that drifted, which variables are spelled three ways
   or never set, and, when the export carries the audit log, which forms fail in use. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el;
  const T = (k, p) => HR.i18n.t(k, p);
  const { card, tile, tabbed, openDrawer, dl } = HR.viewkit;

  const SEVS = ['critical', 'high', 'medium', 'low', 'info'];
  const sevPill = sev => el('span', { class: 'sev ' + sev, text: T('c.' + sev) });
  const ruleTitle = r => T('sa.r.' + r + '.t');
  const lineText = f => T('sa.r.' + f.rule + '.line', f.p);
  const kindLabel = k => T('sc.kind.' + k);

  /* --------------------------------------------------------------- drawers */

  /** The script, numbered, with the lines a finding points at marked. */
  function codeBlock(src, marks) {
    const pre = el('pre', { class: 'sa-code' });
    String(src || '').split('\n').forEach((line, i) => {
      const n = i + 1;
      const row = el('span', { class: 'sa-line' + (marks.has(n) ? ' mark' : ''), title: marks.get(n) || '' }, [
        el('span', { class: 'sa-ln', text: String(n) }),
        document.createTextNode(line + '\n')
      ]);
      if (marks.has(n)) row.id = 'sa-l' + n;
      pre.appendChild(row);
    });
    return pre;
  }

  function findingList(list, a, opts) {
    if (!list.length) return el('p', { class: 'note', text: T('sc.noFindings') });
    return el('ul', { class: 'clean' }, list.map(f => el('li', { class: 'row' }, [
      sevPill(f.sev),
      el('span', {}, [el('strong', { text: ruleTitle(f.rule) }), document.createTextNode(' · ' + lineText(f))]),
      f.line ? el('span', { class: 'pill', text: T('sc.lineN', { n: f.line }) }) : null,
      opts && opts.open && f.script ? el('a', { href: '#', text: T('sc.openScript'), onclick: e => { e.preventDefault(); scriptDrawer(a.scripts.find(s => s.id === f.script), a, f.line); } }) : null
    ].filter(Boolean))));
  }

  function scriptDrawer(s, a, focusLine) {
    if (!s) return;
    const marks = new Map();
    s.findings.forEach(f => { if (f.line) marks.set(f.line, (marks.get(f.line) ? marks.get(f.line) + '\n' : '') + ruleTitle(f.rule)); });
    const cluster = s.cluster && a.clusters.find(c => c.id === s.cluster);
    const head = el('div', {}, [
      el('h2', { text: s.name }),
      el('div', { class: 'row' }, [
        el('span', { class: 'pill', text: kindLabel(s.kind) }),
        el('span', { class: 'pill', text: T('sc.lines', { n: U.fmtInt(s.lines) }) }),
        el('span', { class: 'pill', text: s.runInCloud ? T('sc.cloud') : T('sc.agent') }),
        cluster ? el('span', { class: 'pill clickable', text: T('sc.inCluster', { n: cluster.members.length }), onclick: () => clusterDrawer(cluster, a, s) }) : null
      ].filter(Boolean))
    ]);
    /* For a data source: what goes in, what comes out, and what HelloID thinks comes out. */
    const io = s.ds ? card(null, null, dl([
      [T('sc.dInput'), s.ds.input.join(', ') || '—'],
      [T('sc.dReturns'), s.ds.out.complete
        ? el('span', {}, [document.createTextNode([...s.ds.out.props.values()].map(p => p.name + (p.exact ? '' : '~')).join(', ')),
          el('div', { class: 'note', text: T('sc.dReturnsNote') })])
        : el('span', { class: 'note', text: T('sc.dReturnsUnknown') })],
      [T('sc.dModel'), s.ds.model.join(', ') || '—'],
      [T('sc.dUsedBy'), s.ds.usedBy.map(x => x.name).join(', ') || '—']
    ])) : null;
    const body = el('div', { class: 'stack' }, [
      io,
      card(T('sc.findingsHere'), null, findingList(s.findings, a)),
      card(T('sc.script'), null, codeBlock(s.script, marks))
    ].filter(Boolean));
    openDrawer(head, body);
    if (focusLine) setTimeout(() => { const n = document.getElementById('sa-l' + focusLine); if (n) n.scrollIntoView({ block: 'center' }); }, 50);
  }

  function clusterDrawer(c, a, pick) {
    const head = el('div', {}, [
      el('h2', { text: T('sc.clusterTitle', { n: c.members.length }) }),
      el('p', { class: 'note', text: T('sc.clusterLead', { ref: c.ref.name, v: c.variants }) })
    ]);
    const diffBox = el('div');
    const others = c.members.filter(m => m !== c.ref);
    const sel = el('select', { onchange: () => draw(others.find(m => m.id === sel.value)) },
      others.map(m => el('option', { value: m.id, text: m.name + ' · ' + Math.round(100 * (c.sims.get(m.id) || 0)) + '%' })));
    function draw(m) {
      diffBox.innerHTML = '';
      if (!m) return;
      const d = HR.salint.diffLines(c.ref.script, m.script);
      const pre = el('pre', { class: 'sa-code sa-diff' });
      let eqRun = [];
      const flush = () => {
        if (eqRun.length > 6) {
          eqRun.slice(0, 2).forEach(t => pre.appendChild(el('span', { class: 'sa-line', text: '  ' + t + '\n' })));
          pre.appendChild(el('span', { class: 'sa-line fold', text: '  ⋯ ' + T('sc.sameLines', { n: eqRun.length - 4 }) + '\n' }));
          eqRun.slice(-2).forEach(t => pre.appendChild(el('span', { class: 'sa-line', text: '  ' + t + '\n' })));
        } else eqRun.forEach(t => pre.appendChild(el('span', { class: 'sa-line', text: '  ' + t + '\n' })));
        eqRun = [];
      };
      d.forEach(x => {
        if (x.op === 'eq') { eqRun.push(x.text); return; }
        flush();
        pre.appendChild(el('span', { class: 'sa-line ' + x.op, text: (x.op === 'add' ? '+ ' : '- ') + x.text + '\n' }));
      });
      flush();
      diffBox.append(el('p', { class: 'note', text: T('sc.diffLegend', { ref: c.ref.name, other: m.name }) }), pre);
    }
    const body = el('div', { class: 'stack' }, [
      card(T('sc.members'), null, el('ul', { class: 'clean' }, c.members.map(m => el('li', { class: 'row' }, [
        el('a', { href: '#', text: m.name, onclick: e => { e.preventDefault(); scriptDrawer(m, a); } }),
        el('span', { class: 'note', text: kindLabel(m.kind) + ' · ' + T('sc.lines', { n: m.lines }) }),
        m === c.ref ? el('span', { class: 'pill ok', text: T('sc.reference') }) : el('span', { class: 'pill', text: Math.round(100 * (c.sims.get(m.id) || 0)) + '%' })
      ])))),
      card(T('sc.diffTitle'), T('sc.diffNote'), el('div', { class: 'stack' }, [others.length ? sel : null, diffBox].filter(Boolean))),
      el('p', { class: 'note', text: T('sc.clusterFix') })
    ]);
    openDrawer(head, body);
    const first = pick && pick !== c.ref ? pick : others[0];
    if (first) { sel.value = first.id; draw(first); }
  }

  function formFieldsTable(form, a, list) {
    const byGuid = new Map(a.dataSources.map(d => [String(d.guid).toLowerCase(), d]));
    const issuesFor = key => list.filter(f => f.where && f.where.field === key);
    return HR.table.make({
      columns: [
        { key: 'key', label: T('sc.cField'), render: x => el('span', { class: 'mono', text: x.field.key }) },
        { key: 'label', label: T('sc.cLabel'), value: x => (x.field.templateOptions || {}).label || '' },
        { key: 'type', label: T('sc.cType'), value: x => x.field.type },
        { key: 'req', label: T('sc.cRequired'), value: x => (x.field.templateOptions || {}).required ? T('c.yes') : '' },
        { key: 'ds', label: T('sc.cSource'), value: x => {
          const g = ((x.field.templateOptions || {}).dataSourceConfig || {}).dataSourceGuid;
          const d = g && byGuid.get(String(g).toLowerCase());
          return d ? d.name : g ? T('sc.missingDs') : '';
        }, render: x => {
          const g = ((x.field.templateOptions || {}).dataSourceConfig || {}).dataSourceGuid;
          const d = g && byGuid.get(String(g).toLowerCase());
          if (!g) return el('span', { class: 'note', text: '—' });
          if (!d) return el('span', { class: 'pill warn', text: T('sc.missingDs') });
          const s = a.scripts.find(x2 => x2.id === 'ds:' + d.guid);
          return s ? el('a', { href: '#', text: d.name, onclick: e => { e.preventDefault(); e.stopPropagation(); scriptDrawer(s, a); } }) : el('span', { text: d.name });
        } },
        { key: 'issues', label: T('sc.cIssues'), num: true, value: x => issuesFor(x.field.key).length,
          render: x => { const n = issuesFor(x.field.key); return n.length ? el('span', { class: 'sev ' + n[0].sev, text: String(n.length) }) : el('span', { class: 'note', text: '0' }); } }
      ],
      rows: form.fields, pageSize: 50, exportName: 'sa-form-fields'
    });
  }

  function entryDrawer(e, a) {
    const list = (a.byTarget.get(e.type + ':' + e.id) || []).concat(e.form ? (a.byTarget.get('form:' + e.form.guid) || []) : []);
    const st = a.activity && a.activity.stats.get(e);
    const head = el('div', {}, [
      el('h2', { text: e.name }),
      el('div', { class: 'row' }, [
        el('span', { class: 'pill', text: T('sc.type.' + e.type) }),
        e.enabled ? null : el('span', { class: 'pill warn', text: T('sc.disabled') }),
        ...SEVS.map(s => { const n = list.filter(f => f.sev === s).length; return n ? el('span', { class: 'sev ' + s, text: n + ' ' + T('c.' + s) }) : null; })
      ].filter(Boolean))
    ]);
    const body = el('div', { class: 'stack' });
    body.appendChild(card(null, null, dl([
      [T('sc.dForm'), e.form ? e.form.name + (e.form.version ? ' · v' + e.form.version : '') : e.formGuid ? T('sc.missingForm') : '—'],
      [T('sc.dAccess'), e.accessGroups.length ? e.accessGroups.join(', ') : (e.type === 'product' && String(e.visibility).toLowerCase() === 'all' ? T('sc.visibleAll') : '—')],
      [T('sc.dCategories'), e.categories.join(', ') || '—'],
      [T('sc.dScripts'), e.scripts.length ? el('span', {}, e.scripts.map((s, i) => el('span', {}, [
        i ? document.createTextNode(' · ') : null,
        el('a', { href: '#', text: s.event ? T('sc.event.' + s.event) + ': ' + s.name.split(' › ').pop() : T('sc.task'), onclick: ev => { ev.preventDefault(); scriptDrawer(s, a); } })
      ].filter(Boolean)))) : '—'],
      st ? [T('sc.dUse'), T('sc.useLine', { o: U.fmtInt(st.opened), s: U.fmtInt(st.submitted), r: U.fmtInt(st.requests), e: U.fmtInt(st.errors + st.failed),
        last: st.lastUse ? U.fmtDate(Date.parse(st.lastUse)).split(',')[0] : '—' })] : null
    ].filter(Boolean))));
    body.appendChild(card(T('sc.findingsHere'), null, findingList(list.concat(e.scripts.flatMap(s => s.findings.filter(f => !list.includes(f)))), a, { open: true })));
    if (st && st.messages.length) {
      body.appendChild(card(T('sc.errorLines'), null, el('ul', { class: 'clean' }, st.messages.slice(-15).reverse().map(m => el('li', {}, [
        el('span', { class: 'note', text: (m.when ? U.fmtDate(Date.parse(m.when)) : '') + ' · ' }), document.createTextNode(m.text)
      ])))));
    }
    if (e.form) body.appendChild(card(T('sc.fields'), null, formFieldsTable(e.form, a, list)));
    openDrawer(head, body);
  }

  function formDrawer(form, a) {
    const list = a.byTarget.get('form:' + form.guid) || [];
    openDrawer(el('div', {}, [el('h2', { text: form.name }), el('p', { class: 'note', text: T('sc.formOrphanLead') })]),
      el('div', { class: 'stack' }, [card(T('sc.findingsHere'), null, findingList(list, a)), card(T('sc.fields'), null, formFieldsTable(form, a, list))]));
  }

  function openTarget(t, a, f) {
    if (f && f.script) { scriptDrawer(a.scripts.find(s => s.id === f.script), a, f.line); return; }
    if (t.type === 'delegated' || t.type === 'product') { const e = a.entries.find(x => x.type === t.type && x.id === t.id); if (e) entryDrawer(e, a); return; }
    if (t.type === 'datasource') {
      const s = a.scripts.find(x => x.id === 'ds:' + t.id);
      if (s) { scriptDrawer(s, a); return; }
      const d = a.dataSources.find(x => x.guid === t.id);
      if (d) openDrawer(el('h2', { text: d.name }), card(null, null, dl([
        [T('sc.dType'), T('sc.dsType.' + d.type)], [T('sc.dModel'), d.model.join(', ') || '—'], [T('sc.dInput'), d.input.join(', ') || '—'],
        [T('sc.dUsedBy'), d.usedBy.map(x => x.name).join(', ') || '—']])));
      return;
    }
    if (t.type === 'cluster') { const c = a.clusters.find(x => x.id === t.id); if (c) clusterDrawer(c, a); return; }
    if (t.type === 'form') { const fm = a.forms.find(x => x.guid === t.id); if (fm) formDrawer(fm, a); return; }
    if (t.type === 'variable') HR.app.go('scripts', { tab: 'variables' });
  }

  /* ------------------------------------------------------------------ tabs */

  /** Findings grouped per rule, worst first: the rule says why and how to fix once. */
  function ruleGroups(a) {
    const by = new Map();
    a.findings.forEach(f => { if (!by.has(f.rule)) by.set(f.rule, []); by.get(f.rule).push(f); });
    return [...by.entries()].map(([rule, list]) => ({ rule, list, sev: list.reduce((s, f) => HR.salint.SEV_ORDER[f.sev] < HR.salint.SEV_ORDER[s] ? f.sev : s, 'info') }))
      .sort((x, y) => HR.salint.SEV_ORDER[x.sev] - HR.salint.SEV_ORDER[y.sev] || y.list.length - x.list.length);
  }

  function overviewTab(a) {
    const wrap = el('div', { class: 'stack' });
    const s = a.summary, c = a.counts;
    const urgent = c.critical + c.high;
    const groups = ruleGroups(a);
    const errs = a.activity ? [...a.activity.stats.values()].filter(x => x.errors || x.failed).length : null;

    wrap.appendChild(el('div', { class: 'notice' + (urgent ? '' : ' ok') }, [
      el('strong', { text: urgent ? T('sc.verdictBad', { n: U.fmtInt(urgent), e: U.fmtInt(new Set(a.findings.filter(f => f.sev === 'critical' || f.sev === 'high').map(f => f.target.type + f.target.id)).size) })
        : T('sc.verdictOk') }),
      el('span', { text: ' ' + T('sc.verdictTail', { c: U.fmtInt(a.clusters.length), s: U.fmtInt(s.saveable) }) })
    ]));

    wrap.appendChild(el('div', { class: 'grid g4' }, [
      tile(T('sc.tEntries'), U.fmtInt(s.delegated + s.products), T('sc.tEntriesFoot', { d: s.delegated, p: s.products }),
        { small: true, onClick: () => HR.app.go('scripts', { tab: 'entries' }) }),
      tile(T('sc.tScripts'), U.fmtInt(s.scripts), T('sc.tScriptsFoot', { l: U.fmtInt(s.lines), d: s.dataSources }),
        { small: true, onClick: () => HR.app.go('scripts', { tab: 'scripts' }) }),
      tile(T('sc.tUrgent'), U.fmtInt(urgent), T('sc.tUrgentFoot', { m: U.fmtInt(c.medium), l: U.fmtInt(c.low) }),
        { small: true, severity: c.critical ? 'critical' : c.high ? 'high' : 'good', onClick: () => HR.app.go('scripts', { tab: 'findings' }) }),
      tile(T('sc.tClones'), U.fmtInt(s.clustered), T('sc.tClonesFoot', { c: a.clusters.length, s: U.fmtInt(s.saveable) }),
        { small: true, severity: a.clusters.length ? 'medium' : 'good', onClick: () => HR.app.go('scripts', { tab: 'clones' }) }),
      a.activity ? tile(T('sc.tFailing'), U.fmtInt(errs), T('sc.tFailingFoot', { d: a.activity.window.days || '—' }),
        { small: true, severity: errs ? 'high' : 'good', onClick: () => HR.app.go('scripts', { tab: 'activity' }) }) : null
    ].filter(Boolean)));

    /* What to do first: the five worst rules, each with its count and its fix. */
    wrap.appendChild(card(T('sc.firstTitle'), T('sc.firstNote'), el('ol', { class: 'sa-actions' }, groups.slice(0, 6).map(g => el('li', {}, [
      el('div', { class: 'row' }, [sevPill(g.sev),
        el('a', { href: '#', text: ruleTitle(g.rule), onclick: e => { e.preventDefault(); HR.app.go('scripts', { tab: 'findings', rule: g.rule }); } }),
        el('span', { class: 'pill solid', text: T('sc.places', { n: U.fmtInt(g.list.length) }) })]),
      el('div', { class: 'note', text: T('sa.r.' + g.rule + '.fix') })
    ])))));

    /* Worst entries: where the problems concentrate. */
    const score = e => { const l = (a.byTarget.get(e.type + ':' + e.id) || []).concat(e.scripts.flatMap(x => x.findings)); return l.reduce((n, f) => n + ({ critical: 50, high: 10, medium: 3, low: 1, info: 0 })[f.sev], 0); };
    const worst = a.entries.map(e => ({ e, n: score(e) })).filter(x => x.n).sort((x, y) => y.n - x.n).slice(0, 8);
    if (worst.length) wrap.appendChild(card(T('sc.worstTitle'), T('sc.worstNote'), HR.charts.barList(worst.map(x => ({ label: x.e.name, value: x.n, color: 'var(--serious)' })), {})));
    wrap.appendChild(el('p', { class: 'note', text: T('sc.source', { t: a.tenant || '—', d: a.collectedAt ? U.fmtDate(Date.parse(a.collectedAt)) : '—' }) }));
    return wrap;
  }

  function findingsTab(a, params) {
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(el('p', { class: 'note', text: T('sc.findingsLead') }));
    ruleGroups(a).forEach(g => {
      const d = el('details', { class: 'finding' + (params.rule === g.rule ? ' finding-target' : '') });
      if (params.rule === g.rule) { d.open = true; setTimeout(() => d.scrollIntoView({ block: 'start' }), 60); }
      d.appendChild(el('summary', {}, [sevPill(g.sev), el('span', { class: 'f-title', text: ruleTitle(g.rule) }),
        el('span', { class: 'pill', text: T('sc.cat.' + g.rule.split('.')[0]) }),
        el('span', { class: 'pill solid', text: T('sc.places', { n: U.fmtInt(g.list.length) }) })]));
      const body = el('div', { class: 'f-body' });
      body.appendChild(dl([[T('rk.why'), T('sa.r.' + g.rule + '.why')], [T('rk.fix'), T('sa.r.' + g.rule + '.fix')]]));
      body.appendChild(el('div', { style: 'margin-top:10px' }, HR.table.make({
        columns: [
          { key: 'target', label: T('sc.cWhere'), value: f => f.target.name },
          { key: 'detail', label: T('rk.detail'), value: f => lineText(f) + (f.line ? ' · ' + T('sc.lineN', { n: f.line }) : '') },
          { key: 'sev', label: T('sc.cSev'), value: f => HR.salint.SEV_ORDER[f.sev], render: f => sevPill(f.sev) }
        ],
        rows: g.list, pageSize: 15, exportName: 'sa-' + g.rule,
        search: (f, q) => (f.target.name + ' ' + lineText(f)).toLowerCase().includes(q),
        onRowClick: f => openTarget(f.target, a, f)
      })));
      d.appendChild(body);
      wrap.appendChild(d);
    });
    if (!a.findings.length) wrap.appendChild(el('p', { class: 'note', text: T('sc.noFindings') }));
    return wrap;
  }

  function entriesTab(a) {
    const all = e => (a.byTarget.get(e.type + ':' + e.id) || []).concat(e.scripts.flatMap(s => s.findings));
    const worstSev = e => all(e).reduce((s, f) => Math.min(s, HR.salint.SEV_ORDER[f.sev]), 9);
    const act = a.activity;
    return card(null, null, HR.table.make({
      columns: [
        { key: 'name', label: T('sc.cName'), value: e => e.name },
        { key: 'type', label: T('sc.cType'), value: e => T('sc.type.' + e.type) },
        { key: 'form', label: T('sc.cForm'), value: e => e.form ? e.form.name : e.formGuid ? T('sc.missingForm') : '—' },
        { key: 'scripts', label: T('sc.cScripts'), num: true, value: e => e.scripts.length },
        { key: 'sev', label: T('sc.cWorst'), value: e => worstSev(e), render: e => { const w = worstSev(e); return w < 9 ? sevPill(SEVS[w]) : el('span', { class: 'sev good', text: T('sc.clean') }); } },
        { key: 'n', label: T('sc.cFindings'), num: true, value: e => all(e).length },
        act ? { key: 'opened', label: T('sc.cOpened'), num: true, value: e => (act.stats.get(e) || {}).opened || 0 } : null,
        act ? { key: 'submitted', label: T('sc.cSubmitted'), num: true, value: e => { const st = act.stats.get(e) || {}; return (st.submitted || 0) + (st.requests || 0); } } : null,
        act ? { key: 'errors', label: T('sc.cErrors'), num: true, value: e => { const st = act.stats.get(e) || {}; return (st.errors || 0) + (st.failed || 0); } } : null,
        { key: 'enabled', label: T('sc.cEnabled'), value: e => e.enabled ? T('c.yes') : T('c.no') }
      ].filter(Boolean),
      rows: a.entries, pageSize: 50, exportName: 'sa-forms-products', initialSort: { key: 'sev', dir: 1 },
      filters: [{ key: 'type', label: T('sc.cType'), options: ['delegated', 'product'].map(v => ({ value: v, label: T('sc.type.' + v) })), match: (e, v) => e.type === v }],
      search: (e, q) => e.name.toLowerCase().includes(q),
      onRowClick: e => entryDrawer(e, a)
    }));
  }

  function clonesTab(a) {
    const wrap = el('div', { class: 'stack' });
    wrap.appendChild(el('p', { class: 'note', text: T('sc.clonesLead') }));
    if (!a.clusters.length) { wrap.appendChild(el('p', { class: 'note', text: T('sc.noClones') })); return wrap; }
    wrap.appendChild(card(null, null, HR.table.make({
      columns: [
        { key: 'ref', label: T('sc.cReference'), value: c => c.ref.name },
        { key: 'n', label: T('sc.cCopies'), num: true, value: c => c.members.length },
        { key: 'v', label: T('sc.cVariants'), num: true, value: c => c.variants },
        { key: 'min', label: T('sc.cMinSim'), num: true, value: c => Math.round(c.min * 100), render: c => el('span', { text: Math.round(c.min * 100) + '%' }) },
        { key: 'names', label: T('sc.cMembers'), sortable: false, value: c => c.members.map(m => m.name).join(', '),
          render: c => el('span', { class: 'trunc note', title: c.members.map(m => m.name).join('\n'), text: c.members.map(m => m.name).join(', ') }) }
      ],
      rows: a.clusters, pageSize: 25, exportName: 'sa-clones', initialSort: { key: 'n', dir: -1 },
      onRowClick: c => clusterDrawer(c, a)
    })));
    return wrap;
  }

  function scriptsTab(a) {
    return card(null, null, HR.table.make({
      columns: [
        { key: 'name', label: T('sc.cName'), value: s => s.name },
        { key: 'kind', label: T('sc.cKind'), value: s => kindLabel(s.kind) },
        { key: 'lines', label: T('sc.cLines'), num: true, value: s => s.lines },
        { key: 'run', label: T('sc.cRuns'), value: s => s.runInCloud ? T('sc.cloud') : T('sc.agent') },
        { key: 'cluster', label: T('sc.cCluster'), value: s => s.cluster || '' },
        { key: 'sev', label: T('sc.cWorst'), value: s => s.findings.reduce((m, f) => Math.min(m, HR.salint.SEV_ORDER[f.sev]), 9),
          render: s => { const w = s.findings.reduce((m, f) => Math.min(m, HR.salint.SEV_ORDER[f.sev]), 9); return w < 9 ? sevPill(SEVS[w]) : el('span', { class: 'sev good', text: T('sc.clean') }); } },
        { key: 'n', label: T('sc.cFindings'), num: true, value: s => s.findings.length }
      ],
      rows: a.scripts, pageSize: 50, exportName: 'sa-scripts', initialSort: { key: 'sev', dir: 1 },
      filters: [{ key: 'kind', label: T('sc.cKind'), options: ['datasource', 'formtask', 'producttask', 'scheduled'].filter(k => a.scripts.some(s => s.kind === k)).map(k => ({ value: k, label: kindLabel(k) })), match: (s, v) => s.kind === v }],
      search: (s, q) => (s.name + '\n' + s.script).toLowerCase().includes(q),
      searchPlaceholder: T('sc.searchCode'),
      onRowClick: s => scriptDrawer(s, a)
    }));
  }

  function variablesTab(a) {
    const vf = name => a.findings.filter(f => f.target.type === 'variable' && f.target.id === name);
    return card(null, T('sc.varsNote'), HR.table.make({
      columns: [
        { key: 'name', label: T('sc.cName'), render: v => el('span', { class: 'mono', text: v.name }) },
        { key: 'kind', label: T('sc.cKind'), value: v => v.isSystem ? T('sc.vSystem') : v.secret ? T('sc.vSecret') : T('sc.vCustom') },
        { key: 'value', label: T('sc.cValue'), value: v => v.secret ? '•••' : v.empty ? '' : String(v.value),
          render: v => v.secret ? el('span', { class: 'note', text: '•••' }) : v.empty ? el('span', { class: 'pill warn', text: T('sc.empty') }) : el('span', { class: 'trunc mono', title: String(v.value), text: String(v.value) }) },
        { key: 'used', label: T('sc.cUsedBy'), num: true, value: v => v.usedBy.length },
        { key: 'spell', label: T('sc.cSpellings'), sortable: false, value: v => v.spellings.map(x => x.spelling + ' ×' + x.n).join(', ') },
        { key: 'issues', label: T('sc.cIssues'), value: v => vf(v.name).map(f => ruleTitle(f.rule)).join(', '),
          render: v => { const l = vf(v.name); return l.length ? el('span', { class: 'row' }, l.map(f => el('span', { class: 'sev ' + f.sev, text: ruleTitle(f.rule) }))) : el('span', { class: 'note', text: '—' }); } }
      ],
      rows: a.variables, pageSize: 50, exportName: 'sa-variables',
      search: (v, q) => v.name.toLowerCase().includes(q),
      onRowClick: v => { if (v.usedBy.length) { const s = a.scripts.find(x => x.id === v.usedBy[0]); scriptDrawer(s, a); } }
    }));
  }

  function activityTab(a) {
    const act = a.activity;
    const wrap = el('div', { class: 'stack' });
    const w = act.window;
    const auditRows = (HR.app.state.saconfig.cfg.activity.audit || []).length;
    wrap.appendChild(el('p', { class: 'note', text: T('sc.actLead', { d: w.days || '—', n: U.fmtInt(w.rows),
      from: w.from ? U.fmtDate(Date.parse(w.from)).split(',')[0] : '—', to: w.to ? U.fmtDate(Date.parse(w.to)).split(',')[0] : '—' }) }));
    if (!auditRows) wrap.appendChild(el('div', { class: 'notice' }, [el('strong', { text: T('sc.actNoAudit') }), el('span', { text: ' ' + T('sc.actNoAuditBody') })]));
    if (!act.anySubmit) wrap.appendChild(el('p', { class: 'note', text: T('sc.actNoSubmit') }));
    const rows = a.entries.map(e => ({ e, st: act.stats.get(e) || { opened: 0, submitted: 0, requests: 0, errors: 0, failed: 0, lastUse: null, messages: [] } }));
    wrap.appendChild(card(null, null, HR.table.make({
      columns: [
        { key: 'name', label: T('sc.cName'), value: r => r.e.name },
        { key: 'type', label: T('sc.cType'), value: r => T('sc.type.' + r.e.type) },
        { key: 'opened', label: T('sc.cOpened'), num: true, value: r => r.st.opened },
        { key: 'submitted', label: T('sc.cSubmitted'), num: true, value: r => r.st.submitted + r.st.requests },
        { key: 'errors', label: T('sc.cErrors'), num: true, value: r => r.st.errors + r.st.failed,
          render: r => { const n = r.st.errors + r.st.failed; return n ? el('span', { class: 'sev high', text: U.fmtInt(n) }) : el('span', { class: 'note', text: '0' }); } },
        { key: 'last', label: T('sc.cLastUse'), value: r => r.st.lastUse || '', render: r => el('span', { text: r.st.lastUse ? U.fmtDate(Date.parse(r.st.lastUse)).split(',')[0] : '—' }) }
      ],
      rows, pageSize: 50, exportName: 'sa-activity', initialSort: { key: 'errors', dir: -1 },
      search: (r, q) => r.e.name.toLowerCase().includes(q),
      onRowClick: r => entryDrawer(r.e, a)
    })));
    return wrap;
  }

  /* ------------------------------------------------------------------ view */

  function scriptsView(m, params) {
    const f = document.createDocumentFragment();
    const sa = HR.app.state.saconfig;
    f.appendChild(el('div', { class: 'view-head' }, el('div', {}, [el('h1', { text: T('sc.title') }), el('p', { text: T('sc.lead') })])));
    if (!sa) {
      f.appendChild(el('div', { class: 'grid' }, card(T('sc.emptyTitle'), null, el('div', { class: 'stack' }, [
        el('p', { text: T('sc.emptyBody') }),
        el('pre', { class: 'sa-code', text: 'python3 helloid-sa-export.py --log-days 90' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', text: T('sc.emptyImport'), onclick: () => {
            const inp = el('input', { type: 'file', accept: '.json' });
            inp.onchange = () => { if (inp.files[0]) HR.app.importFileAs(inp.files[0], 'saconfig'); };
            inp.click();
          } }),
          el('button', { class: 'btn', text: T('sc.emptySources'), onclick: () => HR.app.go('sources') })
        ])
      ]))));
      return f;
    }
    const a = sa.analysis;
    f.appendChild(tabbed('scripts', [
      { id: 'overview', label: T('sc.tab.overview'), build: () => overviewTab(a) },
      { id: 'findings', label: T('sc.tab.findings'), count: a.findings.length, build: p => findingsTab(a, p) },
      { id: 'entries', label: T('sc.tab.entries'), count: a.entries.length, build: () => entriesTab(a) },
      { id: 'clones', label: T('sc.tab.clones'), count: a.clusters.length, build: () => clonesTab(a) },
      { id: 'scripts', label: T('sc.tab.scripts'), count: a.scripts.length, build: () => scriptsTab(a) },
      { id: 'variables', label: T('sc.tab.variables'), count: a.variables.length, build: () => variablesTab(a) },
      a.activity ? { id: 'activity', label: T('sc.tab.activity'), build: () => activityTab(a) } : null
    ].filter(Boolean), params));
    return f;
  }

  HR.views.scripts = scriptsView;
})(window.HR);

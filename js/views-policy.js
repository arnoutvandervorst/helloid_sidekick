/* The Policies view: the organisation's quality guidelines as adjustable
   thresholds, the score they produce, and per guideline the people and
   accounts behind the number. The engine lives in js/policy.js; this file
   only renders it and writes threshold changes back to the settings. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el;
  const T = (k, p) => HR.i18n.t(k, p);
  const { card, tile, openDrawer, drawerAccount, drawerPermission, drawerVaultPerson,
    personRow, partialNotice } = HR.viewkit;

  const fmtVal = r => r.def.unit === 'pct' ? U.fmtNum(r.value, 1) + '%' : U.fmtInt(r.value);
  const fmtV = (def, v) => v == null ? '\u2014' : (def.unit === 'pct' ? U.fmtNum(v, 1) + '%' : U.fmtInt(v));
  const MOVE_CLASS = { newlyMet: 'ok', improved: 'ok', same: '', worse: 'removed', newlyBroken: 'removed', new: 'muted', gone: 'muted' };

  /** How far a control is from its limit, 0..1: full when met; against an upper limit
      limit ÷ value, against a lower one value ÷ limit; a breached limit of 0 is empty. */
  function kpiScore(row) {
    if (!row.applicable) return null;
    const v = row.value, l = row.threshold;
    if (row.def.dir === 'max') return v <= l + 1e-9 ? 1 : (l <= 0 ? 0 : Math.max(0, Math.min(1, l / v)));
    return v >= l - 1e-9 ? 1 : (l <= 0 ? 0 : Math.max(0, Math.min(1, v / l)));
  }
  /** The control as a ring: today's value inside, the limit under it, colour by what is open. */
  function kpiRing(row) {
    const sc = kpiScore(row);
    const tone = sc === null ? null : row.status === 'met' ? 'good' : row.status === 'accepted' ? 'warn' : (row.def.severity || 'medium');
    const s = HR.viewkit.ring(sc, row.applicable ? fmtVal(row) : '\u2014', T('po.limitIs', { limit: fmtLimit(row) }), { band: tone, min: row.status === 'notMet' ? 0.04 : 0 });
    s.setAttribute('title', row.applicable ? T('po.ringTip', { pct: U.fmtPct(sc, 0) }) : T('po.needs'));
    return s;
  }

  /** This control's movement against the compared data point, if there is one. */
  function movementOf(id) {
    const d = HR.app.state.diff;
    return d && d.controls ? d.controls.rows.find(r => r.id === id) || null : null;
  }

  /** The control's value on every data point, oldest first — null where a point never stored it. */
  function historyOf(id) {
    const snaps = (HR.app.state.snapshots || []).slice().sort((a, b) => (a.dataDate - b.dataDate) || (a.importedAt - b.importedAt));
    if (snaps.length < 2) return null;
    return snaps.map(s => { const c = s.summary && s.summary.controls && s.summary.controls[id]; return c ? c.value : null; });
  }
  const fmtLimit = r => (r.def.dir === 'max' ? '≤ ' : '≥ ') +
    (r.def.unit === 'pct' ? U.fmtNum(r.threshold, 1) + '%' : U.fmtInt(r.threshold));

  function openAffected(m, row) {
    const label = x => x.kind === 'account' ? x.a.userName
      : x.kind === 'perm' ? x.perm.name : (x.person.displayName || x.person.externalId);
    const sub = x => x.kind === 'account' ? (x.a.personName || T('c.unowned'))
      : x.kind === 'perm' ? x.perm.system : T('c.person');
    openDrawer(el('div', {}, [
      el('div', { text: T('po.p.' + row.def.id) }),
      el('span', { class: 'note', text: T('po.affectedHead', { n: row.affected.length }) })
    ]), el('div', { class: 'stack' }, HR.table.make({
      columns: [
        { key: 'label', label: T('po.cWho'), value: label },
        { key: 'sub', label: T('po.cContext'), value: sub }
      ],
      rows: row.affected, pageSize: 15, exportName: 'policy-' + row.def.id,
      search: (x, q) => (label(x) + ' ' + sub(x)).toLowerCase().includes(q),
      onRowClick: x => {
        if (x.kind === 'account') drawerAccount(x.a);
        else if (x.kind === 'perm') drawerPermission(x.perm, m);
        else drawerVaultPerson(personRow(m, x.person), m);
      }
    })));
  }

  let OPEN_CTL = null;
  function change(m, id, patch) {
    HR.policy.set(id, patch);
    delete m._policy;
    /* The summary carries the score into snapshots and deltas; keep it current. */
    try { Object.assign(m.summary, HR.policy.summaryOf(m)); HR.model.governance(m.summary); } catch (e) { /* not scoreable yet */ }
    HR.app.updateTopbar && HR.app.updateTopbar();
    HR.app.render();
    /* The control's drawer, if it is open, shows the edit at once. */
    if (OPEN_CTL === id) openControl(m, id);
  }

  /** One control in full — what it means, the articles, the affected, the fold — in a drawer. */
  function openControl(m, id) {
    const row = HR.policy.evaluate(m).rows.find(r => r.def.id === id);
    if (!row) return;
    OPEN_CTL = id;
    const head = el('div', {}, [
      el('h2', {}, [el('span', { class: 'sev ' + (row.def.severity || 'medium') }), document.createTextNode(' ' + T('po.p.' + id))]),
      el('p', { class: 'note', text: T('po.p.' + id + '.d') })
    ]);
    openDrawer(head, el('div', { class: 'stack ctl-drawer' }, policyLine(m, row)));
  }

  /** The card: ring, status, articles, title, what it means, the affected — the row's summary. */
  function policyCard(m, row) {
    const id = row.def.id;
    const status = !row.applicable
      ? el('span', { class: 'pill muted', text: T('po.needs') })
      : !row.on ? el('span', { class: 'pill muted', text: T('po.off') })
      : el('span', { class: 'pill ' + (row.status === 'met' ? 'ok' : row.status === 'accepted' ? 'warn' : 'removed'), text: T('po.status.' + row.status) });
    const refs = HR.policy.FRAMEWORKS.filter(k => row.def.refs && row.def.refs[k]).map(k => fwLabel[k] + ' ' + row.def.refs[k]).join(' \u00b7 ');
    const mv = movementOf(id);
    const open = () => openControl(m, id);
    const c = el('article', { class: 'card k-card' + (row.applicable && row.on && row.status === 'notMet' ? ' open' : ''), tabindex: '0', onclick: open, onkeydown: e => { if (e.key === 'Enter') open(); } }, [
      kpiRing(row),
      el('div', { class: 'k-body' }, [
        el('div', { class: 'k-top' }, [status, el('span', { class: 'k-refs mono', text: refs })]),
        el('h3', { text: T('po.p.' + id) }),
        el('p', { class: 'note', text: T('po.p.' + id + '.d') }),
        el('div', { class: 'k-foot' }, [
          row.applicable && row.affected.length
            ? el('a', { href: '#', text: T('po.affectedN', { n: U.fmtInt(row.affected.length) }) + ' \u2192', onclick: e => { e.preventDefault(); e.stopPropagation(); openAffected(m, row); } })
            : el('span', {}),
          el('span', { class: 'note' }, [
            mv && mv.was ? el('span', { class: 'pill ' + MOVE_CLASS[mv.movement], text: T('tr.mv.' + mv.movement), style: 'margin-right:6px' }) : null,
            document.createTextNode(T('po.owner') + ' ' + (row.owner || '\u2014') + ' \u00b7 ' + T('po.due') + ' ' + (row.due || '\u2014'))
          ].filter(Boolean))
        ])
      ])
    ]);
    return c;
  }

  const fwLabel = { nis2: 'NIS2', iso27001: 'ISO 27001', bio: 'BIO 2.0' };
  const refPills = (def, onclick) => Object.keys(def.refs || {}).map(fw =>
    el('button', { class: 'pill mono' + (onclick ? ' clickable' : ''), title: T('po.fw.' + fw), text: fwLabel[fw] + ' ' + def.refs[fw], onclick }));

  /* "Show framework references" is a reading preference, kept per browser. */
  const SHOW_REFS = 'policy.showRefs';
  const showRefs = () => { try { return localStorage.getItem(SHOW_REFS) === '1'; } catch (e) { return false; } };
  const setShowRefs = on => { try { localStorage.setItem(SHOW_REFS, on ? '1' : '0'); } catch (e) { /* private window */ } };

  /** What the articles ask and how this control evidences them. */
  function refsBlock(def) {
    const ev = HR.frameworks.evidenceOf(def);
    return el('div', { class: 'ctl-fwtext' }, [
      ev ? el('p', {}, [el('strong', { text: T('po.fwEvidence') + ' ' }), document.createTextNode(ev)]) : null
    ].concat(HR.frameworks.refsOf(def).map(r => el('div', { class: 'fw-ref' }, [
      el('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, [
        el('span', { class: 'mono', text: r.label + ' ' + r.ref }),
        el('strong', { text: r.title }),
        el('span', { class: 'fw-tag', text: T(r.official ? 'po.fwOfficial' : 'po.fwDescribed') }),
        r.source ? el('a', { href: r.source, target: '_blank', rel: 'noopener noreferrer', class: 'note', text: T('po.fwSource') }) : null
      ].filter(Boolean)),
      el('p', { class: 'fw-about', text: r.about })
    ]))).filter(Boolean));
  }

  /* Accepting a failing control as a known risk: until when, by whom, why. */
  function exceptionForm(m, row) {
    const ex = row.exception || {};
    const until = el('input', { type: 'date', value: ex.until || '' });
    const by = el('input', { type: 'text', value: ex.by || '', placeholder: T('po.exBy') });
    const why = el('input', { type: 'text', value: ex.why || '', placeholder: T('po.exWhy') });
    why.style.minWidth = '260px';
    const save = el('button', { class: 'btn sm primary', text: T('c.save'), onclick: () => {
      if (!until.value) return;
      change(m, row.def.id, { exception: { until: until.value, by: by.value.trim(), why: why.value.trim() } });
    } });
    const clear = el('button', { class: 'btn sm ghost', text: T('po.exClear'),
      onclick: () => change(m, row.def.id, { exception: null }) });
    return el('div', { class: 'slot-actions', style: 'margin-top:6px' }, [
      el('span', { class: 'note', text: T('po.exTitle') }),
      el('label', { class: 'inline' }, [document.createTextNode(T('po.exUntil')), until]),
      by, why, save, row.exception ? clear : null
    ].filter(Boolean));
  }

  /* One control, three columns: what it is and why; where we stand against the limit;
     who owns it and by when. Editing (limit, switch, owner, due, exception) folds
     behind one link so the page reads as a scorecard, not a form. */
  function policyLine(m, row) {
    const id = row.def.id;
    const wrap = el('div', { class: 'ctl' + (row.applicable && row.on && row.status === 'notMet' ? ' open' : '') });

    /* --- column 1: what --- */
    const status = !row.applicable
      ? el('span', { class: 'pill muted', text: T('po.needs') })
      : !row.on ? el('span', { class: 'pill muted', text: T('po.off') })
      : el('span', { class: 'pill ' + (row.status === 'met' ? 'ok' : row.status === 'accepted' ? 'warn' : 'removed'),
          text: T('po.status.' + row.status) });
    const what = el('div', { class: 'ctl-what' }, [
      el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
        status,
        el('span', { class: 'sev ' + (row.def.severity || 'medium'), title: T('po.sev.' + (row.def.severity || 'medium')) }),
        el('strong', { text: T('po.p.' + id) })
      ]),
      el('p', { class: 'note ctl-desc', text: T('po.p.' + id + '.d') }),
      el('div', { class: 'ctl-refs' }, refPills(row.def, () => { block.hidden = !block.hidden; }))
    ]);
    const block = refsBlock(row.def);
    block.hidden = !showRefs();
    what.appendChild(block);
    if (!row.applicable) {
      what.appendChild(el('p', { class: 'note', text: T('po.needsNote', { list: row.missing.map(n => T('po.need.' + n)).join(', ') }) }));
    }
    if (row.applicable && row.on && row.status === 'notMet') {
      what.appendChild(el('p', { class: 'note ctl-fix' }, [
        el('span', { class: 'sev medium', text: T('po.improve') }),
        document.createTextNode(' ' + T('po.p.' + id + '.fix'))
      ]));
    }
    if (row.applicable && row.status === 'accepted') {
      what.appendChild(el('p', { class: 'note ctl-fix', text: T('po.exAccepted', {
        until: row.exception.until, by: row.exception.by || '—', why: row.exception.why || '—' }) }));
    }

    /* --- column 2: now vs limit --- */
    const stand = el('div', { class: 'ctl-stand' });
    stand.appendChild(kpiRing(row));
    if (row.applicable) {
      if (row.affected.length) {
        stand.appendChild(el('a', { href: '#', class: 'ctl-affected', text: T('po.affectedN', { n: U.fmtInt(row.affected.length) }),
          onclick: e => { e.preventDefault(); openAffected(m, row); } }));
      }
      /* --- the trend: against the compared data point, and over all of them --- */
      const mv = movementOf(id);
      const hist = historyOf(id);
      if (mv && mv.was) {
        stand.appendChild(el('div', { class: 'ctl-trend' }, [
          el('span', { class: 'pill ' + MOVE_CLASS[mv.movement], text: T('tr.mv.' + mv.movement) }),
          el('span', { class: 'note', text: T('tr.wasNow', { was: fmtV(row.def, mv.was.value), now: fmtV(row.def, mv.now ? mv.now.value : null) }) })
        ]));
      }
      if (hist && hist.some(v => v != null)) {
        const sp = HR.charts.spark(hist, { limit: row.threshold, color: row.met ? 'var(--good)' : 'var(--critical)' });
        sp.setAttribute('title', T('tr.sparkTip', { n: hist.filter(v => v != null).length, total: hist.length }));
        stand.appendChild(el('div', { class: 'ctl-spark' }, sp));
      }
    }

    /* --- column 3: who, by when, and the fold --- */
    const who = el('div', { class: 'ctl-who' });
    who.appendChild(el('div', { class: 'ctl-kv' }, [
      el('span', { class: 'note', text: T('po.owner') }),
      el('span', { text: row.owner || '—' })
    ]));
    who.appendChild(el('div', { class: 'ctl-kv' }, [
      el('span', { class: 'note', text: T('po.due') }),
      el('span', { text: row.due || '—' })
    ]));
    /* Where to go: the finding itself when it fired, else the page the control reads from. */
    const fired = row.def.finding && m.findings.some(f => f.id === row.def.finding);
    if (fired) {
      who.appendChild(el('a', { href: '#', class: 'note', text: T('po.seeFinding') + ' \u2192',
        onclick: e => { e.preventDefault(); HR.app.go('risk', { tab: 'findings', finding: row.def.finding }); } }));
    } else if (row.def.goto) {
      const g = row.def.goto;
      const tab = g.params && g.params.tab;
      /* The tab's own label, from whichever view owns it. */
      const tabKey = tab && [g.view === 'org' ? 'org.tab.' + tab : null, g.view === 'audit' ? 'au.tab.' + tab : null,
        g.view === 'risk' ? (tab === 'toxic' ? 'sod.tab' : 'rk.tab.' + tab) : null].find(k => k && HR.i18n.has(k));
      who.appendChild(el('a', { href: '#', class: 'note', text: T('po.open') + ' \u2192',
        title: T('nav.' + g.view) + (tabKey ? ' \u203a ' + T(tabKey) : ''),
        onclick: e => { e.preventDefault(); HR.app.go(g.view, Object.assign({}, g.params || {})); } }));
    }
    const editor = el('div', { class: 'ctl-edit', hidden: true });
    const editLink = el('a', { href: '#', class: 'note', text: T('po.edit') + ' ▾', onclick: e => {
      e.preventDefault(); editor.hidden = !editor.hidden;
      editLink.textContent = T('po.edit') + (editor.hidden ? ' ▾' : ' ▴');
    } });
    who.appendChild(editLink);
    wrap.append(what, stand, who);

    /* --- the fold: limit, switch, owner, due, exception, log --- */
    const tIn = el('input', { type: 'number', min: 0, step: row.def.unit === 'pct' ? 0.5 : 1, value: row.threshold });
    tIn.style.width = '72px';
    tIn.onchange = () => change(m, id, { t: Math.max(0, +tIn.value || 0) });
    const controls = el('div', { class: 'slot-actions' }, [
      el('label', { class: 'inline' }, [document.createTextNode(T('po.limitLabel')), tIn,
        document.createTextNode(row.def.unit === 'pct' ? '%' : '')]),
      el('span', { class: 'note', text: T('po.defaultIs', { v: row.def.unit === 'pct' ? U.fmtNum(row.def.def, 1) + '%' : U.fmtInt(row.def.def) })
        + (row.def.paramDef !== undefined ? ' \u00b7 ' + T('po.paramLabel.' + id) + row.def.paramDef : '') })
    ]);
    if (row.def.paramDef !== undefined) {
      const pIn = el('input', { type: 'number', min: 1, step: 1, value: row.param });
      pIn.style.width = '64px';
      pIn.onchange = () => change(m, id, { p: Math.max(1, Math.round(+pIn.value || 1)) });
      controls.appendChild(el('label', { class: 'inline' }, [document.createTextNode(T('po.paramLabel.' + id)), pIn]));
    }
    const onIn = el('input', { type: 'checkbox' });
    onIn.checked = row.on;
    onIn.onchange = () => change(m, id, { on: onIn.checked });
    controls.appendChild(el('label', { class: 'inline' }, [onIn, document.createTextNode(T('po.countLabel'))]));
    const owner = el('input', { type: 'text', value: row.owner || '', placeholder: T('po.owner') });
    owner.style.width = '150px';
    owner.onchange = () => change(m, id, { owner: owner.value.trim() });
    const due = el('input', { type: 'date', value: row.due || '' });
    due.onchange = () => change(m, id, { due: due.value });
    controls.append(
      el('label', { class: 'inline' }, [document.createTextNode(T('po.owner')), owner]),
      el('label', { class: 'inline' }, [document.createTextNode(T('po.due')), due])
    );
    editor.appendChild(controls);
    if (row.applicable && (row.status === 'notMet' || row.status === 'accepted')) editor.appendChild(exceptionForm(m, row));
    if (row.changes && row.changes.length) {
      const last = row.changes[row.changes.length - 1];
      editor.appendChild(el('p', { class: 'note', style: 'margin:4px 0 0', title: row.changes.slice(-5).map(c =>
        c.at.slice(0, 10) + ' ' + c.field + ': ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to)).join('\n'),
        text: T('po.lastChange', { at: last.at.slice(0, 10), field: last.field }) }));
    }
    wrap.appendChild(editor);
    return wrap;
  }

  /** The whole scorecard as one file: what an audit takes away. */
  function scorecardRows(ev) {
    return ev.rows.map(r => ({
      id: r.def.id, control: T('po.p.' + r.def.id), severity: r.severity || r.def.severity || '',
      nis2: (r.def.refs || {}).nis2 || '', iso27001: (r.def.refs || {}).iso27001 || '', bio: (r.def.refs || {}).bio || '',
      refTitles: HR.frameworks.refsOf(r.def).map(x => x.label + ' ' + x.ref + ' ' + x.title).join('; '),
      evidence: HR.frameworks.evidenceOf(r.def),
      value: r.applicable ? (r.def.unit === 'pct' ? U.fmtNum(r.value, 1) + '%' : U.fmtInt(r.value)) : '',
      limit: fmtLimit(r), status: r.applicable ? (r.on ? r.status : 'off') : 'waiting',
      owner: r.owner || '', due: r.due || '',
      exceptionUntil: r.exception ? r.exception.until : '', exceptionBy: r.exception ? r.exception.by : '', exceptionWhy: r.exception ? r.exception.why : '',
      affected: r.applicable ? r.affected.length : ''
    }));
  }

  /* ---- scorecards: the ring, the bars, one card per framework ---------------- */
  const bandOf = score => score >= 0.9 ? 'good' : score >= 0.6 ? 'medium' : 'critical';
  /** The score as a ring: the weighted share met, the points under it. */
  const ring = (score, points, total, size) => HR.viewkit.ring(score, U.fmtPct(score, 0), T('po.sc.pts', { n: U.fmtNum(points, 0), of: U.fmtNum(total, 0) }), { band: bandOf(score), size });
  function bar(label, n, of, tone) {
    const pct = of ? 100 * n / of : 0;
    return el('div', { class: 'sc-bar' }, [
      el('div', { class: 'sc-row' }, [el('b', { text: label }), el('span', { class: 'mono note' }, [el('strong', { text: U.fmtInt(n) }), document.createTextNode(' ' + T('po.sc.of', { of: U.fmtInt(of) }))])]),
      el('div', { class: 'sc-track' }, el('i', { class: tone || '', style: 'width:' + pct.toFixed(1) + '%' }))
    ]);
  }
  /** Since the compared data point, for the controls this card covers. */
  function movementLine(st) {
    const d = HR.app.state.diff;
    if (!d || !d.controls) return T('po.sc.noCompare');
    const ids = new Set(st.rows.map(r => r.def.id));
    const rows = d.controls.rows.filter(r => r.on && ids.has(r.id));
    const n = mv => rows.filter(r => r.movement === mv).length;
    const bits = [];
    if (n('newlyMet')) bits.push(U.fmtInt(n('newlyMet')) + ' ' + T('tr.mv.newlyMet'));
    if (n('newlyBroken')) bits.push(U.fmtInt(n('newlyBroken')) + ' ' + T('tr.mv.newlyBroken'));
    if (n('improved')) bits.push(U.fmtInt(n('improved')) + ' ' + T('tr.mv.improved'));
    if (n('worse')) bits.push(U.fmtInt(n('worse')) + ' ' + T('tr.mv.worse'));
    return bits.length ? bits.join(' \u00b7 ') : T('df.noChange');
  }
  function scorecard(m, fw, opts) {
    const st = HR.policy.frameworkStats(m, fw);
    const gs = m.summary;
    const title = st.theme ? T('po.theme.' + st.theme) : fw ? st.meta.name : T('po.sc.all');
    const kicker = st.theme ? T('po.theme.' + st.theme + '.k', { n: U.fmtInt(st.rows.length) }) : fw ? st.meta.kicker : T('po.sc.allKicker', { date: (() => { const cur = HR.app.state.snapshots.find(x => x.id === HR.app.state.currentSnapshotId); return cur ? U.fmtDate(cur.dataDate || cur.importedAt).split(',')[0] : '\u2014'; })() });
    const open = () => HR.app.go('policies', { tab: 'kpis', fw });
    const c = el('section', { class: 'card sc-card' + (opts && opts.detail ? ' detail' : ''), tabindex: '0', onclick: opts && opts.detail ? null : open, onkeydown: e => { if (e.key === 'Enter' && !(opts && opts.detail)) open(); } }, [
      el('div', { class: 'sc-kicker', text: kicker }),
      el('h2', {}, [
        opts && opts.detail ? document.createTextNode(title) : el('a', { href: '#', text: title, onclick: e => { e.preventDefault(); open(); } }),
        document.createTextNode(' '),
        st.criticalOpen ? el('span', { class: 'pill removed', text: T('po.sc.criticalOpen', { n: U.fmtInt(st.criticalOpen) }) })
          : st.critical ? el('span', { class: 'pill ok', text: T('po.sc.criticalAllMet') }) : null
      ]),
      el('div', { class: 'sc-ringwrap' }, [el('div', { class: 'sc-cap', text: T('po.sc.score') }), ring(st.score, st.points, st.total, opts && opts.detail ? 'lg' : '')]),
      el('div', { class: 'sc-meta' }, [
        el('span', {}, [document.createTextNode(st.theme ? T('po.sc.frameworks') : fw ? T('po.sc.cited') : T('gs.title')),
          el('b', { text: st.theme ? (U.uniq(st.rows.flatMap(r => Object.keys(r.def.refs || {}))).map(k => fwLabel[k]).join(' \u00b7 ') || '\u2014') : fw ? (st.cites.join(' \u00b7 ') || '\u2014') : (gs.governanceScore == null ? '\u2014' : gs.governanceScore + ' / 100') })]),
        el('span', {}, [document.createTextNode(T('po.sc.since')), el('b', { text: movementLine(st) })])
      ]),
      el('div', { class: 'sc-bars' }, [
        bar(T('po.sc.controlsMet'), st.met, st.evaluated, ''),
        bar(T('po.sc.criticalMet'), st.criticalMet, st.critical, st.criticalMet < st.critical ? 'crit' : 'good'),
        bar(T('po.sc.owned'), st.owned, st.evaluated, 'good')
      ]),
      el('div', { class: 'sc-foot' }, [
        el('span', { text: T('po.sc.waiting', { n: U.fmtInt(st.waiting) }) }),
        st.worst.length ? el('span', { text: T('po.sc.worst', { list: st.worst.map(r => T('po.p.' + r.def.id)).join(', ') }) }) : el('span', { text: T('po.sc.nothingOpen') }),
        opts && opts.detail ? null : el('a', { href: '#', text: T('po.sc.open'), onclick: e => { e.preventDefault(); e.stopPropagation(); open(); } })
      ])
    ]);
    return c;
  }
  function scorecardsTab(m) {
    const wrap = el('div', {});
    wrap.appendChild(el('h3', { class: 'sc-h', text: T('po.sc.byFramework') }));
    wrap.appendChild(el('div', { class: 'grid g2 sc-grid' }, [''].concat(HR.policy.FRAMEWORKS).map(fw => scorecard(m, fw))));
    /* Themes: the question a reader asks, across frameworks. */
    wrap.appendChild(el('h3', { class: 'sc-h', style: 'margin-top:18px', text: T('po.sc.byTheme') }));
    wrap.appendChild(el('div', { class: 'grid g3 sc-grid' }, Object.keys(HR.policy.THEMES).map(id => scorecard(m, 'theme:' + id))));
    wrap.appendChild(el('p', { class: 'note', style: 'margin-top:10px', text: T('po.sc.foot') }));
    return wrap;
  }

  function policiesView(m, params) {
    params = params || {};
    const f = document.createDocumentFragment();
    f.appendChild(el('div', { class: 'view-head' }, el('div', {}, [
      el('h1', { text: T('po.title') }),
      el('p', { text: T('po.lead') })
    ])));

    if (!m || !m.summary) {
      const note = partialNotice(['recon']);
      if (note) f.appendChild(note);
      f.appendChild(card(null, null, el('p', { text: T('po.empty') })));
      return f;
    }

    const ev = HR.policy.evaluate(m);
    const s = ev.summary;
    const score = s.score;
    /* Thin classification makes every category-based KPI weak: say so before the score. */
    if (m.summary.classified < 0.7) {
      f.appendChild(el('div', { class: 'notice' }, [
        el('span', { text: T('st.classifiedWeak', { pct: U.fmtPctFloor(m.summary.classified), p: U.fmtInt(m.summary.unclassifiedPermissions), a: U.fmtInt(m.summary.unclassifiedAccounts) }) + ' ' }),
        el('a', { href: '#', text: T('wz.stOpen'), onclick: e => { e.preventDefault(); HR.app.go('classify'); } })
      ]));
    }
    /* The same headline as everywhere else leads; the controls share is its second half. */
    const gs = m.summary;
    const gsSev = { good: 'good', watch: 'medium', poor: 'critical' }[gs.governanceBand] || 'medium';
    const diffGs = HR.app.state.diff && HR.app.state.diff.summary.governanceScore;
    f.appendChild(el('div', { class: 'grid g5', style: 'margin-bottom:14px' }, [
      tile(T('gs.title'), gs.governanceScore == null ? '\u2014' : String(gs.governanceScore),
        gs.governancePartial ? T('gs.footPartial', { risk: gs.riskScore }) : T('gs.foot', { risk: gs.riskScore, pct: U.fmtPct(score, 0) }),
        { severity: gsSev, delta: diffGs, inverse: true, onClick: () => HR.app.go('overview') }),
      tile(T('po.kScore'), U.fmtPct(score, 0),
        T('po.kScoreFoot', { passed: s.passed, n: s.evaluated }) + ' \u00b7 ' + T('po.kScoreWeighted') + ' \u00b7 ' + T('gs.halfOfShort'),
        { small: true, severity: score >= 1 ? 'good' : score >= 0.7 ? 'medium' : 'high', delta: HR.app.state.diff && HR.app.state.diff.summary.policyScore
          ? { change: Math.round(100 * HR.app.state.diff.summary.policyScore.change) } : undefined, deltaFormat: v => v + 'pp', inverse: true }),
      tile(T('po.kCritical'), U.fmtInt(s.criticalOpen),
        s.worstOpen ? T('po.kCriticalFoot', { control: T('po.p.' + s.worstOpen.def.id) }) : T('po.kCriticalNone'),
        { severity: s.criticalOpen ? 'critical' : 'good', small: true }),
      tile(T('po.kAccepted'), U.fmtInt(s.accepted),
        s.nextExpiry ? T('po.kAcceptedFoot', { until: s.nextExpiry }) : T('po.kAcceptedNone'),
        { severity: s.accepted ? 'medium' : 'good', small: true }),
      tile(T('po.kWaiting'), U.fmtInt(ev.rows.filter(r => !r.applicable).length),
        T('po.kWaitingFoot'), { small: true })
    ]));

    /* Two tabs: the scorecards, and the KPI list — which, filtered to a framework,
       opens with that framework's own ring. */
    const kpis = document.createDocumentFragment();
    const fw = (HR.app.state.params && HR.app.state.params.fw) || '';
    const themeId = fw.startsWith('theme:') ? fw.slice(6) : null;
    if (fw && (HR.policy.FRAMEWORK_META[fw] || (themeId && HR.policy.THEMES[themeId]))) kpis.appendChild(el('div', { style: 'margin-bottom:14px' }, scorecard(m, fw, { detail: true })));
    const chips = el('div', { class: 'slot-actions', style: 'margin-bottom:8px' },
      [['', T('c.all')]].concat(HR.policy.FRAMEWORKS.map(k => [k, fwLabel[k]])).concat(Object.keys(HR.policy.THEMES).map(k => ['theme:' + k, T('po.theme.' + k)])).map(([k, label]) =>
        el('button', { class: 'btn sm' + (fw === k ? ' primary' : ''), text: label,
          onclick: () => HR.app.go('policies', { tab: 'kpis', fw: k }) })));
    chips.appendChild(el('button', { class: 'btn sm' + (showRefs() ? ' primary' : ''), text: T(showRefs() ? 'po.hideRefs' : 'po.showRefs'),
      onclick: () => { setShowRefs(!showRefs()); HR.app.render(); } }));
    chips.appendChild(el('span', { class: 'spacer' }));
    chips.appendChild(el('button', { class: 'btn sm', text: T('po.exportScorecard'), onclick: () => {
      U.download('compliance-scorecard.csv', U.toCSV(scorecardRows(ev)), 'text/csv;charset=utf-8');
      HR.usage.exported('compliance-scorecard');
    } }));
    chips.appendChild(el('button', { class: 'btn sm ghost', text: 'JSON', onclick: () => {
      U.download('compliance-scorecard.json', JSON.stringify({ generatedAt: new Date().toISOString(),
        score: s.score, passed: s.passed, evaluated: s.evaluated, bySeverity: s.bySeverity, rows: scorecardRows(ev) }, null, 2), 'application/json');
      HR.usage.exported('compliance-scorecard-json');
    } }));

    /* Since the compared data point: which way the KPIs went. Chips narrow the list. */
    const d = HR.app.state.diff, mvFilter = (HR.app.state.params && HR.app.state.params.move) || '';
    if (d && d.controls) {
      const base = HR.app.state.snapshots.find(s => s.id === HR.app.state.baselineId);
      const strip = el('div', { class: 'slot-actions', style: 'margin-bottom:8px;align-items:center' }, [
        el('span', { class: 'note', text: T('tr.since', { date: base ? U.fmtDate(base.dataDate || base.importedAt).split(',')[0] : '\u2014' }) })
      ].concat(['newlyMet', 'improved', 'worse', 'newlyBroken'].map(mvk => el('button', {
        class: 'btn sm' + (mvFilter === mvk ? ' primary' : ''), text: U.fmtInt(d.controls[mvk]) + ' ' + T('tr.mv.' + mvk),
        onclick: () => HR.app.go('policies', { tab: 'kpis', fw, move: mvFilter === mvk ? '' : mvk }) }))));
      kpis.appendChild(card(null, null, strip));
    }
    /* Critical first, then the rest; inside a group, failing before passing. */
    const shown = ev.rows.filter(r => !fw || (themeId ? (HR.policy.THEMES[themeId] || { controls: [] }).controls.includes(r.def.id) : (r.def.refs && r.def.refs[fw])))
      .filter(r => !mvFilter || (movementOf(r.def.id) || {}).movement === mvFilter);
    const groups = HR.policy.SEVERITIES.map(sev => ({ sev, rows: shown.filter(r => (r.def.severity || 'medium') === sev)
      .sort((a, b) => (a.status === 'notMet' ? 0 : 1) - (b.status === 'notMet' ? 0 : 1)) })).filter(g => g.rows.length);
    kpis.appendChild(card(T('po.cardTitle'), T('po.cardNote'), [chips].concat(groups.map(g => el('div', {}, [
      el('h3', { style: 'margin:14px 0 4px' }, [el('span', { class: 'sev ' + g.sev, text: T('po.sev.' + g.sev) }),
        document.createTextNode(' ' + T('po.groupFoot', { n: U.fmtInt(g.rows.length), open: U.fmtInt(g.rows.filter(r => r.applicable && r.on && r.status === 'notMet').length) }))]),
      el('div', { class: 'k-grid' }, g.rows.map(row => policyCard(m, row)))
    ])))));
    kpis.appendChild(el('p', { class: 'note', style: 'margin-top:10px', text: T('po.foot') }));

    /* A framework chip or a scorecard opens the KPI tab; the tab remembers the filter. */
    const tabParams = Object.assign({}, params, { tab: params.tab || (fw || params.move ? 'kpis' : 'scorecards') });
    f.appendChild(HR.viewkit.tabbed('policies', [
      { id: 'scorecards', label: T('po.tab.scorecards'), build: p => scorecardsTab(m, p) },
      { id: 'kpis', label: T('po.tab.kpis'), count: s.evaluated - s.passed, build: () => kpis }
    ], tabParams));
    return f;
  }

  HR.views.policies = policiesView;
  HR.views.policyRing = ring;
  HR.views.kpiRing = kpiRing;
  HR.views.kpiScore = kpiScore;
  HR.views.policyShowRefs = showRefs;
})(window.HR);

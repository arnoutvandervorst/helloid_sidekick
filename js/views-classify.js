/* The classification workbench: the rules are the engine, the fallout is the work list.

   Recognition rows (js/hints.js) decide categories and account types. This page shows
   what each rule catches and which rule wins, what falls through to the fallback, and
   lets the reader tighten a rule, add one from a selection, or overrule a single name.
   Everything is a draft until "Save & re-score": the table previews the draft's answer
   on every row so a rule edit shows its effect at once, without a rebuild per keystroke.

   Older answers from the wizard (a category or type per mined family) keep working and
   show as "family answer", convertible to a rule or forgotten. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el;
  const T = (k, p) => HR.i18n.t(k, p);
  const { card, tile, tabbed, openDrawer, closeDrawer } = HR.viewkit;

  /* ---- the draft: what the page edits, applied on save ----------------------- */
  /* The draft remembers what the saved settings looked like when it was taken, per
     field, and which fields the reader touched. Save writes only those fields, so an
     edit made meanwhile in Settings › Recognition or the wizard to another field
     survives; a clash on the same field is asked about, never silently overwritten. */
  const FIELDS = ['hints', 'catOverrides', 'clsOverrides', 'catFamilies', 'clsFamilies'];
  const savedField = (cfg, f) => f === 'hints'
    ? { categories: HR.hints.rowsFor('categories'), classes: HR.hints.rowsFor('classes') }
    : (cfg[f] || {});
  const sig = v => JSON.stringify(v);
  let DRAFT = null;
  function fresh() {
    const cfg = HR.config.get();
    const d = { dirty: false, touched: new Set(), base: {} };
    FIELDS.forEach(f => { d[f] = HR.config.clone(savedField(cfg, f)); d.base[f] = sig(savedField(cfg, f)); });
    return d;
  }
  function draft() {
    /* An untouched draft follows the saved settings; it is only a cache until edited. */
    if (DRAFT && !DRAFT.dirty) {
      const cfg = HR.config.get();
      if (FIELDS.some(f => sig(savedField(cfg, f)) !== DRAFT.base[f])) DRAFT = null;
    }
    if (!DRAFT) DRAFT = fresh();
    return DRAFT;
  }
  const touch = field => { const d = draft(); d.dirty = true; d.touched.add(field); };

  async function save() {
    const d = draft(), cfg = HR.config.get();
    const clashed = Array.from(d.touched).filter(f => sig(savedField(cfg, f)) !== d.base[f]);
    if (clashed.length && !confirm(T('cw.clash'))) return;
    d.touched.forEach(f => { cfg[f] = HR.config.clone(d[f]); });
    if (d.touched.has('hints')) ['categories', 'classes'].forEach(k => (cfg.hints[k] || []).forEach(r => { delete r._new; }));
    HR.config.save(cfg);
    DRAFT = null;
    await HR.app.rebuildBusy();
    U.toast(T('cw.saved'), 3000);
    HR.app.render();
  }
  function discard() { DRAFT = null; HR.app.render(); }
  /* Leaving the page with unsaved rule edits asks first. */
  window.addEventListener('beforeunload', e => { if (DRAFT && DRAFT.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- the preview: the draft's answer for one name ---------------------------- */
  /* The same resolver the model build uses (js/classify.js), handed the draft — so
     what this page shows is what Save will produce. */
  const fallbackCat = cfg => HR.classify.permission({ name: '' }, { cfg, rows: [], overrides: {}, families: {}, signals: false }).def;
  const classifyPerm = (p, d, cfg) => HR.classify.permission(p,
    { cfg, rows: d.hints.categories, overrides: d.catOverrides, families: d.catFamilies });
  const classifyAcc = (a, d, cfg) => HR.classify.account(a,
    { cfg, rows: d.hints.classes, overrides: d.clsOverrides, families: d.clsFamilies });

  /* ---- shared pieces ------------------------------------------------------------- */
  const ruleLabel = (row, i) => (i + 1) + ' · ' + T('st.hintOp.' + (row.op || 'starts')) + ' ' + String(row.t || '').split(',').map(s => s.trim()).filter(Boolean).join(', ');
  const decidedBy = (r, rows) => r.source === 'auto' && rows[r.rule]
    ? T('cw.byRule', { rule: ruleLabel(rows[r.rule], r.rule) })
    : r.source === 'signal' ? T('cw.bySignal', { what: T('cw.sig.' + r.signal) })
    : T('cw.by.' + r.source);

  /** The word most of the selected names share — the seed of a new rule. */
  function proposeRule(names, kind) {
    const counts = new Map();
    names.forEach(n => U.uniq(HR.hints.wordsOf(n)).forEach(w => { if (w.length >= 2) counts.set(w, (counts.get(w) || 0) + 1); }));
    const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    if (best && best[1] >= Math.max(2, Math.ceil(names.length * 0.6))) return { op: 'word', t: best[0], covers: best[1] };
    /* No common word: the common prefix of the first words, if there is one. */
    const firsts = names.map(n => (HR.hints.wordsOf(n)[0] || '').toLowerCase()).filter(Boolean);
    let prefix = firsts[0] || '';
    firsts.forEach(f => { while (prefix && !f.startsWith(prefix)) prefix = prefix.slice(0, -1); });
    if (prefix.length >= 2) return { op: kind === 'classes' ? 'edge' : 'starts', t: prefix, covers: firsts.length };
    return null;
  }

  /* The rules card: live rows, hit/win counts against the draft, order controls. */
  function rulesCard(kind, items, nameOf, targets, targetLabel, results, onChange) {
    const d = draft();
    const rows = d.hints[kind];
    const cfg = HR.config.get();
    const hitsOf = i => kind === 'categories'
      ? items.filter(p => HR.hints.matchesRow(rows[i], nameOf(p))).length
      : items.filter(a => { const co = HR.classify.cohortKeyOf(a.userName, rows); return co && HR.hints.tokens(rows[i]).includes(co.slice(2)); }).length;
    const winsOf = i => results.filter(r => r.res.source === 'auto' && r.res.rule === i).length;
    const body = el('div', {});
    const t = el('table', { class: 'tbl' });
    t.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { class: 'no-sort', text: '#' }),
      el('th', { class: 'no-sort', text: T('st.hintOp') }),
      el('th', { class: 'no-sort', text: T('st.hintWords') }),
      el('th', { class: 'no-sort', text: targetLabel }),
      el('th', { class: 'no-sort num', text: T('cw.hits') }),
      el('th', { class: 'no-sort num', text: T('cw.wins') }),
      el('th', { class: 'no-sort' })
    ])));
    const tb = el('tbody');
    rows.forEach((row, i) => {
      const tr = el('tr', { class: row._new ? 'cw-new' : '' });
      tr.appendChild(el('td', { class: 'mono note', text: String(i + 1) }));
      const opSel = el('select', { onchange: e => { row.op = e.target.value; touch('hints'); onChange(); } });
      (kind === 'categories' ? HR.hints.OPS : ['edge']).forEach(op => opSel.appendChild(el('option', { value: op, text: T('st.hintOp.' + op), selected: (row.op || (kind === 'categories' ? 'starts' : 'edge')) === op })));
      tr.appendChild(el('td', {}, opSel));
      const words = el('input', { type: 'text', value: row.t || '', placeholder: T('st.opValuesPh'), onchange: e => { row.t = e.target.value; delete row._new; touch('hints'); onChange(); } });
      words.style.width = '220px';
      tr.appendChild(el('td', {}, words));
      const tgt = el('select', { onchange: e => { row.id = e.target.value; touch('hints'); onChange(); } });
      targets.forEach(c => tgt.appendChild(el('option', { value: c.id, text: HR.config.labelOf(c), selected: row.id === c.id })));
      tr.appendChild(el('td', {}, tgt));
      const hits = hitsOf(i), wins = winsOf(i);
      tr.appendChild(el('td', { class: 'num' }, el('span', { class: 'note', text: U.fmtInt(hits) })));
      tr.appendChild(el('td', { class: 'num' }, el('a', { href: '#', class: 'pill' + (wins ? ' ok' : hits ? ' warn' : ' muted'), text: U.fmtInt(wins),
        title: hits && !wins ? T('cw.shadowed') : T('cw.winsTip'), onclick: e => { e.preventDefault(); HR.app.go('classify', { tab: kind === 'categories' ? 'perms' : 'accounts', filter: 'rule:' + i }); } })));
      tr.appendChild(el('td', {}, el('div', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' }, [
        el('button', { class: 'btn sm ghost', text: '↑', title: T('cw.up'), disabled: i === 0, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); touch('hints'); onChange(); } }),
        el('button', { class: 'btn sm ghost', text: '↓', title: T('cw.down'), disabled: i === rows.length - 1, onclick: () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); touch('hints'); onChange(); } }),
        el('button', { class: 'btn sm danger', text: '✕', onclick: () => { rows.splice(i, 1); touch('hints'); onChange(); } })
      ])));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(el('div', { class: 'tbl-wrap' }, t));
    body.appendChild(el('div', { class: 'slot-actions', style: 'margin-top:8px' }, [
      el('button', { class: 'btn sm', text: T('st.addRow'), onclick: () => { rows.push(kind === 'categories' ? { op: 'word', t: '', id: fallbackCat(cfg).id, _new: true } : { t: '', id: HR.classify.FALLBACK.cls, _new: true }); touch('hints'); onChange(); } }),
      el('span', { class: 'note', text: T('cw.orderNote') })
    ]));
    return card(T(kind === 'categories' ? 'st.hintsCat' : 'st.hintsCls'), T('cw.rulesNote'), body);
  }

  /* ---- one tab: entitlements or accounts ------------------------------------------ */
  function workTab(m, kind, params) {
    const d = draft(), cfg = HR.config.get();
    const isPerm = kind === 'categories';
    const items = isPerm ? m.permissionList : m.accountList;
    const nameOf = isPerm ? p => p.name : a => a.userName;
    const targets = isPerm ? cfg.categories : cfg.accountClasses;
    const results = items.map(x => ({ item: x, res: isPerm ? classifyPerm(x, d, cfg) : classifyAcc(x, d, cfg) }));
    /* A plain user name that fell through is a user account — the fallback is right for
       it. What counts as unclassified is a name shape the wizard rule would ask about. */
    if (!isPerm) {
      /* Same rule as the summary (wizard.unansweredAccounts), on the draft's answers. */
      const floor = HR.wizard.cohortFloor(m), size = new Map();
      results.forEach(r => { if (r.res.source === 'default' && r.res.cohort) { const k = r.item.system + '|' + r.res.cohort; size.set(k, (size.get(k) || 0) + 1); } });
      results.forEach(r => { if (r.res.source === 'default') r.res.source = r.res.cohort && size.get(r.item.system + '|' + r.res.cohort) >= floor ? 'unknown' : 'plain'; });
    }
    /* Names the vocabulary update moved, while it is unacknowledged: key → old answer. */
    const vc = m.vocabChanges ? new Map((isPerm ? m.vocabChanges.perms : m.vocabChanges.accs).map(x => [x.item.key, x.from])) : null;
    const rows = d.hints[kind];
    const wrap = el('div', {});
    const redraw = () => HR.app.render();
    const tabId = isPerm ? 'perms' : 'accounts';

    /* The fallout strip: tiles that filter the table. */
    const filter = (params && params.filter) || '';
    const cnt = src => results.filter(r => r.res.source === src).length;
    const pick = f => HR.app.go('classify', { tab: tabId, filter: filter === f ? '' : f });
    const seg = (label, n, f, sev) => tile(label, U.fmtInt(n), filter === f ? T('c.filtered', { what: label }) : T('cw.tapToFilter'), { small: true, severity: sev, onClick: () => pick(f) });
    wrap.appendChild(el('div', { class: 'grid', style: 'margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' }, [
      isPerm ? seg(T('cw.kUnclassified'), cnt('default'), 'unclassified', cnt('default') ? 'high' : 'good')
        : seg(T('cw.kUnknownShape'), cnt('unknown'), 'unclassified', cnt('unknown') ? 'high' : 'good'),
      seg(T('cw.kByRule'), cnt('auto'), 'auto', 'good'),
      seg(T('cw.kManual'), cnt('manual'), 'manual', undefined),
      seg(T('cw.kFamily'), cnt('family'), 'family', undefined),
      cnt('signal') ? seg(T('cw.kSignal'), cnt('signal'), 'signal', 'good') : null,
      vc && vc.size ? seg(T('cw.kVocab'), vc.size, 'vocab', 'medium') : null,
      isPerm ? tile(T('cw.kTotal'), U.fmtInt(items.length), T('cw.kTotalFoot'), { small: true }) : seg(T('cw.kMembership'), cnt('membership'), 'membership', undefined),
      isPerm ? null : seg(T('cw.kPlain'), cnt('plain'), 'plain', undefined)
    ].filter(Boolean)));

    wrap.appendChild(rulesCard(kind, items, nameOf, targets, isPerm ? T('c.category') : T('c.class'), results, redraw));

    /* The table: every name, the draft's answer, and a dropdown that overrules it. */
    let shown = results;
    if (filter === 'unclassified') shown = results.filter(r => r.res.source === 'default' || r.res.source === 'unknown');
    else if (filter === 'vocab') shown = vc ? results.filter(r => vc.has(r.item.key)) : [];
    else if (filter.startsWith('rule:')) { const i = +filter.slice(5); shown = results.filter(r => r.res.source === 'auto' && r.res.rule === i); }
    else if (filter) shown = results.filter(r => r.res.source === filter);
    const overrides = isPerm ? d.catOverrides : d.clsOverrides;
    const keyOf = isPerm ? r => HR.classify.overrideKey(r.item.system, r.item.name) : r => r.item.key;
    const setOverride = (r, id) => {
      /* Permission answers are kept per system; an older name-only answer is replaced. */
      if (isPerm) delete overrides[r.item.name];
      if (id) overrides[keyOf(r)] = id; else delete overrides[keyOf(r)];
      touch(isPerm ? 'catOverrides' : 'clsOverrides');
    };
    const columns = [
      { key: 'name', label: isPerm ? T('c.permission') : T('c.account'), value: r => nameOf(r.item) },
      { key: 'system', label: T('c.system'), value: r => r.item.system },
      isPerm ? { key: 'holders', label: T('c.holders'), num: true, value: r => r.item.holderCount || 0 }
        : { key: 'person', label: T('c.person'), value: r => r.item.personName || (r.item.orphan ? T('c.unowned') : '') },
      { key: 'token', label: T('cw.cFirstWord'), value: r => isPerm ? (r.res.fam || HR.hints.wordsOf(r.item.name)[0] || '') : (r.res.token || ''), render: r => el('span', { class: 'mono note', text: isPerm ? (r.res.fam || HR.hints.wordsOf(r.item.name)[0] || '—') : (r.res.token || '—') }) },
      { key: 'target', label: isPerm ? T('c.category') : T('c.class'), value: r => r.res.id, render: r => {
        const sel = el('select', { onchange: e => { setOverride(r, e.target.value); redraw(); } });
        sel.appendChild(el('option', { value: '', text: T('cw.followRules'), selected: r.res.source !== 'manual' }));
        targets.forEach(c => sel.appendChild(el('option', { value: c.id, text: HR.config.labelOf(c), selected: r.res.source === 'manual' && r.res.id === c.id })));
        sel.title = r.res.source === 'manual' ? T('cw.by.manual') : HR.config.labelOf(targets.find(c => c.id === r.res.id) || {});
        if (r.res.source !== 'manual') sel.classList.add('cw-auto');
        return el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:nowrap' }, [
          r.res.source === 'manual' ? null : el('span', { class: 'pill' + (r.res.source === 'default' ? ' removed' : ''), text: HR.config.labelOf(targets.find(c => c.id === r.res.id) || {}) }), sel]);
      } },
      { key: 'by', label: T('cw.cDecidedBy'), value: r => r.res.source + ':' + (r.res.rule == null ? '' : r.res.rule), render: r => {
        const bits = [el('span', { class: 'note', text: decidedBy(r.res, rows) })];
        if (vc && vc.has(r.item.key)) bits.push(el('span', { class: 'pill', title: T('cw.wasTip'), text: T('cw.was', { what: HR.config.labelOf(targets.find(c => c.id === vc.get(r.item.key)) || { label: vc.get(r.item.key) }) }) }));
        if (r.res.source === 'family') {
          const famKey = HR.classify.famStoreKey(r.item.system, isPerm ? r.res.fam : r.res.cohort);
          const famField = isPerm ? 'catFamilies' : 'clsFamilies';
          const fams = isPerm ? d.catFamilies : d.clsFamilies;
          bits.push(el('button', { class: 'btn sm ghost', text: T('cw.toRule'), title: T('cw.toRuleTip'), onclick: () => {
            rows.push(isPerm ? { op: 'starts', t: String(r.res.fam || '').toLowerCase(), id: r.res.id, _new: true } : { t: r.res.token, id: r.res.id, _new: true });
            delete fams[famKey]; touch('hints'); touch(famField); redraw();
          } }));
          bits.push(el('button', { class: 'btn sm ghost', text: T('cw.forget'), onclick: () => { delete fams[famKey]; touch(famField); redraw(); } }));
        }
        return el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:nowrap' }, bits);
      } }
    ];
    /* A target for a selection, asked in a drawer rather than a dialog. */
    const askTarget = (title, note, then) => {
      const sel = el('select', {}, targets.map(c => el('option', { value: c.id, text: HR.config.labelOf(c) })));
      openDrawer(el('div', {}, [el('h2', { text: title }), el('p', { class: 'note', text: note })]),
        el('div', { class: 'stack' }, el('div', { class: 'row', style: 'gap:8px' }, [sel,
          el('button', { class: 'btn primary', text: T('cw.apply'), onclick: () => { closeDrawer(); then(sel.value); } })])));
    };
    wrap.appendChild(el('div', { style: 'margin-top:14px' }, card(T(isPerm ? 'cw.tablePerms' : 'cw.tableAccounts'), T('cw.tableNote', { n: U.fmtInt(shown.length), of: U.fmtInt(results.length) }), HR.table.make({
      columns, rows: shown, pageSize: 25, exportName: 'classification-' + tabId,
      initialSort: { key: 'by', dir: 1 },
      search: (r, q) => (nameOf(r.item) + ' ' + r.item.system).toLowerCase().includes(q),
      bulkActions: [
        { label: n => T('cw.bulkSet', { n }), run: sel => askTarget(T('cw.bulkSetTitle', { n: U.fmtInt(sel.length) }), T('cw.bulkSetNote'), id => { sel.forEach(r => setOverride(r, id)); redraw(); }) },
        { label: n => T('cw.bulkRule', { n }), run: sel => {
          const prop = proposeRule(sel.map(r => nameOf(r.item)), kind);
          if (!prop) { U.toast(T('cw.noCommonWord'), 5000); return; }
          askTarget(T('cw.bulkRuleTitle', { op: T('st.hintOp.' + prop.op), word: prop.t }), T('cw.ruleProposed', { op: T('st.hintOp.' + prop.op), word: prop.t, covers: U.fmtInt(prop.covers), of: U.fmtInt(sel.length) }), id => {
            rows.unshift(isPerm ? { op: prop.op, t: prop.t, id, _new: true } : { t: prop.t, id, _new: true });
            touch('hints'); redraw();
          });
        } },
        { label: n => T('cw.bulkClear', { n }), run: sel => { sel.forEach(r => setOverride(r, '')); redraw(); } }
      ]
    }))));
    return wrap;
  }

  function classifyView(m, params) {
    const f = document.createDocumentFragment();
    const d = draft();
    f.appendChild(el('div', { class: 'view-head' }, [
      el('div', {}, [el('h1', { text: T('cw.title') }), el('p', { text: T('cw.lead') })]),
      el('div', { class: 'row' }, [
        m && m.vocabChanges && (m.vocabChanges.perms.length + m.vocabChanges.accs.length)
          ? el('button', { class: 'btn', text: T('vc.keep'), title: T('vc.keepTip'), onclick: () => HR.app.vocabAck() }) : null,
        d.dirty ? el('span', { class: 'pill warn', text: T('cw.unsaved') }) : null,
        el('button', { class: 'btn', text: T('cw.discard'), disabled: !d.dirty, onclick: discard }),
        el('button', { class: 'btn primary', text: T('cw.save'), disabled: !d.dirty, onclick: save }),
        el('button', { class: 'btn ghost', text: T('cw.toSettings'), onclick: () => HR.app.go('settings', { tab: 'recognition' }) })
      ].filter(Boolean))
    ]));
    if (!m || !m.summary) {
      f.appendChild(card(null, null, el('p', { text: T('wz.empty') })));
      return f;
    }
    f.appendChild(tabbed('classify', [
      { id: 'perms', label: T('cw.tabPerms'), count: m.summary.unclassifiedPermissions, build: p => workTab(m, 'categories', p) },
      { id: 'accounts', label: T('cw.tabAccounts'), count: m.summary.unclassifiedAccounts, build: p => workTab(m, 'classes', p) }
    ], params || {}));
    return f;
  }

  HR.views.classify = classifyView;
  HR.classifyBench = { draft, save, discard, classifyPerm, classifyAcc, proposeRule };
})(window.HR);

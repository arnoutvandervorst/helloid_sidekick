/* Rule journey: the business-rule export made explainable, in four steps.
     explore  - every rule as a plain sentence; search and filter on rule, condition or entitlement
     stack    - pick a person from the vault, or a profile from the rules' own values, and see
                the rules stack layer by layer: what each adds, what was already there
     timeline - one person through their contracts: when each rule applies, zoomable
     tidy     - where stacking adds nothing, as findings over a rules x entitlements matrix
   The engine is js/journey.js; matching is HR.evaluate's. Filters and picks live in `ui`
   for the session, so moving between steps keeps what was chosen. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el, C = HR.charts, J = HR.journey;
  const T = (k, p) => HR.i18n.t(k, p);
  const { card, tile, tabbed, openDrawer, closeDrawer } = HR.viewkit;
  const DAY = J.DAY;

  const ui = { q: '', cat: '', status: '', signal: false, mode: '', personId: '', profile: {}, drafts: false,
    date: '', zoom: 'all', lane: '', focus: -1 };

  const vaultOf = () => { const st = HR.app.state; return st.vault || (st.directory && st.directory.vault) || null; };
  const asOf = m => m && m.asOf ? new Date(m.asOf) : new Date();
  const whenOf = m => ui.date ? new Date(ui.date + 'T12:00:00Z') : asOf(m);
  const fmtD = (t, o) => new Date(t).toLocaleDateString(HR.i18n.locale, Object.assign({ timeZone: 'UTC' }, o || { day: 'numeric', month: 'short', year: 'numeric' }));
  const catOf = r => r.categories[0] || T('jr.noCat');
  const statusOf = r => HR.i18n.has('jr.st.' + r.status) ? T('jr.st.' + r.status) : r.status;
  const names = (rules, max) => {
    const n = rules.map(r => r.name);
    return n.length > (max || 3) ? n.slice(0, max || 3).join(', ') + ' ' + T('jr.andMore', { n: n.length - (max || 3) }) : n.join(', ');
  };

  /* Per rule set, computed once: colours, grant counts, findings. */
  const cache = new WeakMap();
  function derive(rs) {
    if (cache.has(rs)) return cache.get(rs);
    const cats = U.uniq(rs.rules.map(catOf)).sort();
    const counts = new Map();
    rs.rules.filter(J.isLive).forEach(r => U.uniq(r.entitlements.map(J.keyOf)).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)));
    const findings = J.tidy(rs);
    const signals = new Map();
    findings.forEach(f => f.rules.forEach(r => signals.set(r, (signals.get(r) || []).concat(f))));
    const d = { cats, color: c => C.slot(cats.indexOf(c) + 1), counts, findings, signals };
    cache.set(rs, d);
    return d;
  }

  const chip = (label, on, onclick, count) => el('button', {
    type: 'button', class: 'jr-pick' + (on ? ' on' : ''), 'aria-pressed': String(!!on), onclick
  }, [document.createTextNode(label), count != null ? el('span', { class: 'jr-pick-n', text: U.fmtInt(count) }) : null].filter(Boolean));
  const group = (legend, kids) => el('fieldset', { class: 'jr-group' }, [el('legend', { text: legend }), el('div', { class: 'jr-picks' }, kids)]);

  /* ------------------------------------------------------------ findings in words */

  function findingText(f) {
    const p = { n: f.rules.length, rules: names(f.rules), by: names(f.by), ents: f.ents.map(e => e.name).join(', '),
      count: f.ents.length || f.rules[0].entitlements.length, persons: U.fmtInt(f.rules[0].personsEvaluated || 0) };
    return { title: T('jr.f.' + f.kind + '.t', p), body: T('jr.f.' + f.kind + '.b', p), effect: T('jr.f.' + f.kind + '.e', p) };
  }

  /* ------------------------------------------------------------ drawer */

  function profileFromRule(rule) {
    const out = {};
    const facets = J.profileFacets([rule]).map(x => x.facet);
    rule.scopingConditions.forEach(c => { if (facets.includes(c.facet)) out[c.facet] = c.values[0]; });
    return out;
  }

  function ruleDrawer(rule, rs) {
    const vault = vaultOf(), d = derive(rs);
    const signals = d.signals.get(rule) || [];
    const head = el('div', {}, [
      el('h2', { text: rule.name }),
      el('div', { class: 'row' }, [
        el('span', { class: 'pill', text: catOf(rule) }),
        el('span', { class: 'pill' + (J.isLive(rule) ? '' : ' muted'), text: statusOf(rule) }),
        rule.personsEvaluated != null ? el('span', { class: 'pill', text: T('jr.persons', { n: U.fmtInt(rule.personsEvaluated) }) }) : null
      ].filter(Boolean))
    ]);
    const body = el('div', { class: 'jr-drawer' }, [
      el('p', { class: 'jr-sentence', text: J.sentence(rule, vault) }),
      el('h3', { text: T('jr.conditions') }),
      el('ul', { class: 'clean' }, rule.conditions.map((c, i) => el('li', {}, [
        el('strong', { class: 'jr-and', text: i ? T('jr.andWord') : T('jr.ifWord') }),
        document.createTextNode(' ' + J.condText(c, vault) + ' '),
        el('code', { text: c.raw })
      ]))),
      el('h3', { text: T('jr.grants', { n: rule.entitlements.length }) }),
      el('div', { class: 'jr-chips' }, rule.entitlements.map(e => {
        const n = d.counts.get(J.keyOf(e)) || 0;
        return el('button', {
          type: 'button', class: 'jr-chip' + (n > 1 ? ' dup' : ''),
          title: n > 1 ? T('jr.alsoVia', { n }) : T('jr.onlyHere'),
          onclick: () => { Object.assign(ui, { q: e.name, cat: '', status: '', signal: false }); closeDrawer(); HR.app.go('journey', { tab: 'explore' }); }
        }, [document.createTextNode(e.name), n > 1 ? el('span', { class: 'jr-x', text: ' ×' + n }) : null].filter(Boolean));
      })),
      el('p', { class: 'note', text: T('jr.chipNote') }),
      signals.length ? el('div', { class: 'notice' }, signals.map(f => el('p', { text: findingText(f).title + ' — ' + findingText(f).body }))) : null,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', text: T('jr.stackThis'), onclick: () => {
          Object.assign(ui, { mode: 'profile', profile: profileFromRule(rule), drafts: ui.drafts || !J.isLive(rule) });
          closeDrawer(); HR.app.go('journey', { tab: 'stack' });
        } })
      ])
    ].filter(Boolean));
    openDrawer(head, body);
  }

  /* ------------------------------------------------------------ 1 explore */

  function exploreTab(rs) {
    const vault = vaultOf(), d = derive(rs);
    const sentences = new Map(rs.rules.map(r => [r, J.sentence(r, vault)]));
    const hay = new Map(rs.rules.map(r => [r, [r.name, sentences.get(r), ...r.entitlements.map(e => e.name), ...r.conditions.map(c => c.raw)].join('\n').toLowerCase()]));

    const filters = el('div', { class: 'jr-filters' });
    const results = el('div', { class: 'jr-results' });
    const set = p => { Object.assign(ui, p); drawFilters(); draw(); };

    function drawFilters() {
      filters.replaceChildren(
        group(T('jr.category'), [chip(T('jr.all'), !ui.cat, () => set({ cat: '' }), rs.rules.length)]
          .concat(d.cats.map(c => chip(c, ui.cat === c, () => set({ cat: c }), rs.rules.filter(r => catOf(r) === c).length)))),
        group(T('jr.status'), [
          chip(T('jr.all'), !ui.status, () => set({ status: '' })),
          chip(T('jr.live'), ui.status === 'live', () => set({ status: 'live' }), rs.rules.filter(J.isLive).length),
          chip(T('jr.notLive'), ui.status === 'other', () => set({ status: 'other' }), rs.rules.filter(r => !J.isLive(r)).length)
        ]),
        group(T('jr.signals'), [chip(T('jr.onlySignals'), ui.signal, () => set({ signal: !ui.signal }), d.signals.size)])
      );
    }

    function draw() {
      const q = ui.q.trim().toLowerCase();
      const list = rs.rules.filter(r => (!ui.cat || catOf(r) === ui.cat)
        && (!ui.status || (ui.status === 'live') === J.isLive(r))
        && (!ui.signal || d.signals.has(r))
        && (!q || hay.get(r).includes(q)));
      const exactKey = q && [...d.counts.keys()].find(k => rs.rules.some(r => r.entitlements.some(e => J.keyOf(e) === k && e.name.toLowerCase() === q)));
      results.replaceChildren(
        el('div', { class: 'jr-count', role: 'status' }, [
          el('strong', { text: T('jr.shown', { n: list.length, total: rs.rules.length }) }),
          exactKey ? el('span', { text: T('jr.grantedBy', { name: ui.q.trim(), n: d.counts.get(exactKey) }) }) : null
        ].filter(Boolean)),
        ...(list.length ? list.map(r => el('button', { type: 'button', class: 'jr-row', onclick: () => ruleDrawer(r, rs) }, [
          el('div', { class: 'jr-row-head' }, [
            el('span', { class: 'jr-dot', style: 'background:' + d.color(catOf(r)), 'aria-hidden': 'true' }),
            el('strong', { text: r.name }),
            el('span', { class: 'pill', text: catOf(r) }),
            J.isLive(r) ? null : el('span', { class: 'pill muted', text: statusOf(r) }),
            d.signals.has(r) ? el('span', { class: 'pill warn', text: T('jr.signal') }) : null
          ].filter(Boolean)),
          el('p', { text: sentences.get(r) }),
          el('span', { class: 'note', text: (r.personsEvaluated != null ? T('jr.persons', { n: U.fmtInt(r.personsEvaluated) }) + ' · ' : '') + T('jr.nEnts', { n: r.entitlements.length }) })
        ])) : [el('p', { class: 'note', text: T('jr.noMatch') })])
      );
    }

    const search = el('input', {
      type: 'search', value: ui.q, placeholder: T('jr.searchPh'), 'aria-label': T('jr.search'), class: 'jr-search',
      oninput: e => { ui.q = e.target.value; draw(); }
    });
    drawFilters(); draw();
    return el('div', { class: 'jr-split' }, [
      el('aside', { class: 'card jr-side' }, [
        el('label', { class: 'jr-label', text: T('jr.search') }), search, filters,
        el('button', { type: 'button', class: 'btn ghost sm', text: T('jr.reset'), onclick: () => { search.value = ''; set({ q: '', cat: '', status: '', signal: false }); } })
      ]),
      el('section', { class: 'jr-main', 'aria-label': T('jr.tab.explore') }, [results])
    ]);
  }

  /* ------------------------------------------------------------ person or profile */

  const personLabel = p => { const id = p.externalId || p.personId; return p.displayName.includes(id) ? p.displayName : p.displayName + ' · ' + id; };
  function currentPerson(vault) {
    let p = ui.personId && vault.persons.find(x => x.personId === ui.personId);
    if (!p) {
      p = showcase(vault);
      ui.personId = p ? p.personId : '';
    }
    return p || null;
  }
  /* The first person shown should explain the most: a mover (two start dates) on whom
     many rules stack. Scored once per vault; shortcut: evaluates every person, fine up to tens of thousands. */
  const showcases = new WeakMap();
  function showcase(vault) {
    if (showcases.has(vault)) return showcases.get(vault);
    const rs = HR.app.state.ruleSet, rules = rs ? rs.rules.filter(J.isLive) : [], now = new Date();
    let best = null, bestScore = -1;
    vault.persons.forEach(p => {
      if (!p.contracts.some(c => c.startDate)) return;
      const starts = U.uniq(p.contracts.filter(c => c.startDate).map(c => +c.startDate)).length;
      const n = rules.filter(r => HR.evaluate.evaluateRule(r, p, now).matches === true).length;
      const score = n + (starts > 1 ? 5 : 0);
      if (score > bestScore) { best = p; bestScore = score; }
    });
    best = best || vault.persons[0] || null;
    showcases.set(vault, best);
    return best;
  }
  function personPicker(vault, onPick) {
    const byLabel = new Map(vault.persons.map(p => [personLabel(p), p]));
    const cur = currentPerson(vault);
    const id = 'jr-persons';
    return el('div', { class: 'jr-field' }, [
      el('label', { for: 'jr-person', text: T('jr.person') }),
      el('input', { id: 'jr-person', type: 'search', list: id, value: cur ? personLabel(cur) : '', placeholder: T('jr.personPh'),
        onchange: e => { const p = byLabel.get(e.target.value); if (p) { ui.personId = p.personId; onPick(); } } }),
      el('datalist', { id }, [...byLabel.keys()].map(v => el('option', { value: v })))
    ]);
  }

  /* ------------------------------------------------------------ 2 stack */

  function stackTab(rs, m) {
    const vault = vaultOf(), d = derive(rs);
    if (!ui.mode || (ui.mode === 'person' && !vault)) ui.mode = vault ? 'person' : 'profile';
    const controls = el('div', { class: 'card jr-controls' });
    const out = el('div', { class: 'jr-split' });

    function drawControls() {
      const rules = rs.rules.filter(r => J.isLive(r) || ui.drafts);
      const facets = J.profileFacets(rules);
      const iso = whenOf(m).toISOString().slice(0, 10);
      controls.replaceChildren(...[
        vault ? group(T('jr.stackFor'), [
          chip(T('jr.modePerson'), ui.mode === 'person', () => { ui.mode = 'person'; drawControls(); draw(); }),
          chip(T('jr.modeProfile'), ui.mode === 'profile', () => { ui.mode = 'profile'; drawControls(); draw(); })
        ]) : null,
        ui.mode === 'person' ? personPicker(vault, draw) : null,
        ...(ui.mode === 'profile' ? facets.map(fc => el('div', { class: 'jr-field' }, [
          el('label', { for: 'jr-f-' + fc.facet, text: fc.facet }),
          el('select', { id: 'jr-f-' + fc.facet, onchange: e => { ui.profile[fc.facet] = e.target.value; draw(); } },
            [el('option', { value: '', text: T('jr.any') })].concat(fc.values.map(v => {
              const dept = /^department\.externalid$/i.test(fc.facet) && vault && (vault.departments || []).find(x => x.externalId === v);
              const o = el('option', { value: v, text: v + (dept && dept.displayName ? ' — ' + dept.displayName : '') });
              if (ui.profile[fc.facet] === v) o.selected = true;
              return o;
            })))
        ])) : []),
        ui.mode === 'profile' && !facets.length ? el('p', { class: 'note', text: T('jr.noFacets') }) : null,
        el('div', { class: 'jr-field' }, [
          el('label', { for: 'jr-date', text: T('jr.onDate') }),
          el('input', { id: 'jr-date', type: 'date', value: iso, onchange: e => { ui.date = e.target.value; draw(); } })
        ]),
        el('label', { class: 'jr-check' }, [
          el('input', { type: 'checkbox', checked: ui.drafts, onchange: e => { ui.drafts = e.target.checked; drawControls(); draw(); } }),
          document.createTextNode(T('jr.drafts'))
        ])
      ].filter(Boolean));
    }

    function draw() {
      const when = whenOf(m);
      const rules = rs.rules.filter(r => J.isLive(r) || (ui.drafts && r.status === 'draft'));
      const person = ui.mode === 'person' ? currentPerson(vault) : J.profilePerson(ui.profile, when);
      if (!person) { out.replaceChildren(el('p', { class: 'note', text: T('jr.noPerson') })); return; }
      const res = J.stack(rules, person, when);

      const layers = el('section', { class: 'jr-main jr-layers', 'aria-label': T('jr.layers') }, res.layers.length ? res.layers.map((l, i) => el('article', {
        class: 'card jr-layer' + (l.added.length ? '' : ' empty') + (J.isLive(l.rule) ? '' : ' draft'), style: '--d:' + Math.min(i, 4)
      }, [
        el('div', { class: 'jr-layer-head' }, [
          el('span', { class: 'jr-badge', style: '--c:' + d.color(catOf(l.rule)), text: String(i + 1) }),
          el('div', { class: 'jr-layer-title' }, [
            el('button', { type: 'button', class: 'jr-link', text: l.rule.name, onclick: () => ruleDrawer(l.rule, rs) }),
            el('span', { class: 'note', text: catOf(l.rule) + ' · ' + (l.rule.scopingConditions.length ? l.rule.scopingConditions.map(c => J.condText(c, vaultOf())).join(T('jr.and')) : T('jr.everyone')) })
          ]),
          el('span', { class: 'pill ok', text: T('jr.added', { n: l.added.length }) }),
          l.repeat.length ? el('span', { class: 'pill warn', text: T('jr.repeat', { n: l.repeat.length }) }) : null
        ].filter(Boolean)),
        el('div', { class: 'jr-chips' }, l.added.map(e => el('span', { class: 'jr-chip', text: e.name }))
          .concat(l.repeat.map(x => el('span', { class: 'jr-chip dup', title: T('jr.alreadyVia', { rule: x.first.name }) }, [
            document.createTextNode(x.e.name), el('span', { class: 'jr-x', text: ' · ' + T('jr.via', { rule: x.first.name }) })
          ])))),
        l.added.length ? null : el('p', { class: 'note', text: T('jr.addsNothing') })
      ].filter(Boolean))) : [el('div', { class: 'card' }, el('p', { text: T('jr.noLayers') }))]);
      if (res.unknown.length) layers.appendChild(el('p', { class: 'note', text: T('jr.unknown', { n: res.unknown.length, list: names(res.unknown) }) }));

      const origin = res.origin.slice().sort((a, b) => b.rules.length - a.rules.length || a.name.localeCompare(b.name));
      const summary = el('aside', { class: 'jr-side' }, [
        card(T('jr.result'), person.personId === 'profile' ? T('jr.resultProfile') : person.displayName, [
          el('div', { class: 'jr-big' }, [el('strong', { text: U.fmtInt(res.unique) }), el('span', { text: T('jr.uniqueRights') })]),
          el('p', { class: 'note', text: T('jr.resultFoot', { grants: res.grants, rules: res.layers.length, dup: res.dup }) }),
          res.unique ? C.stackedBar(res.layers.filter(l => l.added.length).map(l => ({ label: l.rule.name, value: l.added.length, color: d.color(catOf(l.rule)) }))) : null,
          el('h3', { text: T('jr.origin') }),
          el('ul', { class: 'clean jr-origin' }, origin.map(o => el('li', {}, [
            el('code', { text: o.name }),
            el('span', { class: o.rules.length > 1 ? 'jr-dupnote' : 'note', text: o.rules.length > 1 ? '×' + o.rules.length + ': ' + names(o.rules, 2) : o.rules[0].name })
          ])))
        ].filter(Boolean)),
        vault && ui.mode === 'person' ? el('button', { class: 'btn', text: T('jr.toTimeline'), onclick: () => HR.app.go('journey', { tab: 'timeline' }) }) : null
      ].filter(Boolean));
      out.replaceChildren(layers, summary);
    }

    drawControls(); draw();
    return el('div', {}, [el('p', { class: 'lead', text: T('jr.stackLead') }), controls, out]);
  }

  /* ------------------------------------------------------------ 3 timeline */

  function ticksFor(from, to) {
    const days = (to - from) / DAY, out = [];
    if (days <= 75) {
      let t = from; while (new Date(t).getUTCDay() !== 1) t += DAY;
      for (; t < to; t += 7 * DAY) out.push({ t, label: fmtD(t, { day: 'numeric', month: 'short' }) });
      return out;
    }
    /* Months up to ~1.5 year, quarters up to ~3 years, then only years. */
    const step = days <= 500 ? 1 : days <= 1100 ? 3 : 12, s = new Date(from);
    for (let y = s.getUTCFullYear(), mo = s.getUTCMonth() + 1; ; mo++) {
      if (mo > 11) { y++; mo = 0; }
      const t = Date.UTC(y, mo, 1);
      if (t >= to) break;
      if (mo % step === 0) out.push({ t, label: step === 12 ? String(y) : fmtD(t, mo === 0 || !out.length ? { month: 'short', year: 'numeric' } : { month: 'short' }) });
    }
    return out;
  }

  function timelineTab(rs, m) {
    const vault = vaultOf(), d = derive(rs);
    if (!vault) {
      return card(T('jr.tlNeeds'), null, [
        el('p', { text: T('jr.tlNeedsBody') }),
        el('button', { class: 'btn primary', text: T('empty.sources'), onclick: () => HR.app.go('sources') })
      ]);
    }
    const rules = rs.rules.filter(J.isLive);
    const controls = el('div', { class: 'card jr-controls' });
    const out = el('div', {});

    function draw() {
      const person = currentPerson(vault);
      const today = Date.now();
      const tl = person && J.timeline(rules, person, today);
      if (!tl) { controls.replaceChildren(personPicker(vault, draw)); out.replaceChildren(el('p', { class: 'note', text: T('jr.tlNoContracts') })); return; }
      const zooms = [{ id: 'all', label: T('jr.zAll'), from: tl.from, to: tl.to }].concat(tl.events.map(ev => ({
        id: ev.kind + ev.t, label: T('jr.ev.' + ev.kind) + ' ' + fmtD(ev.t - (ev.kind === 'leave' ? DAY : 0), { day: 'numeric', month: 'short', year: 'numeric' }),
        from: ev.t - 30 * DAY, to: ev.t + 30 * DAY
      })));
      const z = zooms.find(x => x.id === ui.zoom) || zooms[0];
      controls.replaceChildren(personPicker(vault, () => { ui.zoom = 'all'; ui.lane = ''; draw(); }),
        group(T('jr.zoom'), zooms.map(x => chip(x.label, x === z, () => { ui.zoom = x.id; draw(); }))));

      const span = z.to - z.from;
      const pos = t => (t - z.from) / span * 100;
      const clip = (a, b) => { const x1 = Math.max(a, z.from), x2 = Math.min(b, z.to); return x2 > x1 ? [pos(x1), pos(x2) - pos(x1)] : null; };
      const range = (a, b, open) => open ? T('jr.since', { d: fmtD(a) }) : fmtD(a) + ' – ' + fmtD(b - DAY);
      /* Labels near an edge hang inward, so none is cut off. */
      const at = x => 'left:' + x + '%;transform:translateX(' + (x < 8 ? '0' : x > 92 ? '-100%' : '-50%') + ')';
      const ticks = ticksFor(z.from, z.to);
      const maxU = Math.max(1, ...tl.intervals.map(iv => iv.unique));
      const evs = tl.events.filter(ev => ev.t >= z.from && ev.t <= z.to);
      const lines = () => ticks.map(t => el('span', { class: 'jr-grid', style: 'left:' + pos(t.t) + '%' }))
        .concat(evs.map(ev => el('span', { class: 'jr-evline ' + ev.kind, style: 'left:' + pos(ev.t) + '%' })))
        .concat(today >= z.from && today <= z.to ? [el('span', { class: 'jr-evline today', style: 'left:' + pos(today) + '%' })] : []);
      if (!tl.lanes.some(l => l.rule.name === ui.lane)) ui.lane = tl.lanes.length ? tl.lanes[0].rule.name : '';

      const grid = el('div', { class: 'jr-tl-grid' }, [
        el('div'),
        el('div', { class: 'jr-track jr-events' }, evs.map(ev => el('span', { class: 'jr-flag ' + ev.kind, style: at(pos(ev.t)),
          text: T('jr.ev.' + ev.kind) + (ev.kind === 'leave' ? '' : ' · ' + (ev.contract.department.name || ev.contract.department.externalId || '')) }))
          .concat(today >= z.from && today <= z.to ? [el('span', { class: 'jr-flag today', style: at(pos(today)), text: T('jr.today') })] : [])),
        el('div', { class: 'jr-tl-label' }, [el('strong', { text: T('jr.stacked') }), el('span', { class: 'note', text: T('jr.stackedSub') })]),
        el('div', { class: 'jr-track jr-stack' }, tl.intervals.map(iv => {
          const c = clip(iv.a, iv.b);
          if (!c || !iv.unique) return null;
          return el('span', {
            class: 'jr-sbar' + (iv.grace.size ? ' warn' : ''),
            style: 'left:' + c[0] + '%;width:calc(' + c[1] + '% - 2px);height:' + Math.max(8, Math.round(iv.unique / maxU * 60)) + 'px',
            title: range(iv.a, iv.b) + ': ' + T('jr.stackTip', { n: iv.unique, rules: iv.on.length, dup: iv.dup })
          }, c[1] > 4 ? String(iv.unique) : null);
        }).filter(Boolean)),
        el('div'),
        el('div', { class: 'jr-track jr-axis' }, ticks.map(t => el('span', { style: at(pos(t.t)), text: t.label }))),
        el('div', { class: 'jr-tl-labels' }, tl.lanes.map(l => el('button', {
          type: 'button', class: 'jr-lane-btn' + (l.rule.name === ui.lane ? ' on' : ''), 'aria-pressed': String(l.rule.name === ui.lane),
          onclick: () => { ui.lane = l.rule.name; draw(); }
        }, [el('span', { class: 'jr-dot', style: 'background:' + d.color(catOf(l.rule)), 'aria-hidden': 'true' }), el('span', { text: l.rule.name })]))),
        el('div', { class: 'jr-track jr-lanes' }, lines().concat(tl.lanes.map(l => el('div', { class: 'jr-lane' + (l.rule.name === ui.lane ? ' on' : '') },
          l.segs.map(s => {
            const c = clip(s.a, s.b);
            if (!c) return null;
            return el('span', { class: 'jr-bar' + (s.grace ? ' grace' : ''), style: 'left:' + c[0] + '%;width:' + c[1] + '%;--c:' + d.color(catOf(l.rule)),
              title: l.rule.name + ': ' + range(s.a, s.b, s.open) + (s.grace ? ' · ' + T('jr.grace') : '') }, c[1] > 9 ? (s.grace ? T('jr.graceShort') : range(s.a, s.b, s.open)) : null);
          }).filter(Boolean)))))
      ]);

      const lane = tl.lanes.find(l => l.rule.name === ui.lane);
      out.replaceChildren(
        el('section', { class: 'card', 'aria-label': T('jr.tab.timeline') }, [
          el('h2', { text: person.displayName }),
          el('div', { class: 'jr-tl' }, grid),
          el('div', { class: 'jr-legend' }, [
            el('span', {}, [el('span', { class: 'jr-key bar' }), document.createTextNode(T('jr.lgRule'))]),
            el('span', {}, [el('span', { class: 'jr-key grace' }), document.createTextNode(T('jr.grace'))]),
            el('span', {}, [el('span', { class: 'jr-key warn' }), document.createTextNode(T('jr.lgWarn'))])
          ])
        ]),
        lane ? card(lane.rule.name, catOf(lane.rule), [
          el('p', { class: 'jr-sentence', text: J.sentence(lane.rule, vault) }),
          el('ul', { class: 'clean' }, lane.segs.map(s => el('li', { text: range(s.a, s.b, s.open) + (s.grace ? ' · ' + T('jr.grace') : '') }))),
          el('button', { class: 'btn sm', text: T('jr.openRule'), onclick: () => ruleDrawer(lane.rule, rs) })
        ]) : null
      );
    }
    draw();
    return el('div', {}, [el('p', { class: 'lead', text: T('jr.tlLead') }), controls, out]);
  }

  /* ------------------------------------------------------------ 4 tidy */

  function tidyTab(rs) {
    const d = derive(rs), fs = d.findings;
    const wrap = el('div', { class: 'jr-split' });
    const DUPS = ['redundant', 'partial', 'frame'];

    /* Columns: entitlement families, most granted first; the long tail in one column. */
    const famCount = new Map();
    rs.rules.forEach(r => r.entitlements.forEach(e => famCount.set(J.familyOf(e), (famCount.get(J.familyOf(e)) || 0) + 1)));
    const fams = [...famCount].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const cols = fams.length > 10 ? fams.slice(0, 9).concat([T('jr.otherFam')]) : fams;
    const famOf = e => { const f = J.familyOf(e); return cols.includes(f) ? f : T('jr.otherFam'); };
    const rows = rs.rules.filter(J.isLive).concat(rs.rules.filter(r => !J.isLive(r)));

    function draw() {
      const focus = fs[ui.focus] || null;
      const flagged = new Map();
      (focus ? [focus] : fs).filter(f => DUPS.includes(f.kind)).forEach(f => f.rules.forEach(r => {
        f.ents.forEach(e => { if (!flagged.has(r)) flagged.set(r, new Set()); flagged.get(r).add(famOf(e)); });
      }));
      const list = el('section', { class: 'jr-side jr-findings', 'aria-label': T('jr.findings') }, [el('h2', { text: T('jr.findings') })].concat(fs.length ? fs.map((f, i) => {
        const tx = findingText(f);
        return el('button', { type: 'button', class: 'jr-finding ' + f.kind + (ui.focus === i ? ' on' : ''), 'aria-pressed': String(ui.focus === i),
          onclick: () => { ui.focus = ui.focus === i ? -1 : i; draw(); } }, [
          el('strong', { text: tx.title }), el('span', { text: tx.body }), el('span', { class: 'jr-effect', text: tx.effect })
        ]);
      }) : [el('p', { class: 'note', text: T('jr.noFindings') })]).concat(ui.focus >= 0 ? [el('button', { type: 'button', class: 'btn ghost sm', text: T('jr.showAll'), onclick: () => { ui.focus = -1; draw(); } })] : []));

      const table = el('table', { class: 'jr-matrix', 'aria-labelledby': 'jr-matrix-cap' }, [
        el('thead', {}, el('tr', {}, [el('th', { scope: 'col', text: T('jr.rule') }), el('th', { scope: 'col', class: 'num', text: T('jr.personsCol') })]
          .concat(cols.map(c => el('th', { scope: 'col', class: 'num', text: c }))))),
        el('tbody', {}, rows.map(r => {
          const on = !focus || focus.rules.includes(r) || focus.by.includes(r);
          const fl = flagged.get(r);
          return el('tr', { class: (on ? '' : 'dim') + (focus && focus.by.includes(r) ? ' by' : '') }, [
            el('th', { scope: 'row' }, el('button', { type: 'button', class: 'jr-link', text: r.name + (J.isLive(r) ? '' : ' (' + statusOf(r) + ')'), onclick: () => ruleDrawer(r, rs) })),
            el('td', { class: 'num', text: r.personsEvaluated == null ? '—' : U.fmtInt(r.personsEvaluated) })
          ].concat(cols.map(c => {
            const n = r.entitlements.filter(e => famOf(e) === c).length;
            const dup = n && fl && fl.has(c);
            return el('td', { class: 'num' }, n ? el('span', { class: 'jr-cell' + (dup ? ' dup' : ''), title: dup ? T('jr.cellDup') : '', text: String(n) }) : null);
          })));
        }))
      ]);
      wrap.replaceChildren(list, el('section', { class: 'jr-main card' }, [
        el('h3', { id: 'jr-matrix-cap', text: focus ? findingText(focus).title : T('jr.matrixAll', { n: rs.rules.length }) }),
        el('div', { class: 'jr-scroll' }, table),
        el('div', { class: 'jr-legend' }, [
          el('span', {}, [el('span', { class: 'jr-key cell' }), document.createTextNode(T('jr.lgCell'))]),
          el('span', {}, [el('span', { class: 'jr-key cell dup' }), document.createTextNode(T('jr.cellDup'))])
        ])
      ]));
    }

    const redundantRules = U.uniq(fs.filter(f => f.kind === 'redundant').flatMap(f => f.rules));
    const dupGrants = U.sum(fs.filter(f => f.kind === 'redundant' || f.kind === 'partial'), f => U.sum(f.rules, r => (r.personsEvaluated || 0) * f.ents.length));
    const k = el('div', { class: 'grid g3' }, [
      tile(T('jr.k.rules'), U.fmtInt(rs.rules.length), T('jr.k.rulesFoot', { live: rs.rules.filter(J.isLive).length }), { small: true }),
      tile(T('jr.k.redundant'), U.fmtInt(redundantRules.length), T('jr.k.redundantFoot', { after: rs.rules.filter(J.isLive).length - redundantRules.length }), { small: true, severity: redundantRules.length ? 'medium' : 'good' }),
      tile(T('jr.k.dup'), U.fmtInt(dupGrants), T('jr.k.dupFoot'), { small: true, severity: dupGrants ? 'medium' : 'good' })
    ]);
    draw();
    return el('div', {}, [k, wrap]);
  }

  /* ------------------------------------------------------------ view */

  function journeyView(m, params) {
    const rs = HR.app.state.ruleSet;
    const f = document.createDocumentFragment();
    f.appendChild(el('div', { class: 'view-head' }, el('div', {}, [
      el('h1', { text: T('jr.title') }),
      el('p', { text: T('jr.lead') })
    ])));
    f.appendChild(tabbed('journey', [
      { id: 'explore', label: T('jr.tab.explore'), count: rs.rules.length, build: () => exploreTab(rs) },
      { id: 'stack', label: T('jr.tab.stack'), build: () => stackTab(rs, m) },
      { id: 'timeline', label: T('jr.tab.timeline'), build: () => timelineTab(rs, m) },
      { id: 'tidy', label: T('jr.tab.tidy'), count: derive(rs).findings.length, build: () => tidyTab(rs) }
    ], params));
    return f;
  }

  HR.views.journey = journeyView;
})(window.HR);

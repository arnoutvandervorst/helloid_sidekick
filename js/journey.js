/* The rule journey: business rules made explainable. The pure part behind the #journey view.

   HelloID stacks rules: a person who meets several rules gets the union of their
   entitlements. This file answers four questions about a rule set, without drawing:
     sentence  - what does one rule say, in plain words
     stack     - for one person (real, from the vault, or a profile someone picks), which
                 rules apply, layer by layer, and what each layer adds to what lay there
     timeline  - when does each rule apply to a real person, given contracts and time frames
     tidy      - where does stacking add nothing (a rule whose every entitlement already
                 comes from a rule that selects at least the same people), and what else
                 deserves a look (drafts, rules nobody meets)
   Matching itself is HR.evaluate's: this file never decides on its own who meets a rule. */
(function (HR) {
  'use strict';

  const DAY = 86400000;
  const U = HR.util;
  const T = (k, p) => HR.i18n.t(k, p);
  const isLive = r => r.status === 'published' || r.status === 'enabled';
  /* The export's own spelling ("System - Name (path)") names an entitlement uniquely. */
  const keyOf = e => e.raw;
  const frameOf = r => {
    const c = r.conditions.find(x => x.timeFrame);
    return c ? HR.evaluate.parseTimeFrame(c.values) : { daysBeforeStart: 0, daysAfterEnd: 0 };
  };
  const dayOf = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

  /* ------------------------------------------------------------ sentences */

  const CONTRACT_KEYS = { department: 'department', title: 'title', location: 'location', costcenter: 'costCenter',
    type: 'type', employer: 'employer', division: 'division', team: 'team', organization: 'organization' };
  const FIELD_KEYS = { externalid: 'externalId', name: 'name', displayname: 'name', code: 'code', description: 'name' };
  const OPS = { 'one of': 'oneOf', not: 'not', 'not only': 'notOnly', 'is empty': 'empty', 'is not empty': 'notEmpty',
    contains: 'contains', 'starts with': 'startsWith' };

  function deptName(vault, id) {
    const d = vault && (vault.departments || []).find(x => x.externalId === id);
    return d ? d.displayName : '';
  }

  function valueText(cond, vault) {
    const byId = /^department/i.test(cond.facet) && /externalid$/i.test(cond.facet);
    return cond.values.map(v => {
      const n = byId ? deptName(vault, v) : '';
      return n && n !== v ? n + ' (' + v + ')' : v;
    }).join(T('jr.or'));
  }

  function frameText(f) {
    if (f.daysBeforeStart && f.daysAfterEnd) return T('jr.fBoth', { before: f.daysBeforeStart, after: f.daysAfterEnd });
    if (f.daysBeforeStart) return T('jr.fBefore', { before: f.daysBeforeStart });
    if (f.daysAfterEnd) return T('jr.fAfter', { after: f.daysAfterEnd });
    return T('jr.fNone');
  }

  /** One condition as a clause that fits "Everyone who …". */
  function condText(cond, vault) {
    if (/^person$/i.test(cond.facet)) {
      return T('jr.c.person', { v: cond.values.map(v => /^active$/i.test(v) ? T('jr.active') : v).join(', ') });
    }
    if (cond.timeFrame) return frameText(HR.evaluate.parseTimeFrame(cond.values));
    const head = cond.facet.split('.')[0].toLowerCase();
    const op = (cond.operator || 'one of').toLowerCase();
    if (op === 'one of' && (head === 'department' || head === 'title' || head === 'location')) {
      return T('jr.c.' + head, { v: valueText(cond, vault) });
    }
    return T('jr.c.generic', { facet: cond.facet, op: OPS[op] ? T('jr.op.' + OPS[op]) : op, v: valueText(cond, vault) });
  }

  function sentence(rule, vault) {
    const scope = rule.scopingConditions.map(c => condText(c, vault));
    const n = rule.entitlements.length;
    const f = frameOf(rule);
    const who = scope.length ? T('jr.who', { what: scope.join(T('jr.and')) }) : T('jr.whoAll');
    const gets = n === 1 ? T('jr.gets1', { first: rule.entitlements[0].name }) : T('jr.getsN', { n });
    const when = f.daysBeforeStart || f.daysAfterEnd ? ' ' + frameText(f) : '';
    return who + ' ' + gets + when + (isLive(rule) ? '.' : ' ' + T('jr.ifPublished') + '.');
  }

  /* ------------------------------------------------------------ profile */

  /** The contract facets the rules select on, with every value they name: the profile picker. */
  function profileFacets(rules) {
    const map = new Map();
    rules.forEach(r => r.scopingConditions.forEach(c => {
      if ((c.operator || 'one of').toLowerCase() !== 'one of') return;
      const parts = c.facet.toLowerCase().split('.');
      /* shortcut: only contract facets can be set in a profile; person custom fields stay unknown */
      if (!CONTRACT_KEYS[parts[0]] || !FIELD_KEYS[parts[1] || 'name']) return;
      if (!map.has(c.facet)) map.set(c.facet, new Set());
      c.values.forEach(v => map.get(c.facet).add(v));
    }));
    return [...map].map(([facet, set]) => ({ facet, values: [...set].sort((a, b) => a.localeCompare(b)) }));
  }

  /** A person with one running contract carrying the chosen values: HR.evaluate reads it like a vault person. */
  function profilePerson(choice, when) {
    const blank = () => ({ externalId: '', code: '', name: '', empty: true });
    const c = { index: 0, externalId: 'profile', startDate: new Date(+when - 365 * DAY), endDate: null,
      custom: {}, details: {}, manager: {} };
    Object.values(CONTRACT_KEYS).forEach(k => { c[k] = blank(); });
    Object.keys(choice || {}).forEach(facet => {
      const v = choice[facet];
      if (!v) return;
      const parts = facet.toLowerCase().split('.');
      const k = CONTRACT_KEYS[parts[0]];
      if (!k) return;
      c[k][FIELD_KEYS[parts[1] || 'name']] = v;
      c[k].empty = false;
    });
    return { personId: 'profile', externalId: '', displayName: T('jr.profile'), blocked: false, excluded: false,
      custom: {}, contracts: [c], accounts: [] };
  }

  /* ------------------------------------------------------------ stacking */

  /** Rules without scope first (everyone), then narrower ones: the order a person reads a stack in. */
  const stackOrder = rules => rules.slice().sort((a, b) => a.scopingConditions.length - b.scopingConditions.length || a.i - b.i);

  function stack(rules, person, when) {
    const first = new Map(), all = new Map(), layers = [], unknown = [];
    for (const rule of stackOrder(rules)) {
      const res = HR.evaluate.evaluateRule(rule, person, when);
      if (res.matches === null) { unknown.push(rule); continue; }
      if (!res.matches) continue;
      const added = [], repeat = [];
      rule.entitlements.forEach(e => {
        const k = keyOf(e);
        all.set(k, (all.get(k) || []).concat(rule));
        if (first.has(k)) repeat.push({ e, first: first.get(k) });
        else { first.set(k, rule); added.push(e); }
      });
      layers.push({ rule, added, repeat });
    }
    return {
      layers, unknown,
      unique: first.size,
      grants: layers.reduce((n, l) => n + l.added.length + l.repeat.length, 0),
      dup: [...all.values()].filter(v => v.length > 1).length,
      origin: [...all].map(([key, rs]) => ({ key, name: rs[0].entitlements.find(e => keyOf(e) === key).name, rules: rs }))
    };
  }

  /* ------------------------------------------------------------ timeline */

  /** Rule lanes over a person's employment: the day boundaries where anything can change
      (contract starts and ends, each shifted by every rule's time frame) cut time into
      intervals, and each interval is evaluated once in its middle. A stretch where a rule
      holds only because of its time frame (before the start, after the end) is marked. */
  function timeline(rules, person, today) {
    const cs = person.contracts.filter(c => c.startDate).slice().sort((a, b) => a.startDate - b.startDate);
    if (!cs.length) return null;
    const frames = rules.map(frameOf);
    const maxBefore = Math.max(0, ...frames.map(f => f.daysBeforeStart));
    const maxAfter = Math.max(0, ...frames.map(f => f.daysAfterEnd));
    const cuts = new Set();
    cs.forEach(c => {
      const s = dayOf(c.startDate), e = c.endDate ? dayOf(c.endDate) + DAY : null;
      cuts.add(s); if (e) cuts.add(e);
      frames.forEach(f => { cuts.add(s - f.daysBeforeStart * DAY); if (e) cuts.add(e + f.daysAfterEnd * DAY); });
    });
    const open = cs.some(c => !c.endDate);
    const lastEnd = open ? null : Math.max(...cs.map(c => dayOf(c.endDate) + DAY));
    const from = dayOf(cs[0].startDate) - (maxBefore + 14) * DAY;
    const to = open ? Math.max(dayOf(today) + 60 * DAY, Math.max(...cuts) + 30 * DAY) : lastEnd + (maxAfter + 14) * DAY;
    cuts.add(from); cuts.add(to);
    const pts = [...cuts].filter(t => t >= from && t <= to).sort((a, b) => a - b);
    const strict = new Map(rules.map(r => [r, Object.assign({}, r, { conditions: r.conditions.filter(c => !c.timeFrame) })]));

    const intervals = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], mid = new Date(a + DAY / 2);
      const on = [], grace = new Set();
      rules.forEach(r => {
        if (HR.evaluate.evaluateRule(r, person, mid).matches !== true) return;
        on.push(r);
        if (HR.evaluate.evaluateRule(strict.get(r), person, mid).matches !== true) grace.add(r);
      });
      const by = new Map();
      on.forEach(r => r.entitlements.forEach(e => by.set(keyOf(e), (by.get(keyOf(e)) || 0) + 1)));
      intervals.push({ a, b, on, grace, unique: by.size, dup: [...by.values()].filter(n => n > 1).length });
    }

    const lanes = stackOrder(rules).map(r => {
      const segs = [];
      intervals.forEach(iv => {
        if (!iv.on.includes(r)) return;
        const g = iv.grace.has(r), last = segs[segs.length - 1];
        if (last && last.b === iv.a && last.grace === g) last.b = iv.b;
        else segs.push({ a: iv.a, b: iv.b, grace: g });
      });
      return { rule: r, segs };
    }).filter(l => l.segs.length);

    /* A stretch running into the end of the window has no end yet: an open contract. */
    if (open) lanes.forEach(l => l.segs.forEach(s => { s.open = s.b === to; }));

    /* One event per day: two contracts starting together are one joiner, not a mover.
       A start with nothing running the day before is a (re)joiner; otherwise a mover. */
    const running = t => cs.some(c => dayOf(c.startDate) <= t && (!c.endDate || dayOf(c.endDate) + DAY > t));
    const events = [];
    U.uniq(cs.map(c => dayOf(c.startDate))).sort((a, b) => a - b).forEach(t => events.push({
      t, kind: running(t - DAY) ? 'move' : 'join', contract: cs.find(c => dayOf(c.startDate) === t)
    }));
    U.uniq(cs.filter(c => c.endDate).map(c => dayOf(c.endDate) + DAY)).filter(t => !running(t)).sort((a, b) => a - b)
      .forEach(t => events.push({ t, kind: 'leave', contract: cs.find(c => c.endDate && dayOf(c.endDate) + DAY === t) }));
    events.sort((a, b) => a.t - b.t);
    return { from, to, intervals, lanes, events };
  }

  /* ------------------------------------------------------------ tidying */

  const sig = c => c.facet.toLowerCase() + '|' + (c.operator || 'one of').toLowerCase() + '|' +
    c.values.map(v => String(v).toLowerCase()).sort().join(',');

  /** Does rule s, by its conditions alone, select everyone rule r selects? Time frames aside. */
  function scopeCovers(s, r) {
    if (s === r) return false;
    const person = x => x.conditions.filter(c => /^person$/i.test(c.facet)).map(sig).sort().join(';');
    if (person(s) !== person(r)) return false;
    return s.scopingConditions.every(c => r.scopingConditions.some(d => {
      if (sig(c) === sig(d)) return true;
      /* "one of A, B" covers "one of A" on the same facet. */
      const one = x => (x.operator || 'one of').toLowerCase() === 'one of';
      if (!one(c) || !one(d) || c.facet.toLowerCase() !== d.facet.toLowerCase()) return false;
      const have = new Set(c.values.map(v => String(v).toLowerCase()));
      return d.values.every(v => have.has(String(v).toLowerCase()));
    }));
  }
  const frameCovers = (s, r) => {
    const fs = frameOf(s), fr = frameOf(r);
    return fs.daysBeforeStart >= fr.daysBeforeStart && fs.daysAfterEnd >= fr.daysAfterEnd;
  };

  /** Findings, grouped: the same kind over the same entitlements is one finding naming every rule. */
  function tidy(ruleSet) {
    const rules = ruleSet.rules.filter(isLive);
    const grants = (s, e) => s.entitlements.some(x => keyOf(x) === keyOf(e));
    const coveredBy = r => rules.filter(s => scopeCovers(s, r));

    /* A rule is redundant when every entitlement it grants comes, for the same people and
       at least as long, from another rule. The rules it leans on must stay themselves. */
    const redundant = new Map();
    rules.forEach(r => {
      if (!r.entitlements.length) return;
      const full = coveredBy(r).filter(s => frameCovers(s, r));
      if (r.entitlements.every(e => full.some(s => grants(s, e)))) {
        redundant.set(r, full.filter(s => r.entitlements.some(e => grants(s, e))));
      }
    });
    /* Two rules that cover each other must not both be dropped: keep the first. */
    redundant.forEach((by, r) => { if (by.every(s => redundant.has(s) && s.i > r.i)) redundant.delete(r); });

    const raw = [];
    redundant.forEach((by, r) => raw.push({ kind: 'redundant', rule: r, ents: r.entitlements, by }));
    rules.filter(r => !redundant.has(r)).forEach(r => {
      const cov = coveredBy(r).filter(s => !redundant.has(s));
      const full = cov.filter(s => frameCovers(s, r)), part = cov.filter(s => !frameCovers(s, r));
      const dupFull = r.entitlements.filter(e => full.some(s => grants(s, e)));
      const dupFrame = r.entitlements.filter(e => !dupFull.includes(e) && part.some(s => grants(s, e)));
      if (dupFull.length) raw.push({ kind: 'partial', rule: r, ents: dupFull, by: full.filter(s => dupFull.some(e => grants(s, e))) });
      if (dupFrame.length) raw.push({ kind: 'frame', rule: r, ents: dupFrame, by: part.filter(s => dupFrame.some(e => grants(s, e))) });
    });
    ruleSet.rules.filter(r => r.status === 'draft').forEach(r => raw.push({ kind: 'draft', rule: r, ents: [], by: [] }));
    rules.filter(r => r.personsEvaluated === 0).forEach(r => raw.push({ kind: 'nobody', rule: r, ents: [], by: [] }));
    rules.filter(r => r.personsEvaluated > 0 && r.personsEvaluated <= 3).forEach(r => raw.push({ kind: 'few', rule: r, ents: [], by: [] }));

    const groups = new Map();
    raw.forEach(f => {
      const key = f.kind + '|' + (f.ents.length ? f.ents.map(e => e.name).sort().join(',') : f.rule.name);
      if (!groups.has(key)) groups.set(key, { kind: f.kind, rules: [], ents: f.ents, by: [] });
      const g = groups.get(key);
      g.rules.push(f.rule);
      f.by.forEach(s => { if (!g.by.includes(s)) g.by.push(s); });
    });
    const ORDER = ['redundant', 'partial', 'frame', 'nobody', 'draft', 'few'];
    return [...groups.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  /** "APP-Intranet" -> "APP"; an account grant is its own family. Matrix columns. */
  const familyOf = e => e.isAccount ? 'Account' : (((/^([A-Za-z]+)[-_ ]/.exec(e.name) || [])[1]) || e.name).toUpperCase();

  HR.journey = { isLive, keyOf, frameOf, sentence, condText, frameText, profileFacets, profilePerson, stack, timeline,
    tidy, scopeCovers, frameCovers, familyOf, DAY };
})(window.HR);

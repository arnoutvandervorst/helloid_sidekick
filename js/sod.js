/* Toxic combinations: two things one account should never hold together.

   Separation of duties is the one control every framework names and HelloID does not
   evaluate: the person who can create a supplier must not be the one who can pay it;
   an external account must not carry privileged groups; a shared account must not be
   an admin. The catalogue holds such pairs as data — each side is a permission
   category, a word in the permission name, or an account type — and every account
   is checked against every pair. A hit is a violation with the two things that
   collide, so a reviewer can act on it, and it feeds the account's risk, a finding
   and a compliance control.

   The defaults are category-based so they hold on any tenant; the name-based one is
   there as the example to edit into the customer's own finance-and-procurement pairs. */
(function (HR) {
  'use strict';

  const U = HR.util;

  /* Side kinds: what a side of a pair matches. */
  const KINDS = ['category', 'name', 'class'];
  const SEVERITIES = ['critical', 'high', 'medium'];
  const DEFAULTS = [
    { id: 'privileged-external', label: 'Privileged access on an external account', aKind: 'category', aValue: 'privileged', bKind: 'class', bValue: 'external', severity: 'critical' },
    { id: 'privileged-shared', label: 'Privileged access on a test or shared account', aKind: 'category', aValue: 'privileged', bKind: 'class', bValue: 'test, shared', severity: 'high' },
    { id: 'two-privileged', label: 'Two privileged groups on one account', aKind: 'category', aValue: 'privileged', bKind: 'category', bValue: 'privileged', severity: 'high' },
    { id: 'finance-procurement', label: 'Finance and procurement on one account', aKind: 'name', aValue: 'FIN', bKind: 'name', bValue: 'INK, PROC, PURCH', severity: 'medium' }
  ];

  const values = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

  /** The permissions on an account that a side matches, or `true` for an account-type side. */
  function sideMatch(kind, value, account) {
    const vals = values(value);
    if (!vals.length) return [];
    if (kind === 'class') return vals.includes(String(account.cls || '').toLowerCase()) ? true : [];
    if (kind === 'category') return account.perms.filter(p => vals.includes(String(p.category || '').toLowerCase()));
    /* name: one of the words is a whole word in the permission name — FIN matches
       FIN-Crediteuren and GG_FIN_Read, not "Link" or "Finale" */
    return account.perms.filter(p => nameWord(value, p.name) != null);
  }
  const nameWord = (value, name) => HR.hints && HR.hints.matchToken
    ? HR.hints.matchToken({ op: 'word', t: value }, name)
    : values(value).find(v => String(name || '').toLowerCase().includes(v)) || null;

  /** What a side matched on: the category, the word in the name, or the account type. */
  function sideWhy(kind, value, perm, account) {
    if (kind === 'class') return { kind, value: String(account.cls || '') };
    if (kind === 'category') return { kind, value: perm ? String(perm.category || '') : '' };
    return { kind, value: (perm && nameWord(value, perm.name)) || '' };
  }

  /** The reason a pair is toxic: the rule's own text, or the shipped one for a default. */
  function whyOf(rule) {
    if (rule.why) return rule.why;
    const key = 'sod.why.' + rule.id;
    return HR.i18n.has(key) ? HR.i18n.t(key) : '';
  }

  /* An empty stored list means the reader removed every pair: it stays empty. */
  function rules() {
    const stored = HR.config.get().sod;
    return Array.isArray(stored) ? stored : DEFAULTS;
  }

  /** A pair's name: the shipped translation for a default, the reader's own text otherwise. */
  function labelOf(rule) {
    const key = 'sod.label.' + rule.id;
    const isDefault = DEFAULTS.some(d => d.id === rule.id && d.label === rule.label);
    return isDefault && HR.i18n.has(key) ? HR.i18n.t(key) : rule.label;
  }

  /* One account may hold a pair on purpose: accepted with a reason until a date. */
  const acceptKey = (rule, account) => rule.id + '|' + account.key;
  function acceptance(rule, account, today) {
    const st = (HR.config.get().sodAccepted || {})[acceptKey(rule, account)];
    return st && st.until && st.until >= today ? st : null;
  }
  function setAccepted(rule, account, st) {
    const cfg = HR.config.get();
    cfg.sodAccepted = cfg.sodAccepted || {};
    if (st && st.until) cfg.sodAccepted[acceptKey(rule, account)] = { until: st.until, why: st.why || '', at: new Date().toISOString().slice(0, 10) };
    else delete cfg.sodAccepted[acceptKey(rule, account)];
    HR.config.save(cfg);
  }

  /** Every account against every pair; one violation per account per pair. */
  function evaluate(model) {
    if (model._sod) return model._sod;
    const list = rules();
    const violations = [];
    const perAccount = new Map();
    const today = new Date(model.asOf || Date.now()).toISOString().slice(0, 10);
    for (const a of model.accountList) {
      for (const r of list) {
        const A = sideMatch(r.aKind, r.aValue, a);
        if (A === true ? false : !A.length) continue;
        const B = sideMatch(r.bKind, r.bValue, a);
        let hit = null;
        if (A === true && B === true) continue;                       // two account types is not a pair
        if (A === true) { if (B.length) hit = { a: null, b: B[0] }; }
        else if (B === true) hit = { a: A[0], b: null };
        else {
          /* Two different permissions, so "two privileged groups" needs two, not one twice. */
          const pair = A.flatMap(x => B.filter(y => y !== x).map(y => [x, y]))[0];
          if (pair) hit = { a: pair[0], b: pair[1] };
        }
        if (!hit) continue;
        const v = { rule: r, account: a, person: a.personName || '', a: hit.a, b: hit.b, severity: r.severity || 'medium',
          /* Which part of each side actually matched, so the row can say what makes it toxic. */
          aWhy: sideWhy(r.aKind, r.aValue, hit.a, a), bWhy: sideWhy(r.bKind, r.bValue, hit.b, a) };
        v.accepted = acceptance(r, a, today);
        violations.push(v);
        if (v.accepted) continue;                                   // a decision, not an open violation
        if (!perAccount.has(a.key)) perAccount.set(a.key, []);
        perAccount.get(a.key).push(v);
      }
    }
    const order = { critical: 0, high: 1, medium: 2 };
    violations.sort((x, y) => order[x.severity] - order[y.severity] || x.account.userName.localeCompare(y.account.userName));
    const open = violations.filter(v => !v.accepted);
    const byRule = list.map(r => ({ rule: r, count: open.filter(v => v.rule === r).length }));
    const bySeverity = {};
    SEVERITIES.forEach(s => { bySeverity[s] = open.filter(v => v.severity === s).length; });
    model._sod = {
      violations: open, all: violations, perAccount, byRule, rules: list,
      summary: { rules: list.length, violations: open.length, accepted: violations.length - open.length, accounts: perAccount.size,
        people: new Set(open.map(v => v.person).filter(Boolean)).size, bySeverity,
        worst: open.length ? open[0].severity : null }
    };
    return model._sod;
  }

  /** The heaviest violation on an account, for the risk score: 0 when clean. */
  const severityWeight = { critical: 1, high: 0.7, medium: 0.4 };
  function weightOf(model, account) {
    const list = evaluate(model).perAccount.get(account.key);
    if (!list) return 0;
    return Math.max.apply(null, list.map(v => severityWeight[v.severity] || 0.4));
  }

  HR.sod = { evaluate, weightOf, rules, whyOf, labelOf, setAccepted, DEFAULTS, KINDS, SEVERITIES };
})(window.HR);

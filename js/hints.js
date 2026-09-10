/* The recognition vocabulary: the product knowledge behind every "recognised"
   answer in the classification wizard.

   A category row says how its words match an entitlement's name — starts with
   (the default, and what the built-ins mean), contains, ends with, is a whole
   word, is exactly — in plain language, no regex. An account name's leading or
   trailing word is compared against the account-type rows (the word IS a
   token). First row that hits wins, a wizard answer always beats a hint.

   The rows are plain data, editable in Settings › Recognition. Edits are
   stored in cfg.hints and travel with the settings export; without edits the
   built-in table below applies. Sensitivity and weight are never stored here —
   they come from the category / account-type definition the row points at. */
(function (HR) {
  'use strict';

  const DEFAULTS = {
    categories: [
      { t: 'priv, pam, tier0, admin, beh, adm', id: 'privileged' },
      { t: 'srv, server, db, sql, log, sys', id: 'server' },
      { t: 'sec, mfa, av, crypt', id: 'security' },
      { t: 'rol, role, func', id: 'role' },
      { t: 'fs, shr, share, dfs, nas', id: 'fileshare' },
      { t: 'app, sw, soft', id: 'application' },
      { t: 'mbx, mail, exch', id: 'mailbox' },
      { t: 'prj, proj, project, projekt', id: 'project' },
      { t: 'dl, dist, distr, mailgroup', id: 'distribution' },
      { t: 'team, grp, group, sp, sharepoint', id: 'team' },
      { t: 'print, wifi, vpn, dev', id: 'device' },
      { t: 'lic, licen, m365, o365', id: 'licence' }
    ],
    classes: [
      { t: 'adm, admin, a', id: 'admin' },
      { t: 'svc, srv, sa, sys, app, service', id: 'service' },
      { t: 'test, tst, demo, dummy, poc, acc, dev', id: 'test' },
      { t: 'info, balie, receptie, algemeen, shared, gen, generic', id: 'shared' },
      { t: 'ext, extern, external, inhuur, contractor, vendor, leverancier, partner', id: 'external' }
    ]
  };

  const tokens = row => String(row.t || '').toLowerCase().split(',')
    .map(s => s.trim()).filter(Boolean);

  const OPS = ['starts', 'contains', 'ends', 'word', 'equals'];

  /** The words of a name: split on separators and on case changes, so
      "GG_FinanceAdmin" yields gg, finance, admin. */
  const wordsOf = name => String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  /** Does this row's vocabulary hit this entitlement name? */
  function matchesRow(row, name) {
    const n = String(name || '').toLowerCase();
    if (!n) return false;
    const toks = tokens(row);
    if (!toks.length) return false;
    switch (row.op || 'starts') {
      case 'contains': return toks.some(x => n.includes(x));
      case 'ends': return toks.some(x => n.endsWith(x));
      case 'equals': return toks.some(x => n === x);
      case 'word': { const w = wordsOf(name); return toks.some(x => w.includes(x)); }
      default: return toks.some(x => n.startsWith(x));
    }
  }

  const rowsFor = kind => {
    const cfg = HR.config ? HR.config.get() : null;
    const stored = cfg && cfg.hints && cfg.hints[kind];
    return (Array.isArray(stored) && stored.length) ? stored : DEFAULTS[kind];
  };

  /** Which category row wins for an entitlement — its index and the row — or null.
      `rows` may be a draft vocabulary (the workbench previews edits before saving). */
  function explain(token, name, rows) {
    const t = String(token || '').toLowerCase();
    const full = String(name || '') || t;
    if (!t && !full) return null;
    const list = rows || rowsFor('categories');
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const op = row.op || 'starts';
      /* "starts" keeps its old meaning: the first word starts with the token. */
      const hit = op === 'starts' ? (t ? tokens(row).some(x => t.startsWith(x)) : matchesRow(row, full)) : matchesRow(row, full);
      if (hit) return { index: i, row };
    }
    return null;
  }

  /** Category hint for an entitlement: its family token (the first word) and, when
      the caller has it, the full name — the richer match kinds need the name. */
  function categoryHintFor(token, name) {
    const hit = explain(token, name);
    if (!hit) return null;
    const def = HR.config ? HR.config.categoryDefOf(hit.row.id) : null;
    return { hint: hit.row.id, sensitivity: def ? def.sensitivity : 1.0, rule: hit.index };
  }

  /** Which account-type row claims this leading/trailing word — index and row, or null. */
  function explainClass(token, rows) {
    const t = String(token || '').toLowerCase();
    if (!t) return null;
    const list = rows || rowsFor('classes');
    for (let i = 0; i < list.length; i++) if (tokens(list[i]).includes(t)) return { index: i, row: list[i] };
    return null;
  }

  /** Account-type hint for a name's leading/trailing token (exact match). */
  function classHintFor(token) {
    const hit = explainClass(token);
    if (!hit) return null;
    const def = HR.config ? HR.config.classDefOf(hit.row.id) : null;
    return { id: hit.row.id, weight: def ? def.weight : 1.2, rule: hit.index };
  }

  HR.hints = { DEFAULTS, OPS, categoryHintFor, classHintFor, explain, explainClass, matchesRow, wordsOf, tokens, rowsFor };
})(window.HR);

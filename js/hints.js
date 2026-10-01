/* The recognition vocabulary: the product knowledge behind every "recognised"
   answer. The decision itself is made in js/classify.js; this file holds the rows
   and the one matcher everything shares.

   A category row says how its words match an entitlement's name — starts with
   (the default, and what the built-ins mean), contains, ends with, is a whole
   word, is exactly — in plain language, no regex. An account's cohort word (a short
   leading or trailing word, js/classify.js cohortKeyOf) is compared against the
   account-type rows: the word IS a token. First row that hits wins; an item or
   family answer always beats a row.

   The rows are plain data, editable in Settings › Recognition. Edits are
   stored in cfg.hints and travel with the settings export; without edits the
   built-in table below applies. Sensitivity and weight are never stored here —
   they come from the category / account-type definition the row points at. */
(function (HR) {
  'use strict';

  /* The vocabulary as shipped until 2026.10.2 — kept to recognise a stored copy of it
     (Settings used to save the whole table on any edit) and upgrade it row by row. */
  const DEFAULTS_V1 = {
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

  /* Version 2. Built-in rows match whole words ("is a word", trailing digits allowed),
     not the start of a name: `log` still catches LOG-Eventcollector and SRV01-…, but
     no longer LOGISTIEK, `beh` no longer BEHANDELAAR, `priv` no longer PRIVACY, `sec`
     no longer SECRETARIAAT, `share` no longer SharePoint. The directory's own
     privileged groups come first, by exact name — they used to land in Uncategorised.
     `b` names the built-in row so a stored copy can be upgraded row by row. */
  const VERSION = 2;
  const DEFAULTS = {
    categories: [
      { b: 'privileged-known', op: 'equals', id: 'privileged',
        t: 'domain admins, enterprise admins, schema admins, administrators, account operators, backup operators, server operators, print operators, group policy creator owners, dnsadmins, key admins, enterprise key admins, cert publishers, ' +
           'global administrator, privileged role administrator, privileged authentication administrator, security administrator, exchange administrator, sharepoint administrator, intune administrator, user administrator, application administrator, cloud application administrator, conditional access administrator, helpdesk administrator, authentication administrator, billing administrator, teams administrator' },
      { b: 'privileged', op: 'word', id: 'privileged', t: 'priv, privileged, pam, tier0, t0, admin, admins, adm, beh, beheer, beheerder, beheerders, pim, paw' },
      { b: 'server', op: 'word', id: 'server', t: 'srv, server, servers, db, dba, sql, log, sys, sysadmin, infra, iis, hyperv, vmware, esx' },
      { b: 'security', op: 'word', id: 'security', t: 'sec, security, mfa, 2fa, antivirus, defender, crypt, bitlocker, laps, firewall' },
      { b: 'role', op: 'word', id: 'role', t: 'rol, role, roles, rollen, func, functie' },
      /* Before file shares: "SharePoint" splits on its capital into share + point. */
      { b: 'team-m365', op: 'word', id: 'team', t: 'sharepoint, spo, onedrive' },
      { b: 'fileshare', op: 'word', id: 'fileshare', t: 'fs, shr, share, shares, dfs, nas, schijf, schijven, map, mappen, gedeeld, folder' },
      { b: 'application', op: 'word', id: 'application', t: 'app, apps, application, applicatie, applicaties, sw, software, citrix, ctx, rds, vdi, avd, sap, afas, d365, crm, erp, ecd' },
      { b: 'mailbox', op: 'word', id: 'mailbox', t: 'mbx, mailbox, mailboxes, mail, exch, exchange, exo' },
      { b: 'project', op: 'word', id: 'project', t: 'prj, proj, project, projects, projekt, projecten' },
      { b: 'distribution', op: 'word', id: 'distribution', t: 'dl, dist, distr, distribution, mailgroup, verdeellijst, verdeellijsten, maillijst' },
      { b: 'team', op: 'word', id: 'team', t: 'team, teams, grp, group, unified' },
      { b: 'device', op: 'word', id: 'device', t: 'print, printer, printers, wifi, wlan, eduroam, vpn, intune, mdm, device, devices' },
      { b: 'licence', op: 'word', id: 'licence', t: 'lic, licence, license, licentie, m365, o365, e1, e3, e5, f1, f3, ems, enterprisepack, standardpack, copilot, pbi, powerbi' }
    ],
    /* Account rows name a cohort word exactly. Dropped from v1: `a` (made every
       a.jansen an admin), `sa` and `gen` (initials). */
    classes: [
      { b: 'admin', id: 'admin', t: 'adm, admin, beheer, bh, priv, da, t0, t1' },
      { b: 'service', id: 'service', t: 'svc, srv, sys, app, service, gmsa, msa, bot, rpa, sync, scan, task, batch, api' },
      { b: 'test', id: 'test', t: 'test, tst, demo, dummy, poc, acc, dev, tmp, temp, stg' },
      { b: 'shared', id: 'shared', t: 'info, balie, receptie, algemeen, shared, generic, room, kiosk, secretariaat' },
      { b: 'external', id: 'external', t: 'ext, extern, external, inhuur, contractor, vendor, leverancier, partner, gast, guest' }
    ]
  };

  /* A stored row equal to a v1 built-in (same target, same words, matched as "starts
     with") is that built-in, untouched — the upgrade may replace it. */
  const normT = t => String(t || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).sort().join(',');
  const isV1Row = (row, kind) => (row.op || 'starts') === (kind === 'categories' ? 'starts' : (row.op || 'starts')) &&
    DEFAULTS_V1[kind].some(d => d.id === row.id && normT(d.t) === normT(row.t));

  /**
   * Bring a stored vocabulary to the current version without losing an edit: rows that
   * are untouched v1 built-ins become their v2 row, rows the user wrote or changed stay
   * where they are, and built-ins new in v2 are added — the directory's privileged
   * groups at the top (they are unambiguous), the rest after.
   */
  function upgradeRows(stored, kind) {
    const out = [], used = new Set();
    stored.forEach(row => {
      if (isV1Row(row, kind)) {
        const v2 = DEFAULTS[kind].find(d => d.b === row.id);
        if (v2 && !used.has(v2.b)) { out.push(Object.assign({}, v2)); used.add(v2.b); }
        return;
      }
      out.push(row);
    });
    const v1Ids = new Set(DEFAULTS_V1[kind].map(d => d.id));
    DEFAULTS[kind].forEach((d, i) => {
      if (used.has(d.b) || out.some(r => r.b === d.b)) return;
      if (v1Ids.has(d.b)) {
        /* A v1 built-in the user edited stays theirs; one they deleted stays deleted
           unless the category itself has no row at all. */
        if (!stored.some(r => r.id === d.id)) out.push(Object.assign({}, d));
        return;
      }
      /* New in v2: the directory's privileged groups go on top; others just before the
         built-in that follows them, so their order still decides. */
      if (d.b === 'privileged-known') { out.unshift(Object.assign({}, d)); return; }
      const next = DEFAULTS[kind][i + 1];
      const at = next ? out.findIndex(r => r.b === next.b || r.id === next.id) : -1;
      out.splice(at < 0 ? out.length : at, 0, Object.assign({}, d));
    });
    return out;
  }

  const tokens = row => String(row.t || '').toLowerCase().split(',')
    .map(s => s.trim()).filter(Boolean);

  /* `path` reads where the group lives — the OU or DN text, not the name. */
  const OPS = ['starts', 'contains', 'ends', 'word', 'equals', 'path'];

  /** The words of a name: split on separators and on case changes, so
      "GG_FinanceAdmin" yields gg, finance, admin. */
  const wordsOf = name => String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  /** Which of this row's tokens hits this entitlement name — the token, or null.
      The one matcher: the build, the workbench preview and its hit counts all use it,
      so a rule never shows hits it cannot win. */
  function matchToken(row, name, path) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    const toks = tokens(row);
    let hit;
    switch (row.op || 'starts') {
      case 'path': { const pth = String(path || '').toLowerCase(); hit = pth ? toks.find(x => pth.includes(x)) : undefined; break; }
      case 'contains': hit = toks.find(x => n.includes(x)); break;
      case 'ends': hit = toks.find(x => n.endsWith(x)); break;
      case 'equals': hit = toks.find(x => n === x); break;
      /* A whole word, digits after it allowed: `srv` hits SRV01-Backup, not SERVICE. Words
         are taken both split on case changes (GG_FinanceAdmin → admin) and as written
         between separators (SharePoint-Finance → sharepoint). */
      case 'word': {
        const w = wordsOf(name).concat(n.split(/[^a-z0-9]+/).filter(Boolean));
        hit = toks.find(x => w.some(y => y === x || (y.startsWith(x) && /^\d+$/.test(y.slice(x.length)))));
        break;
      }
      default: hit = toks.find(x => n.startsWith(x));
    }
    return hit == null ? null : hit;
  }
  const matchesRow = (row, name, path) => matchToken(row, name, path) != null;

  const rowsFor = kind => {
    const cfg = HR.config ? HR.config.get() : null;
    const stored = cfg && cfg.hints && cfg.hints[kind];
    return (Array.isArray(stored) && stored.length) ? stored : DEFAULTS[kind];
  };

  /** Which category row hits an entitlement name — its index and the row — or null.
      `rows` may be a draft vocabulary. A bare family token (no name) is matched as the
      name, which is what "starts with" means for a prefix. */
  function explain(token, name, rows) {
    const full = String(name || '') || String(token || '');
    if (!full) return null;
    const list = rows || rowsFor('categories');
    for (let i = 0; i < list.length; i++) if (matchesRow(list[i], full)) return { index: i, row: list[i] };
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

  HR.hints = { DEFAULTS, DEFAULTS_V1, VERSION, upgradeRows, OPS, categoryHintFor, classHintFor, explain, explainClass, matchToken, matchesRow, wordsOf, tokens, rowsFor };
})(window.HR);

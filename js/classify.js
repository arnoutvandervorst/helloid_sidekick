/* The one place a permission's category and an account's type are decided.

   Before this module there were three resolvers — the model build, the workbench
   preview and config.categoryFor — and they disagreed: the build only consulted the
   rules when a name had a family prefix, so a "contains" rule the workbench showed
   catching "FinanceAdmins" fell to Other after Save. Everything now asks here, with
   the saved vocabulary or a draft one, and gets the same answer.

   Order for a permission:  item answer › family answer › rules › signals › fallback.
   Order for an account:    item answer › cohort answer › rules › signals ›
                            privileged membership › fallback.

   A rule whose target no longer exists is skipped, not terminal — a deleted category
   used to swallow every name its row matched. The fallback is named (`other`,
   `user`), never "whatever row is last". */
(function (HR) {
  'use strict';

  const SEP = '\u001f';
  const FALLBACK = { category: 'other', cls: 'user' };

  /* ------------------------------------------------------------- name shapes */

  /** A permission's family: its prefix token before a separator, uppercased. */
  function famKeyOf(name) {
    const m = /^([A-Za-z][A-Za-z0-9#]{1,11})[-_. ]/.exec(String(name || ''));
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * An account name with the directory's decoration taken off: `DOMAIN\jdoe` → jdoe,
   * `jdoe@corp.nl` → jdoe, `svc-backup$` → svc-backup (a managed service account),
   * `jan_partner.nl#EXT#@tenant…` → a guest.
   */
  function normAccount(userName) {
    let n = String(userName || '');
    const guest = /#EXT#/i.test(n);
    n = n.replace(/^.*\\/, '');
    if (guest) n = n.replace(/#EXT#.*$/i, '');
    n = n.replace(/@.*$/, '');
    const msa = /\$$/.test(n);
    if (msa) n = n.slice(0, -1);
    return { name: n, guest, msa };
  }

  const tokensOf = row => HR.hints.tokens(row);
  const hasToken = (rows, tok) => {
    const t = String(tok || '').toLowerCase();
    return !!t && (rows || []).some(r => tokensOf(r).includes(t));
  };

  /**
   * The cohort an account name belongs to: a short leading word (`s:adm`) or a short
   * trailing one (`e:tst`). A recognised word wins over an unrecognised one, so
   * `jan-adm` is the `adm` cohort, not a cohort of one called `jan`. An unrecognised
   * leading word still forms a cohort when it is set off by `-`, `_` or a space —
   * `bot-…`, `kiosk_…` — but not by a dot, which is how personal names are written.
   */
  function cohortKeyOf(userName, rows) {
    const list = rows || HR.hints.rowsFor('classes');
    const parts = normAccount(userName).name.split(/([-_.\s]+)/);
    if (parts.length < 3) return null;
    const head = parts[0], sep = parts[1], tail = parts[parts.length - 1];
    const short = s => s && s.length <= 6;
    if (short(head) && hasToken(list, head)) return 's:' + head.toLowerCase();
    if (short(tail) && hasToken(list, tail)) return 'e:' + tail.toLowerCase();
    if (short(head) && !sep.includes('.')) return 's:' + head.toLowerCase();
    return null;
  }

  const famStoreKey = (system, fam) => system + SEP + fam;
  const overrideKey = (system, name) => system + SEP + name;

  /* --------------------------------------------------------------- matching */

  /** How sure a rule hit is: an exact or whole-word match, or a token of four
      characters and up, is strong; a short "starts with" token is a guess. */
  function ruleConfidence(row, tok) {
    const op = row.op || 'starts';
    if (op === 'equals' || op === 'word') return 'strong';
    return String(tok || '').length >= 4 ? 'strong' : 'weak';
  }

  /** The first category row that matches this name and points at a real category. */
  function ruleFor(name, rows, valid) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (valid && !valid(row.id)) continue;
      const tok = HR.hints.matchToken(row, name);
      if (tok != null) return { index: i, row, op: row.op || 'starts', t: tok };
    }
    return null;
  }
  /** The first account-type row that names this cohort word and points at a real type. */
  function classRuleFor(token, rows, valid) {
    const t = String(token || '').toLowerCase();
    if (!t) return null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (valid && !valid(row.id)) continue;
      if (tokensOf(row).includes(t)) return { index: i, row, op: 'edge', t };
    }
    return null;
  }

  /* ------------------------------------------------------------- resolvers */

  const catOf = (cfg, id) => (cfg.categories || []).find(c => c.id === id) || null;
  const clsOf = (cfg, id) => (cfg.accountClasses || []).find(c => c.id === id) || null;
  const fallbackCat = cfg => catOf(cfg, FALLBACK.category) || cfg.categories[cfg.categories.length - 1];
  const fallbackCls = cfg => clsOf(cfg, FALLBACK.cls) || cfg.accountClasses[cfg.accountClasses.length - 1];

  /**
   * A permission's category.
   * @param p   { name, system, path? } — plus whatever the signals read
   * @param ctx { cfg?, rows?, overrides?, families?, signals? } — saved config by default;
   *            the workbench passes its draft so the preview is the build.
   * @returns { def, id, source, rule, fam, signal, confidence }
   */
  function permission(p, ctx) {
    ctx = ctx || {};
    const cfg = ctx.cfg || HR.config.get();
    const rows = ctx.rows || HR.hints.rowsFor('categories');
    const overrides = ctx.overrides || cfg.catOverrides || {};
    const families = ctx.families || cfg.catFamilies || {};
    const name = String(p.name || ''), system = p.system || '';
    const fam = famKeyOf(name);
    const done = (def, source, extra) => Object.assign({ def, id: def.id, source, rule: null, fam, signal: null,
      confidence: source === 'manual' || source === 'family' ? 'decided' : source === 'default' ? 'none' : 'strong' }, extra || {});

    const ov = overrides[overrideKey(system, name)] || overrides[name];
    if (ov && catOf(cfg, ov)) return done(catOf(cfg, ov), 'manual');
    if (fam) {
      const fid = families[famStoreKey(system, fam)];
      if (fid && catOf(cfg, fid)) return done(catOf(cfg, fid), 'family');
    }
    const hit = ruleFor(name, rows, id => !!catOf(cfg, id));
    if (hit) return done(catOf(cfg, hit.row.id), 'auto', { rule: hit.index, ruleOp: hit.op, ruleToken: hit.t, confidence: ruleConfidence(hit.row, hit.t) });
    const sig = ctx.signals !== false && HR.classify.permSignal ? HR.classify.permSignal(p, cfg) : null;
    if (sig && catOf(cfg, sig.id)) return done(catOf(cfg, sig.id), 'signal', { signal: sig.signal });
    return done(fallbackCat(cfg), 'default');
  }

  /**
   * An account's type.
   * @param a   { key, system, userName, privileged? }
   * @param ctx { cfg?, rows?, overrides?, families? }
   * @returns { def, id, source, rule, token, signal, confidence }
   */
  function account(a, ctx) {
    ctx = ctx || {};
    const cfg = ctx.cfg || HR.config.get();
    const rows = ctx.rows || HR.hints.rowsFor('classes');
    const overrides = ctx.overrides || cfg.clsOverrides || {};
    const families = ctx.families || cfg.clsFamilies || {};
    const co = cohortKeyOf(a.userName, rows);
    const token = co ? co.slice(2) : null;
    const done = (def, source, extra) => Object.assign({ def, id: def.id, source, rule: null, token, cohort: co, signal: null,
      confidence: source === 'manual' || source === 'family' ? 'decided' : source === 'default' ? 'none' : 'strong' }, extra || {});

    const ov = overrides[a.key];
    if (ov && clsOf(cfg, ov)) return done(clsOf(cfg, ov), 'manual');
    if (co) {
      const fid = families[famStoreKey(a.system, co)];
      if (fid && clsOf(cfg, fid)) return done(clsOf(cfg, fid), 'family');
      const hit = classRuleFor(token, rows, id => !!clsOf(cfg, id));
      if (hit) return done(clsOf(cfg, hit.row.id), 'auto', { rule: hit.index, ruleOp: hit.op, ruleToken: hit.t });
    }
    /* What the directory's own decoration says, when the name said nothing. */
    const n = normAccount(a.userName);
    if (n.guest && clsOf(cfg, 'external')) return done(clsOf(cfg, 'external'), 'signal', { signal: 'guest' });
    if (n.msa && clsOf(cfg, 'service')) return done(clsOf(cfg, 'service'), 'signal', { signal: 'msa' });
    const sig = ctx.signals !== false && HR.classify.accSignal ? HR.classify.accSignal(a, cfg) : null;
    if (sig && clsOf(cfg, sig.id)) return done(clsOf(cfg, sig.id), 'signal', { signal: sig.signal });
    if (a.privileged && a.privileged.length && clsOf(cfg, 'admin')) return done(clsOf(cfg, 'admin'), 'membership');
    return done(fallbackCls(cfg), 'default');
  }

  /** The one definition of "not placed yet", for permissions and accounts alike. */
  const isUnclassified = x => (x.categorySource || x.clsSource || x.source) === 'default';

  HR.classify = {
    SEP, FALLBACK, famKeyOf, normAccount, cohortKeyOf, famStoreKey, overrideKey,
    ruleFor, classRuleFor, permission, account, isUnclassified,
    /* Part D fills these: evidence beyond the name. */
    permSignal: null, accSignal: null
  };
})(window.HR);

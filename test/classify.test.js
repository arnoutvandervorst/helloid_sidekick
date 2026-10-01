/* Classification engine tests — no dependencies.
   Run:  NODE_OPTIONS= node test/classify.test.js

   Loads the real browser modules (util, hints, config, classify) into a sandbox with a
   minimal window/localStorage, then checks the resolver against a golden list. Every
   vocabulary or precedence decision the engine makes should have a line here. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const store = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
  setTimeout, clearTimeout
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'hints.js', 'config.js', 'classify.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}
const HR = sandbox.HR;
HR.i18n = { has: () => false, t: k => k };

let pass = 0, fail = 0;
const failures = [];
function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++; failures.push('  FAIL ' + name + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const cfg = HR.config.get();
const perm = (name, ctx, system) => HR.classify.permission({ name, system: system || 'AD' }, Object.assign({ cfg }, ctx || {}));
const acc = (userName, ctx, extra) => HR.classify.account(Object.assign({ key: 'AD|' + userName, system: 'AD', userName }, extra || {}), Object.assign({ cfg }, ctx || {}));

/* ---------- one engine: rules apply whether or not a name has a family prefix ---------- */
const containsAdmin = [{ op: 'contains', t: 'admin', id: 'privileged' }];
eq('contains rule hits an unprefixed name', perm('FinanceAdmins', { rows: containsAdmin }).id, 'privileged');
eq('contains rule hits a long first word', perm('Applicatiebeheerders-Admin', { rows: containsAdmin }).id, 'privileged');
eq('word rule hits an unprefixed camelCase name', perm('FinanceAdmin', { rows: [{ op: 'word', t: 'admin', id: 'privileged' }] }).id, 'privileged');
eq('equals rule', perm('Domain Admins', { rows: [{ op: 'equals', t: 'domain admins', id: 'privileged' }] }).id, 'privileged');
eq('starts token with a separator matches', perm('M365-E5-Users', { rows: [{ op: 'starts', t: 'm365-e5', id: 'licence' }] }).id, 'licence');
eq('rule records op and token', perm('FinanceAdmins', { rows: containsAdmin }).ruleToken, 'admin');

/* ---------- a rule pointing at a deleted category falls through ---------- */
const deadFirst = [{ op: 'starts', t: 'fin', id: 'gone-category' }, { op: 'contains', t: 'admin', id: 'privileged' }];
eq('deleted target is skipped', perm('FinanceAdmins', { rows: deadFirst }).id, 'privileged');

/* ---------- fallback by id, wherever `other` sits ---------- */
const reordered = Object.assign({}, cfg, { categories: cfg.categories.slice().reverse() });
eq('fallback is other by id', HR.classify.permission({ name: 'zzz', system: 'AD' }, { cfg: reordered, rows: [] }).id, 'other');
eq('fallback source is default', perm('zzz', { rows: [] }).source, 'default');
eq('isUnclassified(default)', HR.classify.isUnclassified({ categorySource: 'default' }), true);
eq('isUnclassified(auto)', HR.classify.isUnclassified({ categorySource: 'auto' }), false);

/* ---------- precedence: item answer > family answer > rule ---------- */
const sep = HR.classify.SEP;
eq('item answer per system', perm('GG-Finance', { rows: containsAdmin, overrides: { ['AD' + sep + 'GG-Finance']: 'fileshare' } }).source, 'manual');
eq('item answer, other system, does not apply', perm('GG-Finance', { rows: [], overrides: { ['Entra' + sep + 'GG-Finance']: 'fileshare' } }).source, 'default');
eq('legacy name-only item answer still read', perm('GG-Finance', { rows: [], overrides: { 'GG-Finance': 'fileshare' } }).id, 'fileshare');
eq('family answer beats rule', perm('GG-Admins', { rows: containsAdmin, families: { ['AD' + sep + 'GG']: 'team' } }).id, 'team');
eq('rule beats fallback', perm('GG-Admins', { rows: containsAdmin }).source, 'auto');

/* ---------- account names ---------- */
const cls = [{ t: 'adm, admin', id: 'admin' }, { t: 'svc, service', id: 'service' }, { t: 'tst, test', id: 'test' }, { t: 'ext', id: 'external' }];
eq('cohort: hinted head', HR.classify.cohortKeyOf('adm-jdoe', cls), 's:adm');
eq('cohort: hinted tail beats unhinted head', HR.classify.cohortKeyOf('jan-adm', cls), 'e:adm');
eq('cohort: hinted tail after a dot', HR.classify.cohortKeyOf('jdoe.adm', cls), 'e:adm');
eq('cohort: unhinted head with a dash forms a cohort', HR.classify.cohortKeyOf('bot-invoices', cls), 's:bot');
eq('cohort: personal dotted name is no cohort', HR.classify.cohortKeyOf('jan.jansen', cls), null);
eq('cohort: DOMAIN\\ stripped', HR.classify.cohortKeyOf('CORP\\svc-backup', cls), 's:svc');
eq('cohort: UPN domain stripped', HR.classify.cohortKeyOf('jdoe.adm@corp.nl', cls), 'e:adm');
eq('account: jan-adm is admin', acc('jan-adm', { rows: cls }).id, 'admin');
eq('account: UPN admin', acc('jdoe.adm@corp.nl', { rows: cls }).id, 'admin');
eq('account: gMSA $ is service by signal', acc('backupsrv$', { rows: cls }).source, 'signal');
eq('account: gMSA $ id', acc('backupsrv$', { rows: cls }).id, 'service');
eq('account: #EXT# guest is external', acc('jan_partner.nl#EXT#@tenant.onmicrosoft.com', { rows: cls }).id, 'external');
eq('account: name beats signal', acc('svc-backup$', { rows: cls }).source, 'auto');
eq('account: privileged membership makes admin', acc('jan.jansen', { rows: cls }, { privileged: [{}] }).source, 'membership');
eq('account: plain user falls back to user', acc('jan.jansen', { rows: cls }).id, 'user');
eq('account: deleted class target skipped', acc('adm-x', { rows: [{ t: 'adm', id: 'gone' }, { t: 'adm', id: 'admin' }] }).id, 'admin');
eq('account: item answer', acc('jan.jansen', { rows: cls, overrides: { 'AD|jan.jansen': 'shared' } }).id, 'shared');

/* ---------- matcher: one function for hits and wins ---------- */
eq('matchToken returns the token', HR.hints.matchToken({ op: 'word', t: 'x, admin' }, 'GG_FinanceAdmin'), 'admin');
eq('matchToken null on miss', HR.hints.matchToken({ op: 'equals', t: 'admin' }, 'admins'), null);

console.log(failures.join('\n'));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

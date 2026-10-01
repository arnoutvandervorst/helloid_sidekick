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

/* ---------- vocabulary v2: the built-in table ---------- */
const v2 = name => perm(name).id;            // saved config = built-ins in a fresh sandbox
const v2c = (userName, extra) => acc(userName, {}, extra).id;
// directory privileged groups, by exact name
eq('v2: Domain Admins', v2('Domain Admins'), 'privileged');
eq('v2: Enterprise Admins', v2('Enterprise Admins'), 'privileged');
eq('v2: Account Operators', v2('Account Operators'), 'privileged');
eq('v2: Global Administrator', v2('Global Administrator'), 'privileged');
eq('v2: Administrators', v2('Administrators'), 'privileged');
// conventions still recognised
eq('v2: ADM-Finance (ambiguous, kept)', v2('ADM-Finance'), 'privileged');
eq('v2: PRIV-PAM-Kluis', v2('PRIV-PAM-Kluis'), 'privileged');
eq('v2: BEH-SQL', v2('BEH-SQL'), 'privileged');
eq('v2: GG_FinanceAdmin', v2('GG_FinanceAdmin'), 'privileged');
eq('v2: LOG-Eventcollector', v2('LOG-Eventcollector'), 'server');
eq('v2: SRV01-Backup (digits after the word)', v2('SRV01-Backup'), 'server');
eq('v2: DB-SQL-Service', v2('DB-SQL-Service'), 'server');
eq('v2: SEC-MFA-Enrolled', v2('SEC-MFA-Enrolled'), 'security');
eq('v2: ROLE-Verpleegkundige', v2('ROLE-Verpleegkundige'), 'role');
eq('v2: FS-CZ08-RO', v2('FS-CZ08-RO'), 'fileshare');
eq('v2: MBX-COM05', v2('MBX-COM05'), 'mailbox');
eq('v2: APP-Copilot', v2('APP-Copilot'), 'application');
eq('v2: TEAM-CA010', v2('TEAM-CA010'), 'team');
eq('v2: PRINT-Zwolle', v2('PRINT-Zwolle'), 'device');
eq('v2: LIC-M365-E5', v2('LIC-M365-E5'), 'licence');
eq('v2: SPE_E5 (Entra SKU)', v2('SPE_E5'), 'licence');
eq('v2: ENTERPRISEPACK', v2('ENTERPRISEPACK'), 'licence');
eq('v2: SharePoint-Finance is team, not file share', v2('SharePoint-Finance'), 'team');
eq('v2: mailgroup-x is distribution, not mailbox', v2('mailgroup-Sales'), 'distribution');
eq('v2: AGDLP DL_FS_… is file share', v2('DL_FS_Finance_RW'), 'fileshare');
eq('v2: Citrix-Users', v2('Citrix-Users'), 'application');
eq('v2: Intune-Devices', v2('Intune-Devices'), 'device');
// false positives gone
eq('v2: BEHANDELAAR-Zorg is not privileged', v2('BEHANDELAAR-Zorg'), 'other');
eq('v2: PRIVACY-Officers is not privileged', v2('PRIVACY-Officers'), 'other');
eq('v2: LOGISTIEK-Planning is not server', v2('LOGISTIEK-Planning'), 'other');
eq('v2: SECRETARIAAT-Noord is not security', v2('SECRETARIAAT-Noord'), 'other');
eq('v2: AVG-Functionaris is not security', v2('AVG-Functionaris'), 'other');
eq('v2: NASCHOLING-2026 is not file share', v2('NASCHOLING-2026'), 'other');
eq('v2: DISTRICT-Oost is not distribution', v2('DISTRICT-Oost'), 'other');
eq('v2: DBC-Registratie is not server', v2('DBC-Registratie'), 'other');
eq('v2: ADMISSIE-Balie is not privileged', v2('ADMISSIE-Balie'), 'other');
eq('v2: Administratie-Lezen is not privileged', v2('Administratie-Lezen'), 'other');
eq('v2: APPROVERS-Inkoop is not application', v2('APPROVERS-Inkoop'), 'other');
eq('v2: SPECIALIST-Cardio is not team', v2('SPECIALIST-Cardio'), 'other');
eq('v2: DEVELOPERS-Web is not device', v2('DEVELOPERS-Web'), 'other');
eq('v2: ROLLOUT-Win11 is not role', v2('ROLLOUT-Win11'), 'other');
// accounts
eq('v2: a.jansen is a user, not admin', v2c('a.jansen'), 'user');
eq('v2: sa.devries is a user', v2c('sa.devries'), 'user');
eq('v2: adm-jdoe admin', v2c('adm-jdoe'), 'admin');
eq('v2: jan-adm admin', v2c('jan-adm'), 'admin');
eq('v2: svc-backup service', v2c('svc-backup'), 'service');
eq('v2: gmsa-sql service', v2c('gmsa-sql'), 'service');
eq('v2: bot-invoices service', v2c('bot-invoices'), 'service');
eq('v2: tst-jdoe test', v2c('tst-jdoe'), 'test');
eq('v2: gast-01 external', v2c('gast-01'), 'external');
eq('v2: room-zaal1 shared', v2c('room-zaal1'), 'shared');

/* ---------- upgrading a stored v1 table ---------- */
const V1 = HR.hints.DEFAULTS_V1;
const up = HR.hints.upgradeRows(JSON.parse(JSON.stringify(V1.categories)), 'categories');
eq('upgrade: untouched v1 becomes v2 length', up.length, HR.hints.DEFAULTS.categories.length);
eq('upgrade: well-known groups on top', up[0].b, 'privileged-known');
eq('upgrade: v1 privileged row replaced by v2', up[1].op, 'word');
const edited = JSON.parse(JSON.stringify(V1.categories));
edited[1] = { t: 'srv, server, db, sql, sys', id: 'server' };       // user removed `log`
edited.push({ op: 'contains', t: 'ecd', id: 'application' });         // and added a row
const up2 = HR.hints.upgradeRows(edited, 'categories');
eq('upgrade: an edited row is kept as written', up2.some(r => r.t === 'srv, server, db, sql, sys' && !r.op), true);
eq('upgrade: no v2 server row added beside the edited one', up2.filter(r => r.id === 'server').length, 1);
eq('upgrade: user row kept', up2.some(r => r.t === 'ecd' && r.op === 'contains'), true);
eq('upgrade: well-known still on top', up2[0].b, 'privileged-known');
const upC = HR.hints.upgradeRows(JSON.parse(JSON.stringify(V1.classes)), 'classes');
eq('upgrade classes: `a` gone', upC.find(r => r.id === 'admin').t.split(',').map(x => x.trim()).includes('a'), false);

console.log(failures.join('\n'));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

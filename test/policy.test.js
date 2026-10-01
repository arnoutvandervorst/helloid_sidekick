/* Compliance engine tests — no dependencies.
   Run:  NODE_OPTIONS= node test/policy.test.js

   Loads util, hints, config, classify, sod and policy into a sandbox and evaluates the
   controls that need nothing but the reconciliation against a synthetic model. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const store = new Map();
const sb = { console, setTimeout, clearTimeout,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) } };
sb.window = sb; vm.createContext(sb);
for (const f of ['util.js', 'hints.js', 'config.js', 'classify.js', 'sod.js', 'policy.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sb, { filename: f });
const HR = sb.HR; HR.i18n = { has: () => false, t: k => k };

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };

let seq = 0;
const acc = o => Object.assign({ key: 'AD|a' + (++seq), userName: 'a' + seq, orphan: false, enabled: true, cls: 'user', permCount: 3,
  perms: [], privileged: [], records: [], resolutions: { None: 1 }, outlier: null, unmanagedPermCount: 0, personName: 'P' }, o || {});
function model(accs) {
  return { accountList: accs, permissionList: [], records: [], findings: [],
    summary: { accounts: accs.length, rows: 0, disabledAccounts: accs.filter(a => a.enabled === false).length } };
}
const ev = m => { delete m._policy; return HR.policy.evaluate(m); };
const row = (e, id) => e.rows.find(r => r.def.id === id);
const cfg = HR.config.get();

/* a tenant where a quarter of the accounts nobody owns: both unowned controls fail */
const accs = Array.from({ length: 40 }, (_, i) => acc({ orphan: i < 10 }));
const m = model(accs);
let e = ev(m);
ok('unowned-share fails', row(e, 'unowned-share').status === 'notMet');
ok('unowned-enabled fails', row(e, 'unowned-enabled').status === 'notMet');
const applicable = e.rows.filter(r => r.applicable && r.on).length;
ok('the two unowned controls count once', e.summary.evaluated === applicable - 1, [e.summary.evaluated, applicable]);
ok('grouped row says what it is counted with', row(e, 'unowned-share').groupWith.includes('unowned-enabled'));

/* defaults that can be met */
ok('wide-membership default is 5 %', row(e, 'wide-membership').threshold === 5);

/* toxic pairs: none defined → waiting, not met */
cfg.sod = [];
e = ev(m);
ok('no toxic pairs: the SoD KPI waits', row(e, 'sod-violations').applicable === false && row(e, 'sod-violations').missing[0] === 'sodPairs');
delete cfg.sod;
e = ev(m);
ok('default pairs: the SoD KPI is measured', row(e, 'sod-violations').applicable === true);

/* exceptions and due dates */
cfg.policies = cfg.policies || {};
cfg.policies['unowned-share'] = { exception: { until: '2020-01-01', why: 'old' }, due: '2020-02-01' };
e = ev(m);
ok('an expired exception is flagged, not silently dropped', row(e, 'unowned-share').exceptionExpired === '2020-01-01');
ok('an expired exception no longer passes', row(e, 'unowned-share').pass === false);
ok('a passed due date on a failing control is overdue', row(e, 'unowned-share').overdue === '2020-02-01');
cfg.policies['unowned-share'] = { exception: { until: '2099-01-01', why: 'migration' } };
e = ev(m);
ok('a running exception passes as accepted', row(e, 'unowned-share').status === 'accepted');
const clean = model(Array.from({ length: 40 }, () => acc()));
e = ev(clean);
ok('an exception on a met control is marked no longer needed', row(e, 'unowned-share').exceptionStale === true);
delete cfg.policies['unowned-share'];

/* rescore: scoring stored results gives the same score as evaluating */
e = ev(m);
const controls = {};
e.rows.forEach(r => { if (r.applicable) controls[r.def.id] = { value: r.value, status: r.status, on: r.on }; });
const sc = HR.policy.scoreFromControls(controls);
ok('stored controls score like a live evaluation', Math.abs(sc.score - e.summary.score) < 1e-9, [sc.score, e.summary.score]);
ok('stored controls count units like a live evaluation', sc.evaluated === e.summary.evaluated, [sc.evaluated, e.summary.evaluated]);

/* frameworks: every count by scoring unit */
const fs1 = HR.policy.frameworkStats(m, '');
ok('All-KPIs card scores like the summary', Math.abs(fs1.score - e.summary.score) < 1e-9);

console.log(fails.join('\n'));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

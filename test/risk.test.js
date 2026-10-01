/* Risk model tests — no dependencies.
   Run:  NODE_OPTIONS= node test/risk.test.js

   Loads util, config and risk into a sandbox and scores synthetic populations: the
   organisation's exposure must follow its worst accounts, not its average one. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const store = new Map();
const sb = { console, setTimeout, clearTimeout,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) } };
sb.window = sb; vm.createContext(sb);
for (const f of ['util.js', 'hints.js', 'config.js', 'classify.js', 'risk.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sb, { filename: f });
const HR = sb.HR; HR.i18n = { has: () => false, t: k => k };

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };

const PRIV = { key: 'AD|Domain Admins', name: 'Domain Admins', sensitivity: 3, holderCount: 20, holdersOrphan: 20, holdersDisabled: 0, issues: {}, rare: false };
const FS = { key: 'AD|FS-Data', name: 'FS-Data', sensitivity: 1.5, holderCount: 100, holdersOrphan: 0, holdersDisabled: 0, issues: {}, rare: false };
let seq = 0;
function account(o) {
  o = o || {};
  const perms = o.perms || [FS];
  const unmanaged = o.unmanaged || [];
  return Object.assign({
    key: 'AD|u' + (++seq), userName: 'u' + seq, enabled: true, orphan: false, flagged: { accountUnmanaged: false },
    clsWeight: 1, clsLabel: 'user', ecatMult: 1, perms, permCount: perms.length,
    privileged: perms.filter(p => p.sensitivity >= 2.4), licences: [], outlier: 0, peerBest: null,
    unmanagedPerms: unmanaged, unmanagedPermKeys: new Set(unmanaged.map(p => p.key)), unmanagedPermCount: unmanaged.length
  }, o.over || {});
}
const model = accs => ({ accountList: accs, permissionList: [PRIV, FS], ISSUE_PERM_UNMANAGED: 'Permission unmanaged' });
const scored = accs => { const m = model(accs); HR.risk.score(m); return m; };

/* dilution: twenty unowned domain admins hidden among five thousand clean users */
const clean = n => Array.from({ length: n }, () => account());
const badAdmin = () => account({ perms: [PRIV], over: { orphan: true, clsWeight: 2.4, clsLabel: 'admin', flagged: { accountUnmanaged: true } } });
const diluted = scored(clean(5000).concat(Array.from({ length: 20 }, badAdmin)));
ok('dilution: 20 unowned admins among 5,000 read high', diluted.risk.overall >= 55, diluted.risk.overall);
const one = scored(clean(5000).concat([badAdmin()]));
ok('one unowned admin among 5,000 shows, but is not high', one.risk.overall >= 5 && one.risk.overall < 45, one.risk.overall);
const cleanOnly = scored(clean(5000));
ok('clean tenant stays low', cleanOnly.risk.overall <= 15, cleanOnly.risk.overall);
const small = scored(clean(50).concat(Array.from({ length: 20 }, badAdmin)));
ok('the same 20 admins read high in a small tenant too', small.risk.overall >= 45 && small.risk.overall >= diluted.risk.overall, [small.risk.overall, diluted.risk.overall]);

/* holding privileged access scores, owned and managed */
const owned = account({ perms: [PRIV] });
scored([owned]);
ok('owned, managed privileged access scores', owned.riskScore >= 12, owned.riskScore);
const ownedUnmanaged = account({ perms: [PRIV], unmanaged: [PRIV] });
scored([ownedUnmanaged]);
ok('privileged held outside the model scores more', ownedUnmanaged.riskScore > owned.riskScore, [ownedUnmanaged.riskScore, owned.riskScore]);

/* one unmanaged admin group among fifty ordinary ones is not averaged away */
const many = Array.from({ length: 50 }, (_, i) => ({ key: 'AD|g' + i, name: 'g' + i, sensitivity: 1, holderCount: 3, holdersOrphan: 0, holdersDisabled: 0, issues: {}, rare: false }));
const oneAdmin = account({ perms: many.concat([PRIV]), unmanaged: [PRIV] });
const oneFile = account({ perms: many.concat([FS]), unmanaged: [FS] });
scored([oneAdmin, oneFile]);
ok('one unmanaged admin group among fifty is not averaged away', oneAdmin.riskScore >= oneFile.riskScore + 15, [oneAdmin.riskScore, oneFile.riskScore]);

/* an owner confirmed by hand outranks the export's "account unmanaged" */
const confirmed = account({ over: { flagged: { accountUnmanaged: true }, matchSource: 'manual' } });
const unconfirmed = account({ over: { flagged: { accountUnmanaged: true } } });
scored([confirmed, unconfirmed]);
ok('confirmed owner drops the unmanaged-identity points', confirmed.riskScore < unconfirmed.riskScore, [confirmed.riskScore, unconfirmed.riskScore]);

/* missing access is not exposure */
const missing = account({ over: { missingCount: 5, missingPerms: [FS] } });
scored([missing]);
ok('missing access adds nothing', missing.riskScore === 0, missing.riskScore);

/* no accounts, no NaN */
const empty = scored([]);
ok('no accounts: overall is 0, not NaN', empty.risk.overall === 0, empty.risk.overall);
const allDisabled = scored([account({ over: { enabled: false } })]);
ok('only disabled accounts: a number', Number.isFinite(allDisabled.risk.overall), allDisabled.risk.overall);

/* formula terms are exposed for the build-up tab */
ok('formula has tail, exposure, coverage', diluted.risk.formula.map(f => f.key).join() === 'tail,exposure,coverage');
ok('weights sum to 1', Math.abs(diluted.risk.formula.reduce((s, f) => s + f.weight, 0) - 1) < 1e-9);

console.log(fails.join('\n'));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

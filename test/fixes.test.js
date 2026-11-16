/* Audit-fix tests — no dependencies.
   Run:  node test/fixes.test.js

   Dates, prices, CSV formula guard, xlsx rows, CSV edge cases, rule parsing, the
   dashboard bundle strip, inclusive contract end dates, workspace id reservation, and
   the Complex-mapping sandbox (its script, and the CSP hash that allows it). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const mem = new Map();
const sb = { console, setTimeout, clearTimeout, structuredClone,
  localStorage: { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k),
    get length() { return mem.size; }, key: i => Array.from(mem.keys())[i] },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) } };
sb.window = sb; vm.createContext(sb);
for (const f of ['util.js', 'storagemode.js', 'access.js', 'workspace.js', 'parse.js', 'hints.js', 'config.js', 'vault.js', 'evaluate.js',
  'products.js', 'audit.js', 'rules.js', 'xlsx.js', 'store.js', 'fieldmap.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sb, { filename: f });
}
const HR = sb.HR; HR.i18n = { has: () => false, t: k => k };
const U = HR.util;

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };
const iso = d => d ? d.toISOString() : null;

/* dates: one strict reader */
ok('date-only is UTC midnight', iso(U.parseDate('2026-08-01')) === '2026-08-01T00:00:00.000Z');
ok('zoneless datetime is UTC, like date-only', iso(U.parseDate('2026-08-01T10:30:00')) === '2026-08-01T10:30:00.000Z');
ok('seven fraction digits and Z', iso(U.parseDate('2025-04-21T04:56:00.0000000Z')) === '2025-04-21T04:56:00.000Z');
ok('offset honoured', iso(U.parseDate('2026-08-01T12:00:00+02:00')) === '2026-08-01T10:00:00.000Z');
ok('Dutch dd-mm-yyyy is day first', iso(U.parseDate('01-08-2026')) === '2026-08-01T00:00:00.000Z');
ok('dd/mm/yyyy with time', iso(U.parseDate('31/12/2026 23:15')) === '2026-12-31T23:15:00.000Z');
ok('impossible day rejected', U.parseDate('31-02-2026') === null && U.parseDate('2026-13-01') === null);
ok('free text rejected', U.parseDate('next tuesday') === null && U.parseDate('') === null && U.parseDate(null) === null);
ok('vault reads Dutch contract dates', iso(HR.vault.parse(JSON.stringify({ Persons: [{ PersonId: 'p', Contracts: [{ StartDate: '01-08-2026' }] }] })).persons[0].contracts[0].startDate) === '2026-08-01T00:00:00.000Z');

/* prices: the tenant's separator, decided from the string */
const P = HR.products.parsePrice;
[['540,00', 540], ['0.125', 0.125], ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['€ 10,00', 10], ['1.250', 1250], ['1,250', 1250],
  ['12.50', 12.5], ['1.000.000', 1000000], ['-3,5', -3.5], ['42', 42], ['', null], ['n/a', null]]
  .forEach(([s, want]) => ok('price ' + JSON.stringify(s), P(s) === want, P(s)));

/* CSV export: formulas neutralised, numbers and the internal round trip left alone */
const csv = U.toCSV([{ a: '=HYPERLINK("x")', b: '+1', c: '-5', d: '@SUM(A1)', e: 'plain', f: -2.5 }]);
ok('formula cells prefixed', csv.split('\r\n')[1] === `"'=HYPERLINK(""x"")",'+1,-5,'@SUM(A1),plain,-2.5`, csv);
ok('raw round trip untouched', U.toCSV([{ a: '=x' }], null, { raw: true }).split('\r\n')[1] === '=x');

/* xlsx: an empty self-closing row must not swallow the next one */
const rows = HR.xlsx.sheetRows('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2" spans="1:1"/>' +
  '<row spans="1:2" r="3"><c t="inlineStr" r="B3"><is><t>x</t></is></c></row></sheetData>', []);
ok('xlsx rows keep their numbers', rows.length === 3 && rows[0][0] === 'h' && rows[1].length === 0 && rows[2][1] === 'x', rows);

/* CSV parsing: Excel's sep= hint, CR-only line ends, long rows warned */
ok('sep= names the delimiter', HR.parse.sniffDelim('sep=;\nA;B\n1;2') === ';');
ok('sep= line is not data', JSON.stringify(HR.parse.parseDelimited('sep=;\r\nA;B\r\n1;2', ';')) === '[["A","B"],["1","2"]]');
ok('CR-only line endings', JSON.stringify(HR.parse.parseDelimited('A,B\r1,2\r3,4', ',')) === '[["A","B"],["1","2"],["3","4"]]');
ok('header line past sep= and BOM', HR.parse.headerLine('﻿sep=,\rA,B\r1,2') === 'A,B');
const recon = HR.parse.parse('System,Person,AccountUserName,Issue\nAD,x,u1,Account unmanaged,extra\n', 'r.csv');
ok('long rows warned', recon.warnings.some(w => /more columns/.test(w)), recon.warnings);

/* rules: quoted values keep their commas; a dashed system name stays whole */
const c = HR.rules.parseCondition("Department.Name, one of: 'Finance, HR & Legal', 'IT'");
ok('quoted value with a comma', JSON.stringify(c.values) === '["Finance, HR & Legal","IT"]', c.values);
ok('unquoted list still splits', JSON.stringify(HR.rules.parseCondition('Department.ExternalId, one of: CA010, CA020').values) === '["CA010","CA020"]');
const rs = HR.rules.parse('Name,EntitlementCount,PersonsLatestEvaluation,Categories,Status,Conditions,Entitlements\n' +
  'R,2,0,,published,Person: active,AFAS - Profit - Account|AFAS - Profit - Rol - Beheer\n', 'rules.csv');
ok('system with a dash', rs.rules[0].entitlements[1].system === 'AFAS - Profit' && rs.rules[0].entitlements[1].name === 'Rol - Beheer', rs.rules[0].entitlements[1]);
const demo = HR.rules.parse(fs.readFileSync(path.join(ROOT, 'demo', 'rules.csv'), 'utf8'), 'rules.csv');
ok('demo rules still parse', demo.rules.length > 5 && demo.rules.every(r => r.systems.every(s => s === 'Microsoft Active Directory')));

/* contract end dates are inclusive, and a model can re-date the running contracts */
const v = HR.vault.parse(JSON.stringify({ Persons: [{ PersonId: 'p', Contracts: [{ StartDate: '2026-01-01', EndDate: '2026-08-01' }] }] }));
const p0 = v.persons[0], last = new Date('2026-08-01T18:00:00Z'), after = new Date('2026-08-02T00:00:00Z');
ok('runs all of its last day', HR.vault.lifecycle(p0, last).state === 'current' && HR.vault.lifecycle(p0, after).state === 'past');
ok('evaluate window inclusive', HR.evaluate.contractInWindow(p0.contracts[0], {}, last) && !HR.evaluate.contractInWindow(p0.contracts[0], {}, after));
HR.vault.setActiveAt(v, last); ok('active on the as-of day', p0.activeContracts.length === 1);
HR.vault.setActiveAt(v, after); ok('not active the day after', p0.activeContracts.length === 0 && v.activeAt === +after);

/* workspaces: dash- belongs to dashboards */
ok('dash- is reserved', HR.workspace.create('dash hr') === 'ws-dash-hr' && HR.workspace.create('Dashboard') === 'dashboard');

/* the published bundle is cut to the audience */
const ctx = { audit: JSON.stringify({ kind: 'helloid-audit', provisioning: [1], reconciliation: [2], logins: [3], portalAdmin: [4] }),
  products: JSON.stringify({ kind: 'helloid-products', products: [{ name: 'x', price: '10', showPrice: true }] }), rules: 'r' };
const hr = HR.store.stripContext(JSON.parse(JSON.stringify(ctx)), []);
const hrAudit = JSON.parse(hr.audit);
ok('hr: provisioning kept, rest of the log gone', hrAudit.provisioning.length === 1 && !hrAudit.logins.length && !hrAudit.reconciliation.length && !hrAudit.portalAdmin.length);
ok('hr: prices gone, rules kept', !('price' in JSON.parse(hr.products).products[0]) && hr.rules === 'r');
const mgr = JSON.parse(HR.store.stripContext(JSON.parse(JSON.stringify(ctx)), ['governance']).audit);
ok('governance keeps exclusions', mgr.reconciliation.length === 1 && !mgr.logins.length);
const full = HR.store.stripContext(JSON.parse(JSON.stringify(ctx)), HR.access.FACETS);
ok('full role untouched', full.audit === ctx.audit && full.products === ctx.products);

/* the Complex sandbox: its script, run as the frame would, and the CSP hash for it */
let handler = null; const sent = [];
const fsb = { structuredClone, String, JSON, Error };
fsb.parent = { postMessage: m => sent.push(m) };
fsb.addEventListener = (t, fn) => { handler = fn; };
vm.createContext(fsb);
vm.runInContext(HR.fieldmap.SANDBOX_SRC, fsb);
ok('sandbox says ready', sent[0] === 'fm-ready' && typeof handler === 'function');
handler({ source: {}, data: { fmId: 9, codes: ['return 1'], persons: [{}] } });
ok('ignores anyone but the parent', sent.length === 1);
handler({ source: fsb.parent, data: { fmId: 7, iteration: 3, persons: [{ N: 'Zoë' }, { N: 'Ab' }],
  codes: [HR.fieldmap.wrapComplex("function f(){ Person.N = 'x'; return deleteDiacriticalMarks(Person.N) }\nf()"),
    'return deleteDiacriticalMarks(Person.N) + Iteration', 'return (', "throw new Error('no')"] } });
const out = sent[1];
ok('one batched answer', out && out.fmId === 7 && out.results.length === 4 && out.results[0].length === 2, out);
ok('each field gets a fresh Person', out.results[1][0].value === 'Zoe3' && out.results[1][1].value === 'Ab3', out.results[1]);
ok('compile and runtime errors reported per cell', out.results[2][0].error && out.results[2][1].error && out.results[3][0].error === 'no');
const hash = "'sha256-" + crypto.createHash('sha256').update(HR.fieldmap.SANDBOX_SRC, 'utf8').digest('base64') + "'";
ok('index.html CSP allows the sandbox script', fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes(hash), hash);

console.log(fails.join('\n'));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

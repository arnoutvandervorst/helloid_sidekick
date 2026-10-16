/* Rule proposal tests: proposed conditions must name a field the person data really has, so the
   proposal selects the people it was mined from. Run:  NODE_OPTIONS= node test/pyramid.test.js

   Regression: titles carrying only a Code were proposed as "Title.ExternalId, one of: <code>", which
   HelloID (and evaluate.js) match against an empty ExternalId: the rule selected nobody. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const store = {};
const sb = { console, setTimeout, clearTimeout, TextDecoder, performance, navigator: { language: 'en-GB' },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
  document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, append() {} }), createTextNode: () => ({}), getElementById: () => ({ style: {}, hidden: true, appendChild() {}, addEventListener() {} }) } };
sb.window = sb; vm.createContext(sb);
for (const f of ['i18n', 'util', 'hints', 'parse', 'config', 'classify', 'sod', 'model', 'risk', 'findings', 'cost', 'diff', 'mine', 'rules', 'compare', 'roles', 'vault', 'evaluate', 'correlate', 'activity', 'products', 'org', 'pyramid', 'cohorts', 'optimise', 'classic', 'explain', 'policy', 'audit', 'directory', 'fit', 'outlier', 'peers', 'workforce', 'nedapons', 'conventions'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8'), sb, { filename: f + '.js' });
const HR = sb.HR;
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };

// condPath: the HelloID contract field per attribute and id source
const cp = HR.pyramid.condPath;
ok('Title by ExternalId', cp({ attr: 'Title', byId: 'ExternalId' }) === 'Title.ExternalId');
ok('Title by Code', cp({ attr: 'Title', byId: 'Code' }) === 'Title.Code');
ok('Title by name', cp({ attr: 'Title', byId: false }) === 'Title.Name');
ok('legacy boolean byId', cp({ attr: 'Location', byId: true }) === 'Location.ExternalId');
ok('Department without ExternalId reads DisplayName', cp({ attr: 'Department', byId: false }) === 'Department.DisplayName');
ok('ContractType is Type.Code', cp({ attr: 'ContractType', byId: 'Code' }) === 'Type.Code');
ok('ContractType by name is Type.Description', cp({ attr: 'ContractType', byId: false }) === 'Type.Description');

// End to end on the demo set (titles have Code + Name, no ExternalId)
const d = f => fs.readFileSync(path.join(ROOT, 'demo', f), 'utf8');
const vault = HR.vault.parse(d('vault.json'), 'vault.json');
const recon = HR.parse.parse(d('recon.csv'), 'recon.csv');
const m = HR.model.build(recon.records, { vault, asOf: new Date('2026-09-01') });
const P = HR.pyramid.build(m, {});
const CD = HR.pyramid.condense(m, P);
const csv = HR.pyramid.condensedToRulesCsv(m, CD);
ok('no Title.ExternalId for code-only titles', !/Title\.ExternalId, one of/.test(csv));
ok('Title.Code conditions present', /Title\.Code, one of/.test(csv));
const evp = HR.evaluate.evaluateAll(HR.rules.parse(csv, 'p.csv'), vault, { includeDrafts: true });
const nobody = evp.stats.rulesMatchingNobody, total = evp.stats.rules;
ok('pyramid proposal: rules select people', nobody / total < 0.1, { nobody, total });
const G = HR.pyramid.greedy(m, {});
const gcsv = HR.pyramid.greedyToRulesCsv(m, HR.pyramid.condenseGreedy(m, G));
const evg = HR.evaluate.evaluateAll(HR.rules.parse(gcsv, 'g.csv'), vault, { includeDrafts: true });
ok('greedy proposal: rules select people', evg.stats.rulesMatchingNobody / evg.stats.rules < 0.1, { nobody: evg.stats.rulesMatchingNobody, total: evg.stats.rules });
const mv = HR.model.build([], { vault, asOf: new Date('2026-09-01') });
const ccsv = HR.cohorts.toRulesCsv(mv, HR.cohorts.build(mv));
const evc = HR.evaluate.evaluateAll(HR.rules.parse(ccsv, 'c.csv'), vault, { includeDrafts: true });
ok('cohorts proposal: rules select people', evc.stats.rulesMatchingNobody === 0, { nobody: evc.stats.rulesMatchingNobody, total: evc.stats.rules });

console.log(`pyramid: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }

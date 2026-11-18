/* Rule journey tests — no dependencies.
   Run:  node test/journey.test.js

   On the demo rules export: rules as sentences (EN and NL), stacking for a profile,
   the timeline of a mover (time-frame lead-in, overlap of two departments), the
   tidy findings, and "Person: active" needing a running contract. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const mem = new Map();
const sb = { console, setTimeout, clearTimeout, structuredClone, navigator: { language: 'en-GB' },
  localStorage: { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) },
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), documentElement: {}, querySelectorAll: () => [] } };
sb.window = sb; vm.createContext(sb);
for (const f of ['i18n.js', 'util.js', 'parse.js', 'vault.js', 'evaluate.js', 'rules.js', 'journey.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sb, { filename: f });
}
const HR = sb.HR, J = HR.journey;

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };
const D = s => new Date(s + 'T00:00:00Z');

const rs = HR.rules.parse(fs.readFileSync(path.join(ROOT, 'demo', 'rules.csv'), 'utf8'), 'rules.csv');
const live = rs.rules.filter(J.isLive);
const rule = n => rs.rules.find(r => r.name === n);

/* sentences */
const tz = rule('Toegang - Thuiszorg');
ok('sentence EN', J.sentence(tz) === 'Everyone who works in CA010 gets 7 entitlements from 14 days before the start date through the end date.', J.sentence(tz));
ok('sentence uses department name from vault', J.sentence(tz, { departments: [{ externalId: 'CA010', displayName: 'Thuiszorg' }] }).includes('Thuiszorg (CA010)'));
ok('sentence for everyone', J.sentence(rule('Basis - Alle medewerkers')).startsWith('Everyone with an active contract gets 7 entitlements'));
ok('sentence for one entitlement names it', J.sentence(rule('Selfservice - Thuiszorg')).endsWith('gets APP-Selfservice.'));
ok('draft says once published', J.sentence(rule('Concept - Inkoop')).endsWith('(once published).'));
HR.i18n.setLang('nl');
ok('sentence NL', J.sentence(tz) === 'Iedereen die bij CA010 werkt, krijgt 7 rechten vanaf 14 dagen vóór de startdatum tot en met de einddatum.', J.sentence(tz));
HR.i18n.setLang('en');

/* profile facets come from the rules */
const facets = J.profileFacets(live);
const dept = facets.find(f => f.facet === 'Department.ExternalId');
ok('profile facets: department and title', !!dept && facets.some(f => f.facet === 'Title.Name'), facets.map(f => f.facet));
ok('department values from the rules', dept && dept.values.includes('CA010') && dept.values.includes('ICT03'));

/* stacking for a profile */
const when = D('2026-11-18');
const nurse = J.profilePerson({ 'Department.ExternalId': 'CA010', 'Title.Name': 'Verpleegkundige' }, when);
const st = J.stack(live, nurse, when);
ok('stack: layers in reading order', st.layers.map(l => l.rule.name).join('|') === 'Basis - Alle medewerkers|Toegang - Thuiszorg|Selfservice - Thuiszorg|Functie - Verpleegkundige', st.layers.map(l => l.rule.name));
ok('stack: 15 unique of 17 grants, 2 double', st.unique === 15 && st.grants === 17 && st.dup === 2, [st.unique, st.grants, st.dup]);
ok('stack: Selfservice layer adds nothing', st.layers[2].added.length === 0 && st.layers[2].repeat[0].first.name === 'Toegang - Thuiszorg');
ok('stack: Account repeats from Basis', st.layers[1].repeat.some(x => x.e.isAccount && x.first.name === 'Basis - Alle medewerkers'));
ok('stack: drafts stay out unless asked', !J.stack(live, J.profilePerson({ 'Department.ExternalId': 'INK08' }, when), when).layers.some(l => l.rule.status === 'draft'));
const inkoop = J.stack(rs.rules, J.profilePerson({ 'Department.ExternalId': 'INK08' }, when), when);
ok('stack: what-if with drafts', inkoop.layers.some(l => l.rule.name === 'Concept - Inkoop'));

/* Person: active needs a running contract (HelloID: an active person has an active contract) */
const leaver = { personId: 'p', displayName: 'X', blocked: false, excluded: false, custom: {},
  contracts: [{ startDate: D('2025-01-01'), endDate: D('2025-12-31'), department: { externalId: 'CA010', name: '', code: '' }, title: { externalId: '', name: 'Verpleegkundige', code: '' } }] };
ok('person active: not after the last contract', HR.evaluate.evaluateRule(rule('Basis - Alle medewerkers'), leaver, D('2026-03-01')).matches === false);
ok('person active: yes during the contract', HR.evaluate.evaluateRule(rule('Basis - Alle medewerkers'), leaver, D('2025-06-01')).matches === true);

/* timeline of a mover: Thuiszorg until 31 Aug, Revalidatie from 1 Sep */
const ref = (id, name) => ({ externalId: id, name: name || '', code: '' });
const femke = { personId: 'f', displayName: 'Femke', blocked: false, excluded: false, custom: {}, contracts: [
  { startDate: D('2026-03-01'), endDate: D('2026-08-31'), department: ref('CA010'), title: ref('', 'Verpleegkundige') },
  { startDate: D('2026-09-01'), endDate: D('2026-12-31'), department: ref('CA060'), title: ref('', 'Verpleegkundige') }
] };
const tl = J.timeline(live, femke, +D('2026-11-18'));
const lane = n => tl.lanes.find(l => l.rule.name === n);
const day = t => new Date(t).toISOString().slice(0, 10);
ok('timeline: events joiner, mover, leaver', tl.events.map(e => e.kind + ' ' + day(e.t)).join('|') === 'join 2026-03-01|move 2026-09-01|leave 2027-01-01', tl.events.map(e => e.kind + ' ' + day(e.t)));
const rv = lane('Toegang - Revalidatie');
ok('timeline: Revalidatie lead-in from 18 Aug through the time frame', rv && rv.segs[0].grace && day(rv.segs[0].a) === '2026-08-18' && day(rv.segs[0].b) === '2026-09-01', rv && rv.segs.map(s => [day(s.a), day(s.b), s.grace]));
ok('timeline: Revalidatie then on contract until 31 Dec', rv && !rv.segs[1].grace && day(rv.segs[1].b) === '2027-01-01');
const tzl = lane('Toegang - Thuiszorg');
ok('timeline: Thuiszorg lead-in 15 Feb, ends with its contract', tzl && day(tzl.segs[0].a) === '2026-02-15' && tzl.segs[0].grace && day(tzl.segs[tzl.segs.length - 1].b) === '2026-09-01');
const basis = lane('Basis - Alle medewerkers');
ok('timeline: Basis only while a contract runs', basis && basis.segs.length === 1 && day(basis.segs[0].a) === '2026-03-01' && day(basis.segs[0].b) === '2027-01-01', basis && basis.segs.map(s => [day(s.a), day(s.b)]));
const overlap = tl.intervals.find(iv => day(iv.a) === '2026-08-18');
ok('timeline: two departments stack 18-31 Aug: 20 unique, 2 double', overlap && overlap.unique === 20 && overlap.dup === 2 && overlap.grace.size === 1, overlap && [overlap.unique, overlap.dup]);

/* tidy */
const fs2 = J.tidy(rs);
const byKind = k => fs2.filter(f => f.kind === k);
const red = byKind('redundant');
ok('tidy: the four Selfservice rules add nothing, one finding', red.length === 1 && red[0].rules.map(r => r.name).sort().join('|') === 'Selfservice - Begeleiding|Selfservice - Dagbesteding|Selfservice - Revalidatie|Selfservice - Thuiszorg', red.map(f => f.rules.map(r => r.name)));
ok('tidy: redundant leans on the Toegang rules', red[0] && red[0].by.every(r => r.name.startsWith('Toegang - ')));
const frame = byKind('frame');
ok('tidy: Account twice except in the time frame, 7 Toegang rules by Basis', frame.length === 1 && frame[0].ents[0].isAccount && frame[0].rules.length === 7 && frame[0].by[0].name === 'Basis - Alle medewerkers', frame.map(f => [f.ents.map(e => e.name), f.rules.length]));
ok('tidy: no partial finding on the demo', byKind('partial').length === 0, byKind('partial').map(f => f.rules.map(r => r.name)));
ok('tidy: draft and few', byKind('draft')[0].rules[0].name === 'Concept - Inkoop' && byKind('few')[0].rules[0].name === 'Toegang - Oud project Zorgdossier');
ok('tidy: redundant first', fs2[0].kind === 'redundant');
const mutual = { rules: [
  { i: 0, name: 'A', status: 'published', categories: [], personsEvaluated: 5, entitlements: [{ raw: 'X - g', name: 'g' }], conditions: [], scopingConditions: [] },
  { i: 1, name: 'B', status: 'published', categories: [], personsEvaluated: 5, entitlements: [{ raw: 'X - g', name: 'g' }], conditions: [], scopingConditions: [] }
] };
const mf = J.tidy(mutual).filter(f => f.kind === 'redundant');
ok('tidy: of two identical rules only one is redundant', mf.length === 1 && mf[0].rules.length === 1 && mf[0].rules[0].name === 'B', mf.map(f => f.rules.map(r => r.name)));

ok('family of an entitlement', J.familyOf({ name: 'APP-Intranet' }) === 'APP' && J.familyOf({ isAccount: true, name: 'Account' }) === 'Account');

console.log(fails.join('\n'));
console.log('journey: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

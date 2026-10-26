/* Service Automation lint: a static quality check over one tenant's delegated forms,
   products, data sources, task scripts and variable library, read from the file
   helloid-sa-export.py writes (kind 'helloid-sa-config').

   Pure: no DOM, no state. analyse(cfg) returns the inventory, the script units, the
   clone clusters and a flat list of findings; the Scripts & forms view renders them and
   test/salint.test.js pins the rules. When the export carries the audit log's Service
   Automation events (cfg.activity), runtime rules join in: forms that error, forms that
   are opened but never submitted, forms nobody opens. */
(function (HR) {
  'use strict';

  const looksLikeConfig = peek => !!peek && typeof peek === 'object' && !Array.isArray(peek) &&
    peek.kind === 'helloid-sa-config' && Array.isArray(peek.dataSources);

  const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const lc = s => String(s == null ? '' : s).toLowerCase();
  const PRODUCT_EVENTS = ['onRequest', 'onApprove', 'onDeny', 'onReturn', 'onWithdrawn'];

  /* ------------------------------------------------------------ PowerShell text */

  /** Blank out comments (and, when asked, single-quoted strings) without moving
      anything: offsets and line numbers stay valid for every later regex. */
  function blank(src, dropSingle) {
    const s = String(src || '');
    let out = '', i = 0;
    const keep = ch => (ch === '\n' ? '\n' : ' ');
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (c === '<' && n === '#') {                       // block comment
        const end = s.indexOf('#>', i + 2);
        const stop = end < 0 ? s.length : end + 2;
        for (; i < stop; i++) out += keep(s[i]);
        continue;
      }
      if (c === '@' && (n === "'" || n === '"') && /\r?\n/.test(s.slice(i + 2, i + 4))) {   // here-string
        const close = '\n' + n + '@';
        const end = s.indexOf(close, i + 2);
        const stop = end < 0 ? s.length : end + close.length;
        if (n === "'" && dropSingle) { for (; i < stop; i++) out += keep(s[i]); }
        else { out += s.slice(i, stop); i = stop; }
        continue;
      }
      if (c === '#') {                                     // line comment
        while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === "'") {                                     // verbatim string
        let j = i + 1;
        while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") break; j++; }
        const stop = Math.min(s.length, j + 1);
        if (dropSingle) { out += "'"; for (i++; i < stop - 1; i++) out += keep(s[i]); out += stop > i ? "'" : ''; i = stop; }
        else { out += s.slice(i, stop); i = stop; }
        continue;
      }
      if (c === '"') {                                     // expandable string: copy, skip escapes
        let j = i + 1;
        while (j < s.length && s[j] !== '"') { if (s[j] === '`') j++; j++; }
        const stop = Math.min(s.length, j + 1);
        out += s.slice(i, stop); i = stop;
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  const lineAt = (text, idx) => { let n = 1; for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

  /** Comment-free, whitespace-collapsed, lower-cased lines: the unit clone detection compares. */
  function normLines(src) {
    return blank(src, false).split('\n').map(l => l.trim().replace(/\s+/g, ' ').toLowerCase()).filter(l => l && l !== '{' && l !== '}');
  }

  /* Variables PowerShell or HelloID provide without the script assigning them. */
  const AUTOMATIC = new Set(['_', 'psitem', 'null', 'true', 'false', 'args', 'input', 'this', 'error', 'matches', 'lastexitcode',
    'host', 'home', 'pwd', 'pid', 'profile', 'shellid', 'stacktrace', 'executioncontext', 'myinvocation', 'psboundparameters',
    'pscmdlet', 'pscommandpath', 'psscriptroot', 'psversiontable', 'pshome', 'psculture', 'psuiculture', 'psitem', 'foreach',
    'switch', 'sender', 'event', 'eventargs', 'eventsubscriber', 'ofs', 'nestedpromptlevel', 'iswindows', 'islinux', 'ismacos',
    'iscoreclr', 'pssenderinfo', 'psdebugcontext', 'consolefilename', 'psemailserver', 'psdefaultparametervalues',
    'psmoduleautoloadingpreference', 'psnativecommandargumentpassing', 'pssessionapplicationname', 'pssessionconfigurationname',
    'pssessionoption', 'psstyle', 'maximumhistorycount', 'erroractionpreference', 'warningpreference', 'verbosepreference',
    'debugpreference', 'informationpreference', 'progresspreference', 'confirmpreference', 'whatifpreference',
    'errorview', 'formatenumerationlimit', 'logcommandhealthevent', 'outputencoding',
    /* HelloID Service Automation */
    'form', 'datasource', 'requester', 'requestedfor', 'product', 'request', 'manager', 'resourceownergroup', 'portalbaseurl']);

  function balanced(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { depth--; if (!depth) return text.slice(open + 1, i); }
    }
    return text.slice(open + 1);
  }

  /** Which variables a script reads and which it gives a value. Names are
      lower-cased (PowerShell is case-insensitive); `spell` keeps every spelling. */
  function varsOf(src) {
    const code = blank(src, true);
    const reads = new Map(), readsAt = new Map(), assigned = new Set(), spell = new Map();
    const note = (name, idx) => {
      const k = name.toLowerCase();
      if (!reads.has(k)) reads.set(k, lineAt(code, idx));
      if (!readsAt.has(k)) readsAt.set(k, []);
      readsAt.get(k).push(idx);
      if (!spell.has(k)) spell.set(k, new Map());
      const m = spell.get(k); m.set(name, (m.get(name) || 0) + 1);
    };
    let m;
    const READ = /(`?)\$(?:\{([^}]+)\}|(?:(global|script|local|private|using):)?([A-Za-z_]\w*)(?::(?!:))?)/g;
    while ((m = READ.exec(code))) {
      if (m[1]) continue;                                   // escaped `$
      const name = m[2] || m[4];
      if (!name) continue;
      if (code[m.index + m[0].length - 1] === ':' && !m[3]) continue;   // $env:X, $function:X — a drive, not a variable
      note(name, m.index);
    }
    const ASSIGN = /\$(?:(?:global|script|local|private):)?([A-Za-z_]\w*)\s*(?:[+\-*/%]|\?\?)?=(?!=)/g;
    while ((m = ASSIGN.exec(code))) assigned.add(m[1].toLowerCase());
    const MULTI = /((?:\$[A-Za-z_]\w*\s*,\s*)+\$[A-Za-z_]\w*)\s*=(?!=)/g;
    while ((m = MULTI.exec(code))) m[1].replace(/\$(\w+)/g, (_, v) => assigned.add(v.toLowerCase()));
    const FOREACH = /foreach\s*\(\s*\$(\w+)\s+in\b/gi;
    while ((m = FOREACH.exec(code))) assigned.add(m[1].toLowerCase());
    const PARAM = /\bparam\s*\(/gi;
    while ((m = PARAM.exec(code))) balanced(code, m.index + m[0].length - 1).replace(/\$(\w+)/g, (_, v) => assigned.add(v.toLowerCase()));
    const FN = /\bfunction\s+[\w-]+\s*\(/gi;
    while ((m = FN.exec(code))) balanced(code, m.index + m[0].length - 1).replace(/\$(\w+)/g, (_, v) => assigned.add(v.toLowerCase()));
    const REF = /\[ref\]\s*\$(\w+)/gi;
    while ((m = REF.exec(code))) assigned.add(m[1].toLowerCase());
    const OUTVAR = /-(?:OutVariable|ErrorVariable|WarningVariable|InformationVariable|PipelineVariable|ov|ev|wv|iv|pv)\s*:?\s*['"]?\+?(\w+)/gi;
    while ((m = OUTVAR.exec(code))) assigned.add(m[1].toLowerCase());
    const SETVAR = /\b(?:Set|New)-Variable\s+(?:-Name\s+)?['"]?(\w+)/gi;
    while ((m = SETVAR.exec(code))) assigned.add(m[1].toLowerCase());
    return { reads, readsAt, assigned, spell, code, catches: catchRanges(code) };
  }

  /** Offsets of every catch { … } body: a variable only read in there only spoils a log line. */
  function catchRanges(code) {
    const out = [];
    const re = /\bcatch\b[^{]*\{/gi;
    let m;
    while ((m = re.exec(code))) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}' && !--depth) break; }
      out.push([m.index, i]);
    }
    return out;
  }

  /* Members every object has; reading them says nothing about the data source's model. */
  const MEMBERS = new Set(['count', 'length', 'tostring', 'gettype', 'psobject', 'trim', 'where', 'foreach', 'split', 'replace',
    'tolower', 'toupper', 'substring', 'contains', 'equals', 'gethashcode', 'value', 'keys', 'values', 'name']);

  /** `$root.key.prop` reads, also through one alias (`$user = $form.gridUsers` … `$user.ObjectGuid`). */
  function propReads(code, root) {
    const out = [];
    const direct = new RegExp('\\$' + root + '\\.(\\w+)\\.(\\w+)', 'gi');
    let m;
    while ((m = direct.exec(code))) out.push({ key: m[1], prop: m[2], idx: m.index });
    const alias = new RegExp('\\$(\\w+)\\s*=\\s*\\$' + root + '\\.(\\w+)\\s*(?:[;\\r\\n]|$)', 'gi');
    while ((m = alias.exec(code))) {
      const name = m[1], key = m[2];
      const use = new RegExp('\\$' + name + '\\.(\\w+)', 'gi');
      let u;
      while ((u = use.exec(code))) out.push({ key, prop: u[1], idx: u.index });
    }
    return out.filter(r => !MEMBERS.has(r.prop.toLowerCase()));
  }

  /* ------------------------------------------------------------- script output */

  /** Top-level keys of the hashtable literal whose '{' sits at `open`. */
  function hashKeys(code, open) {
    const keys = [];
    let depth = 0, start = open + 1;
    const take = (a, b) => { const m = code.slice(a, b).match(/^\s*['"]?([A-Za-z_][\w-]*)['"]?\s*=/); if (m) keys.push(m[1]); };
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === '{' || c === '(' || c === '[') { depth++; continue; }
      if (c === '}' || c === ')' || c === ']') { depth--; if (!depth) { take(start, i); break; } continue; }
      if (depth === 1 && (c === ';' || c === '\n')) { take(start, i); start = i + 1; }
    }
    return keys;
  }

  /** The text of one statement from `from`: up to a newline or ';' outside brackets. */
  function statement(code, from) {
    let depth = 0, i = from;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') { if (!depth) break; depth--; }
      else if (!depth && (c === '\n' || c === ';')) break;
    }
    return code.slice(from, i);
  }

  const splitTop = text => {
    const out = []; let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      else if (c === ',' && !depth) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out.map(x => x.trim()).filter(Boolean);
  };

  /**
   * What a PowerShell data source returns, read from its code: the keys of hashtables
   * it writes out, the properties its Select-Object picks (also through a variable such
   * as $propertiesToSelect), and Add-Member note properties. `exact` says the casing is
   * fixed by the script (a hashtable key); Select-Object takes the casing of the source
   * object at run time, so those names are only known case-insensitively. `complete`
   * says every output statement was understood; only then can the script be said not
   * to return something.
   */
  /* A task that changes something (AD, Exchange, Graph, HelloID or any REST write). */
  const MUTATE_ANY = /\b(?:Add|New|Remove|Disable|Enable|Set|Revoke|Grant|Delete|Clear|Move|Rename|Unlock|Update)-(?!Object\b|Type\b|Member\b|Variable\b|TimeSpan\b)\w+|-Method\s+['"]?(?:Delete|Post|Put|Patch)|\bMethod\s*=\s*['"](?:Delete|Post|Put|Patch)/i;

  /** [start, end] of every `function Name { … }` body in comment-blanked code. */
  function functionBodies(code) {
    const out = [];
    const FN = /\bfunction\s+[\w-]+\s*(?:\([^)]*\))?\s*\{/gi;
    let m;
    while ((m = FN.exec(code))) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}' && --depth === 0) break; }
      out.push([m.index, i]);
    }
    return out;
  }

  function outputsOf(src) {
    const code = blank(src, false);
    const props = new Map();
    let complete = true, any = false;
    const put = (name, exact) => {
      if (!name) return;
      any = true;
      const k = name.toLowerCase(), cur = props.get(k);
      if (!cur) props.set(k, { name, exact: !!exact, spellings: new Set([name]) });
      else { cur.spellings.add(name); if (exact && !cur.exact) { cur.exact = true; cur.name = name; } }
    };
    const assignments = name => {
      const out = [];
      const re = new RegExp('\\$' + name + '\\s*=(?!=)', 'gi');
      let m;
      while ((m = re.exec(code))) out.push(statement(code, m.index + m[0].length).trim());
      return out;
    };
    const arrayStrings = name => {
      const vals = [];
      assignments(name).forEach(rhs => rhs.replace(/["']([^"'$]+)["']/g, (_, v) => vals.push(v)));
      return vals;
    };
    function selectProps(args) {
      let a = args.split(/\|/)[0];
      if (/-ExpandProperty\b/i.test(a)) { complete = false; return; }
      a = a.replace(/-(?:First|Last|Skip)\s+\d+/gi, '').replace(/-(?:Unique|Property)\b/gi, '');
      splitTop(a).forEach(tok => {
        if (/^@\{/.test(tok)) { const m = tok.match(/\b(?:Name|n|Label|l)\s*=\s*['"]([^'"]+)['"]/i); if (m) put(m[1], true); else complete = false; return; }
        const v = tok.match(/^\$(\w+)$/);
        if (v) { const vals = arrayStrings(v[1]); if (vals.length) vals.forEach(x => put(x, false)); else complete = false; return; }
        const w = tok.match(/^['"]?([A-Za-z_][\w-]*)['"]?$/);
        if (w) put(w[1], false); else complete = false;
      });
    }
    const seenVar = new Set();
    function fromRhs(rhs) {
      const h = rhs.match(/^(?:\(?\s*\[pscustomobject\]\s*)?@\{/i);
      if (h) { hashKeys(rhs, rhs.indexOf('{', h.index)).forEach(k => put(k, true)); return true; }
      const sel = rhs.match(/\bSelect-Object\b([^|]*)/i);
      if (sel) { selectProps(sel[1]); return true; }
      const v = rhs.match(/^\$(\w+)\b/);
      if (v) return resolve(v[1]);
      return false;
    }
    function resolve(name) {
      const k = name.toLowerCase();
      if (k === '_' || k === 'psitem') return false;
      if (seenVar.has(k)) return true;
      seenVar.add(k);
      let ok = false;
      assignments(name).forEach(rhs => { if (fromRhs(rhs)) ok = true; });
      const fe = new RegExp('foreach\\s*\\(\\s*\\$' + name + '\\s+in\\s+\\$(\\w+)', 'i').exec(code);
      if (fe && resolve(fe[1])) ok = true;
      /* A collection filled with .Add / .AddRange / += takes what was added. */
      const fill = new RegExp('\\$' + name + '\\s*(?:\\.(?:Add|AddRange)\\(\\s*|\\+=\\s*)(?:\\[\\w.]+\\])?\\$(\\w+)', 'gi');
      let f;
      while ((f = fill.exec(code))) if (resolve(f[1])) ok = true;
      const hashAdd = new RegExp('\\$' + name + '\\.(?:Add\\(\\s*[\'"]([\\w-]+)[\'"]|([A-Za-z_]\\w*)\\s*=(?!=))', 'gi');
      let m;
      while ((m = hashAdd.exec(code))) { put(m[1] || m[2], true); ok = true; }
      return ok;
    }
    /* Add-Member note properties, wherever they are added. */
    code.replace(/Add-Member\b[^\n]*?-(?:NotePropertyName|Name)\s+['"]?([\w-]+)/gi, (_, n) => { put(n, true); return _; });

    /* What a function writes goes back to its caller, not to the form. */
    const fnBodies = functionBodies(code);
    const OUT = /\b(?:Write-Output|return)\b[ \t]*(?:-InputObject\s+)?([^\n;]*)/gi;
    let m;
    while ((m = OUT.exec(code))) {
      if (fnBodies.some(([a, b]) => m.index > a && m.index < b)) continue;
      const expr = m[1].trim().replace(/[\s})]+$/, '');
      if (!expr) continue;
      if (/^\(?\s*(?:\[pscustomobject\]\s*)?@\{/i.test(expr)) {
        const at = code.indexOf('{', m.index + m[0].length - m[1].length);
        hashKeys(code, at).forEach(k => put(k, true));
        continue;
      }
      if (/^["']/.test(expr)) { put('output', false); complete = false; continue; }
      const v = expr.match(/^\$(\w+)\s*$/);
      if (v && /^(_|psitem)$/i.test(v[1])) {
        /* $_ inside a ForEach-Object: what was piped in. */
        const before = code.slice(0, m.index);
        let src = null, mm;
        const pipe = /\$(\w+)\s*\|(?:[^|\n{]*\|)*\s*(?:ForEach-Object|%|foreach)\b/gi;
        while ((mm = pipe.exec(before))) src = mm[1];
        if (!src || !resolve(src)) complete = false;
        continue;
      }
      if (v) { if (!resolve(v[1])) complete = false; continue; }
      complete = false;
    }
    /* A pipeline ending in Select-Object on its own line is output too. */
    const IMPLICIT = /^[ \t]*\$\w+\s*\|\s*Select-Object\b([^\n]*)$/gim;
    while ((m = IMPLICIT.exec(code))) selectProps(m[1]);
    const IMPLICIT2 = /^[ \t]*(?:Get-\w+|Search-\w+)\b[^\n]*\|\s*Select-Object\b([^\n]*)$/gim;
    while ((m = IMPLICIT2.exec(code))) selectProps(m[1]);
    return { props, complete: complete && any };
  }

  /* --------------------------------------------------------------- dynamic forms */

  /** Every field in a schema, steps and form rows included, with the step it sits in. */
  function fieldsOf(schema) {
    const out = [];
    const walk = (o, step) => {
      if (Array.isArray(o)) { o.forEach(x => walk(x, step)); return; }
      if (!o || typeof o !== 'object') return;
      const isField = typeof o.key === 'string' && typeof o.type === 'string';
      if (isField && o.type !== 'formrow') out.push({ field: o, step });
      const nextStep = !isField && Array.isArray(o.fields) && o.label ? o.label : step;
      if (Array.isArray(o.fields)) walk(o.fields, nextStep);
      if (Array.isArray(o.fieldGroup)) walk(o.fieldGroup, nextStep);
    };
    walk(schema || [], null);
    return out;
  }

  /** The data-source bindings of one field: the primary one and, for a dual list, the destination. */
  function bindingsOf(field) {
    const to = field.templateOptions || {};
    const b = [];
    if (to.dataSourceConfig && to.dataSourceConfig.dataSourceGuid) b.push({ role: 'source', cfg: to.dataSourceConfig });
    if (to.destinationDataSourceConfig && to.destinationDataSourceConfig.dataSourceGuid) b.push({ role: 'destination', cfg: to.destinationDataSourceConfig });
    return b;
  }

  /** Which model properties a field reads off its data source. */
  function propsRead(field) {
    const to = field.templateOptions || {};
    const out = [];
    if (to.grid && Array.isArray(to.grid.columns)) to.grid.columns.forEach(c => c && c.field && out.push({ prop: c.field, via: 'column' }));
    ['valueField', 'textField', 'displayField'].forEach(k => { if (to[k]) out.push({ prop: to[k], via: k }); });
    if (to.dualList) ['optionKeyProperty', 'optionDisplayProperty'].forEach(k => { if (to.dualList[k]) out.push({ prop: to.dualList[k], via: k }); });
    return out;
  }

  /** What a data source hands the form: inferred from its script, its static rows, or
      (native sources) the model HelloID keeps. */
  function dsOutput(d) {
    if (d.type === 4) return outputsOf(d.script);
    const props = new Map();
    const put = n => { if (n && !props.has(n.toLowerCase())) props.set(n.toLowerCase(), { name: n, exact: true, spellings: new Set([n]) }); };
    if (d.type === 2 && Array.isArray(d.value)) { d.value.forEach(r => r && typeof r === 'object' && Object.keys(r).forEach(put)); return { props, complete: props.size > 0 }; }
    d.model.forEach(put);
    return { props, complete: props.size > 0 };
  }

  /** Does the data source deliver `prop` to the form? 'ok', 'case' (only with other
      capitals) or 'missing', and whether that verdict rests on the script (certain)
      or only on the stored model. */
  function delivers(d, prop) {
    const k = prop.toLowerCase();
    const o = d.out, hit = o.props.get(k);
    if (o.complete) {
      if (!hit) return { state: 'missing', certain: true };
      if (hit.spellings.has(prop)) return { state: 'ok' };
      /* A hashtable key fixes the casing; Select-Object most likely keeps the spelling it was given. */
      if (!hit.exact && d.model.includes(prop)) return { state: 'ok' };
      return { state: 'case', certain: hit.exact, near: hit.name };
    }
    if (d.model.includes(prop) || (hit && (!hit.exact || hit.spellings.has(prop)))) return { state: 'ok' };
    const near = (hit && hit.name) || d.model.find(x => x.toLowerCase() === k);
    return near ? { state: 'case', certain: false, near } : { state: 'missing', certain: false };
  }
  const deliverList = d => (d.out.complete ? [...d.out.props.values()].map(p => p.name) : d.model).slice(0, 12).join(', ');
  const deliversAny = (d, prop) => d.model.some(x => x.toLowerCase() === prop.toLowerCase()) || d.out.props.has(prop.toLowerCase());

  /* ------------------------------------------------------------------- analyse */

  function analyse(cfg, opts) {
    opts = opts || {};
    const findings = [];
    const add = (rule, sev, target, p, extra) => findings.push(Object.assign({ rule, sev, target, p: p || {} }, extra || {}));

    const variables = (cfg.variables || []).map(v => ({
      name: String(v.name || ''), value: v.value, secret: v.secret === true || v.secret === 'True' || v.secret === 'true',
      isSystem: !!v.isSystem, guid: v.automationVariableGuid
    }));
    const libByLc = new Map(variables.map(v => [v.name.toLowerCase(), v]));
    const pools = new Set((cfg.agentPools || []).map(p => p.agentPoolGUID || p.id).filter(Boolean).map(lc));

    /* Data sources, by GUID; dynamic forms, by both their GUID and their original GUID. */
    const dsByGuid = new Map();
    (cfg.dataSources || []).forEach(d => dsByGuid.set(lc(d.dataSourceGUID), {
      guid: d.dataSourceGUID, name: d.name || '(unnamed)', type: d.type, runInCloud: !!d.runInCloud,
      model: (d.model || []).map(x => x && x.key).filter(Boolean), input: (d.input || []).map(x => x && x.key).filter(Boolean),
      script: d.type === 4 ? (d.script || '') : '', value: d.value, usedBy: []
    }));
    dsByGuid.forEach(d => { d.out = dsOutput(d); });
    const formByGuid = new Map();
    const forms = (cfg.dynamicForms || []).map(f => {
      const form = { guid: f.dynamicFormGUID, original: f.formOriginalGUID || f.dynamicFormGUID, name: f.name || '(unnamed)',
        version: f.version, fields: fieldsOf(f.formSchema), usedBy: [] };
      formByGuid.set(lc(form.guid), form);
      if (form.original) formByGuid.set(lc(form.original), form);
      (f.versionGUIDs || []).forEach(g => formByGuid.set(lc(g), form));   // older versions entries still point at
      return form;
    });

    /* Things a user can start: delegated forms and products. */
    const catNames = new Map();
    (cfg.delegatedFormCategories || []).forEach(c => {
      const n = c.name && typeof c.name === 'object' ? (c.name.en || Object.values(c.name).find(Boolean)) : c.name;
      catNames.set(lc(c.delegatedFormCategoryGuid), n || '');
    });
    const entries = [];
    (cfg.delegatedForms || []).forEach(d => {
      const form = d.dynamicFormGUID ? formByGuid.get(lc(d.dynamicFormGUID)) : null;
      const e = { type: 'delegated', id: d.delegatedFormGUID, name: d.name || '(unnamed)', enabled: d.isEnabled !== false,
        formGuid: d.dynamicFormGUID || null, form, accessGroups: (d.accessGroups || []).map(g => g.name || g.groupGUID),
        categories: (d.categoryGuids || []).map(g => catNames.get(lc(g)) || g), task: d.task || null, scripts: [] };
      entries.push(e);
      if (form) form.usedBy.push(e);
    });
    (cfg.products || []).forEach(pr => {
      const fid = pr.dynamicForm && (pr.dynamicForm.id || pr.dynamicForm.dynamicFormGUID);
      const form = fid ? formByGuid.get(lc(fid)) : null;
      const tasks = [];
      PRODUCT_EVENTS.forEach(ev => (pr[ev] || []).forEach(t => tasks.push(Object.assign({ event: ev }, t))));
      const e = { type: 'product', id: pr.productId, name: pr.name || '(unnamed)', code: pr.code, enabled: true,
        formGuid: fid || null, form, accessGroups: (pr.accessGroups || []).map(g => g.name || g.id), visibility: pr.visibility,
        categories: (pr.categories || []).map(c => c.name || c.id), tasks, actions: pr.actions || [],
        agentPoolId: pr.agentPool && pr.agentPool.id, scripts: [] };
      entries.push(e);
      if (form) form.usedBy.push(e);
    });
    const entryByForm = new Map();   // form guid → first entry using it (for targets)
    entries.forEach(e => { if (e.form && !entryByForm.has(e.form.guid)) entryByForm.set(e.form.guid, e); });

    const tgtEntry = e => ({ type: e.type, id: e.id, name: e.name });
    const tgtForm = f => { const e = entryByForm.get(f.guid); return e ? tgtEntry(e) : { type: 'form', id: f.guid, name: f.name }; };
    const tgtDs = d => ({ type: 'datasource', id: d.guid, name: d.name });

    /* Script units: everything PowerShell that runs. */
    const scripts = [];
    dsByGuid.forEach(d => { if (d.type === 4) scripts.push({ id: 'ds:' + d.guid, kind: 'datasource', name: d.name, script: d.script,
      runInCloud: d.runInCloud, ds: d, target: tgtDs(d) }); });
    entries.forEach(e => {
      if (e.type === 'delegated' && e.task && e.task.script) {
        const s = { id: 'df:' + e.id, kind: 'formtask', name: e.name, script: e.task.script, runInCloud: !!e.task.runInCloud,
          agentPoolId: e.task.agentPoolId, entry: e, target: tgtEntry(e) };
        scripts.push(s); e.scripts.push(s);
      }
      if (e.type === 'product') e.tasks.forEach(t => {
        if (!t.script) return;
        const s = { id: 'pt:' + (t.id || e.id + ':' + t.event), kind: 'producttask', name: e.name + ' › ' + (t.name || t.event),
          event: t.event, script: t.script, runInCloud: !!t.runInCloud, agentPoolId: t.agentPoolId, entry: e, target: tgtEntry(e),
          localVars: (t.variables || []).map(v => lc(v.name)) };
        scripts.push(s); e.scripts.push(s);
      });
    });
    (cfg.scheduledTasks || []).forEach(t => {
      const src = t.script || (t.powerShellScript) || (t.metaData && t.metaData.script) || '';
      if (!src) return;
      scripts.push({ id: 'st:' + (t.automationTaskGuid || t.id), kind: 'scheduled', name: t.name || '(unnamed)', script: src,
        runInCloud: !!t.runInCloud, agentPoolId: t.agentPoolGUID, localVars: (t.variables || []).map(v => lc(v.name)),
        target: { type: 'scheduled', id: t.automationTaskGuid || t.id, name: t.name } });
    });
    scripts.forEach(s => {
      s.lines = String(s.script).split('\n').length;
      s.vars = varsOf(s.script);
      s.norm = normLines(s.script);
      s.cluster = null;
    });

    /* --------------------------------------------------------------- form rules */
    const bindings = [];
    forms.forEach(form => {
      const keys = new Set(form.fields.map(x => x.field.key));
      const keysLc = new Set([...keys].map(lc));
      const tgt = tgtForm(form);
      const bools = new Set(form.fields.filter(x => x.field.type === 'boolean').map(x => x.field.key));
      form.fields.forEach(({ field, step }) => {
        const to = field.templateOptions || {};
        const where = { form: form.name, field: field.key, step };
        /* Data sources: exist, deliver what the field reads, accept what the form feeds them. */
        bindingsOf(field).forEach(({ cfg: bc }) => {
          const ds = dsByGuid.get(lc(bc.dataSourceGuid));
          if (!ds) { add('form.ds.missing', 'high', tgt, { field: field.key, guid: bc.dataSourceGuid }, { where }); return; }
          if (!ds.usedBy.includes(form)) ds.usedBy.push(form);
          bindings.push({ form, field, ds, pis: ((bc.input && bc.input.propertyInputs) || []).filter(Boolean), tgt, where });
          ((bc.input && bc.input.propertyInputs) || []).forEach(pi => {
            if (!pi) return;
            if (ds.input.length && pi.propertyName && !ds.input.some(k => lc(k) === lc(pi.propertyName))) {
              add('form.ds.input', 'medium', tgt, { field: field.key, ds: ds.name, prop: pi.propertyName, known: ds.input.join(', ') }, { where });
            }
            const other = pi.otherFieldValue && pi.otherFieldValue.otherFieldKey;
            if (other && !keys.has(other)) add('form.ref', 'high', tgt, { field: field.key, ref: other, how: 'input' }, { where });
          });
        });
        const primary = to.dataSourceConfig && dsByGuid.get(lc(to.dataSourceConfig.dataSourceGuid));
        if (primary && (primary.model.length || primary.out.complete) && (to.useDataSource !== false || field.type === 'grid' || field.type === 'multiselectgrid' || field.type === 'duallist')) {
          propsRead(field).forEach(({ prop, via }) => {
            const v = delivers(primary, prop);
            if (v.state === 'ok') return;
            add(v.state === 'case' ? 'form.model.case' : 'form.model', v.certain ? 'high' : 'medium', tgt,
              { field: field.key, prop, via, ds: primary.name, near: v.near || '', model: deliverList(primary) },
              { where, basis: v.certain ? 'script' : 'model' });
          });
        }
        /* References to other fields. */
        const refs = [];
        if (typeof field.hideExpression === 'string') field.hideExpression.replace(/model\[\s*["']([^"']+)["']\s*\]|model\.(\w+)/g, (_, a, b) => refs.push(a || b));
        if (to.useDependOn && to.dependOn) refs.push(to.dependOn);
        refs.forEach(r => { if (!keys.has(r)) add('form.ref', 'high', tgt, { field: field.key, ref: r, how: 'show' }, { where }); });
        /* A field a checkbox reveals that nobody has to fill in. */
        const reveal = typeof field.hideExpression === 'string' && field.hideExpression.match(/^\s*!\s*model\[\s*["']([^"']+)["']\s*\]\s*$/);
        if (reveal && bools.has(reveal[1]) && !to.required && !['boolean', 'formrow'].includes(field.type) && !to.readonly) {
          add('form.reveal.required', 'medium', tgt, { field: field.key, toggle: reveal[1] }, { where });
        }
        /* A choice list without anything real to choose. */
        if (['dropdown', 'radio'].includes(field.type) && !to.useDataSource) {
          const opts2 = Array.isArray(to.options) ? to.options : [];
          const label = o => typeof o === 'object' && o ? (o.text || o.label || o.value || o.name) : o;
          if (!opts2.length || opts2.every(o => /^option \d+$/i.test(String(label(o)).trim()))) {
            add('form.choice.placeholder', 'medium', tgt, { field: field.key, n: opts2.length }, { where });
          }
        }
        if (to.useDataSource && ['dropdown', 'radio', 'duallist', 'grid', 'multiselectgrid'].includes(field.type) && !bindingsOf(field).length) {
          add('form.choice.nosource', 'high', tgt, { field: field.key }, { where });
        }
      });
      form.keysLc = keysLc;
    });

    /* Delegated form task reads $form.<key> the form does not have. */
    entries.forEach(e => e.scripts.forEach(s => {
      if (!e.form) return;
      const code = s.vars.code;
      const seen = new Set();
      code.replace(/\$form\.(\w+)/gi, (all, key, idx) => {
        if (seen.has(lc(key)) || e.form.keysLc.has(lc(key))) return all;
        seen.add(lc(key));
        add('script.form.key', 'high', s.target, { key, script: s.name }, { script: s.id, line: lineAt(code, idx) });
        return all;
      });
    }));

    /* The chain form → input → script. A field whose value is a grid row or a dropdown
       item hands the whole object on; the script can only read properties that the
       data source behind that field returns. */
    const fieldModel = (form, key) => {
      const hit = form.fields.find(x => x.field.key === key);
      if (!hit || !['grid', 'dropdown'].includes(hit.field.type)) return null;
      const g = ((hit.field.templateOptions || {}).dataSourceConfig || {}).dataSourceGuid;
      const d = g && dsByGuid.get(lc(g));
      return d && (d.model.length || d.out.props.size) ? { field: hit.field, ds: d } : null;
    };
    const dsScripts = new Map(scripts.filter(x => x.ds).map(x => [x.ds, x]));
    bindings.forEach(b => {
      const sc = dsScripts.get(b.ds);
      if (!sc) return;
      const code = sc.vars.code;
      /* Inputs the script reads that this form does not pass. */
      const fed = new Set(b.pis.map(pi => lc(pi.propertyName)));
      const seen = new Set();
      code.replace(/\$datasource\.(\w+)/gi, (all, key, idx) => {
        const k = lc(key);
        if (seen.has(k) || fed.has(k) || !b.ds.input.some(x => lc(x) === k)) return all;
        seen.add(k);
        add('form.ds.unfed', 'medium', b.tgt, { field: b.field.key, ds: b.ds.name, input: key }, { where: b.where, script: sc.id, line: lineAt(code, idx) });
        return all;
      });
      /* Properties read off a passed grid row / dropdown item that its data source does not return. */
      b.pis.forEach(pi => {
        const other = pi.otherFieldValue && pi.otherFieldValue.otherFieldKey;
        const src = other && fieldModel(b.form, other);
        if (!src) return;
        const done = new Set();
        propReads(code, 'datasource').filter(r => lc(r.key) === lc(pi.propertyName)).forEach(r => {
          if (done.has(lc(r.prop)) || deliversAny(src.ds, r.prop)) return;
          done.add(lc(r.prop));
          add('form.chain.prop', src.ds.out.complete ? 'high' : 'medium', b.tgt, { field: b.field.key, input: pi.propertyName, prop: r.prop, src: other, ds: src.ds.name,
            model: deliverList(src.ds) }, { where: b.where, script: sc.id, line: lineAt(code, r.idx) });
        });
      });
    });
    entries.forEach(e => e.scripts.forEach(s => {
      if (!e.form) return;
      const code = s.vars.code;
      const done = new Set();
      propReads(code, 'form').forEach(r => {
        const src = fieldModel(e.form, r.key);
        const k = lc(r.key + '.' + r.prop);
        if (!src || done.has(k) || deliversAny(src.ds, r.prop)) return;
        done.add(k);
        add('script.form.prop', src.ds.out.complete ? 'high' : 'medium', s.target, { key: r.key, prop: r.prop, ds: src.ds.name, model: deliverList(src.ds) },
          { script: s.id, line: lineAt(code, r.idx) });
      });
    }));

    /* ------------------------------------------------------------- entry rules */
    entries.forEach(e => {
      const tgt = tgtEntry(e);
      if (e.formGuid && !e.form) add('entry.form.missing', e.type === 'delegated' ? 'critical' : 'high', tgt, { guid: e.formGuid });
      if (e.type === 'delegated') {
        if (!e.formGuid) add('entry.form.missing', 'critical', tgt, { guid: '—' });
        if (e.enabled && !e.accessGroups.length) add('entry.access', 'high', tgt, {});
        if (e.enabled && !e.categories.length) add('entry.category', 'low', tgt, {});
        if (!e.task || !String(e.task.script || '').trim()) add('entry.notask', 'medium', tgt, {});
      } else {
        if (!e.categories.length) add('entry.category', 'low', tgt, {});
        if (lc(e.visibility) !== 'all' && !e.accessGroups.length) add('entry.access', 'high', tgt, {});
        if (!e.tasks.length && !e.actions.length) add('product.notask', 'info', tgt, {});
      }
    });
    /* Same name twice: lookups by name (and people) cannot tell them apart. */
    const dupes = (items, kind) => {
      const by = new Map();
      items.forEach(x => { const k = lc(x.name).trim(); if (!by.has(k)) by.set(k, []); by.get(k).push(x); });
      by.forEach(list => { if (list.length > 1) add('name.dup', 'low', list[0].target || list[0], { kind, name: list[0].name, n: list.length, spellings: [...new Set(list.map(x => x.name))].join(' / ') }); });
    };
    dupes([...dsByGuid.values()].map(d => ({ name: d.name, target: tgtDs(d) })), 'datasource');
    dupes(entries.filter(e => e.type === 'delegated').map(e => ({ name: e.name, target: tgtEntry(e) })), 'delegated');
    dupes(entries.filter(e => e.type === 'product').map(e => ({ name: e.name, target: tgtEntry(e) })), 'product');

    /* The stored model against what the script really returns. */
    dsByGuid.forEach(d => {
      if (d.type !== 4 || !d.out.complete) return;
      const outs = [...d.out.props.values()].filter(p => p.name !== 'output');
      if (!outs.length) return;
      const ml = new Set(d.model.map(lc));
      const added = outs.filter(p => !ml.has(lc(p.name))).map(p => p.name);
      const gone = d.model.filter(k => !d.out.props.has(lc(k)));
      const recased = outs.filter(p => p.exact && ml.has(lc(p.name)) && !d.model.includes(p.name))
        .map(p => d.model.find(k => lc(k) === lc(p.name)) + ' \u2192 ' + p.name);
      if (added.length || gone.length || recased.length) add('ds.model.stale', 'low', tgtDs(d), { added: added.join(', ') || '\u2014',
        gone: gone.slice(0, 12).join(', ') + (gone.length > 12 ? ', \u2026' : '') || '\u2014', recased: recased.join(', ') || '\u2014' },
        { script: 'ds:' + d.guid });
    });

    /* Orphans: built, never reachable. */
    dsByGuid.forEach(d => { if (!d.usedBy.length) add('orphan.ds', 'low', tgtDs(d), {}); });
    const seenForm = new Set();
    forms.forEach(f => {
      if (seenForm.has(f.original)) return; seenForm.add(f.original);
      if (!f.usedBy.length) add('orphan.form', 'low', { type: 'form', id: f.guid, name: f.name }, {});
    });

    /* ------------------------------------------------------------ script rules */
    const libUse = new Map();   // variable lc → Set(script id)
    scripts.forEach(s => {
      const code = s.vars.code;
      const raw = blank(s.script, false);   // comments out, strings kept: literals are what these rules look for
      const lineOf = re => { const m = re.exec(code); return m ? lineAt(code, m.index) : null; };
      const lineOfRaw = re => { const m = re.exec(raw); return m ? lineAt(raw, m.index) : null; };
      const local = new Set(s.localVars || []);
      const dsInputs = s.ds ? new Set(s.ds.input.map(lc)) : null;

      /* Library variables used, and anything read that nothing defines. */
      s.vars.reads.forEach((line, name) => {
        if (libByLc.has(name)) { if (!libUse.has(name)) libUse.set(name, new Set()); libUse.get(name).add(s.id); return; }
        if (s.vars.assigned.has(name) || AUTOMATIC.has(name) || local.has(name)) return;
        if (/preference$/.test(name)) return;
        const shown = [...s.vars.spell.get(name).keys()][0];
        /* Read only behind an emptiness check: an optional library variable this tenant never created. */
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const guarded = new RegExp('IsNullOr(?:Empty|WhiteSpace)\\(\\s*\\$' + esc + '\\s*\\)|\\bif\\s*\\(\\s*(?:-not\\s+|!\\s*)?\\$' + esc + '\\s*\\)', 'i').test(code);
        const lineText = i => code.slice(code.lastIndexOf('\n', i) + 1, (code.indexOf('\n', i) + 1 || code.length + 1) - 1);
        const inCatch = (s.vars.readsAt.get(name) || []).every(i => s.vars.catches.some(([a, b]) => i > a && i < b) ||
          /^\s*(?:Write-(?:Information|Warning|Verbose|Host|Debug|Error)\b|\$?\w*Message\s*=)/i.test(lineText(i)));
        if (guarded) add('script.optional', 'low', s.target, { name: shown, script: s.name }, { script: s.id, line });
        else if (inCatch) add('script.undefined.log', 'low', s.target, { name: shown, script: s.name }, { script: s.id, line });
        else add('script.undefined', 'high', s.target, { name: shown, script: s.name }, { script: s.id, line });
      });
      /* {{variable.x}} placeholders count as use too. */
      raw.replace(/\{\{\s*variable\.(\w+)\s*\}\}/gi, (_, v) => { const k = lc(v); if (!libUse.has(k)) libUse.set(k, new Set()); libUse.get(k).add(s.id); return _; });

      /* $datasource.x the data source never declares as input. */
      if (dsInputs) {
        const seen = new Set();
        code.replace(/\$datasource\.(\w+)/gi, (all, key, idx) => {
          if (seen.has(lc(key)) || dsInputs.has(lc(key))) return all;
          seen.add(lc(key));
          add('script.ds.input', 'medium', s.target, { key, script: s.name, known: s.ds.input.join(', ') || '—' }, { script: s.id, line: lineAt(code, idx) });
          return all;
        });
      }

      /* Patterns. */
      let ln;
      if ((ln = lineOf(/SecurityProtocolType\]::(?:Tls\b|Tls11|Ssl3)|SecurityProtocol\s*=\s*['"]?(?:Tls|Ssl3)\b(?!12|13)/i))) add('script.tls', 'low', s.target, { script: s.name }, { script: s.id, line: ln });
      if ((ln = lineOfRaw(/api\/v1\/(?:selfservice\/products(?:\/(?:\$\w+|\$\([^)]*\)|[0-9a-f-]{36}))?(?=["'`?\s)]|$)|productownership\b)/im))) add('script.endpoint', 'high', s.target, { script: s.name }, { script: s.id, line: ln });
      if ((ln = lineOfRaw(/ConvertTo-SecureString\s+(?:-String\s+)?["'][^"'$]{3,}["']\s+-AsPlainText|\$\w*(?:password|passwd|pwd|secret|apikey|token)\w*\s*=\s*["'][^"'$\s]{6,}["']/i))) {
        add('script.secret', 'critical', s.target, { script: s.name }, { script: s.id, line: ln });
      }
      if ((ln = lineOfRaw(/["'][^"'\n]*\bDC=\w+[^"'\n]*["']|["'][\w.+-]+@(?!odata\.)[\w-]+\.[\w.-]+["']/i))) add('script.hardcoded', 'medium', s.target, { script: s.name }, { script: s.id, line: ln });
      if ((ln = lineOf(/\bWrite-Host\b/i))) add('script.writehost', 'low', s.target, { script: s.name }, { script: s.id, line: ln });
      const calls = /\b(?:Get|Set|New|Remove|Add|Move|Enable|Disable|Unlock|Rename)-(?:AD|Mg|Mailbox|DistributionGroup)\w*|\bInvoke-(?:RestMethod|WebRequest)\b/i;
      if (calls.test(code) && !/\btry\s*\{/i.test(code)) add('script.notry', s.kind === 'datasource' ? 'low' : 'medium', s.target, { script: s.name }, { script: s.id, line: lineOf(new RegExp(calls.source, 'i')) });
      if (s.kind !== 'datasource' && MUTATE_ANY.test(code) && !/-Tags\s+['"]?Audit/i.test(code)) add('script.noaudit', 'low', s.target, { script: s.name }, { script: s.id });

      /* Agent: an on-prem script with no pool to run it, or a pool that is gone. */
      if (!s.runInCloud && !pools.size) add('agent.none', 'critical', s.target, { script: s.name }, { script: s.id });
      else if (!s.runInCloud && s.agentPoolId && !pools.has(lc(s.agentPoolId))) add('agent.pool', 'high', s.target, { script: s.name, pool: s.agentPoolId }, { script: s.id });
    });

    /* ------------------------------------------------- safety and robustness */
    const AD_READ = /\b(?:Get-AD(?:User|Group|Object|Computer|OrganizationalUnit)|Search-ADAccount|Get-ADGroupMember)\b/i;
    const AD_CALL = /\b(?:Get|Set|New|Remove|Add|Move|Enable|Disable|Unlock|Rename|Search|Clear)-AD\w+|\bImport-Module\s+['"]?ActiveDirectory/i;
    const PRIV_OP = /\b(?:Set-ADAccountPassword|Add-ADGroupMember|Add-ADPrincipalGroupMembership|Enable-ADAccount|Unlock-ADAccount)\b/i;
    const MUTATE = /\b(?:Remove|Disable|Set|Revoke|Delete|Clear)-\w+|-Method\s+['"]?(?:Delete|Post|Put|Patch)|\bMethod\s*=\s*['"](?:Delete|Post|Put|Patch)|\.Remove\(/i;
    /* What hands something out: adds, creates, enables (helpers like New-Object or a generated password do not). */
    const GRANT = /\b(?:Add-(?!Member|Type|Content)|New-(?!Object|\w*Password|TimeSpan|Guid|Variable)|Enable-|Grant-)\w+|-Method\s+['"]?(?:Post|Put|Patch)|\bMethod\s*=\s*['"](?:Post|Put|Patch)/i;
    /* Data sources that feed something a person selects from (not lookups of one object or uniqueness checks). */
    const selecting = new Set();
    forms.forEach(f => f.fields.forEach(({ field }) => {
      if (!['grid', 'dropdown', 'duallist', 'multiselectgrid', 'radio'].includes(field.type)) return;
      bindingsOf(field).forEach(({ cfg: bc }) => { const d = dsByGuid.get(lc(bc.dataSourceGuid)); if (d) selecting.add(d); });
    }));
    const DESTRUCT = /\b(?:Remove-AD(?:User|Group|Object|Computer)|Disable-ADAccount|Remove-Mailbox|Remove-DistributionGroup|Remove-Mg(?:User|Group))\b/i;
    const BROAD = /^(?:users|everyone|all users|domain users|iedereen|alle gebruikers|gebruikers)$/i;
    const PROTECTED = /adminCount|Domain Admins|Enterprise Admins|Schema Admins|Administrators|Account Operators|isCriticalSystemObject|protected/i;
    const lineOfIn = (code, re) => { const m = re.exec(code); return m ? lineAt(code, m.index) : null; };

    /* Which variables carry what the person filling in the form typed or picked. */
    function tainted(code) {
      const t = new Set();
      const ASSIGN = /\$(\w+)\s*=(?!=)([^\n;]*)/g;
      for (let pass = 0; pass < 3; pass++) {
        let m; ASSIGN.lastIndex = 0;
        while ((m = ASSIGN.exec(code))) {
          const rhs = m[2];
          if (/\$(?:datasource|form)\./i.test(rhs) || [...t].some(v => new RegExp('\\$' + v + '\\b', 'i').test(rhs))) t.add(m[1].toLowerCase());
        }
      }
      ['datasource', 'form', 'psitem', '_'].forEach(x => t.delete(x));
      return t;
    }

    /* Data sources whose searches are not bounded to an OU. */
    const unscoped = new Set();
    scripts.forEach(s => {
      const code = s.vars.code, raw = blank(s.script, false);
      /* 5. A cloud script calling the AD module: there is no AD in the cloud. */
      if (s.runInCloud && AD_CALL.test(code)) add('script.cloud.ad', 'high', s.target, { script: s.name }, { script: s.id, line: lineOfIn(code, new RegExp(AD_CALL.source, 'i')) });

      /* 1a. Searches without a SearchBase look through the whole domain, admins included. */
      /* A search (wildcard, everything, an LDAP filter), not a lookup of one known object. */
      const wildcard = /-like\s|-Filter\s*(?:\*|['"]\*['"])|-LDAPFilter|Name\s+-like/i.test(raw);
      const searches = AD_READ.test(code) && wildcard;
      const hasBase = /SearchBase/i.test(code);
      /* A uniqueness check must search the whole domain, or it misses the duplicate in another OU. */
      const uniqueness = s.ds && !selecting.has(s.ds) && /\bunique\b|Measure-Object|\.Count\s*-(?:gt|ge|eq)\s*[01]\b/i.test(code);
      if (uniqueness) { /* deliberate */ } else if (searches && !/SearchBase/i.test(code) || searches && /SearchBase\s*[=]?\s*['"]\s*DC=[^'"]*['"]/i.test(raw) && !/SearchBase\s*[=]?\s*['"][^'"]*OU=/i.test(raw)) {
        const base = hasBase;
        const root = /SearchBase\s*[=]?\s*['"]\s*DC=[^'"]*['"]/i.test(raw) && !/SearchBase\s*[=]?\s*['"][^'"]*OU=/i.test(raw);
        if (!base || root) { if (s.ds) unscoped.add(s.ds); add('script.scope', 'medium', s.target, { script: s.name, how: root ? 'root' : 'none' }, { script: s.id, line: lineOfIn(code, new RegExp(AD_READ.source, 'i')) }); }
      }

      /* 2. What someone typed, pasted into a filter string or an expression. */
      const t = tainted(code);
      const usesTaint = text => /\$(?:datasource|form)\./i.test(text) || [...t].some(v => new RegExp('\\$\\(?\\$?' + v + '\\b|\\$' + v + '\\b', 'i').test(text));
      const escaped = /-replace\s*["']'["']\s*,\s*["']''["']|\.Replace\(\s*["']'["']\s*,\s*["']''["']\s*\)|ConvertTo-LdapEscaped|\[System\.Security\.SecurityElement\]::Escape|EscapeDataString/i.test(raw);
      let m;
      const FILTER = /-(?:LDAP)?Filter\s+"([^"]*)"/gi;
      let flagged = false;
      while ((m = FILTER.exec(raw)) && !flagged) {
        if (usesTaint(m[1]) && !escaped) { flagged = true; add('script.inject', s.kind === 'datasource' ? 'low' : 'high', s.target, { script: s.name, how: 'filter' }, { script: s.id, line: lineAt(raw, m.index) }); }
      }
      const SPLATF = /\bFilter\s*=\s*"([^"]*)"/gi;
      while (!flagged && (m = SPLATF.exec(raw))) {
        if (usesTaint(m[1]) && !escaped) { flagged = true; add('script.inject', s.kind === 'datasource' ? 'low' : 'high', s.target, { script: s.name, how: 'filter' }, { script: s.id, line: lineAt(raw, m.index) }); }
      }
      const FVAR = /\$(\w+)\s*=\s*"([^"]*)"/gi;
      while (!flagged && (m = FVAR.exec(raw))) {
        if (usesTaint(m[2]) && !escaped && new RegExp('-(?:LDAP)?Filter\\s+\\$' + m[1] + '\\b|Filter\\s*=\\s*\\$' + m[1] + '\\b', 'i').test(raw)) {
          flagged = true; add('script.inject', s.kind === 'datasource' ? 'low' : 'high', s.target, { script: s.name, how: 'filter' }, { script: s.id, line: lineAt(raw, m.index) });
        }
      }
      const IEX = /\b(?:Invoke-Expression|iex)\b([^\n]*)/gi;
      while ((m = IEX.exec(code))) if (usesTaint(m[1])) { add('script.inject', 'high', s.target, { script: s.name, how: 'iex' }, { script: s.id, line: lineAt(code, m.index) }); break; }

      /* 3b. Secrets into the log. */
      const LOG = /\bWrite-(?:Information|Verbose|Host|Warning|Debug|Error)\b([^\n]*)/gi;
      while ((m = LOG.exec(raw))) {
        const arg = m[1];
        const secretVar = (arg.match(/\$(?:form\.)?\w*(?:password|passwd|wachtwoord|secret|apikey|token)\w*\b/gi) || [])
          .some(v => !/(?:change|cannotchange)password|password(?:neverexpires|lastset|expired|notrequired|policy|age|atlogon)/i.test(v));
        if ((/\$form\b(?!\.)|ConvertTo-Json[^\n]*\$form\b/i.test(arg) || secretVar) &&
            !/-Tags\s+['"]?Audit/i.test(arg)) {
          add('script.log.secret', 'high', s.target, { script: s.name }, { script: s.id, line: lineAt(raw, m.index) });
          break;
        }
      }

      /* 7. A catch that swallows the error: the activity shows success. */
      const catches = s.vars.catches;
      const fns = functionBodies(code);
      for (const [a, b] of catches) {
        if (fns.some(([x, y]) => a > x && a < y)) continue;   // a helper's fallback; its caller handles the error
        const body = code.slice(a, b);
        if (!/\b(?:throw|Write-Error|exit\s+\d)|IsError\s*=\s*\$true|Write-Warning/i.test(body)) {
          add('script.swallow', s.kind === 'datasource' ? 'low' : 'medium', s.target, { script: s.name }, { script: s.id, line: lineAt(code, a) });
          break;
        }
      }

      /* 9. Loads the whole directory for one dropdown. */
      /* No search value: everything, every time the field opens — or a "*" that means everything. */
      if (s.kind === 'datasource' && searches && !/ResultSetSize|-First\s+\d/i.test(code)) {
        const readsInput = /\$datasource\.\w+/i.test(code);
        const all = /-Filter\s*(?:\*|['"]\*['"]|\{\s*Name\s+-like\s+['"]\*['"]\s*\})|(?<!-not\s*\(\s*\w+\s+)-like\s+['"]\*['"]/i.test(raw);
        const star = /-eq\s+['"]\*['"]/i.test(raw);
        if (all && (!readsInput || star)) {
          add('script.unbounded', hasBase ? 'low' : 'medium', s.target, { script: s.name }, { script: s.id, line: lineOfIn(raw, /-Filter\s*(?:\*|['"]\*['"]|\{)|-like\s+['"]\*['"]/i) });
        }
      }
    });

    entries.forEach(e => {
      const tgt = tgtEntry(e);
      const fields = e.form ? e.form.fields.map(x => x.field) : [];
      const byKey = new Map(fields.map(f => [lc(f.key), f]));
      const taskCode = e.scripts.map(s => s.vars.code).join('\n');
      const taskRaw = e.scripts.map(s => blank(s.script, false)).join('\n');

      /* 3a. A password field shown in the activity summary. */
      fields.forEach(f => {
        const label = lc((f.templateOptions || {}).label);
        if ((f.type === 'password' || /password|wachtwoord/.test(lc(f.key)) && f.type === 'input' || /password|wachtwoord/.test(label) && f.type === 'input') &&
            !/hide/i.test(String(f.summaryVisibility || ''))) {
          add('form.password.shown', 'high', tgt, { field: f.key, vis: f.summaryVisibility || 'Show' });
        }
      });
      if (!e.scripts.length) return;

      /* 1b. Can touch privileged accounts or groups: the operation is sensitive, a lookup is unscoped, nothing filters protected objects. */
      if (e.type === 'delegated' && PRIV_OP.test(taskCode)) {
        const dss = new Set();
        if (e.form) e.form.fields.forEach(({ field }) => bindingsOf(field).forEach(({ cfg: bc }) => { const d = dsByGuid.get(lc(bc.dataSourceGuid)); if (d) dss.add(d); }));
        const open = [...dss].filter(d => unscoped.has(d));
        const guarded = PROTECTED.test(taskRaw) || [...dss].some(d => PROTECTED.test(d.script || ''));
        if (open.length && !guarded) add('entry.privileged', 'high', tgt, { op: (taskCode.match(PRIV_OP) || [''])[0].split(/\s/)[0], ds: open.map(d => d.name).join(', ') });
      }

      /* 4. Destructive without a brake. */
      if (e.type === 'delegated' && DESTRUCT.test(taskCode)) {
        const confirm = fields.some(f => f.type === 'boolean' && (f.templateOptions || {}).required);
        const broad = e.accessGroups.some(g => BROAD.test(String(g).trim()));
        if (!confirm || broad) add('entry.destructive', broad ? 'high' : 'medium', tgt, { op: (taskCode.match(DESTRUCT) || [''])[0], why: broad ? 'broad' : 'noconfirm',
          groups: e.accessGroups.join(', ') || '—' });
      }
      if (!e.form || e.type !== 'delegated') return;

      /* 8. Fields the task never reads. */
      const wholeForm = /\$form\b(?!\.)|\$form\.PSObject/i.test(taskCode);
      const readKeys = new Set(); taskCode.replace(/\$form\.(\w+)/gi, (_, k) => { readKeys.add(lc(k)); return _; });
      const feeds = new Set();
      e.form.fields.forEach(({ field }) => {
        bindingsOf(field).forEach(({ cfg: bc }) => ((bc.input && bc.input.propertyInputs) || []).forEach(pi => { const o = pi && pi.otherFieldValue && pi.otherFieldValue.otherFieldKey; if (o) feeds.add(lc(o)); }));
        if (typeof field.hideExpression === 'string') field.hideExpression.replace(/model\[\s*["']([^"']+)["']\s*\]/g, (_, k) => { feeds.add(lc(k)); return _; });
        const dep = (field.templateOptions || {}).dependOn; if (dep) feeds.add(lc(dep));
      });
      if (!wholeForm) fields.forEach(f => {
        if (['label', 'text', 'html', 'formrow', 'divider'].includes(f.type)) return;
        const to = f.templateOptions || {};
        /* Display and validation fields a data source fills are there to be read by people, not by the task. */
        if (to.readonly || (bindingsOf(f).length && !to.required)) return;
        const k = lc(f.key);
        if (readKeys.has(k) || feeds.has(k) || /confirm|repeat|verify|bevestig|herhaal/.test(k)) return;
        add('form.field.unused', 'low', tgt, { field: f.key });
      });

      /* 6. An optional field written straight into AD: left empty, it clears the attribute. */
      if (/\b(?:Set-AD\w+|Set-Mailbox|Set-MgUser)\b/i.test(taskCode)) {
        const aliases = new Map();   // alias → form key
        taskCode.replace(/\$(\w+)\s*=\s*\$form\.(\w+)\s*(?=[;\n]|$)/gi, (_, a, k) => { aliases.set(lc(a), lc(k)); return _; });
        const checks = key => {
          const names = [key].concat([...aliases].filter(([, k]) => k === key).map(([a]) => a));
          return names.some(n => new RegExp('IsNullOr(?:Empty|WhiteSpace)\\(\\s*\\$(?:form\\.)?' + n + '\\b|\\bif\\s*\\(\\s*(?:-not\\s+|!\\s*)?\\$(?:form\\.)?' + n + '\\s*\\)|\\$(?:form\\.)?' + n + '\\s*-(?:ne|eq)\\s*(?:\\$null|""|\'\')|\\$null\\s*-(?:ne|eq)\\s*\\$(?:form\\.)?' + n + '\\b', 'i').test(taskCode));
        };
        const seen = new Set();
        const USE = /-(\w+)\s+\$(?:form\.)?(\w+)\b|(?<![$\w.])(\w+)\s*=\s*\$(?:form\.)?(\w+)\s*(?=[;\n}])/gi;
        let m;
        while ((m = USE.exec(taskCode))) {
          const param = m[1] || m[3], ref = lc(m[2] || m[4]);
          const key = byKey.has(ref) && /\$form\./i.test(m[0]) ? ref : aliases.get(ref);
          if (!key || seen.has(key)) continue;
          const f = byKey.get(key);
          if (!f || !['input', 'textarea', 'email', 'datetime', 'number'].includes(f.type) || (f.templateOptions || {}).required || checks(key)) continue;
          /* Shown by a checkbox the task branches on: the empty case is handled there. */
          const toggle = typeof f.hideExpression === 'string' && (f.hideExpression.match(/model\[\s*["']([^"']+)["']\s*\]/) || [])[1];
          if (toggle && (readKeys.has(lc(toggle)))) continue;
          if (/^(?:Identity|Filter|SearchBase|Server|Credential|ErrorAction|Properties)$/i.test(param)) continue;
          seen.add(key);
          add('script.clears', 'medium', e.scripts[0].target, { field: f.key, param }, { script: e.scripts[0].id, line: lineAt(taskCode, m.index) });
        }
      }

      /* 10. Free text that AD will refuse or store wrong. */
      const LIMITS = [
        { re: /^(?:sam(?:account)?name|samaccountname|username|accountname)$/, need: 'max', max: 20 },
        { re: /^(?:mail|email|emailaddress|e-?mail)$/, need: 'pattern' },
        { re: /^(?:phone|telephone|telephonenumber|mobile|mobilephone|officephone|homephone)$/, need: 'pattern' },
        { re: /^(?:userprincipalname|upn)$/, need: 'pattern' }
      ];
      fields.forEach(f => {
        if (f.type !== 'input' || !readKeys.has(lc(f.key))) return;
        const rule = LIMITS.find(r => r.re.test(lc(f.key)));
        if (!rule) return;
        const to = f.templateOptions || {};
        const ok = rule.need === 'max' ? (to.maxLength && +to.maxLength <= rule.max) || to.pattern : !!to.pattern;
        if (!ok) add('form.validation', 'low', tgt, { field: f.key, need: rule.need, max: rule.max || '' });
      });
    });

    /* 3c. A credential in a variable that is not marked secret. */
    variables.forEach(v => {
      if (v.secret || v.isSystem) return;
      if (/pass(?:word)?|pwd|secret|token|api_?key|apisecret|clientsecret|wachtwoord/i.test(v.name) && v.value != null && String(v.value).trim() !== '') {
        add('var.secret.plain', 'high', { type: 'variable', id: v.name, name: v.name }, { name: v.name });
      }
    });

    /* 11. Products that grant without taking back, or grant risky things at once. */
    entries.filter(e => e.type === 'product').forEach(e => {
      const tgt = tgtEntry(e);
      const grants = e.tasks.some(t => t.event === 'onApprove' && t.script && GRANT.test(blank(t.script, true))) ||
        e.actions.some(a => !/\b(?:remove|disable|delete|revoke|reset|unlock)\b/i.test(a.name || ''));
      const returns = e.tasks.filter(t => t.event === 'onReturn');
      const revokes = returns.some(t => t.script && MUTATE.test(blank(t.script, true)));
      const pr = (cfg.products || []).find(x => x.productId === e.id) || {};
      if (grants && !revokes) add(returns.length ? 'product.return.empty' : 'product.norevoke', pr.hasTimeLimit ? 'high' : 'medium', tgt,
        { limit: pr.hasTimeLimit ? 'yes' : 'no', task: returns.map(t => t.name).join(', ') || '\u2014' });
      if (grants && pr.returnOnUserDisable === false) add('product.leaver', 'low', tgt, {});
      const wf = lc(pr.approvalWorkflow && pr.approvalWorkflow.name);
      const risky = (pr.hasRiskFactor && +pr.riskFactor >= 5) || (pr.showPrice && pr.price && parseFloat(String(pr.price).replace(',', '.')) > 0);
      if (/instant|direct|auto/.test(wf) && risky) add('product.instant', 'medium', tgt, { wf: pr.approvalWorkflow.name, risk: pr.hasRiskFactor ? pr.riskFactor : '—', price: pr.showPrice && pr.price ? pr.price : '—' });
    });

    /* -------------------------------------------------------- variable rules */
    const spellings = new Map();   // lc → Map(spelling → count)
    scripts.forEach(s => s.vars.spell.forEach((m, k) => {
      if (!libByLc.has(k)) return;
      if (!spellings.has(k)) spellings.set(k, new Map());
      m.forEach((n, sp) => spellings.get(k).set(sp, (spellings.get(k).get(sp) || 0) + n));
    }));
    const varRows = variables.map(v => {
      const k = v.name.toLowerCase();
      const used = libUse.get(k) || new Set();
      const sp = spellings.get(k) || new Map();
      const empty = !v.secret && (v.value == null || String(v.value).trim() === '');
      const tgt = { type: 'variable', id: v.name, name: v.name };
      if (!v.isSystem && !used.size) add('var.unused', 'low', tgt, { name: v.name });
      if (empty) add('var.empty', used.size ? 'high' : 'low', tgt, { name: v.name, n: used.size });
      const others = [...sp.keys()].filter(x => x !== v.name);
      if (others.length) add('var.casing', 'low', tgt, { name: v.name, spellings: [...sp.entries()].map(([x, n]) => x + ' ×' + n).join(', ') });
      /* One value, two parsers: some scripts split it on ';', others read it as JSON. */
      let json = 0, split = 0;
      used.forEach(id => {
        const s = scripts.find(x => x.id === id); if (!s) return;
        const code = s.vars.code;
        const re = n => new RegExp(n.replace('X', '\\$' + v.name), 'i');
        if (re('X\\s*\\|\\s*ConvertFrom-Json').test(code) || re('ConvertFrom-Json\\s+(?:-InputObject\\s+)?X\\b').test(code)) json++;
        if (re('X\\s*-split\\b').test(code) || re('X\\.Split\\(').test(code)) split++;
      });
      if (json && split) add('var.format', 'medium', tgt, { name: v.name, json, split });
      return { name: v.name, secret: v.secret, isSystem: v.isSystem, empty, value: v.secret ? null : v.value,
        usedBy: [...used], spellings: [...sp.entries()].map(([x, n]) => ({ spelling: x, n })) };
    });

    /* ------------------------------------------------------------ clones */
    const clusters = clone(scripts, opts.threshold || 0.6);
    clusters.forEach(c => add('script.clone', c.exact ? 'low' : 'medium',
      { type: 'cluster', id: c.id, name: c.members[0].name },
      { n: c.members.length, variants: c.variants, min: Math.round(c.min * 100), names: c.members.slice(0, 4).map(m => m.name).join(', ') + (c.members.length > 4 ? ', …' : '') },
      { cluster: c.id }));

    /* ------------------------------------------------------------ runtime */
    const activity = cfg.activity ? runtime(cfg.activity, entries, add) : null;

    /* A form no delegated form or product uses breaks nobody's request: its defects wait for cleanup. */
    if (entries.length) findings.forEach(f => { if (f.target.type === 'form' && f.rule !== 'orphan.form' && SEV_ORDER[f.sev] < SEV_ORDER.low) f.sev = 'low'; });
    findings.forEach(f => { f.order = SEV_ORDER[f.sev]; });
    findings.sort((a, b) => a.order - b.order || a.rule.localeCompare(b.rule));

    /* Attach findings to what they are about, for the per-entry and per-script views. */
    const byTarget = new Map();
    findings.forEach(f => { const k = f.target.type + ':' + f.target.id; if (!byTarget.has(k)) byTarget.set(k, []); byTarget.get(k).push(f); });
    scripts.forEach(s => { s.findings = findings.filter(f => f.script === s.id); });

    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    findings.forEach(f => counts[f.sev]++);
    const dsArr = [...dsByGuid.values()];
    return {
      tenant: cfg.tenant || '', collectedAt: cfg.collectedAt || null,
      entries, forms, dataSources: dsArr, scripts, clusters, variables: varRows, findings, byTarget, counts, activity,
      summary: {
        delegated: entries.filter(e => e.type === 'delegated').length,
        products: entries.filter(e => e.type === 'product').length,
        forms: seenForm.size, dataSources: dsArr.length, scripts: scripts.length,
        lines: scripts.reduce((n, s) => n + s.lines, 0), variables: variables.length,
        clustered: clusters.reduce((n, c) => n + c.members.length, 0),
        saveable: clusters.reduce((n, c) => n + c.members.length - 1, 0)
      }
    };
  }

  /* ------------------------------------------------------------ clone clusters */

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    let inter = 0; small.forEach(x => { if (big.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
  }

  function clone(scripts, threshold) {
    const units = scripts.filter(s => s.norm.length >= 3).map(s => ({ s, set: new Set(s.norm), key: s.norm.join('\n') }));
    const parent = units.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const sims = new Map();
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i].set, b = units[j].set;
        if (Math.min(a.size, b.size) / Math.max(a.size, b.size) < threshold) continue;   // Jaccard cannot reach it
        const exact = units[i].key === units[j].key;
        if (!exact && Math.min(a.size, b.size) < 5) continue;
        const sim = exact ? 1 : jaccard(a, b);
        if (sim >= threshold) { parent[find(i)] = find(j); sims.set(i + ':' + j, sim); }
      }
    }
    const groups = new Map();
    units.forEach((u, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
    const out = [];
    groups.forEach(idx => {
      if (idx.length < 2) return;
      const members = idx.map(i => units[i]);
      /* The variant most members share is the reference the others are compared with. */
      const byKey = new Map();
      members.forEach(m => byKey.set(m.key, (byKey.get(m.key) || 0) + 1));
      const refKey = [...byKey.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
      const ref = members.find(m => m.key === refKey);
      let min = 1;
      members.forEach(m => { if (m !== ref) { const v = m.key === ref.key ? 1 : jaccard(m.set, ref.set); m.sim = v; if (v < min) min = v; } else m.sim = 1; });
      const c = { id: 'c' + (out.length + 1), members: members.map(m => m.s).sort((a, b) => a.name.localeCompare(b.name)), ref: ref.s,
        sims: new Map(members.map(m => [m.s.id, m.sim])), variants: byKey.size, exact: byKey.size === 1, min };
      c.members.forEach(s => { s.cluster = c.id; });
      out.push(c);
    });
    out.sort((a, b) => b.members.length - a.members.length);
    out.forEach((c, i) => { c.id = 'c' + (i + 1); c.members.forEach(s => { s.cluster = c.id; }); });
    return out;
  }

  /** Line diff (LCS) between two scripts, on trimmed lines; equal runs collapse. */
  function diffLines(a, b) {
    const A = String(a || '').split('\n'), B = String(b || '').split('\n');
    const na = A.map(l => l.trim().replace(/\s+/g, ' ').toLowerCase()), nb = B.map(l => l.trim().replace(/\s+/g, ' ').toLowerCase());
    const n = A.length, m = B.length;
    if (n * m > 4e6) return [{ op: 'skip', text: '' }];
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (na[i] === nb[j]) { out.push({ op: 'eq', text: B[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', text: A[i++] });
      else out.push({ op: 'add', text: B[j++] });
    }
    while (i < n) out.push({ op: 'del', text: A[i++] });
    while (j < m) out.push({ op: 'add', text: B[j++] });
    return out;
  }

  /* ------------------------------------------------------------- runtime rules */

  /** The audit log's Service Automation events, per delegated form and product:
      opened, submitted, errors written by the task. Field names vary between event
      types; the names, GUIDs and the IsError flag are read wherever they sit. */
  function runtime(act, entries, add) {
    const rows = [].concat(act.forms || [], act.audit || [], act.requests || [], act.approvals || []);
    const byId = new Map(entries.map(e => [lc(e.id), e]));
    const byName = new Map(entries.map(e => [lc(e.name), e]));
    const stats = new Map();
    const statOf = e => { if (!stats.has(e)) stats.set(e, { opened: 0, submitted: 0, requests: 0, errors: 0, failed: 0, lastUse: null, messages: [] }); return stats.get(e); };
    const pick = (r, keys) => { for (const k of keys) { const v = k.split('.').reduce((o, p) => o && o[p], r); if (v) return v; } return null; };
    const isErr = r => {
      const v = pick(r, ['isError', 'IsError', 'data.isError', 'data.IsError', 'log.isError']);
      if (v === true || v === 'true' || v === 'True') return true;
      return /error|fail/i.test(String(pick(r, ['level', 'logLevel', 'severity', 'taskState', 'state', 'status']) || ''));
    };
    let unmatched = 0;
    rows.forEach(r => {
      const ev = String(r.event || '');
      const id = pick(r, ['formGUID', 'delegatedFormGUID', 'delegatedFormGuid', 'productGUID', 'productGuid', 'productId']);
      const name = pick(r, ['formName', 'delegatedFormName', 'productName', 'taskName', 'name']);
      const e = (id && byId.get(lc(id))) || (name && byName.get(lc(name)));
      if (!e) { unmatched++; return; }
      const st = statOf(e);
      const when = r.logDate || null;
      if (when && (!st.lastUse || when > st.lastUse)) st.lastUse = when;
      if (/form-opened/.test(ev)) st.opened++;
      else if (/form-submitted/.test(ev)) st.submitted++;
      else if (/request-state-created/.test(ev)) st.requests++;
      if (/request-state-(?:failed|blocked)/.test(ev) || r.blockedReason) st.failed++;
      if (/sa-audit/.test(ev) && isErr(r)) {
        st.errors++;
        const msg = pick(r, ['message', 'Message', 'data.message', 'data.Message', 'messageData.Message']);
        if (msg && st.messages.length < 50) st.messages.push({ when, text: String(msg).slice(0, 400) });
      }
    });
    const win = { from: act.from || null, to: act.to || null, days: act.days || null, rows: rows.length, unmatched };
    const anySubmit = rows.some(r => /form-submitted/.test(String(r.event || '')));
    entries.forEach(e => {
      const st = stats.get(e);
      const tgt = { type: e.type, id: e.id, name: e.name };
      if (st && (st.errors || st.failed)) add('use.errors', 'high', tgt, { n: st.errors + st.failed, last: (st.messages[st.messages.length - 1] || {}).text || '' });
      if (st && anySubmit && e.type === 'delegated' && st.opened >= 5 && st.submitted / st.opened < 0.3) {
        add('use.abandon', 'medium', tgt, { opened: st.opened, submitted: st.submitted, pct: Math.round(100 * st.submitted / st.opened) });
      }
      if (e.enabled && (!st || (!st.opened && !st.submitted && !st.requests)) && (win.days || 0) >= 30) add('use.unused', 'low', tgt, { days: window.days });
    });
    return { stats, window: win, anySubmit };
  }

  HR.salint = { outputsOf, looksLikeConfig, analyse, diffLines, varsOf, normLines, fieldsOf, blank, SEV_ORDER };
})(window.HR = window.HR || {});

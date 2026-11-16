/* Snapshot storage. IndexedDB when the page is served over http(s); an in-memory
   fallback (plus JSON export) when opened straight from the filesystem, where
   browsers give the page an opaque origin and refuse persistent storage.

   A snapshot is a data point: one dated moment of a tenant. It holds the
   reconciliation rows and the vault that goes with them, because a person diff
   (who joined, who left) needs two vaults and a historic model needs its own. */
(function (HR) {
  'use strict';

  const DB_NAME = HR.workspace ? HR.workspace.dbName('helloid-recon') : 'helloid-recon';
  const DB_VERSION = 2;
  const STORE = 'snapshots';
  /* The rules and the activity exports describe the tenant rather than a single
     reconciliation run, so they outlive any one snapshot and are kept apart. The
     vault is kept here too as "the one loaded now"; each snapshot carries its own. */
  const CONTEXT = 'context';

  let dbPromise = null;
  let memory = new Map();
  let usingMemory = false;
  let dbOk = false;   // the database opened: a failed write now is a real loss, not file:// or storage off

  /* A dashboard viewer holds the published bundle in this tab's memory only: nothing of it
     outlives the tab, and a failed fetch leaves nothing behind. The copy older builds kept
     in the dashboard's own database is dropped. */
  const viewer = !!(HR.dashboard && HR.dashboard.id());
  if (viewer && HR.workspace && HR.workspace.active().dashboard) {
    try { indexedDB.deleteDatabase(DB_NAME); } catch (e) { /* no IndexedDB */ }
  }

  function open() {
    if (viewer) { usingMemory = true; return Promise.reject(new Error('dashboard: memory only')); }
    /* Storage off: reject before touching the cached connection, so every
       caller drops into its existing in-memory fallback. Not cached, so
       re-enabling works without a reload. */
    if (HR.storageMode && !HR.storageMode.enabled()) {
      usingMemory = true;
      return Promise.reject(new Error('storage disabled'));
    }
    if (dbPromise) return dbPromise;
    dbPromise = openDb(DB_NAME).then(db => { dbOk = true; return db; }).catch(err => { usingMemory = true; throw err; });
    return dbPromise;
  }
  /** Open any workspace's database with the same shape; a new name is created on the spot. */
  function openDb(name) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(name, DB_VERSION); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('importedAt', 'importedAt');
        }
        if (!db.objectStoreNames.contains(CONTEXT)) {
          db.createObjectStore(CONTEXT, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  /** Write a full snapshot into another workspace's database (a data point moving house). */
  async function copyTo(dbName, snap) {
    const db = await openDb(dbName);
    try {
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(snap);
        t.oncomplete = resolve; t.onerror = () => reject(t.error);
      });
    } finally { db.close(); }
  }

  function tx(mode, fn, storeName) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeName || STORE, mode);
      const os = t.objectStore(storeName || STORE);
      let result;
      try { result = fn(os); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    })).catch(err => { usingMemory = true; throw err; });
  }

  const isMemory = () => usingMemory;

  async function list() {
    try {
      const rows = await tx('readonly', os => os.getAll()) || [];
      /* A snapshot whose put failed lives in memory only; it is still this session's data point. */
      const ids = new Set(rows.map(r => r.id));
      memory.forEach((v, id) => { if (!ids.has(id)) rows.push(v); });
      return rows.map(stripHeavy).sort((a, b) => b.importedAt - a.importedAt);
    } catch (e) {
      return Array.from(memory.values()).map(stripHeavy).sort((a, b) => b.importedAt - a.importedAt);
    }
  }

  async function get(id) {
    try { return (await tx('readonly', os => os.get(id))) || memory.get(id) || null; }
    catch (e) { return memory.get(id) || null; }
  }

  async function put(snap) {
    memory.set(snap.id, snap);
    try { await tx('readwrite', os => os.put(snap)); return { persisted: true }; }
    catch (e) { usingMemory = true; return { persisted: false, error: e }; }
  }

  async function remove(id) {
    memory.delete(id);
    try { await tx('readwrite', os => os.delete(id)); } catch (e) { /* memory only */ }
  }

  async function clear() {
    memory.clear();
    try { await tx('readwrite', os => os.clear()); } catch (e) { /* memory only */ }
  }

  /* Raw text is kept rather than the parsed object: re-parsing costs milliseconds and
     avoids any question about what survives structured cloning. */
  let contextMemory = null;

  async function saveContext(ctx) {
    contextMemory = Object.assign({}, contextMemory, ctx, { id: 'current', savedAt: Date.now() });
    try { await tx('readwrite', os => os.put(contextMemory), CONTEXT); return { persisted: true }; }
    catch (e) {
      usingMemory = true;
      /* The previous record stays behind and would come back after a reload: say so. */
      if (dbOk && HR.util && HR.i18n) HR.util.toast(HR.i18n.t('toast.contextNotSaved'), 10000);
      return { persisted: false, error: e };
    }
  }

  async function loadContext() {
    try {
      const stored = await tx('readonly', os => os.get('current'), CONTEXT);
      if (stored) contextMemory = stored;
    } catch (e) { /* memory only */ }
    return contextMemory;
  }

  async function clearContext() {
    contextMemory = null;
    try { await tx('readwrite', os => os.delete('current'), CONTEXT); } catch (e) { /* memory only */ }
  }

  function stripHeavy(s) {
    const { records, vault, ...rest } = s;
    return { ...rest, rowCount: rest.rowCount ?? (records ? records.length : 0),
      hasVault: !!vault, dataDate: rest.dataDate || rest.importedAt };
  }

  /** The date an export is about, read off its file name: 2026-08-01, 20260801,
      01-08-2026 (day first, as HelloID's Dutch customers write it). Null when none. */
  function dateFromName(fileName) {
    const s = String(fileName || '');
    let m = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/.exec(s);
    if (m) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return isNaN(t) ? null : t; }
    m = /(?<!\d)(0[1-9]|[12]\d|3[01])[-_.](0[1-9]|1[0-2])[-_.](20\d{2})(?!\d)/.exec(s);
    if (m) { const t = Date.UTC(+m[3], +m[2] - 1, +m[1]); return isNaN(t) ? null : t; }
    return null;
  }

  /**
   * @param {Object} [opts] { name, vault: raw text, vaultFileName, kind: 'recon'|'vault' }
   */
  function makeSnapshot(parsed, model, opts) {
    opts = typeof opts === 'string' ? { name: opts } : (opts || {});
    const now = Date.now();
    return {
      id: 'snap_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      name: opts.name || String(parsed.meta.fileName || '').replace(/\.(csv|json)$/i, ''),
      fileName: parsed.meta.fileName,
      importedAt: now,
      dataDate: dateFromName(parsed.meta.fileName) || dateFromName(opts.vaultFileName) || now,
      kind: opts.kind || 'recon',
      fingerprint: parsed.meta.fingerprint,
      rowCount: parsed.records.length,
      summary: model.summary,
      records: parsed.records,
      vault: opts.vault || null,
      vaultFileName: opts.vault ? (opts.vaultFileName || null) : null,
      vaultFingerprint: opts.vault ? HR.util.hash(opts.vault.length + '|' + opts.vault) : null
    };
  }

  async function exportAll() {
    const ids = (await list()).map(s => s.id);
    const full = [];
    for (const id of ids) { const s = await get(id); if (s) full.push(s); }
    return JSON.stringify({ kind: 'helloid-recon-snapshots', version: 1, exportedAt: Date.now(), snapshots: full });
  }

  async function importJSON(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    const snaps = Array.isArray(data) ? data : (data.snapshots || []);
    if (!snaps.length) throw new Error('No snapshots found in that file.');
    for (const s of snaps) {
      if (!s.id || !s.records || !s.summary) throw new Error('Snapshot file is malformed.');
      await put(s);
    }
    /* A dashboard bundle also carries the companions the data points share. */
    if (data.context && typeof data.context === 'object') await saveContext(data.context);
    return snaps.length;
  }

  /* A dashboard's audience gets only what its facets cover — the file itself is stripped,
     since hiding in the UI protects nothing once the bundle is on the host. Provisioning
     rows feed person timelines; exclusions are governance; the rest of the log is audit. */
  function stripContext(context, facets) {
    const has = f => facets.includes(f);
    const edit = (k, fn) => { try { const d = JSON.parse(context[k]); fn(d); context[k] = JSON.stringify(d); } catch (e) { delete context[k]; } };
    if (context.audit && !has('audit')) edit('audit', d => Object.keys(d).forEach(k => {
      if (Array.isArray(d[k]) && k !== 'provisioning' && !(k === 'reconciliation' && has('governance'))) d[k] = [];
    }));
    if (context.products && !has('money')) edit('products', d => (d.products || []).forEach(p => { delete p.price; delete p.showPrice; }));
    return context;
  }

  /** Everything a dashboard needs, in one file: every data point (vaults included) and
      the companions loaded now. Published on the host; the dashboard fetches it.
      facets (a dashboard's): strip what that audience may not see; omitted = everything. */
  async function exportBundle(workspaceName, facets) {
    const ids = (await list()).map(s => s.id);
    const snapshots = [];
    for (const id of ids) { const s = await get(id); if (s) snapshots.push(s); }
    /* Stored money figures cannot be re-derived without the prices, so they go too. */
    const noMoney = facets && !facets.includes('money');
    const shipped = noMoney ? snapshots.map(s => {
      const summary = Object.assign({}, s.summary);
      ['monthlyCost', 'wasteMonthly', 'remediationCost'].forEach(k => delete summary[k]);
      return Object.assign({}, s, { summary });
    }) : snapshots;
    const ctx = (await loadContext()) || {};
    const context = {};
    ['rules', 'granted', 'history', 'audit', 'products', 'assignments', 'fileNames', 'importedAt'].forEach(k => { if (ctx[k] != null) context[k] = ctx[k]; });
    if (facets) stripContext(context, facets);
    return JSON.stringify({ kind: 'helloid-sidekick-bundle', version: 1, exportedAt: Date.now(),
      workspace: workspaceName || null, snapshots: shipped, context });
  }

  /** The kill-switch's half: close the connection, delete the database, and
      forget the in-memory copies so the archive reads as empty afterwards. */
  async function wipeDb() {
    if (dbPromise) {
      try { const db = await dbPromise; if (db) db.close(); } catch (e) { /* never opened */ }
    }
    dbPromise = null;
    memory = new Map();
    contextMemory = null;
    await new Promise(res => {
      let req;
      try { req = indexedDB.deleteDatabase(DB_NAME); } catch (e) { return res(); }
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  }

  HR.store = { list, get, put, remove, clear, copyTo, makeSnapshot, dateFromName, exportAll, exportBundle, stripContext, importJSON, isMemory,
    saveContext, loadContext, clearContext, wipeDb };
})(window.HR);

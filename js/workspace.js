/* Workspaces: one browser, many customers.

   A partner runs Sidekick for several tenants. Everything the app remembers — settings,
   branding, favourites, the snapshot archive and the raw imports — used to live under
   one set of keys, so the second customer overwrote the first. A workspace scopes those
   keys: the first workspace ("default") keeps the unscoped keys it always had, so nothing
   migrates and nothing breaks; every further workspace gets its own suffix on the same
   keys and its own IndexedDB. Switching reloads the page: every module reads its key at
   load time, and that is the safest moment to change it.

   The registry itself, the language, the theme and the storage switch stay global. */
(function (HR) {
  'use strict';

  const KEY = 'hr.workspaces';
  const DEFAULT = { id: 'default', name: 'My tenant' };
  let reg = null;

  function load() {
    if (reg) return reg;
    try { reg = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { reg = null; }
    if (!reg || !Array.isArray(reg.list) || !reg.list.length) reg = { active: DEFAULT.id, list: [Object.assign({ createdAt: Date.now() }, DEFAULT)] };
    if (!reg.list.some(w => w.id === reg.active)) reg.active = reg.list[0].id;
    return reg;
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(reg)); } catch (e) { /* in-memory only */ }
  }

  const active = () => load().list.find(w => w.id === load().active) || load().list[0];
  const list = () => load().list.slice();
  const suffix = id => (id || active().id) === DEFAULT.id ? '' : '@' + (id || active().id);
  /** The storage key for a base name in the active workspace. */
  const key = (base, id) => base + suffix(id);
  const dbName = (base, id) => base + suffix(id);

  const slug = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ws';

  function create(name) {
    load();
    let id = slug(name), k = 2;
    while (reg.list.some(w => w.id === id)) id = slug(name) + '-' + k++;
    reg.list.push({ id, name: String(name || id).trim() || id, createdAt: Date.now() });
    persist();
    return id;
  }
  function rename(id, name) {
    const w = load().list.find(x => x.id === id);
    if (w && String(name || '').trim()) { w.name = String(name).trim(); persist(); }
  }
  /** Forget a workspace and everything stored under it. The default one cannot go. */
  async function remove(id) {
    load();
    if (id === DEFAULT.id || !reg.list.some(w => w.id === id)) return false;
    const bases = ['hr.config.v1', 'hr.brand', 'hr.nav.v1', 'hr.edition'];
    bases.forEach(b => { try { localStorage.removeItem(b + suffix(id)); } catch (e) { /* ignore */ } });
    await new Promise(res => { try { const r = indexedDB.deleteDatabase(dbName('helloid-recon', id)); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch (e) { res(); } });
    reg.list = reg.list.filter(w => w.id !== id);
    if (reg.active === id) reg.active = DEFAULT.id;
    persist();
    return true;
  }
  /** Make another workspace current and start over: modules read their keys at load. */
  function switchTo(id, opts) {
    load();
    if (!reg.list.some(w => w.id === id)) return;
    reg.active = id;
    if (opts && opts.pendingDemo) reg.pendingDemo = true;
    persist();
    location.hash = '';
    location.reload();
  }
  function takePendingDemo() {
    load();
    const p = !!reg.pendingDemo;
    if (p) { delete reg.pendingDemo; persist(); }
    return p;
  }
  /** Every key a wipe has to remove, over every workspace. */
  const allKeys = base => load().list.map(w => base + suffix(w.id));
  const allDbs = base => load().list.map(w => dbName(base, w.id));

  HR.workspace = { KEY, DEFAULT, active, list, key, dbName, create, rename, remove, switchTo, takePendingDemo, allKeys, allDbs };
})(window.HR);

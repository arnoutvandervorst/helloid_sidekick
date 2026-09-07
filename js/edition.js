/* Three products, one engine.

   Sidekick does three jobs for three audiences: governance analytics for the partner who
   reports to a customer every quarter, a health check for whoever has to say whether a
   HelloID tenant is well built and running, and a helper for the consultant designing
   the model before HelloID exists. One sidebar for all of it read as no goal at all.

   An edition is a presentation choice, not a build: which views the sidebar lists, where
   a fresh session lands, what the empty page asks for first. Every view stays reachable
   by its hash — a link from a colleague on another edition still opens — and a view
   outside the current edition says which edition it belongs to. `all` is the old sidebar,
   for development and for the person who wants everything. */
(function (HR) {
  'use strict';

  const KEY = 'hr.edition';

  /* Group keys reuse nav.g.* labels; view ids are the registered views. Overlap is
     deliberate: mining serves the optimiser and the designer, evidence serves the
     reporter and the health checker. */
  const EDITIONS = {
    govern: {
      groups: [
        ['state', ['overview', 'policies', 'audit', 'risk', 'cost']],
        ['who', ['accounts', 'permissions', 'people', 'org']],
        ['data', ['diff', 'snapshots', 'sources']],
        ['out', ['board', 'settings']]
      ],
      landing: 'overview', firstSlots: ['recon', 'vault', 'audit', 'history']
    },
    health: {
      groups: [
        ['state', ['overview', 'audit', 'risk']],
        ['model', ['rules', 'mining', 'activity', 'explain', 'conventions', 'matching']],
        ['who', ['accounts', 'permissions', 'people']],
        ['data', ['diff', 'snapshots', 'sources']],
        ['out', ['board', 'settings']]
      ],
      landing: 'rules', firstSlots: ['recon', 'rules', 'history', 'audit', 'vault']
    },
    consult: {
      groups: [
        ['model', ['mining', 'conventions', 'fieldmap', 'nedap', 'matching', 'products', 'rules']],
        ['who', ['people', 'org', 'accounts', 'permissions']],
        ['data', ['sources', 'snapshots']],
        ['out', ['settings']]
      ],
      landing: 'sources', firstSlots: ['vault', 'directory', 'recon', 'rules']
    },
    all: {
      groups: [
        ['state', ['overview', 'policies', 'audit', 'risk', 'cost']],
        ['who', ['accounts', 'permissions', 'people', 'matching', 'org', 'conventions']],
        ['model', ['mining', 'rules', 'products', 'nedap', 'fieldmap', 'activity', 'explain']],
        ['data', ['diff', 'snapshots', 'sources']],
        ['out', ['board', 'settings']]
      ],
      landing: 'overview', firstSlots: []
    }
  };
  const PUBLIC = ['govern', 'health', 'consult'];

  let current = null;

  /** ?edition= wins, then the remembered choice, then the hostname's first label. */
  function resolve() {
    try {
      const q = new URLSearchParams(location.search).get('edition');
      if (q && EDITIONS[q]) { set(q); return q; }
    } catch (e) { /* no URL API: fall through */ }
    try {
      const saved = localStorage.getItem(KEY);
      if (saved && EDITIONS[saved]) return saved;
    } catch (e) { /* storage blocked */ }
    const host = String(location.hostname || '').toLowerCase();
    for (const id of PUBLIC) if (host.startsWith('helloid-' + id + '.') || host.startsWith(id + '.')) return id;
    return null;
  }

  function set(id) {
    if (!EDITIONS[id]) return;
    current = id;
    try { localStorage.setItem(KEY, id); } catch (e) { /* in-memory only */ }
  }

  function get() {
    if (current === null) current = resolve();
    return current;
  }

  const def = () => EDITIONS[get() || 'all'];
  /** The sidebar groups for the edition, in nav.js's shape. */
  const groups = () => def().groups.map(([key, views]) => ({ key, views }));
  const has = view => def().groups.some(g => g[1].includes(view));
  /** Which editions list a view — for the "this belongs to …" notice. */
  const ownersOf = view => PUBLIC.filter(id => EDITIONS[id].groups.some(g => g[1].includes(view)));
  const landing = () => def().landing;
  const firstSlots = () => def().firstSlots;
  const chosen = () => get() !== null;

  HR.edition = { EDITIONS, PUBLIC, KEY, get, set, groups, has, ownersOf, landing, firstSlots, chosen };
})(window.HR);

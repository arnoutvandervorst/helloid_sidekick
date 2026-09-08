/* Sub-dashboards: one audience, a few views, published data, nothing to touch.

   HR wants Person 360 and who joined or left — not the imports, the settings, the
   money or the risk scores. An edition is a sidebar preset; a dashboard is stricter:
   fixed views, chrome and facts hidden, no import of any kind, and its data comes
   from a bundle the partner publishes on the host (later: a HelloID API). It runs
   in a workspace of its own so the partner's own data in the same browser stays
   untouched.

   The app cannot authenticate anyone — a dashboard is a preset, not a permission.
   Who may open it is the host's business (a hostname with an access policy).

   Built-ins live here; a deployment overrides or adds dashboards with
   published/dashboards.json — see docs/dashboards.example.json. */
(function (HR) {
  'use strict';

  const KEY = 'hr.dashboard';
  const FILE = 'published/dashboards.json';
  const BUILTIN = {
    hr: { id: 'hr', name: 'HR', views: ['people', 'org'], landing: 'people', hide: ['money', 'risk'], readOnly: true, source: null }
  };

  let defs = Object.assign({}, BUILTIN);
  let current = null;
  /* Decided at load, before the deployment file answers: the id alone picks the
     workspace, and every module that scopes a storage key reads it synchronously. */
  const currentId = resolveId();
  if (currentId && BUILTIN[currentId]) current = BUILTIN[currentId];

  /** ?dashboard= wins (off clears), then the remembered one, then the hostname's first label. */
  function resolveId() {
    try {
      const q = new URLSearchParams(location.search).get('dashboard');
      if (q === 'off' || q === 'none') { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } return null; }
      if (q) { try { localStorage.setItem(KEY, q); } catch (e) { /* ignore */ } return q; }
    } catch (e) { /* no URL API */ }
    try { const s = localStorage.getItem(KEY); if (s) return s; } catch (e) { /* storage blocked */ }
    const host = String(location.hostname || '').toLowerCase();
    for (const id of Object.keys(defs)) if (host.startsWith(id + '.') || host.startsWith('helloid-' + id + '.')) return id;
    return null;
  }

  /* The deployment file is fetched once; until it answers, only the built-ins are known.
     Boot waits on `ready` before deciding the workspace and the data. */
  const ready = (async () => {
    try {
      const res = await fetch(FILE, { cache: 'no-store' });
      if (res.ok && !(res.headers.get('content-type') || '').includes('html')) {
        const data = await res.json();
        Object.keys(data || {}).forEach(id => {
          const base = BUILTIN[id] || { id, name: id, views: ['people'], landing: 'people', hide: [], readOnly: true, source: null };
          defs[id] = Object.assign({}, base, data[id], { id });
          if (!defs[id].landing || !defs[id].views.includes(defs[id].landing)) defs[id].landing = defs[id].views[0];
        });
      }
    } catch (e) { /* not served: built-ins only */ }
    current = currentId && defs[currentId] ? defs[currentId] : null;
    return current;
  })();

  const active = () => current;
  const is = id => !!current && (!id || current.id === id);
  const views = () => current ? current.views.slice() : [];
  const landing = () => current ? current.landing : null;
  const hides = kind => !!current && (current.hide || []).includes(kind);
  const readOnly = () => !!current && current.readOnly !== false;
  const source = () => current ? current.source || null : null;
  const name = () => current ? current.name || current.id : '';
  /** The workspace a dashboard lives in; created on first use. Known from the id alone. */
  const workspaceId = () => currentId ? 'dash-' + currentId : null;
  const id = () => currentId;
  const all = () => Object.assign({}, defs);

  HR.dashboard = { KEY, FILE, ready, active, id, is, views, landing, hides, readOnly, source, name, workspaceId, all };
})(window.HR);

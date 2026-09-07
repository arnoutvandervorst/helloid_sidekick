/* The edition chooser: which of the three jobs this session is for. */
(function (HR) {
  'use strict';

  const U = HR.util, el = U.el;
  const T = (k, p) => HR.i18n.t(k, p);

  function chooseView() {
    const f = document.createDocumentFragment();
    const current = HR.edition.chosen() ? HR.edition.get() : null;
    f.appendChild(el('div', { class: 'view-head' }, el('div', {}, [
      el('h1', { text: T('ed.title') }),
      el('p', { text: T('ed.lead') })
    ])));
    const cards = HR.edition.PUBLIC.map(id => el('div', { class: 'card ed-card' + (id === current ? ' current' : '') }, [
      el('div', { class: 'ed-kicker', text: T('ed.' + id + '.for') }),
      el('h2', { text: T('ed.' + id + '.name') }),
      el('p', { text: T('ed.' + id + '.promise') }),
      el('p', { class: 'note', text: T('ed.' + id + '.needs') }),
      el('ul', { class: 'clean ed-views' }, HR.edition.EDITIONS[id].groups.flatMap(g => g[1]).filter(v => HR.views[v] && v !== 'settings' && v !== 'sources')
        .map(v => el('li', { text: T('nav.' + v) }))),
      el('div', { class: 'slot-actions' }, [
        el('button', { class: 'btn ' + (id === current ? '' : 'primary'), text: id === current ? T('ed.current') : T('ed.open'),
          onclick: () => { HR.edition.set(id); HR.app.applyChrome(); HR.app.go(HR.edition.landing()); } })
      ])
    ]));
    f.appendChild(el('div', { class: 'grid g3 ed-grid' }, cards));
    f.appendChild(el('p', { class: 'note', style: 'margin-top:12px' }, [
      document.createTextNode(T('ed.allNote') + ' '),
      el('a', { href: '#', text: T('ed.all.name'), onclick: e => { e.preventDefault(); HR.edition.set('all'); HR.app.applyChrome(); HR.app.go('overview'); } })
    ]));
    return f;
  }

  HR.views.choose = chooseView;
})(window.HR);

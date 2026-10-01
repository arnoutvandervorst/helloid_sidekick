/* One colour for one number. The governance score, the compliance score, identity
   coverage and the managed share used to be coloured by their own copy of a threshold
   in every view — 85 % compliance amber on the Overview and green elsewhere. Every view
   asks here instead.

   A band is a ring colour (good · medium · high · critical) and, for the board, a tone
   (good · watch · bad). */
(function (HR) {
  'use strict';

  const toneOf = band => band === 'good' ? 'good' : band === 'medium' || band === 'low' ? 'watch' : 'bad';

  const BANDS = {
    /* Governance 0..100: the model's own bands (≥ 80 good, ≥ 60 watch). */
    governance: v => v == null ? null : v >= 80 ? 'good' : v >= 60 ? 'medium' : 'critical',
    /* The weighted compliance share 0..1. */
    compliance: v => v == null ? null : v >= 0.9 ? 'good' : v >= 0.6 ? 'medium' : 'critical',
    /* Accounts linked to a person 0..1. */
    coverage: v => v == null ? null : v >= 0.9 ? 'good' : v >= 0.75 ? 'medium' : 'high',
    /* Access the model explains 0..1. */
    managed: v => v == null ? null : v >= 0.8 ? 'good' : v >= 0.5 ? 'medium' : 'critical',
    /* Classified, weighted by access 0..1. */
    classified: v => v == null ? null : v >= 0.95 ? 'good' : v >= 0.8 ? 'medium' : 'high',
    /* Risk 0..100: the editable severity bands in Settings. */
    risk: v => v == null ? null : HR.config.severityOf(v)
  };

  /** band('compliance', 0.85) → 'medium'. */
  const band = (kind, v) => (BANDS[kind] ? BANDS[kind](v) : null) || 'medium';
  /** tone('compliance', 0.85) → 'watch'. */
  const tone = (kind, v) => toneOf(band(kind, v));
  /** A control's state as a tone: met is good, accepted watch, failing by its severity. */
  const controlTone = row => !row || !row.applicable ? null
    : row.status === 'met' ? 'good' : row.status === 'accepted' ? 'watch'
    : (row.severity === 'critical' || row.severity === 'high') ? 'bad' : 'watch';

  HR.bands = { band, tone, toneOf, controlTone };
})(window.HR);

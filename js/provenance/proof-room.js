// ============================================================
// DATAGLOW — Proof Room (Trust Passport, composition batch 1)
// ============================================================
// A single screen that composes FIVE already-shipped, already-tested trust
// surfaces into one top-to-bottom "assembled proof", in a fixed order:
//   1. Metric Studio            (js/metrics/metric-studio.js)
//   2. Trust Strip              (js/trust/trust-strip.js)
//   3. Data Nutrition Label     (js/provenance/data-nutrition-label.js)
//   4. Verifiable Check Seal    (js/provenance/verifiable-check-seal.js)
//   5. Trust Beam               (js/provenance/trust-beam.js + verify-beam.html)
//
// PURE UI COMPOSITION ONLY — this module invents NO crypto, NO validation logic,
// NO backend, and NO AI model. It reuses each underlying module's existing
// exported render/build functions verbatim (the caller supplies those as thin
// closures in opts.renderers, mirroring how main.js already wires each surface),
// so nothing here re-implements or forks the modules it assembles.
//
// This file holds exactly two things:
//   • buildProofRoomPlan(ctx) — a PURE, DOM-free, never-throwing aggregator that
//     decides the ordered steps and whether each is ready given the current
//     session state. This is the only new logic and it is unit-tested.
//   • renderProofRoom(opts)   — a thin DOM presenter that lays out the numbered
//     steps and, for each ready step, calls the caller-supplied renderer.
//
// HONEST NAMING (inherited from every module it composes): the assembled screen
// is NOT a certification, NOT "blockchain", and NOT a zero-knowledge proof — it
// only summarizes checks that ran against the fingerprinted data.

import { el, escapeHtml } from '../app-shell/utils.js';

// Fixed, ordered step keys. Order is the product spec: define → summarize →
// label → seal → beam.
export const PROOF_ROOM_STEP_KEYS = [
  'metricStudio',
  'trustStrip',
  'dataNutritionLabel',
  'verifiableCheckSeal',
  'trustBeam',
];

// Per-step metadata: the short heading + one-line description shown above each
// composed surface. Pure data — no DOM, no behavior.
export const PROOF_ROOM_STEPS = [
  {
    key: 'metricStudio',
    title: 'Metric Studio',
    description: 'Define the metrics this dataset is meant to answer, tied to real columns and computed against the in-browser engine.',
  },
  {
    key: 'trustStrip',
    title: 'Trust Strip',
    description: 'A live at-a-glance read of freshness, validation pass/fail, anomalies, metric certification, and lineage — every value from real computed state.',
  },
  {
    key: 'dataNutritionLabel',
    title: 'Data Nutrition Label',
    description: 'A portable, human-readable manifest of what was checked, what passed or failed, what was transformed, and the chain of custody. A summary, not a certification.',
  },
  {
    key: 'verifiableCheckSeal',
    title: 'Verifiable Check Seal',
    description: 'Seal a check result into a Merkle-tree (SHA-256) commitment binding the check, its parameters, and the data fingerprint — re-verifiable by anyone with only the artifact.',
  },
  {
    key: 'trustBeam',
    title: 'Trust Beam',
    description: 'Turn a seal into a self-contained shareable link whose whole payload lives in the URL fragment, so nothing is ever uploaded. A recipient re-verifies it in verify-beam.html with zero install.',
  },
];

export const PROOF_ROOM_DISCLAIMER =
  'The Proof Room assembles existing DATAGLOW trust surfaces into one view. It '
  + 'is NOT a certification, NOT "blockchain", and NOT a zero-knowledge proof. '
  + 'A sealed check proves only that the check ran against data matching the '
  + 'committed fingerprint and produced this result — never that the underlying '
  + 'data is accurate, truthful, or complete.';

// ------------------------------------------------------------
// Pure plan builder (unit-tested)
// ------------------------------------------------------------
// Decide, from plain session state, which of the ordered steps are ready to
// render and — when one is not — a one-line reason the caller shows in place of
// the surface. Never throws; missing/garbage input degrades to "not ready".
//
// @param {object} ctx
// @param {boolean} ctx.datasetLoaded         A dataset is loaded.
// @param {boolean} ctx.hasValidationResults  At least one validation layer has run.
// @param {boolean} [ctx.sealReady]           A seal can be / has been produced.
//   Defaults to (datasetLoaded && hasValidationResults) — the seal step's own
//   readiness — since a beam needs a seal to exist first.
// @returns {{steps: Array<{key,title,description,step,available,detail}>,
//            readyCount: number, totalCount: number}}
export function buildProofRoomPlan(ctx = {}) {
  const datasetLoaded = !!(ctx && ctx.datasetLoaded);
  const hasValidationResults = !!(ctx && ctx.hasValidationResults);
  const sealStepReady = datasetLoaded && hasValidationResults;
  const sealReady = ctx && ctx.sealReady != null ? !!ctx.sealReady : sealStepReady;

  const available = {
    // Metric Studio needs the loaded dataset's schema columns to validate a
    // formula against, so it is only meaningful once a dataset is loaded.
    metricStudio: datasetLoaded,
    // The Trust Strip has an honest "nothing loaded yet" empty state, so it is
    // always safe to render — it simply reflects whatever state exists.
    trustStrip: true,
    // The Nutrition Label summarizes the loaded dataset; nothing to summarize
    // until one is loaded.
    dataNutritionLabel: datasetLoaded,
    // A seal binds a real check result to the data's fingerprint, so it needs
    // both a loaded dataset AND at least one validation run.
    verifiableCheckSeal: sealStepReady,
    // A beam is a wrapper around a seal, so it needs a seal to exist first.
    trustBeam: sealReady,
  };

  const detail = {
    metricStudio: 'Load a dataset to define and certify metrics against its real columns.',
    trustStrip: '',
    dataNutritionLabel: 'Load a dataset to assemble its nutrition label.',
    verifiableCheckSeal: 'Run the validation layers first — a seal binds a real check result to the data’s fingerprint.',
    trustBeam: 'Seal a check result above, then beam it as a self-contained shareable link.',
  };

  const steps = PROOF_ROOM_STEPS.map((meta, i) => ({
    key: meta.key,
    title: meta.title,
    description: meta.description,
    step: i + 1,
    available: !!available[meta.key],
    detail: available[meta.key] ? '' : (detail[meta.key] || ''),
  }));

  return {
    steps,
    readyCount: steps.filter((s) => s.available).length,
    totalCount: steps.length,
  };
}

// ------------------------------------------------------------
// Thin DOM presenter (browser-only)
// ------------------------------------------------------------
// Lay out the numbered steps. For each READY step, call the caller-supplied
// renderer with a fresh body host so the real underlying surface fills it; for a
// not-ready step, show the plan's one-line reason instead. The caller owns every
// data/engine/seal concern (via the closures in opts.renderers) — this presenter
// only arranges them, so it stays a composition and never forks a module.
//
// @param {object} opts
// @param {HTMLElement} opts.host             Container to render into (cleared first).
// @param {object} opts.plan                  Result of buildProofRoomPlan(ctx).
// @param {object} [opts.renderers]           Map keyed by step key → (bodyHost) => void.
//   Called only for a step whose plan entry is `available`.
// @param {string} [opts.disclaimer]          Defaults to PROOF_ROOM_DISCLAIMER.
export function renderProofRoom(opts = {}) {
  const { host, plan } = opts;
  if (!host) return;
  const renderers = opts.renderers || {};
  const disclaimer = opts.disclaimer || PROOF_ROOM_DISCLAIMER;
  host.innerHTML = '';

  host.appendChild(el('div', {
    class: 'card',
    'data-testid': 'proof-room-disclaimer',
    style: 'margin-bottom:var(--space-4); padding:var(--space-3); font-size:var(--text-xs); '
      + 'color:var(--color-text-muted); border-left:3px solid var(--color-grade-a); '
      + 'background:var(--color-surface-2, transparent);',
  }, disclaimer));

  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  for (const step of steps) {
    const section = el('section', {
      class: 'card',
      'data-testid': `proof-room-step-${step.key}`,
      'data-step': String(step.step),
      style: 'margin-bottom:var(--space-4); padding:var(--space-4); display:flex; '
        + 'flex-direction:column; gap:var(--space-2);',
    });

    section.appendChild(el('div', {
      style: 'display:flex; align-items:baseline; gap:var(--space-2);',
    }, [
      el('span', {
        style: 'font-size:var(--text-xs); font-weight:700; color:var(--color-text-faint); '
          + 'min-width:1.5em;',
      }, `${step.step}.`),
      el('span', { style: 'font-size:var(--text-md); font-weight:600;' }, step.title),
    ]));

    section.appendChild(el('div', {
      style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:var(--space-1);',
    }, step.description));

    const body = el('div', { 'data-testid': `proof-room-body-${step.key}` });
    section.appendChild(body);

    const renderer = renderers[step.key];
    if (step.available && typeof renderer === 'function') {
      try {
        renderer(body);
      } catch (e) {
        body.appendChild(el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-error);',
        }, `This surface could not be rendered: ${escapeHtml(e && e.message ? e.message : String(e))}`));
      }
    } else {
      body.appendChild(el('div', {
        class: 'proof-room-step-pending',
        style: 'font-size:var(--text-xs); color:var(--color-text-faint); font-style:italic;',
      }, step.detail || 'Not available yet.'));
    }

    host.appendChild(section);
  }
}

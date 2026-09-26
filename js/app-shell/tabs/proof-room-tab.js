// ============================================================
// Proof Room Tab (Trust Passport, composition batch 1)
// ============================================================
// A single "assembled proof" screen that COMPOSES five already-shipped,
// already-tested trust surfaces top-to-bottom in a fixed product order:
// Metric Studio -> Trust Strip -> Data Nutrition Label -> Verifiable Check Seal
// -> Trust Beam. The composer/plan builder + presenter live in
// js/provenance/proof-room.js; this function is only the thin caller that
// supplies each step's REAL render function as a closure (mirroring how the
// SQL/Validate tabs already wire the same surfaces), so nothing here
// re-implements or forks a module.
//
// FLAG HANDLING: this tab is gated by ONE umbrella flag, proofRoom (off by
// default). The five underlying surfaces have NO internal flag check of their
// own, so the Proof Room calls each render function DIRECTLY regardless of its
// own trustStripProofDrawer/metricStudio/dataNutritionLabel/verifiableCheckSeal/
// trustBeam flag -- this composed view is where they become visible together.
// The tab only exists in the bar when proofRoom is on (see renderTabBar); this
// function is the second, inner gate matching the meeting/diplomacy precedent,
// and it renders nothing until a dataset is loaded.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, 2026-09-26) -- byte-for-byte identical
// behavior, only the file location changed. renderProofRoomTab and
// getProofRoomSealForExport now take a `deps` object bundling everything that
// must stay defined in main.js: `metricRegistry`, `engine`, `openMetricProof`,
// `recordMetricDefinitionVersion`, `openTrustFieldProof`,
// `collectValidationSummary`, `downloadText`, `ledger`, `aiTouchLedger`, and
// `state` are each read or written from multiple OTHER places in main.js (not
// just this tab), so extracting any of them would either create a circular
// import or fork shared state into two diverging copies.
//
// getProofRoomSealForExport is a read-only accessor so other sections of
// main.js (the MCP gate-state export handler, Agent Passport Bridge batch)
// can read whatever seal has already been minted this session without
// duplicating the module-scoped `proofRoomSeal` variable or forcing a fresh
// seal to be created just for export -- it is re-exported from main.js for
// that one external call site.

import { el } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import { sealCheckResult, verifySeal, renderSealSummaryLines, exportSealAsJSON } from '../../provenance/verifiable-check-seal.js';
import { buildBeamUrl } from '../../provenance/trust-beam.js';
import * as provenance from '../../provenance/provenance.js';
import { buildDataNutritionLabel, renderLabelSummaryLines } from '../../provenance/data-nutrition-label.js';
import { renderMetricStudio } from '../../metrics/metric-studio.js';
import { collectTrustSignals, renderTrustStrip } from '../../trust/trust-strip.js';
import { buildProofRoomPlan, renderProofRoom } from '../../provenance/proof-room.js';
import { summarizeTouchLedger, exportTouchLedger } from '../../provenance/ai-touch-ledger.js';

let proofRoomSeal = null;

export function getProofRoomSealForExport() {
  return proofRoomSeal || null;
}

// Build (or reuse) a seal over the latest validation summary for the composed
// seal + beam steps. Reuses the EXISTING sealCheckResult() verbatim -- no new
// crypto. The "result" is a display roll-up of the real per-layer statuses
// (worst-wins), and the data bound to the seal is that same summary.
async function buildProofRoomSeal(ds, { collectValidationSummary }) {
  if (proofRoomSeal) return proofRoomSeal;
  const { validation: valSummary } = collectValidationSummary();
  const rank = { fail: 3, warn: 2, pass: 1, idle: 0 };
  let status = 'pass';
  let flagCount = 0;
  for (const row of valSummary) {
    if (row.status !== 'pass' && row.status !== 'idle') flagCount += 1;
    if ((rank[row.status] || 0) > (rank[status] || 0)) status = row.status;
  }
  proofRoomSeal = await sealCheckResult({ status, flagCount }, {
    check: { name: 'DATAGLOW validation summary', kind: 'validation-summary' },
    params: JSON.stringify(valSummary.map((r) => r.layer)),
    dataset: {
      name: ds ? ds.name : 'active dataset',
      rowCount: ds ? (ds.rowCount ?? null) : null,
      columnNames: ds ? (ds.cols || []) : [],
    },
    data: valSummary,
    dataglow: { version: (window.__dataglowVersion || null), build: null },
  });
  return proofRoomSeal;
}

export function renderProofRoomTab(deps) {
  const {
    state, getActiveDataset, metricRegistry, engine, openMetricProof, toast,
    recordMetricDefinitionVersion, openTrustFieldProof, collectValidationSummary,
    downloadText, ledger, aiTouchLedger,
  } = deps;
  const host = document.getElementById('proof-room-body');
  if (!host) return;
  // Double-gate: the flag and (like every data-driven surface) a loaded dataset.
  if (!isEnabled('proofRoom')) { host.innerHTML = ''; return; }
  const ds = getActiveDataset();
  if (!ds) {
    host.innerHTML = '';
    host.appendChild(el('div', {
      class: 'card',
      style: 'padding:var(--space-4); font-size:var(--text-sm); color:var(--color-text-muted);',
    }, 'Load a dataset to assemble its Proof Room — the five trust surfaces compose here in order once there is data to describe.'));
    return;
  }
  // A fresh seal per (re)render of this tab -- the composed steps reflect the
  // current dataset + validation state, not a stale artifact.
  proofRoomSeal = null;

  const chain = provenance.getProvenance(ds.table);
  const plan = buildProofRoomPlan({
    datasetLoaded: true,
    hasValidationResults: !!state.validationResults,
    aiTouchLedgerEnabled: isEnabled('aiTouchLedger'),
  });

  renderProofRoom({
    host,
    plan,
    renderers: {
      metricStudio: (body) => renderMetricStudio({
        host: body,
        registry: metricRegistry,
        schemaCols: ds.cols || [],
        table: ds.table,
        engine,
        onOpenProof: openMetricProof,
        onToast: toast,
        onChange: () => renderProofRoomTab(deps),
        onDefinitionSaved: recordMetricDefinitionVersion, // Metric Contracts version trail
      }),
      trustStrip: (body) => renderTrustStrip({
        host: body,
        signals: collectTrustSignals({
          dataset: ds,
          validationResults: state.validationResults,
          metricCounts: metricRegistry.statusCounts(),
          provenanceChain: chain,
          anomalyResult: null,
        }),
        onFieldClick: openTrustFieldProof,
      }),
      dataNutritionLabel: (body) => {
        const { validation: valSummary } = collectValidationSummary();
        const label = buildDataNutritionLabel({
          dataset: ds,
          custody: chain,
          assumptions: ledger.getLedgerEntries(),
          checks: valSummary,
        });
        for (const line of renderLabelSummaryLines(label)) {
          body.appendChild(el('div', {
            style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:pre;',
          }, line));
        }
      },
      verifiableCheckSeal: (body) => {
        const note = el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-faint);',
        }, 'Sealing the latest validation summary…');
        body.appendChild(note);
        (async () => {
          try {
            const seal = await buildProofRoomSeal(ds, { collectValidationSummary });
            const check = await verifySeal(seal, undefined);
            note.remove();
            for (const line of renderSealSummaryLines(seal)) {
              body.appendChild(el('div', {
                style: 'font-size:var(--text-xs); color:var(--color-text-muted); white-space:pre;',
              }, line));
            }
            body.appendChild(el('div', {
              style: `font-size:var(--text-xs); margin-top:6px; color:var(--color-${check.commitmentValid ? 'success' : 'error'});`,
            }, check.commitmentValid ? '✓ Commitment re-verified locally' : '✗ Commitment failed to verify'));
            body.appendChild(el('button', {
              class: 'btn btn-secondary',
              style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
              'data-testid': 'proof-room-seal-download',
              onclick: () => downloadText('dataglow-check-seal.json', exportSealAsJSON(seal), 'application/json'),
            }, 'Download seal (.json)'));
          } catch (e) {
            note.textContent = 'Could not seal this result: ' + (e && e.message ? e.message : String(e));
          }
        })();
      },
      trustBeam: (body) => {
        const detail = el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-muted);',
        }, 'Turn the seal above into a self-contained link whose whole payload lives in the URL fragment — nothing is uploaded. A recipient re-verifies it in verify-beam.html with zero install.');
        body.appendChild(detail);
        body.appendChild(el('button', {
          class: 'btn btn-primary',
          style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start; margin-top:6px;',
          'data-testid': 'proof-room-beam-create',
          onclick: async () => {
            try {
              const seal = await buildProofRoomSeal(ds, { collectValidationSummary });
              const baseUrl = new URL('verify-beam.html', window.location.href).href;
              const url = buildBeamUrl(seal, baseUrl);
              let field = body.querySelector('[data-testid="proof-room-beam-link"]');
              if (!field) {
                field = el('input', {
                  type: 'text', readonly: 'readonly',
                  'data-testid': 'proof-room-beam-link',
                  style: 'width:100%; margin-top:6px; font-family:var(--font-mono); font-size:var(--text-xs); '
                    + 'padding:4px 6px; border:1px solid var(--color-border); border-radius:var(--radius-sm); '
                    + 'background:var(--color-surface-2); color:var(--color-text);',
                  onclick: (e) => e.target.select(),
                });
                body.appendChild(field);
              }
              field.value = url;
              field.select && field.select();
              toast('Beam link ready — copy it to share', 'success');
            } catch (e) {
              toast('Could not build a beam link: ' + (e && e.message ? e.message : String(e)), 'error');
            }
          },
        }, 'Beam it'));
      },
      aiTouchLedger: (body) => {
        const entries = aiTouchLedger.getEntries();
        if (!entries.length) {
          body.appendChild(el('div', {
            style: 'font-size:var(--text-xs); color:var(--color-text-faint); font-style:italic;',
          }, 'No AI touches recorded yet this session — generate a story with an on-device or external model in the Story tab to see entries here.'));
          return;
        }
        body.appendChild(el('div', {
          style: 'font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:6px;',
        }, summarizeTouchLedger(entries)));
        body.appendChild(el('button', {
          class: 'btn btn-secondary',
          style: 'font-size:var(--text-xs); padding:2px 8px; align-self:flex-start;',
          'data-testid': 'proof-room-ai-touch-ledger-export',
          onclick: () => downloadText('dataglow-ai-touch-ledger.json', exportTouchLedger(entries, 'json'), 'application/json'),
        }, 'Download AI Touch Ledger (.json)'));
      },
    },
  });
}

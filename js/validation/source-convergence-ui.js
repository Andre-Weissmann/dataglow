// ============================================================
// DATAGLOW — Source Convergence (Batch 3 of 3, final): the Convergence UI
// ============================================================
// WHAT THIS IS: the presenter for the two already-merged, already-tested
// Source Convergence engine layers. It invents NO convergence logic of its own —
// it only wires them into a visible "Convergence" tab:
//   - Batch 1 (js/validation/source-convergence.js): buildConvergenceGraph,
//     computeConvergenceClusters, resolveClusterWithTrust, summarizeConvergence.
//   - Batch 2 (js/validation/source-convergence-ingestion.js): adaptExcelWorkbook,
//     adaptApiSource, adaptSiteExport, toEngineSources.
// Both are treated as stable dependencies; this file does not touch their APIs.
//
// IDENTITY SPLIT (same convention as js/rooms/room-ui.js and
// js/diplomacy/diplomacy-ui.js): the model builders are PURE, Node-testable,
// DOM-free functions (buildConvergenceView / buildSourceCardModel /
// sourceKindBadge / formatTrust / buildEscalationModel / toggleExpanded); the
// browser-only renderer (mountConvergence) turns those models into DOM and owns
// the two browser affordances — reading a file with the app's existing global
// XLSX, and a user-initiated client-side fetch() — exactly the bits Batch 2
// deferred to "the UI batch".
//
// DISCIPLINE:
//   - zero-upload/local-first: every load reads data the user chose, client-side,
//     and only ever produces a LOCAL summary; nothing is uploaded. A URL pull is
//     a plain outbound fetch() the user initiated — it sends no dataset anywhere.
//   - honest EMPTY STATE: with no sources loaded the tab shows a real "load
//     something" prompt, never the mockup's fixed demo numbers.
//   - the pure builders NEVER throw — malformed input yields a safe view model.
// ============================================================

import { el } from '../app-shell/utils.js';
import {
  buildConvergenceGraph,
  computeConvergenceClusters,
  resolveClusterWithTrust,
  summarizeConvergence,
  DEFAULT_MARGIN_THRESHOLD,
} from './source-convergence.js';
import {
  adaptExcelWorkbook,
  adaptApiSource,
  adaptSiteExport,
  toEngineSources,
} from './source-convergence-ingestion.js';

// ---------- tiny total helpers ----------

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Flatten a mix of single-source and per-sheet-array adapter results into one
// flat list of source objects, KEEPING each source's meta (unlike
// toEngineSources, which drops it) so the source rail can show provenance.
function flattenAdapterResults(adapterResults) {
  const flat = [];
  for (const r of Array.isArray(adapterResults) ? adapterResults : [adapterResults]) {
    if (Array.isArray(r)) { for (const s of r) if (isPlainObject(s)) flat.push(s); }
    else if (isPlainObject(r)) flat.push(r);
  }
  return flat;
}

// ============================================================
// shouldOfferConvergence({ enabled }) — the single pure gate the caller checks
// before mounting anything. True only when the flag is on. No DOM, no flag read.
// ============================================================
export function shouldOfferConvergence({ enabled } = {}) {
  return enabled === true;
}

// ============================================================
// sourceKindBadge(kind) — the type badge for a source card. Reuses the existing
// .badge vocabulary (css/base.css); invents no new colors. Never throws.
// ============================================================
export function sourceKindBadge(kind) {
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  switch (k) {
    case 'excel': return { label: 'Excel tab', className: 'badge badge-a' };
    case 'csv': return { label: 'CSV', className: 'badge badge-a' };
    case 'upload': return { label: 'File', className: 'badge badge-a' };
    case 'api': return { label: 'API', className: 'badge badge-b' };
    case 'site': return { label: 'Site export', className: 'badge badge-c' };
    default: return { label: k || 'Source', className: 'badge' };
  }
}

// ============================================================
// formatTrust(n) — a two-decimal trust label, or '—' when absent. Never throws.
// ============================================================
export function formatTrust(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—';
}

// Render a possibleKeys list (strings or composite arrays) as a readable label.
export function formatKeyList(possibleKeys) {
  if (!Array.isArray(possibleKeys) || possibleKeys.length === 0) return null;
  const parts = [];
  for (const k of possibleKeys) {
    if (typeof k === 'string' && k.trim() !== '') parts.push(k.trim());
    else if (Array.isArray(k)) {
      const cols = k.filter(c => typeof c === 'string' && c.trim() !== '').map(c => c.trim());
      if (cols.length) parts.push(cols.join('+'));
    }
  }
  return parts.length ? parts.join(', ') : null;
}

// ============================================================
// buildSourceCardModel(source) — a pure, DOM-free view model for ONE source-rail
// card, straight from a Batch 2 adapter output ({ id, rows, possibleKeys, trust,
// meta }). Reuses the adapter's own meta (kind/rowCount/needsManualKeySelection/
// url) rather than re-deriving anything. Never throws.
// ============================================================
export function buildSourceCardModel(source) {
  if (!isPlainObject(source)) {
    return { id: '(invalid source)', ok: false, badge: sourceKindBadge(''), rowText: '—', keyLabel: null, trustText: '—', needsManualKey: false, reason: 'not a source object', live: false };
  }
  const meta = isPlainObject(source.meta) ? source.meta : {};
  const kind = typeof meta.kind === 'string' ? meta.kind : null;
  const ok = meta.ok !== false;
  const rowCount = Number.isFinite(meta.rowCount)
    ? meta.rowCount
    : (Array.isArray(source.rows) ? source.rows.length : 0);
  const live = kind === 'api';
  return {
    id: source.id != null ? String(source.id) : '(unnamed)',
    ok,
    badge: sourceKindBadge(kind),
    kind,
    rowText: live ? 'live pull' : `${rowCount.toLocaleString('en-US')} rows`,
    rowCount,
    keyLabel: formatKeyList(source.possibleKeys),
    trustText: formatTrust(source.trust),
    trust: typeof source.trust === 'number' ? source.trust : null,
    needsManualKey: meta.needsManualKeySelection === true,
    url: meta.url ?? null,
    reason: ok ? null : (meta.reason || 'source has no usable rows'),
    live,
  };
}

// A short, readable identifier for a cluster from its joinKeys ([{key,value}]).
function clusterJoinLabel(cluster) {
  const jk = isPlainObject(cluster) && Array.isArray(cluster.joinKeys) ? cluster.joinKeys : [];
  if (jk.length === 0) return '(unkeyed)';
  const seen = new Set();
  const parts = [];
  for (const { key, value } of jk) {
    const sig = `${key}=${value}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    parts.push(sig);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

// ============================================================
// buildEscalationModel(cluster, resolution) — a pure detail model for ONE
// escalated cluster: which columns disagree, the competing values with their
// source + trust, the computed margin, and the engine's reason. Reuses the
// resolution object resolveClusterWithTrust already produced. Never throws.
// ============================================================
export function buildEscalationModel(cluster, resolution) {
  const res = isPlainObject(resolution) ? resolution : {};
  const resolutions = Array.isArray(res.resolutions) ? res.resolutions : [];
  const fields = resolutions
    .filter(r => isPlainObject(r) && r.resolved === false)
    .map(r => ({
      column: r.column,
      reason: r.reason || 'escalated',
      margin: Number.isFinite(r.margin) ? r.margin : null,
      rationale: r.rationale || null,
      candidates: (Array.isArray(r.candidates) ? r.candidates : []).map(c => ({
        sourceId: c.sourceId != null ? String(c.sourceId) : null,
        value: c.value,
        trust: typeof c.trust === 'number' && Number.isFinite(c.trust) ? c.trust : null,
      })),
    }));
  return {
    clusterId: isPlainObject(cluster) ? (cluster.id ?? null) : null,
    joinLabel: clusterJoinLabel(cluster),
    sourceIds: isPlainObject(cluster) && Array.isArray(cluster.sourceIds) ? cluster.sourceIds : [],
    coverageCount: isPlainObject(cluster) ? (cluster.coverageCount || 0) : 0,
    fields,
  };
}

// ============================================================
// toggleExpanded(expandedSet, clusterId) — the pure click-through state
// transition: returns a NEW Set with clusterId toggled on/off. The renderer
// holds the Set and re-renders; keeping the transition pure makes the
// expand/collapse logic Node-testable without a DOM. Never throws.
// ============================================================
export function toggleExpanded(expandedSet, clusterId) {
  const next = new Set(expandedSet instanceof Set ? expandedSet : []);
  if (clusterId == null) return next;
  if (next.has(clusterId)) next.delete(clusterId);
  else next.add(clusterId);
  return next;
}

// ============================================================
// buildConvergenceView(adapterResults, { marginThreshold }) — THE pipeline.
// Runs the whole Source Convergence flow over Batch 2 adapter output and returns
// one DOM-free view model the renderer paints:
//   toEngineSources -> buildConvergenceGraph -> computeConvergenceClusters
//   -> resolveClusterWithTrust (per cluster, attached as cluster.resolution)
//   -> summarizeConvergence.
// Returns (never throws):
//   {
//     ok, reason, isEmpty,
//     sources:      [sourceCardModel...],          // the source rail (incl. error sources)
//     usableCount,                                  // sources actually fed to the engine
//     allSourceIds: [id...],                        // coverage-matrix columns
//     matrix:       [{ clusterId, joinLabel, sourceIds, coverageCount, status, conflictCount }],
//     summary:      summarizeConvergence(...) | null,
//     escalations:  [escalationModel...],
//   }
// ============================================================
export function buildConvergenceView(adapterResults, { marginThreshold = DEFAULT_MARGIN_THRESHOLD } = {}) {
  try {
    const flat = flattenAdapterResults(adapterResults);
    const sources = flat.map(buildSourceCardModel);

    const { sources: engineSources, sourceTrust } = toEngineSources(flat);
    const usableCount = engineSources.length;

    if (usableCount === 0) {
      return {
        ok: true, reason: null, isEmpty: true,
        sources, usableCount: 0, allSourceIds: [],
        matrix: [], summary: null, escalations: [],
      };
    }

    const graph = buildConvergenceGraph(engineSources);
    if (!graph || graph.evaluated !== true) {
      return {
        ok: false, reason: (graph && graph.reason) || 'could not build convergence graph',
        isEmpty: false, sources, usableCount, allSourceIds: engineSources.map(s => String(s.id)),
        matrix: [], summary: null, escalations: [],
      };
    }

    const clusters = computeConvergenceClusters(graph, engineSources);
    // Attach the trust resolution to each conflicting cluster so
    // summarizeConvergence can count auto-resolved vs. needs-human, and so the
    // escalate list can show the engine's own reasoning verbatim.
    for (const c of clusters) {
      if (isPlainObject(c) && c.hasConflict) {
        c.resolution = resolveClusterWithTrust(c, sourceTrust, { marginThreshold });
      }
    }

    const allSourceIds = Array.isArray(graph.sources) ? graph.sources.map(String) : [];

    // Coverage matrix: only the JOINED clusters (present in 2+ sources) are
    // interesting — a single-source cluster has nothing to converge.
    const matrix = clusters
      .filter(c => isPlainObject(c) && c.coverageCount >= 2)
      .map(c => {
        let status = 'agreed';
        if (c.hasConflict) status = (c.resolution && c.resolution.escalated) ? 'escalate' : 'resolved';
        return {
          clusterId: c.id,
          joinLabel: clusterJoinLabel(c),
          sourceIds: Array.isArray(c.sourceIds) ? c.sourceIds : [],
          coverageCount: c.coverageCount,
          conflictCount: Array.isArray(c.conflicts) ? c.conflicts.length : 0,
          status,
        };
      });

    const escalations = clusters
      .filter(c => isPlainObject(c) && c.hasConflict && c.resolution && c.resolution.escalated)
      .map(c => buildEscalationModel(c, c.resolution));

    const summary = summarizeConvergence(clusters);

    return {
      ok: true, reason: null, isEmpty: false,
      sources, usableCount, allSourceIds,
      matrix, summary, escalations,
    };
  } catch (e) {
    return {
      ok: false, reason: `unevaluable: ${e && e.message ? e.message : 'unknown error'}`,
      isEmpty: false, sources: [], usableCount: 0, allSourceIds: [],
      matrix: [], summary: null, escalations: [],
    };
  }
}

// ============================================================
// mountConvergence({ host, onToast, marginThreshold }) — the BROWSER renderer.
// Left to the browser/e2e path (like room-ui.js's renderRoomUi): it owns the two
// browser-only affordances Batch 2 deferred — reading a file via the app's global
// XLSX, and a user-initiated client-side fetch() — then feeds their parsed output
// through the Batch 2 adapters and repaints the pure view. Returns a handle
// { getState, destroy } or null when there is no host.
// ============================================================
export function mountConvergence(opts = {}) {
  const { host, onToast = () => {}, marginThreshold = DEFAULT_MARGIN_THRESHOLD } = opts;
  if (!host) return null;

  let adapterResults = []; // accumulates each load's adapter output
  let expanded = new Set(); // expanded escalation cluster ids

  const toastSafe = (msg, type) => { try { onToast(msg, type); } catch { /* never bubble */ } };

  function addResult(result) {
    adapterResults.push(result);
    render();
  }

  // ---- browser-only loaders ----

  async function handleFile(file) {
    if (!file) return;
    const name = file.name || 'file';
    const lower = name.toLowerCase();
    try {
      if (/\.(xlsx|xlsm|xlsb|xls)$/.test(lower)) {
        if (typeof XLSX === 'undefined') { toastSafe('Excel support unavailable', 'error'); return; }
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const sheets = wb.SheetNames.map((sheetName) => ({
          sheetName,
          rows: XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true }),
        }));
        addResult(adaptExcelWorkbook(sheets, { fileName: name }));
        toastSafe(`Loaded ${sheets.length} tab(s) from ${name}`, 'success');
      } else if (/\.json$/.test(lower)) {
        const data = JSON.parse(await file.text());
        addResult(adaptApiSource(data, { sourceId: name }));
        toastSafe(`Loaded ${name}`, 'success');
      } else {
        toastSafe('Load an .xlsx or .json file (or pull a URL)', 'warn');
      }
    } catch (e) {
      toastSafe(`Could not read ${name}: ${e && e.message ? e.message : 'parse error'}`, 'error');
    }
  }

  async function handleUrlPull(url, kind) {
    const u = (url || '').trim();
    if (u === '') { toastSafe('Enter a URL to pull', 'warn'); return; }
    try {
      // User-initiated, client-side fetch: pulls data IN; sends no dataset out.
      const res = await fetch(u);
      const data = await res.json();
      const adapt = kind === 'site' ? adaptSiteExport : adaptApiSource;
      addResult(adapt(data, { url: u }));
      toastSafe(`Pulled from ${u}`, 'success');
    } catch (e) {
      toastSafe(`Pull failed: ${e && e.message ? e.message : 'network/parse error'}`, 'error');
    }
  }

  // ---- DOM builders ----

  function loaderBar() {
    const fileInput = el('input', {
      type: 'file', accept: '.xlsx,.xls,.xlsm,.xlsb,.json', 'data-testid': 'convergence-file-input',
      style: 'display:none',
      onchange: (e) => { const f = e.target.files && e.target.files[0]; handleFile(f); e.target.value = ''; },
    });
    const urlInput = el('input', {
      type: 'text', class: 'input', placeholder: 'https://…/data.json',
      'data-testid': 'convergence-url-input', style: 'flex:1;min-width:160px;',
    });
    const kindSelect = el('select', { class: 'input', 'data-testid': 'convergence-url-kind', style: 'max-width:130px;' }, [
      el('option', { value: 'api' }, 'API'),
      el('option', { value: 'site' }, 'Site export'),
    ]);
    return el('div', { class: 'convergence-loader', 'data-testid': 'convergence-loader' }, [
      fileInput,
      el('button', {
        class: 'btn btn-primary', 'data-testid': 'convergence-add-file',
        onclick: () => fileInput.click(),
      }, 'Add Excel / JSON file'),
      el('div', { class: 'convergence-url-row' }, [
        urlInput,
        kindSelect,
        el('button', {
          class: 'btn', 'data-testid': 'convergence-pull-url',
          onclick: () => handleUrlPull(urlInput.value, kindSelect.value),
        }, 'Pull'),
      ]),
    ]);
  }

  function emptyState() {
    return el('div', { class: 'empty-state', 'data-testid': 'convergence-empty' }, [
      el('div', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/></svg>' }),
      el('h3', {}, 'No sources loaded yet'),
      el('p', {}, 'Load two or more sources — Excel workbook tabs, a JSON file, or a live API / site pull — to reconcile them across the Truth Network. Nothing leaves your device.'),
    ]);
  }

  function sourceRail(view) {
    const cards = view.sources.map((m) => el('div', {
      class: `convergence-source-card${m.ok ? '' : ' is-error'}`,
      'data-testid': 'convergence-source-card',
    }, [
      el('div', { class: 'convergence-source-head' }, [
        el('span', { class: m.badge.className }, m.badge.label),
        el('span', { class: 'convergence-source-trust', title: 'default trust weight' }, `trust ${m.trustText}`),
      ]),
      el('div', { class: 'convergence-source-id' }, m.id),
      el('div', { class: 'convergence-source-meta' }, m.ok
        ? `${m.rowText}${m.keyLabel ? ` · key: ${m.keyLabel}` : (m.needsManualKey ? ' · needs manual key' : '')}`
        : (m.reason || 'unusable')),
    ]));
    return el('section', { class: 'convergence-section' }, [
      el('h3', { class: 'convergence-section-title' }, `Sources (${view.usableCount} usable)`),
      el('div', { class: 'convergence-rail', 'data-testid': 'convergence-rail' }, cards),
    ]);
  }

  function statusPill(status) {
    const map = {
      agreed: { label: 'Agreed', className: 'badge badge-a' },
      resolved: { label: 'Resolved', className: 'badge badge-a' },
      escalate: { label: 'Escalate', className: 'badge badge-c' },
    };
    const s = map[status] || { label: status, className: 'badge' };
    return el('span', { class: s.className }, s.label);
  }

  function coverageMatrix(view) {
    if (view.matrix.length === 0) {
      return el('section', { class: 'convergence-section' }, [
        el('h3', { class: 'convergence-section-title' }, 'Coverage matrix'),
        el('p', { class: 'convergence-hint', 'data-testid': 'convergence-matrix-empty' },
          'No cluster spans two or more sources yet — the loaded sources share no join key/value. Load sources that share an id (or a composite key) to see them converge.'),
      ]);
    }
    const headRow = el('tr', {}, [
      el('th', {}, 'Entity (join)'),
      ...view.allSourceIds.map((id) => el('th', { class: 'convergence-col-source', title: id }, id)),
      el('th', {}, 'Status'),
    ]);
    const bodyRows = view.matrix.map((row) => {
      const inSource = new Set(row.sourceIds.map(String));
      return el('tr', {}, [
        el('td', { class: 'convergence-cell-entity' }, row.joinLabel),
        ...view.allSourceIds.map((id) => el('td', { class: 'convergence-cell-dot' },
          el('span', { class: inSource.has(id) ? 'convergence-dot on' : 'convergence-dot' }, ''))),
        el('td', {}, statusPill(row.status)),
      ]);
    });
    return el('section', { class: 'convergence-section' }, [
      el('h3', { class: 'convergence-section-title' }, 'Coverage matrix'),
      el('div', { class: 'convergence-table-scroll' }, [
        el('table', { class: 'convergence-matrix', 'data-testid': 'convergence-matrix' }, [
          el('thead', {}, headRow),
          el('tbody', {}, bodyRows),
        ]),
      ]),
    ]);
  }

  function verdictPanel(view) {
    const text = view.summary && view.summary.text ? view.summary.text : 'No joined clusters to summarize yet.';
    return el('section', { class: 'convergence-section' }, [
      el('div', { class: 'convergence-verdict', 'data-testid': 'convergence-verdict' }, [
        el('div', { class: 'convergence-verdict-text' }, text),
      ]),
    ]);
  }

  function escalationList(view) {
    if (view.escalations.length === 0) {
      return el('section', { class: 'convergence-section' }, [
        el('h3', { class: 'convergence-section-title' }, 'Escalate for human review'),
        el('p', { class: 'convergence-hint', 'data-testid': 'convergence-escalate-empty' },
          'Nothing needs a human — every cross-source conflict either agreed or auto-resolved by a decisive trust margin.'),
      ]);
    }
    const items = view.escalations.map((esc) => {
      const isOpen = expanded.has(esc.clusterId);
      const detail = isOpen ? el('div', { class: 'convergence-escalate-detail', 'data-testid': 'convergence-escalate-detail' },
        esc.fields.map((f) => el('div', { class: 'convergence-conflict-field' }, [
          el('div', { class: 'convergence-conflict-col' }, [
            el('strong', {}, f.column),
            el('span', { class: 'convergence-conflict-margin' },
              f.margin == null ? ` — ${f.reason}` : ` — margin ${f.margin.toFixed(3)} (${f.reason})`),
          ]),
          el('table', { class: 'convergence-candidates' }, [
            el('thead', {}, el('tr', {}, [el('th', {}, 'Source'), el('th', {}, 'Value'), el('th', {}, 'Trust')])),
            el('tbody', {}, f.candidates.map((c) => el('tr', {}, [
              el('td', {}, c.sourceId || '—'),
              el('td', {}, c.value == null ? '—' : String(c.value)),
              el('td', {}, formatTrust(c.trust)),
            ]))),
          ]),
        ]))
      ) : null;

      return el('div', { class: 'convergence-escalate-item', 'data-testid': 'convergence-escalate-item' }, [
        el('button', {
          class: 'convergence-escalate-head',
          'data-testid': 'convergence-escalate-toggle',
          'aria-expanded': isOpen ? 'true' : 'false',
          onclick: () => { expanded = toggleExpanded(expanded, esc.clusterId); render(); },
        }, [
          el('span', { class: 'convergence-escalate-caret' }, isOpen ? '▾' : '▸'),
          el('span', { class: 'convergence-escalate-title' }, esc.joinLabel),
          el('span', { class: 'convergence-escalate-count' },
            `${esc.fields.length} conflict${esc.fields.length === 1 ? '' : 's'} · ${esc.coverageCount} sources`),
        ]),
        detail,
      ].filter(Boolean));
    });
    return el('section', { class: 'convergence-section' }, [
      el('h3', { class: 'convergence-section-title' }, `Escalate for human review (${view.escalations.length})`),
      el('div', { class: 'convergence-escalate-list' }, items),
    ]);
  }

  function render() {
    host.innerHTML = '';
    const view = buildConvergenceView(adapterResults, { marginThreshold });
    const root = el('div', { class: 'convergence-root', 'data-testid': 'convergence-root' }, [loaderBar()]);

    if (!view.ok) {
      root.appendChild(el('p', { class: 'convergence-hint', 'data-testid': 'convergence-error' },
        `Could not evaluate convergence: ${view.reason || 'unknown'}.`));
    } else if (view.isEmpty) {
      root.appendChild(emptyState());
    } else {
      root.appendChild(verdictPanel(view));
      root.appendChild(sourceRail(view));
      root.appendChild(coverageMatrix(view));
      root.appendChild(escalationList(view));
    }
    host.appendChild(root);
  }

  render();

  return {
    getState: () => ({ adapterResults: [...adapterResults], expanded: new Set(expanded) }),
    addResult,
    destroy: () => { host.innerHTML = ''; adapterResults = []; expanded = new Set(); },
  };
}

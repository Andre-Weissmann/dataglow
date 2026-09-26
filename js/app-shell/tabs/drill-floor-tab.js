// ============================================================
// Drill Floor Tab (Batch 1 + Batch 2 -- ships dark behind the drillFloor flag)
// ============================================================
// Practice-problem module: the SAME drill is solved side-by-side in SQL, Python
// and R against the drill's own bundled tables (drill_orders / drill_promos),
// loaded once per session into DuckDB. The tab's flag is checked HERE (the
// caller), never inside js/drill-floor/*. Python/R runtimes are heavy, so we do
// NOT initialize them when the tab opens -- only on the first click of each
// language's Run button (see the handlers below), mirroring ensurePythonRuntime /
// ensureRRuntime used by the Python/R tabs.
//
// Batch 2 adds a cross-language comparison panel below the three columns. After
// EVERY run we store that language's latest result and re-run the PURE diff
// engine (js/drill-floor/drill-diff.js) over whatever has run so far, so the
// panel is always accurate for partial state: each language shows its own
// not-run / errored / no-count / row-count status, and when two or more counts
// are comparable the panel explains match/mismatch grounded in the ACTUAL
// numbers plus an optional caveat-flagged likely-cause hint.
//
// Extracted verbatim from js/app-shell/main.js during the Structural Readiness
// Phase item 3 (main.js monolith paydown, batch 2b part 2, 2026-09-26) --
// byte-for-byte identical behavior, only the file location changed.
//
// Dependency-injection note: `ensurePythonRuntime` and `ensureRRuntime` are
// main.js-only functions also called directly from main.js's tab-dispatch
// (for the Python/R tabs themselves), so they stay defined in main.js and are
// passed into this module via the `deps` object rather than being duplicated
// or re-exported. Every other identifier used here (`state`, `getActiveDataset`,
// `engine`, `pyRuntime`, `rRuntime`, `drillFloor`, `drillFloorData`, `drillDiff`,
// `isEnabled`, `$`, `toast`, `escapeHtml`) is independently importable from its
// own source module. `drillReceiptLine`/`recordDrillReceipt` were confirmed via
// a whole-file grep to be used ONLY within this tab, so they moved here in full
// rather than being injected.

import { state, getActiveDataset } from '../state.js';
import { $, toast, escapeHtml } from '../utils.js';
import { isEnabled } from '../../build/build-flags.js';
import * as engine from '../duckdb-engine.js';
import * as pyRuntime from '../../runtimes-viz/python-runtime.js';
import * as rRuntime from '../../runtimes-viz/r-runtime.js';
import * as drillFloor from '../../drill-floor/drill-floor.js';
import * as drillFloorData from '../../drill-floor/drill-floor-data.js';
import * as drillDiff from '../../drill-floor/drill-diff.js';

let drillFloorLoaded = false;
// Bundle 16: which drill is on screen persists across tab re-renders (module-
// level, like drillFloorLoaded) so switching drills doesn't require re-picking
// on every render. Defaults to the original Batch 1 drill.
let drillFloorActiveId = 'spot-the-sale';

// Bundle 16: best-effort, never-throwing RECEIPT-line export for one drill
// check-answer result. Mirrors the shape other receipt lines in this codebase
// use (a short human sentence), sent to the same sinks csv-quarantine's
// receiptLine consumers use when present, and always at least logged to the
// console so the line exists even in a build with neither sink mounted.
function drillReceiptLine(scoreResult) {
  if (!scoreResult) return null;
  const engineLabel = scoreResult.engine === 'sql' ? 'SQL' : scoreResult.engine === 'python' ? 'Python' : scoreResult.engine === 'r' ? 'R' : String(scoreResult.engine);
  const verdict = scoreResult.pass ? 'PASS' : 'FAIL';
  const numbers = scoreResult.expected !== null && scoreResult.expected !== undefined
    ? `expected ${scoreResult.expected}, got ${scoreResult.got === null || scoreResult.got === undefined ? 'unknown' : scoreResult.got}`
    : (scoreResult.error || 'no comparable result');
  return {
    line: `Drill "${scoreResult.drillId}" (${engineLabel}): ${verdict} - ${numbers}`,
    drillId: scoreResult.drillId,
    engine: scoreResult.engine,
    pass: scoreResult.pass,
    expected: scoreResult.expected,
    got: scoreResult.got,
  };
}

function recordDrillReceipt(scoreResult) {
  const line = drillReceiptLine(scoreResult);
  if (!line) return;
  try {
    const t = window.DataGlowTrustLedger;
    if (t && typeof t.record === 'function') t.record(line);
  } catch (_e) {}
  try { console.log('[drill receipt] ' + line.line); } catch (_e2) {}
  // Bundle 16: a passing/failing drill run is itself worth a Repair Ledger
  // row when the battery flag is on, via the SAME shared, never-throwing
  // append every other surface uses.
  try {
    const ui = window.DataGlowRepairLedgerUI;
    if (isEnabled('receiptDrillBattery') && ui && typeof ui.appendFromSurface === 'function') {
      const kind = scoreResult.engine === 'python' ? 'python_recipe' : scoreResult.engine === 'r' ? 'r_recipe' : 'sql_recipe_run';
      ui.appendFromSurface(kind, {
        engine: scoreResult.engine === 'sql' ? 'sql' : scoreResult.engine,
        title: 'Drill check: ' + scoreResult.drillId,
        summary: line.line,
        status: scoreResult.pass ? 'applied' : 'failed',
      });
    }
  } catch (_e3) {}
}

export async function renderDrillFloorTab({ ensurePythonRuntime, ensureRRuntime }) {
  const host = document.getElementById('drill-floor-body');
  if (!host) return;
  if (!isEnabled('drillFloor')) { host.innerHTML = ''; drillFloorLoaded = false; return; }
  const battleOn = isEnabled('receiptDrillBattery');
  const drill = drillFloor.getDrill(drillFloorActiveId) || drillFloor.DRILLS[0];
  if (!drill) { host.innerHTML = '<p class="empty-state">No drill available.</p>'; return; }

  const pane = (lang, label, textId, btnId, outId, code) => `
    <div class="drill-pane" data-testid="drill-pane-${lang}" style="display:flex; flex-direction:column; min-width:0; gap:var(--space-2);">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-2);">
        <strong>${escapeHtml(label)}</strong>
        <button type="button" class="btn btn-primary" id="${btnId}" data-testid="${btnId}">Run</button>
      </div>
      <textarea id="${textId}" data-testid="${textId}" class="code-input" spellcheck="false" style="width:100%; min-height:220px; font-family:var(--font-mono); font-size:var(--text-sm);">${escapeHtml(code)}</textarea>
      <div class="console-log" id="${outId}" data-testid="${outId}" style="min-height:48px;"><span style="color:var(--color-text-faint);">(not run yet)</span></div>
    </div>`;

  // Bundle 16: a drill picker (battery flag on, more than one drill) plus a
  // per-language "Check answer" affordance and a small honesty note. All net
  // new markup; the original single-drill shell (still what renders when the
  // battery flag is off, or only one drill exists) is unchanged below it.
  const picker = (battleOn && drillFloor.DRILLS.length > 1)
    ? `<div class="drill-picker" data-testid="drill-picker" style="display:flex; gap:var(--space-2); flex-wrap:wrap;">
        ${drillFloor.DRILLS.map((d) => `<button type="button" class="btn ${d.id === drill.id ? 'btn-primary' : 'btn-secondary'}" data-drill-id="${escapeHtml(d.id)}" data-testid="drill-pick-${escapeHtml(d.id)}">${escapeHtml(d.title)}</button>`).join('')}
      </div>`
    : '';
  const honestyNote = battleOn
    ? `<p class="drill-honesty-note" data-testid="drill-honesty-note" style="color:var(--color-text-muted); font-size:var(--text-sm); margin:0;">${escapeHtml(drillFloor.DRILL_BATTERY_HONESTY_NOTE)}</p>`
    : '';
  const excelNoteHtml = (battleOn && drill.excelNote)
    ? `<p class="drill-excel-note" data-testid="drill-excel-note" style="color:var(--color-text-muted); font-size:var(--text-sm); margin:0;">${escapeHtml(drill.excelNote)}</p>`
    : '';
  const checkRow = (lang, btnId, statusId) => battleOn
    ? `<div style="display:flex; align-items:center; gap:var(--space-2);">
        <button type="button" class="btn btn-secondary" id="${btnId}" data-testid="${btnId}">Check answer</button>
        <span id="${statusId}" data-testid="${statusId}" style="font-size:var(--text-sm); color:var(--color-text-muted);"></span>
      </div>`
    : '';

  host.innerHTML = `
    <div class="drill-floor" data-testid="drill-floor" style="display:flex; flex-direction:column; gap:var(--space-4);">
      <header style="display:flex; flex-direction:column; gap:var(--space-2);">
        ${picker}
        <div style="display:flex; align-items:center; gap:var(--space-2);">
          <h2 style="margin:0;" data-testid="drill-title">${escapeHtml(drill.title)}</h2>
          <span class="badge" data-testid="drill-difficulty">${escapeHtml(drill.difficulty)}</span>
        </div>
        <p data-testid="drill-description" style="color:var(--color-text-muted); margin-top:var(--space-2);">${escapeHtml(drill.description)}</p>
        ${honestyNote}
        ${excelNoteHtml}
      </header>
      <div class="drill-grid" style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:var(--space-4);">
        ${pane('sql', 'SQL', 'drill-sql-input', 'btn-drill-sql-run', 'drill-sql-output', drill.starterSql)}
        ${pane('python', 'Python', 'drill-py-input', 'btn-drill-py-run', 'drill-py-output', drill.starterPython)}
        ${pane('r', 'R', 'drill-r-input', 'btn-drill-r-run', 'drill-r-output', drill.starterR)}
      </div>
      <div class="drill-check-row" data-testid="drill-check-row" style="display:flex; gap:var(--space-4); flex-wrap:wrap;">
        ${checkRow('sql', 'btn-drill-sql-check', 'drill-sql-check-status')}
        ${checkRow('python', 'btn-drill-py-check', 'drill-py-check-status')}
        ${checkRow('r', 'btn-drill-r-check', 'drill-r-check-status')}
      </div>
      <div class="drill-comparison card" id="drill-comparison" data-testid="drill-comparison" style="padding:var(--space-3);"></div>
    </div>`;

  if (picker) {
    host.querySelectorAll('[data-drill-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-drill-id');
        if (id && id !== drillFloorActiveId) {
          drillFloorActiveId = id;
          renderDrillFloorTab({ ensurePythonRuntime, ensureRRuntime });
        }
      });
    });
  }

  // Load the drill's sample tables once per session. This runs CREATE OR REPLACE
  // TABLE for drill_orders / drill_promos (dedicated names -- they never touch the
  // user's own tables) and registers descriptors into state.datasets WITHOUT
  // changing the active dataset, so the Python/R pandas/df bridges can expose them
  // via dataglow.get_df / dataglow_get_df.
  if (!drillFloorLoaded) {
    drillFloorLoaded = true;
    try {
      const descriptors = await drillFloorData.loadDrillTables({ runQuery: engine.runQuery });
      for (const d of descriptors) {
        if (!state.datasets.some((ds) => ds.table === d.table)) {
          state.datasets.push({ ...d, loadedAt: Date.now() });
        }
      }
    } catch (err) {
      drillFloorLoaded = false;
      toast('Drill Floor: failed to load sample data: ' + err.message, 'error');
    }
  }

  const renderDrillOutput = (outId, { stdout, result, error, rowCount }) => {
    const out = document.getElementById(outId);
    if (!out) return;
    let html = '';
    if (typeof rowCount === 'number') html += `<div data-testid="${outId}-rowcount"><strong>${rowCount.toLocaleString()}</strong> row(s)</div>`;
    if (stdout) html += `<div>${escapeHtml(stdout)}</div>`;
    // Only render `result` as a display string when it genuinely IS one (e.g.
    // Python/R runtime bridges that surface a printable value). SQL's `result`
    // is the raw DuckDB query object (used above for rowCount) -- stringifying
    // that here used to print the literal "[object Object]" text to the user;
    // found live during drillFloor's pre-flight verification, 2026-07-18.
    if (typeof result === 'string' && result !== '') html += `<div class="ok">${escapeHtml(result)}</div>`;
    if (error) html += `<div class="err" data-testid="${outId}-error">${escapeHtml(error)}</div>`;
    if (!html) html = '<span style="color:var(--color-text-faint);">(no output)</span>';
    out.innerHTML = html;
  };

  // Per-language latest result (null = "not yet run" -- a distinct state from an
  // errored run or a run with no readable count). Fed verbatim to the pure diff
  // engine, whose return shapes each language's run* output already matches.
  const drillResults = { sql: null, python: null, r: null };

  const updateComparison = () => {
    const panel = document.getElementById('drill-comparison');
    if (!panel) return;
    const summary = drillDiff.compareDrillResults(drillResults);
    const suggestion = drillDiff.suggestLikelyCause(summary);
    const chip = (lang) => {
      const e = summary.languages[lang];
      let detail;
      if (e.state === 'ok') detail = `${e.count.toLocaleString()} rows`;
      else if (e.state === 'error') detail = 'error';
      else if (e.state === 'unknown') detail = 'no count';
      else detail = 'not run';
      return `<span class="badge" data-testid="drill-cmp-${lang}" data-state="${e.state}">${escapeHtml(drillDiff.LANG_LABELS[lang])}: ${escapeHtml(detail)}</span>`;
    };
    let html = `<div style="display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;">
        <strong>Comparison</strong>${chip('sql')}${chip('python')}${chip('r')}
      </div>
      <p data-testid="drill-cmp-status" data-status="${summary.status}" style="margin:var(--space-2) 0 0;">${escapeHtml(summary.message)}</p>`;
    if (suggestion) {
      html += `<p data-testid="drill-cmp-suggestion" style="margin:var(--space-2) 0 0; color:var(--color-text-muted);"><strong>Possible cause</strong> — ${escapeHtml(suggestion.text)}</p>`;
    }
    panel.innerHTML = html;
  };
  updateComparison();

  $('#btn-drill-sql-run').addEventListener('click', async () => {
    const out = document.getElementById('drill-sql-output');
    out.innerHTML = '<span style="color:var(--color-text-faint);">Running…</span>';
    const res = await drillFloor.runDrillSql($('#drill-sql-input').value, { runQuery: engine.runQuery });
    renderDrillOutput('drill-sql-output', res);
    drillResults.sql = res;
    updateComparison();
  });

  $('#btn-drill-py-run').addEventListener('click', async () => {
    const out = document.getElementById('drill-py-output');
    out.innerHTML = '<span style="color:var(--color-text-faint);">Loading Python runtime…</span>';
    ensurePythonRuntime();
    try {
      await pyRuntime.initPyodideRuntime();
    } catch (err) {
      const res = { error: 'Python runtime failed to load: ' + err.message };
      renderDrillOutput('drill-py-output', res);
      drillResults.python = res;
      updateComparison();
      return;
    }
    out.innerHTML = '<span style="color:var(--color-text-faint);">Running…</span>';
    const res = await drillFloor.runDrillPython($('#drill-py-input').value, { runPython: (c) => pyRuntime.runPython(c, getActiveDataset()?.table) });
    renderDrillOutput('drill-py-output', res);
    drillResults.python = res;
    updateComparison();
  });

  $('#btn-drill-r-run').addEventListener('click', async () => {
    const out = document.getElementById('drill-r-output');
    out.innerHTML = '<span style="color:var(--color-text-faint);">Loading R runtime…</span>';
    ensureRRuntime();
    try {
      await rRuntime.initWebRRuntime();
    } catch (err) {
      const res = { error: 'R runtime failed to load: ' + err.message };
      renderDrillOutput('drill-r-output', res);
      drillResults.r = res;
      updateComparison();
      return;
    }
    out.innerHTML = '<span style="color:var(--color-text-faint);">Running…</span>';
    const res = await drillFloor.runDrillR($('#drill-r-input').value, { runR: rRuntime.runR });
    renderDrillOutput('drill-r-output', res);
    drillResults.r = res;
    updateComparison();
  });

  // Bundle 16: "Check answer" buttons score the LAST run result for that
  // language against the drill's goldenAnswers (drill-floor.js's pure,
  // never-throwing scoreDrillAnswer). If the language has not been run yet,
  // this reports that plainly instead of guessing.
  if (battleOn) {
    const wireCheck = (lang, btnId, statusId) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const statusEl = document.getElementById(statusId);
        const latest = drillResults[lang];
        if (!latest) {
          if (statusEl) statusEl.textContent = 'Run this language first.';
          return;
        }
        const score = drillFloor.scoreDrillAnswer(drill.id, lang, latest);
        if (statusEl) {
          statusEl.textContent = score.pass
            ? `Pass - ${score.got} row(s), matches the golden answer.`
            : `Not yet - expected ${score.expected === null ? 'n/a' : score.expected}, got ${score.got === null ? 'unknown' : score.got}.${score.error ? ' (' + score.error + ')' : ''}`;
          statusEl.style.color = score.pass ? 'var(--color-success, #1a7f37)' : 'var(--color-danger, #cf222e)';
        }
        recordDrillReceipt(score);
      });
    };
    wireCheck('sql', 'btn-drill-sql-check', 'drill-sql-check-status');
    wireCheck('python', 'btn-drill-py-check', 'drill-py-check-status');
    wireCheck('r', 'btn-drill-r-check', 'drill-r-check-status');
  }
}

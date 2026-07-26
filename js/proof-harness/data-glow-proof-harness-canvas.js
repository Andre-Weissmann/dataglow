/* ---- from js/proof-harness/data-glow-proof-harness-canvas.js ---- */
;(function () {
  'use strict';

  /* Proof Harness (VERDICT): the claim bar plus a review inbox that the
     MASTER PROMPT doctrine calls for, not a chat panel. Doctrine #8: "There is
     no chat panel. The surface is a claim bar plus a review inbox."

     v0 shipped one card: the current claim's proposal, verdict and receipt,
     under a single Prove tab implicitly.

     v1 (this file, behind proofHarnessV1) adds a tabbed panel -- Inbox | Prove
     | Vault | Cartridge -- Inbox is the default tab, matching the spec's
     review-queue-first posture. The Prove tab is BYTE-FOR-BYTE the v0 body:
     same ids, same markup, same behavior, so a flag-off session or a session
     with proofHarnessV1 off still gets exactly v0. Everything else (Inbox
     rendering, Vault list/run, Cartridge export/import) is additive and only
     ever mounted when proofHarnessV1 is on.

     The pure engine (js/proof-harness/index.js + proposal.js + verdict.js +
     score-claim.js + receipt.js + second-engine.js + vault.js + cartridge.js +
     inbox.js, published together as window.DataGlowProofHarness) owns typed
     proposals, the verdict decision, claim scoring, the hash-chained receipt
     ledger, corroboration, the regression vault, cartridges, and the inbox
     queue state machine. This module owns only what the engine cannot: the
     button, the panel, tabs, and wiring the Prove tab's Prove button to the
     SAME live DuckDB engine Drill Floor's SQL Run/Check path already uses
     (resolveDrillSqlRunQuery / window.engine.runQuery / the DuckDB singleton
     -- see Bundle 18 hotfix 5, #613). No second wasm load path is created
     here, in any tab.

     DOCTRINE IN THIS FILE:
       1. AI proposes, engines prove, human confirms, in that order. The Prove
          button always runs BEFORE the Confirm button is enabled.
       2. No free-form execution: the SQL statement the Prove button runs is
          only ever handed to createTypedProposal() first; the executor
          (runQuery) is only ever called with proposal.statement, which is
          exactly what was typed into the visible, editable field, never a
          hidden or model-composed string. The Cartridge tab's import re-run
          follows the identical discipline: only the cartridge's own recorded
          statement is ever executed, never anything else.
       3. Never auto-mutate: nothing here writes to a saved session/table.
          Confirm only marks the CURRENT proposal as confirmed in memory,
          bound to its digest.
       6. Four verdict colors in v1: GREEN / RED / GRAY / AMBER (stale digest
          only). v0 had three; AMBER is additive, never a silent reclassify
          of an existing GREEN/RED/GRAY case.
       8. No chat panel. Claim bar + tabbed review surface. No free text
          response area.

     No em dash (U+2014) anywhere in this file's visible strings. */

  var BTN_ID = 'dg-proof-harness-btn';
  var PANEL_ID = 'dg-proof-harness-panel';
  var STYLE_ID = 'dg-proof-harness-styles';
  var BODY_ID = 'dg-proof-harness-body';
  var TABS_ID = 'dg-proof-harness-tabs';

  var _lastProposal = null;
  var _lastResult = null;
  var _lastEngineMissing = false;
  var _lastConfirm = null;
  var _activeTab = 'inbox'; // inbox | prove | vault | cartridge (v1 default: inbox)

  var _inboxStore = null; // created lazily from js/proof-harness/inbox.js's createInbox()
  var _lastVaultRun = null;
  var _lastCartridgeExport = null;
  var _lastCartridgeImport = null;
  var _lastCartridgeReprove = null; // 'Re-prove on this device' result (v1.1)
  var _lastExcelClaimResult = null; // {rejected, reason} | {rejected:false, statement} (v2)
  var _lastMeshExport = null; // serialized mesh attestation JSON text (v2)
  var _lastMeshCompare = null; // {agree, divergences[]} (v2)

  function engine() { return window.DataGlowProofHarness || null; }

  /* Same optional-provider read as Trust Ledger / Air-Gap / Shield Packs: a
     flags provider is honored when present, and its absence means on, since
     canvas registers no provider today. window.DATAGLOW_PROOF_HARNESS is the
     explicit local override in either direction, matching window.
     DATAGLOW_TRUST_LEDGER's pattern. */
  function flagOn() {
    try { if (window.DATAGLOW_PROOF_HARNESS === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_HARNESS === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofHarness') !== false;
      }
    } catch (_e) {}
    return true;
  }

  /* v1 umbrella flag: gates ONLY the Inbox/Vault/Cartridge tabs and their
     controls. With this off (but proofHarness still on), the panel renders
     exactly the v0 single Prove surface, no tab bar at all -- matching
     acceptance gate 4 ("Flag off: v1 tabs hidden; v0 prove path still works
     if proofHarness on"). */
  function v1FlagOn() {
    try { if (window.DATAGLOW_PROOF_HARNESS_V1 === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_HARNESS_V1 === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofHarnessV1') !== false;
      }
    } catch (_e) {}
    return true;
  }

  /* v2 umbrella flag: gates ONLY the Excel-style claim fill control + the
     adversary pass/fail note on the Prove tab, and the mesh attestation
     export/compare controls on the Cartridge tab. With this off (but
     proofHarness/proofHarnessV1 still on), the panel renders exactly the
     v1 surface -- no Excel fill control, no adversary note, no mesh
     controls -- matching acceptance gate 9 ("Flag off / skip path does
     not break v1 tests"). The pure v2 modules (adversary.js, excel-
     claim.js, mesh-attestation.js) are still evaluable via
     window.DataGlowProofHarness regardless of this flag, since they make
     no DOM change on their own; only this canvas module's UI mounting is
     gated. */
  function v2FlagOn() {
    try { if (window.DATAGLOW_PROOF_HARNESS_V2 === false) return false; } catch (_e0) {}
    try { if (window.DATAGLOW_PROOF_HARNESS_V2 === true) return true; } catch (_e1) {}
    try {
      if (window.DataGlowFlags && typeof window.DataGlowFlags.isEnabled === 'function') {
        return window.DataGlowFlags.isEnabled('proofHarnessV2') !== false;
      }
    } catch (_e) {}
    return true;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, kind || 'info'); return; } catch (_e) {}
    }
    console.info('[Proof Harness]', msg);
  }

  function inbox() {
    if (!_inboxStore && engine() && typeof engine().createInbox === 'function') {
      _inboxStore = engine().createInbox();
    }
    return _inboxStore;
  }

  /* ---------------------------- SQL engine resolution --------------------
     Reuses the exact resolver Drill Floor's SQL Run/Check path uses (Bundle
     18 hotfix 5, #613), with the same graduated fallbacks, so there is never
     a second wasm load path and the warm SQL connection stays shared. Shared
     by the Prove tab and the Cartridge tab's import re-run. */
  function resolveRunQuery() {
    if (typeof window.resolveDrillSqlRunQuery === 'function') {
      try {
        var q = window.resolveDrillSqlRunQuery();
        if (q) return q;
      } catch (_e0) {}
    }
    try {
      if (window.engine && typeof window.engine.runQuery === 'function') {
        return function (sql) { return window.engine.runQuery(sql, []); };
      }
    } catch (_e1) {}
    try {
      if (window.DuckDBEngine && typeof window.DuckDBEngine.runQuery === 'function') {
        return function (sql) { return window.DuckDBEngine.runQuery(sql, []); };
      }
    } catch (_e2) {}
    try {
      if (window._sqlEngineSingleton && typeof window._sqlEngineSingleton.runQuery === 'function') {
        return function (sql) { return window._sqlEngineSingleton.runQuery(sql, []); };
      }
    } catch (_e3) {}
    if (typeof window._dgGetSQLEngine === 'function') {
      return async function (sql) {
        var eng = await window._dgGetSQLEngine();
        if (!eng || typeof eng.runQuery !== 'function') {
          throw new Error('SQL engine not ready in this canvas.');
        }
        return eng.runQuery(sql, []);
      };
    }
    try {
      if (window.SQLEngine && typeof window.SQLEngine.init === 'function') {
        return async function (sql) {
          if (!window._sqlEngineSingleton) {
            window._sqlEngineSingleton = window.SQLEngine.init({});
            window.DuckDBEngine = window._sqlEngineSingleton;
            window.engine = window._sqlEngineSingleton;
          }
          return window._sqlEngineSingleton.runQuery(sql, []);
        };
      }
    } catch (_e4) {}
    return null;
  }

  /* ---------------------------- second engine host bridge (v1.1) --------
     PROOF_HARNESS_V1_1_SPEC.md pillar B1/B2: publish window.runProofSecondEngine,
     a real host bridge resolveSecondEngine() in js/proof-harness/second-engine.js
     now prefers over the old direct window.runDrillPython/window.runDrillR
     lookup. This function is the ONLY thing this canvas module adds to the
     window beyond what v0/v1 already published (window.DataGlowProofHarness
     itself is owned by js/proof-harness/index.js, not here).

     Contract: window.runProofSecondEngine(statement) -> Promise<{rowCount,
     rows?, scalars?, engine?, error?}>. NEVER invents agreement -- when a
     real second engine cannot run the statement, it resolves to
     {error:'pyodide-sql-unavailable'} (corroboration then reports
     ran:false, agrees:null, i.e. "not ready", never a false RED and never a
     false GREEN), it never rejects/throws (second-engine.js's corroborateRun
     always treats a caught rejection the same as an explicit error field,
     but resolving cleanly keeps this bridge's own contract explicit rather
     than relying on that catch).

     Path, in order:
       a) window.DataGlowPython (the existing Pyodide kernel this canvas
          already ships for the Python tab/notebook) must exist and expose
          loadRuntime()/buildHelper() -- both PUBLIC methods already used by
          the Python Notebooks-lite bridge, so this reuses the exact same
          kernel and dataset sync path rather than opening a second Pyodide
          load. Sync happens via buildHelper(py), the same call the single
          Python REPL and the notebook already make; this never fetches or
          uploads anything new.
       b) Prefer installing duckdb inside that same Pyodide via micropip and
          running the statement through duckdb.sql(...).fetchdf(); this is
          "a second runtime (CPython/WASM vs DuckDB-WASM JS)" per spec B5,
          not a second warehouse -- independence is the runtime/memory
          space, not a different SQL dialect family.
       c) If duckdb cannot be installed quickly (no network, micropip
          missing, timeout), and the statement is a trivial literal probe
          (SELECT 1 / SELECT <int> AS alias with no FROM clause), evaluate
          it in pure Python and return a matching rowCount:1 + scalar --
          enough to corroborate the simplest claims without a full SQL
          engine.
       d) Otherwise, return {error:'pyodide-sql-unavailable'} honestly. */

  var SECOND_ENGINE_DUCKDB_INSTALL_TIMEOUT_MS = 12000;
  var _secondEngineDuckdbReady = null; // null=unknown, true=installed, false=failed

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timed out')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /* Trivial literal probe fallback: SELECT 1 / SELECT 42 AS n, no FROM
     clause, no joins, nothing that needs a real table. Deliberately narrow
     -- this is Fallback A from the spec, not a SQL interpreter. Returns
     {rowCount, scalars} on a recognized literal SELECT, or null when the
     statement is not this trivial shape (caller then falls through to the
     honest not-available error). */
  function evalTrivialLiteralSelect(statement) {
    var stmt = String(statement || '').trim().replace(/;\s*$/, '');
    var m = /^select\s+(.+?)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?$/i.exec(stmt);
    if (!m) return null;
    var exprPart = m[1].trim();
    // Only accept a single literal number or a comma-free simple literal;
    // anything with FROM/WHERE/a function call is out of scope here.
    if (/\bfrom\b/i.test(exprPart) || /[(),]/.test(exprPart)) return null;
    if (!/^-?\d+(\.\d+)?$/.test(exprPart)) return null;
    var value = Number(exprPart);
    var alias = m[2] || (/^-?\d+$/.test(exprPart) ? (exprPart.indexOf('.') === -1 ? 'col' : 'col') : 'col');
    var scalars = {};
    scalars[alias] = value;
    return { rowCount: 1, rows: [scalars], scalars: scalars, engine: 'pyodide-literal' };
  }

  async function ensureDuckdbInPyodide(py) {
    if (_secondEngineDuckdbReady === true) return true;
    if (_secondEngineDuckdbReady === false) return false;
    try {
      // Some Pyodide builds ship duckdb already; try a plain import first
      // (cheap, no network) before reaching for micropip.
      py.runPython('import duckdb');
      _secondEngineDuckdbReady = true;
      return true;
    } catch (_eDirect) { /* fall through to micropip install */ }
    try {
      await withTimeout(
        py.loadPackage('micropip').then(function () {
          return py.runPythonAsync('import micropip\nawait micropip.install("duckdb")');
        }),
        SECOND_ENGINE_DUCKDB_INSTALL_TIMEOUT_MS
      );
      py.runPython('import duckdb');
      _secondEngineDuckdbReady = true;
      return true;
    } catch (_eInstall) {
      _secondEngineDuckdbReady = false;
      return false;
    }
  }

  /* ---- v1.2: pyodide-duckdb TABLE registration (PROOF_HARNESS_V1_2_SPEC.md
     pillar A) ----

     The v1.1 bridge called duckdb.sql(statement) directly against the
     dataset CSVs buildHelper(py) already dropped into Pyodide's globals as
     `dg_csv_<safeTableName>` strings, but it never registered any of those
     frames as duckdb TABLES first. duckdb.sql has its own separate
     in-memory catalog from that global namespace, so any `FROM <table>`
     statement always failed there and silently fell back to the trivial
     literal probe (or the honest unavailable error) -- real FROM-queries
     never actually corroborated against pyodide-duckdb. This section fixes
     that: register every `dg_csv_*` frame as a same-named duckdb table
     BEFORE running the statement, every bridge call (never assume a stale
     registration from a previous dataset survives a swap). */

  var DG_CSV_GLOBAL_RE = /^dg_csv_(.+)$/;

  /* Pure helper (spec success criterion #2 / ship item #2): given an
     iterable of Pyodide global KEY NAMES (not the globals map itself, so
     this is trivially unit-testable with a plain array or Set/Map keys),
     return the list of duckdb table names to register -- the capture group
     after the `dg_csv_` prefix, i.e. exactly SQLEngine.safeTableName(name)
     as buildDGHelper already produces. Order is preserved from the input;
     duplicates (should not occur -- one CSV global per dataset -- but a
     defensive dedupe costs nothing) are collapsed. */
  function listCsvGlobalTableNames(globalKeys) {
    var seen = {};
    var out = [];
    var keys = [];
    if (globalKeys && typeof globalKeys.keys === 'function' && typeof globalKeys.get === 'function') {
      // Map-shaped (a real Pyodide globals PyProxy behaves as a JS Map, or a
      // plain JS Map in tests) -- .keys() is the unambiguous source of key
      // names; forEach on a Map instead hands (value, key), which is not
      // what we want here, so a Map-shaped object always prefers .keys().
      var keysIter = globalKeys.keys();
      if (keysIter && typeof keysIter[Symbol.iterator] === 'function') {
        for (var kk of keysIter) keys.push(kk);
      } else if (keysIter && typeof keysIter.forEach === 'function') {
        keysIter.forEach(function (k) { keys.push(k); });
      }
    } else if (Array.isArray(globalKeys) || globalKeys instanceof Set) {
      // Array/Set forEach hands (value, index/value) -- value IS the key name.
      globalKeys.forEach(function (k) { keys.push(k); });
    } else if (globalKeys && typeof globalKeys[Symbol.iterator] === 'function') {
      for (var k2 of globalKeys) keys.push(k2);
    } else if (globalKeys && typeof globalKeys === 'object') {
      keys = Object.keys(globalKeys);
    }
    keys.forEach(function (key) {
      var m = DG_CSV_GLOBAL_RE.exec(String(key));
      if (!m) return;
      var tableName = m[1];
      if (!tableName || seen[tableName]) return;
      seen[tableName] = true;
      out.push(tableName);
    });
    return out;
  }

  /* Pure helper (HOTFIX_SQLITE_PROXY_MESH_SPEC.md #1): given ANY value a
     Pyodide PyProxy hands back through py.globals.get(...) -- a real Python
     object, a PyProxy wrapping one, `undefined` (key never set), or a
     genuine JS primitive already (e.g. in unit tests that pass in plain
     mocks, never a real Pyodide runtime) -- return the best-effort plain JS
     value:
       - null/undefined -> null (never "None"/"undefined" strings)
       - a proxy with a real .toJs() -> its converted plain-JS value
         ({create_proxies:false} so nothing borrows Pyodide memory that would
         need an explicit .destroy() the caller cannot know to call)
       - a genuine string -> itself, unchanged
       - anything else convertible -> String(v), swallowing a conversion
         throw into null rather than ever letting it escape
     This function itself never throws. */
  function pyToJs(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object' && v !== null && typeof v.toJs === 'function') {
      try {
        return v.toJs({ create_proxies: false });
      } catch (_eToJs) {
        // fall through to the string paths below rather than propagate
      }
    }
    if (typeof v === 'string') return v;
    try {
      return String(v);
    } catch (_eStr) {
      return null;
    }
  }

  /* Pure helper (HOTFIX_SQLITE_PROXY_MESH_SPEC.md #1): Pyodide's Python
     `None` frequently comes back through the JS boundary as a PyProxy that
     is truthy under `!== undefined && !== null` (it is an object, not the
     JS null it represents) and whose `String(proxy)` is the literal text
     `"None"` -- NOT a real error message. The old
     `errProxy !== undefined && errProxy !== null` check therefore treated
     every successful sqlite run as an error, because
     `_dg_second_engine_sqlite_error` starts life as Python `None` in the
     snippet below and a real Pyodide proxy for that None is neither
     undefined nor JS null. This helper is the single place that decides
     "is this actually a reported error string" -- true Python None (via
     pyToJs converting it to JS null/undefined), an empty string, or the
     literal text "None" (a stringified None proxy that slipped past a
     conversion attempt) are ALL treated as "no error", exactly per spec:
     "ignore null/undefined/''/'None'". Anything else non-empty is a real
     error message. */
  function isRealPyodideErrorValue(v) {
    var jsVal = pyToJs(v);
    if (jsVal === null || jsVal === undefined) return false;
    if (typeof jsVal !== 'string') {
      try {
        jsVal = String(jsVal);
      } catch (_eCoerce) {
        return false;
      }
    }
    var trimmed = jsVal.trim();
    return trimmed !== '' && trimmed !== 'None';
  }

  /* Pure helper (ship item #2): build the Python snippet that, given a list
     of table names already known to have a `dg_csv_<name>` global string in
     scope, reads each as a pandas DataFrame from the in-memory CSV and
     registers it with duckdb under its bare table name -- pd.read_csv +
     duckdb.register, no filesystem, no re-fetch, matching spec A1 exactly.
     Kept pure/string-only (no py handle) so it is unit-testable without a
     real Pyodide runtime; the caller is responsible for actually running
     this snippet via py.runPythonAsync. */
  function buildRegisterPythonSnippet(tableNames) {
    var names = Array.isArray(tableNames) ? tableNames : [];
    var lines = [
      'import pandas as pd, io, duckdb as _dg_duckdb',
      '_dg_second_engine_tables_registered = []',
    ];
    names.forEach(function (name) {
      var safe = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
      var globalKey = 'dg_csv_' + safe;
      lines.push('if globals().get(' + JSON.stringify(globalKey) + ') is not None:');
      lines.push('    _dg_df = pd.read_csv(io.StringIO(str(globals()[' + JSON.stringify(globalKey) + '])))');
      lines.push('    _dg_duckdb.register(' + JSON.stringify(safe) + ', _dg_df)');
      lines.push('    _dg_second_engine_tables_registered.append(' + JSON.stringify(safe) + ')');
    });
    return lines.join('\n');
  }

  /* Registers every dg_csv_* global as a duckdb table on the SAME duckdb
     module/connection that runViaPyodideDuckdb's duckdb.sql(...) call uses
     (duckdb.register binds into duckdb's default in-process connection, the
     same one duckdb.sql() reads from -- no separate connection object is
     created here so there is nothing for the two calls to disagree about).
     Re-run on every bridge call per spec A3: no fingerprint/skip-if-unchanged
     shortcut, so a dataset swap can never leave a stale table silently
     corroborating a claim against old data. Returns the list of table names
     actually registered (empty array if there were no dg_csv_* globals or
     the registration Python failed, both non-fatal for the caller). */
  async function registerCsvGlobalsAsDuckdbTables(py) {
    var tableNames;
    try {
      tableNames = listCsvGlobalTableNames(py.globals);
    } catch (_eList) {
      return [];
    }
    if (!tableNames.length) return [];
    try {
      var snippet = buildRegisterPythonSnippet(tableNames);
      await py.runPythonAsync(snippet);
      var registeredProxy = py.globals.get('_dg_second_engine_tables_registered');
      var registered = (registeredProxy && typeof registeredProxy.toJs === 'function')
        ? registeredProxy.toJs()
        : registeredProxy;
      return Array.isArray(registered) ? registered : tableNames;
    } catch (_eRegister) {
      // Registration is best-effort: a bad CSV for one dataset should not
      // block corroboration of statements that do not touch it, and the
      // caller's duckdb.sql() will honestly fail on any table that never
      // got registered rather than fabricate a match.
      return [];
    }
  }

  async function runViaPyodideDuckdb(py, statement) {
    var tablesRegistered = await registerCsvGlobalsAsDuckdbTables(py);
    py.globals.set('_dg_second_engine_sql', String(statement));
    var code = [
      'import duckdb, json',
      '_dg_second_engine_res = duckdb.sql(_dg_second_engine_sql).fetchdf()',
      '_dg_second_engine_payload = json.dumps({',
      '    "columns": list(_dg_second_engine_res.columns),',
      '    "rows": _dg_second_engine_res.values.tolist(),',
      '    "rowCount": len(_dg_second_engine_res)',
      '}, default=str)',
    ].join('\n');
    await py.runPythonAsync(code);
    var payloadJson = py.globals.get('_dg_second_engine_payload');
    var payload = JSON.parse(payloadJson);
    var scalars = {};
    if (payload.rows && payload.rows.length && payload.columns) {
      payload.columns.forEach(function (col, i) { scalars[col] = payload.rows[0][i]; });
    }
    return { rowCount: payload.rowCount, rows: payload.rows, scalars: scalars, engine: 'pyodide-duckdb', tablesRegistered: tablesRegistered };
  }

  /* ---- HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md F1: pyodide-pandas narrow COUNT ----

     Live-proven root cause: micropip.install("duckdb") does not reliably
     succeed inside Pyodide (privacy warn on pypi.org / install path returns
     false), so ensureDuckdbInPyodide() can honestly resolve to false even
     though buildHelper(py) already dropped a `dg_csv_<table>` CSV string
     into the SAME Python globals that pyodide-duckdb would have registered
     from. When that happens the old bridge fell straight through to the
     webR path (or the honest unavailable error), even though the exact
     data needed to answer a narrow `SELECT COUNT(*) FROM <table>` is
     already sitting in globals as a pandas-readable CSV. This is honest
     second-engine corroboration on the same CSV sync buildHelper already
     provides -- CPython/pandas is still a second runtime from DuckDB-WASM,
     independent per spec B5, even without the duckdb Python package.

     Deliberately narrow like parseCountStarFrom itself: only ever answers
     `SELECT COUNT(*) [AS alias] FROM <table>` shape, and only when
     `dg_csv_<table>` actually exists in py.globals -- anything else returns
     null so the caller can fall through to the next honest step, never a
     guess. */
  async function runViaPyodidePandasCount(py, statement) {
    var parsed = parseCountStarFrom(statement);
    if (!parsed) return null;
    var safe = String(parsed.table).replace(/[^a-zA-Z0-9_]/g, '_');
    var globalKey = 'dg_csv_' + safe;
    var hasGlobal;
    try {
      hasGlobal = py.globals.get(globalKey) !== undefined && py.globals.get(globalKey) !== null;
    } catch (_eHas) {
      hasGlobal = false;
    }
    if (!hasGlobal) return null;
    try {
      py.globals.set('_dg_second_engine_pandas_key', globalKey);
      var code = [
        'import pandas as pd, io',
        '_dg_second_engine_pandas_df = pd.read_csv(io.StringIO(str(globals()[_dg_second_engine_pandas_key])))',
        '_dg_second_engine_pandas_n = len(_dg_second_engine_pandas_df)',
      ].join('\n');
      await py.runPythonAsync(code);
      var nProxy = py.globals.get('_dg_second_engine_pandas_n');
      var n = Number(nProxy);
      if (isNaN(n)) return null;
      var scalars = {};
      scalars[parsed.alias] = n;
      return { rowCount: 1, rows: [scalars], scalars: scalars, engine: 'pyodide-pandas', tablesRegistered: [safe] };
    } catch (_eRun) {
      // Best-effort: a CSV that pandas cannot parse (should not happen for
      // anything buildHelper produced) falls through to the next honest
      // step rather than fabricating a count.
      return null;
    }
  }

  /* ---- HOTFIX_SECOND_ENGINE_SQLITE_SQL_SPEC.md: pyodide-sqlite full SQL ----

     WHY THIS EXISTS: micropip.install("duckdb") cannot ever succeed inside
     browser Pyodide -- PyPI only ships NATIVE wheels (manylinux/macosx/win)
     for the duckdb package; there is no pure-Python/wasm duckdb wheel in
     the Pyodide lockfile at all, so ensureDuckdbInPyodide()'s micropip
     fallback is not a flaky/slow install, it is an install that can never
     succeed on this platform (the plain `import duckdb` pre-check above
     still wins first on any Pyodide build that DOES ship duckdb, e.g. a
     future lockfile that adds a wasm build -- this hotfix does not touch
     that check). The previous safety net (runViaPyodidePandasCount) only
     ever answers a narrow `SELECT COUNT(*) FROM t`, so any other
     corroboration statement (`SUM`, `GROUP BY`, `JOIN`, `WHERE`, ...) fell
     straight through to webR's equally-narrow COUNT(*)-only path, or the
     honest unavailable error -- real second-engine SQL corroboration was
     never actually possible for anything but a bare row count.

     Python's stdlib `sqlite3` module ships with EVERY CPython build,
     including Pyodide's -- no network, no micropip, nothing to install.
     This path: for every `dg_csv_<table>` global already dropped into
     Pyodide's namespace by buildHelper(py) (the exact same sync the
     duckdb/pandas paths above already read from), read it with
     `pd.read_csv` and load it into a fresh `sqlite3.connect(':memory:')`
     via `df.to_sql(table, conn, index=False, if_exists='replace')`, then
     run the proof `statement` against that same connection with
     `pandas.read_sql_query`. This answers arbitrary SQL (aggregates,
     GROUP BY, JOIN, WHERE, ORDER BY, ...) -- not just COUNT(*) -- while
     staying 100% inside what stdlib CPython + pandas (both already
     required for every path above) can do offline.

     HONESTY (spec "Honesty" section): the result is tagged engine:
     'pyodide-sqlite', never 'pyodide-duckdb' -- this is SQLite's SQL
     dialect in Python, not a second DuckDB, and some DuckDB-only syntax
     (QUALIFY, certain list comprehensions, DuckDB-specific functions) will
     legitimately fail here even when it would succeed against the primary
     DuckDB-WASM engine. A dialect failure returns null (never a fabricated
     row), so the caller falls through to the pandas-COUNT/literal/webR
     safety net below exactly like a duckdb-in-pyodide failure already
     does -- this is an ADDITIONAL rung, not a replacement for the existing
     fallback chain. */

  /* Pure helper (spec "Pure helpers" section, ship item):
     buildSqliteRegisterAndQuerySnippet(statement, tableNames) -> Python
     source string. Given the proof `statement` and the list of table names
     already known to have a `dg_csv_<name>` global in scope (the same
     names listCsvGlobalTableNames(...) already extracts for the duckdb
     path), generates the Python that:
       1. opens a fresh in-memory sqlite3 connection (fresh EVERY call, no
          cross-call caching, mirroring the duckdb path's "always
          re-register" discipline from HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md
          spec A3 -- a dataset swap must never corroborate against stale
          sqlite tables either);
       2. reads each dg_csv_<table> global via pandas.read_csv and loads it
          with df.to_sql(table, conn, index=False, if_exists='replace');
       3. runs the caller's `statement` via pandas.read_sql_query against
          that same connection and serializes {columns, rows, rowCount} as
          JSON, `default=str` so any non-JSON-native value (Timestamp,
          Decimal, numpy scalar) degrades to a string instead of throwing;
       4. on any exception (bad CSV, dialect-incompatible SQL, syntax
          error, missing table) sets _dg_second_engine_sqlite_error to the
          exception text instead of letting the exception propagate past
          runPythonAsync, so the caller (runViaPyodideSqlite) can read one
          flag either way rather than needing a try/except around the
          Pyodide call boundary itself.
     Kept pure/string-only (no py handle), exactly like
     buildRegisterPythonSnippet, so it is unit-testable without a real
     Pyodide runtime.

     HOTFIX_SQLITE_PROXY_MESH_SPEC.md #2: when the caller's JS-side
     `tableNames` list is empty (listCsvGlobalTableNames(py.globals) found
     nothing -- Pyodide's globals PyProxy iteration is not always reliable
     the very first tick after buildHelper(py) just ran), the generated
     snippet ALSO discovers `dg_csv_*` names for itself from directly inside
     the Python runtime via `list(globals())`, which is the authoritative
     source of truth the JS-side proxy walk is only mirroring. This makes
     Python-side discovery a fallback, never a replacement: an explicit,
     non-empty `tableNames` from the JS side is still honored exactly as
     before (same registered-name order, same behavior), so this is purely
     additive for the empty-list case. */
  function buildSqliteRegisterAndQuerySnippet(statement, tableNames) {
    var names = Array.isArray(tableNames) ? tableNames : [];
    var lines = [
      'import pandas as pd, io, sqlite3, json, re as _dg_re',
      '_dg_second_engine_sqlite_tables_registered = []',
      '_dg_second_engine_sqlite_error = None',
      '_dg_second_engine_sqlite_payload = None',
      '_dg_sqlite_conn = sqlite3.connect(":memory:")',
      'try:',
    ];
    var body = [];
    if (names.length > 0) {
      names.forEach(function (name) {
        var safe = String(name).replace(/[^a-zA-Z0-9_]/g, '_');
        var globalKey = 'dg_csv_' + safe;
        body.push('    if globals().get(' + JSON.stringify(globalKey) + ') is not None:');
        body.push('        _dg_df = pd.read_csv(io.StringIO(str(globals()[' + JSON.stringify(globalKey) + '])))');
        body.push('        _dg_df.to_sql(' + JSON.stringify(safe) + ', _dg_sqlite_conn, index=False, if_exists="replace")');
        body.push('        _dg_second_engine_sqlite_tables_registered.append(' + JSON.stringify(safe) + ')');
      });
    } else {
      // HOTFIX_SQLITE_PROXY_MESH_SPEC.md #2: no names came from the JS-side
      // proxy walk -- discover dg_csv_* globals directly inside Python via
      // list(globals()), which sees the real interpreter namespace rather
      // than whatever the JS<->Pyodide proxy iteration surfaced (or failed
      // to surface). Every matching key is registered under the same
      // sanitized-name discipline listCsvGlobalTableNames already uses on
      // the JS side (non [A-Za-z0-9_] -> "_"), so a table registered this
      // way is named identically to how it would have been named had the
      // JS list not been empty.
      body.push('    _dg_discovered_csv_names = []');
      body.push('    for _dg_key in list(globals()):');
      body.push('        _dg_m = _dg_re.match(r"^dg_csv_(.+)$", _dg_key)');
      body.push('        if _dg_m and globals().get(_dg_key) is not None:');
      body.push('            _dg_discovered_csv_names.append(_dg_m.group(1))');
      body.push('    for _dg_name in _dg_discovered_csv_names:');
      body.push('        _dg_safe = _dg_re.sub(r"[^a-zA-Z0-9_]", "_", _dg_name)');
      body.push('        _dg_df = pd.read_csv(io.StringIO(str(globals()["dg_csv_" + _dg_name])))');
      body.push('        _dg_df.to_sql(_dg_safe, _dg_sqlite_conn, index=False, if_exists="replace")');
      body.push('        _dg_second_engine_sqlite_tables_registered.append(_dg_safe)');
    }
    body.push('    _dg_sqlite_res = pd.read_sql_query(' + JSON.stringify(String(statement)) + ', _dg_sqlite_conn)');
    body.push('    _dg_second_engine_sqlite_payload = json.dumps({');
    body.push('        "columns": list(_dg_sqlite_res.columns),');
    body.push('        "rows": _dg_sqlite_res.values.tolist(),');
    body.push('        "rowCount": len(_dg_sqlite_res)');
    body.push('    }, default=str)');
    lines = lines.concat(body);
    lines.push('except Exception as _dg_sqlite_exc:');
    lines.push('    _dg_second_engine_sqlite_error = str(_dg_sqlite_exc)');
    lines.push('finally:');
    lines.push('    _dg_sqlite_conn.close()');
    return lines.join('\n');
  }

  /* Registers every dg_csv_* global as a sqlite3 table (via pandas
     read_csv + to_sql) on a FRESH `sqlite3.connect(":memory:")`, then runs
     `statement` against it and returns the full {rowCount, rows, scalars,
     engine, tablesRegistered} shape -- the same result contract
     runViaPyodideDuckdb already returns, so corroborateRun() (which reads
     rowCount/scalars generically) needs no changes to consume either
     engine.
     Returns null (never throws) when: there are no dg_csv_* tables to
     register AND the statement is not something sqlite could still
     legitimately answer with zero tables (e.g. a trivial literal, which
     the caller handles separately) -- the important behavior per spec
     "Dialect honesty" is that a genuine SQL failure inside sqlite
     surfaces as an error the caller can act on, so this only resolves to
     null when there is nothing at all to run (no _dg_csv_ tables in
     scope), letting the caller fall through the same way an empty-catalog
     duckdb.sql call would. A real dialect/runtime failure from sqlite
     itself is returned as {error: <message>} so the caller's honest
     fall-through logic (identical shape to a duckdb.sql() throw) still
     applies uniformly across both engines.

     HOTFIX_SQLITE_PROXY_MESH_SPEC.md #1: reads every Pyodide global through
     pyToJs(...) rather than raw truthiness/String() checks, and treats
     `_dg_second_engine_sqlite_error` as a real error only via
     isRealPyodideErrorValue(...) -- a stringified Python None (proxy or
     literal "None" text) is never mistaken for an error message, which is
     exactly the live bug that made every successful sqlite run look like a
     failure and silently fall through to pyodide-pandas. The payload is run
     through pyToJs(...) before JSON.parse so a PyProxy-wrapped JSON string
     is unwrapped/converted first instead of being JSON.parse()'d directly
     (which throws on a proxy object rather than its string content).

     HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md: live root cause (proven against
     the deployed canvas on 945166e) -- Pyodide UNVENDORS the `sqlite3`
     stdlib module. It is not bundled in the core Pyodide runtime the way
     CPython's own stdlib docs might suggest; the module only becomes
     importable after `await pyodide.loadPackage('sqlite3')` has resolved,
     exactly the same shape as `pandas`/`numpy`/`matplotlib` in
     js/runtimes-viz/python-runtime.js's `initPyodideRuntime`. Every line
     of `buildSqliteRegisterAndQuerySnippet`'s generated Python starts with
     `import ... sqlite3 ...`, so without this load every single call here
     threw `ModuleNotFoundError: No module named 'sqlite3'` inside the
     generated snippet's own try/except, which correctly (but uselessly)
     surfaced as `_dg_second_engine_sqlite_error` and sent every
     corroboration down to the narrower pyodide-pandas COUNT-only path --
     the pyodide-sqlite full-SQL rung of the fallback ladder could never
     actually be reached on a real device. `ensureSqlite3InPyodide(py)`
     below closes that gap the same way `ensureDuckdbInPyodide` already
     guards the duckdb rung: cached (promise, not just a boolean, so
     concurrent callers share one in-flight load rather than issuing the
     CDN fetch twice), timed out at ~12s, and non-throwing -- a failure
     honestly resolves to false so the caller falls through to
     pyodide-pandas exactly as it already does for any other sqlite
     failure, never a fabricated result. */

  var SQLITE3_LOAD_TIMEOUT_MS = 12000;
  var _sqlite3ReadyPromise = null; // null=not started, else a shared in-flight/resolved Promise<boolean>

  /* Loads the Pyodide-distributed `sqlite3` package (from the same Pyodide
     CDN/lockfile pandas/numpy already come from -- jsdelivr, already
     allowlisted; NOT a pypi/micropip install, so this is not subject to
     the "no native wheel" impossibility that blocks duckdb) so that
     `import sqlite3` succeeds inside the generated snippet.

     Resolution order, mirroring the spec:
       1. `py.loadPackage` -- present when `py` is the full Pyodide API
          object (true for every real caller: both the notebook-lite
          bridge's `loadPyodide()` in canvas/index.html and
          js/runtimes-viz/python-runtime.js's `initPyodideRuntime` return
          the real pyodide module object, not a restricted proxy).
       2. `window.DataGlowPython.getPyodide?.()` -- an alternate seam some
          hosts may expose a full pyodide handle through, tried only when
          `py` itself lacks `loadPackage` (defensive; no current caller
          needs this, but the spec calls for it explicitly).
       3. Neither is available -- `py.runPythonAsync` alone cannot install
          packages, so this honestly returns false (never throws) and the
          caller falls through to pyodide-pandas, same as any other
          sqlite-path failure.

     Cached as a shared promise (not re-attempted every call once it
     settles either way) so a slow/failed CDN fetch is not retried on
     every single corroboration click in the same session. */
  function ensureSqlite3InPyodide(py) {
    if (_sqlite3ReadyPromise) return _sqlite3ReadyPromise;
    _sqlite3ReadyPromise = (async () => {
      try {
        var loader = null;
        if (py && typeof py.loadPackage === 'function') {
          loader = py;
        } else if (window.DataGlowPython && typeof window.DataGlowPython.getPyodide === 'function') {
          try {
            var maybePy = await window.DataGlowPython.getPyodide();
            if (maybePy && typeof maybePy.loadPackage === 'function') loader = maybePy;
          } catch (_eGet) { /* seam not available on this host -- fall through to false below */ }
        }
        if (!loader) return false;
        await withTimeout(Promise.resolve(loader.loadPackage('sqlite3')), SQLITE3_LOAD_TIMEOUT_MS);
        // Confirm the import actually succeeds post-load rather than trusting
        // loadPackage's resolution alone (spec step 3: "After load, `import
        // sqlite3` must succeed").
        py.runPython('import sqlite3');
        return true;
      } catch (_eLoad) {
        return false;
      }
    })();
    return _sqlite3ReadyPromise;
  }

  async function runViaPyodideSqlite(py, statement) {
    var tableNames;
    try {
      tableNames = listCsvGlobalTableNames(py.globals);
    } catch (_eList) {
      tableNames = [];
    }
    try {
      await ensureSqlite3InPyodide(py);
      var snippet = buildSqliteRegisterAndQuerySnippet(statement, tableNames);
      await py.runPythonAsync(snippet);
      var errProxy = py.globals.get('_dg_second_engine_sqlite_error');
      if (isRealPyodideErrorValue(errProxy)) {
        var errJs = pyToJs(errProxy);
        return { error: typeof errJs === 'string' ? errJs : String(errJs) };
      }
      var payloadProxy = py.globals.get('_dg_second_engine_sqlite_payload');
      var payloadJs = pyToJs(payloadProxy);
      if (payloadJs === null || payloadJs === undefined || payloadJs === '' || payloadJs === 'None') return null;
      var payload = typeof payloadJs === 'string' ? JSON.parse(payloadJs) : payloadJs;
      var scalars = {};
      if (payload.rows && payload.rows.length && payload.columns) {
        payload.columns.forEach(function (col, i) { scalars[col] = payload.rows[0][i]; });
      }
      var registeredProxy = py.globals.get('_dg_second_engine_sqlite_tables_registered');
      var registeredJs = pyToJs(registeredProxy);
      var registered = Array.isArray(registeredJs) ? registeredJs : null;
      return {
        rowCount: payload.rowCount,
        rows: payload.rows,
        scalars: scalars,
        engine: 'pyodide-sqlite',
        tablesRegistered: registered || (tableNames.length ? tableNames : []),
      };
    } catch (_eRun) {
      // Registration/query Python itself failed to even run (should be
      // rare -- buildSqliteRegisterAndQuerySnippet's own try/except/finally
      // is meant to catch dialect errors before this point) -- fall
      // through honestly rather than fabricate a result.
      return null;
    }
  }

  /* ---- v1.2 pillar B: webR best-effort second path ----

     Only reached when the Pyodide path could not answer the statement at
     all (window.DataGlowPython missing, or duckdb-in-pyodide unavailable
     AND the statement was not a trivial literal). Never boots a second
     WebR runtime if a notebook host already owns one -- window.DataGlowR is
     the only public seam this bridge is allowed to use; if it is not
     present (no R Notebooks-lite host mounted / not initialized), this
     path honestly no-ops rather than reaching into the R tab's private
     closure state (_webR) which is not a public contract. */

  /* Pure helper (ship item #2 / spec B4 narrow COUNT pattern): recognize
     `SELECT COUNT(*) FROM t` / `SELECT count(*) AS c FROM t` (optionally
     quoted table name, optional trailing semicolon) and return the table
     name plus the alias to report the count under, or null for anything
     else -- deliberately narrow, refuses rather than guesses per spec B2.2. */
  function parseCountStarFrom(statement) {
    var stmt = String(statement || '').trim().replace(/;\s*$/, '');
    var m = /^select\s+count\s*\(\s*\*\s*\)\s*(?:as\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s+from\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*$/i.exec(stmt);
    if (!m) return null;
    return { table: m[2], alias: m[1] || 'c' };
  }

  /* HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md F2: never invent 0.

     Live-proven root cause: this path used to call `nrow(<table>)` directly
     and accept whatever came back, including 0 when `<table>` was never
     bound in the R session at all -- webR's nrow() on an unbound name
     throws, but some call shapes (an empty/undefined shelter, a prior
     partial eval) could still resolve to a false Number(0) and were
     accepted as a REAL zero-row answer. Either way, a MISSING table must
     never be reported as a present table with n=0 rows: that is the exact
     false RED this hotfix closes (webr-duckdb returning n=0 for a table
     that plainly was not there, while primary DuckDB-WASM correctly
     returned 10). Before accepting ANY R count now, this requires
     `exists(table, inherits=FALSE) && is.data.frame(get(table))` to be
     TRUE first; a missing/non-data.frame table returns the honest
     unavailable error, never 0. */
  async function runViaWebRNarrowCount(statement) {
    if (!window.DataGlowR || typeof window.DataGlowR.init !== 'function') return { error: 'pyodide-sql-unavailable' };
    var parsed = parseCountStarFrom(statement);
    if (!parsed) return { error: 'pyodide-sql-unavailable' };
    try {
      var r = await window.DataGlowR.init();
      if (!r || typeof r.evalR !== 'function') return { error: 'pyodide-sql-unavailable' };
      var existsCheckCode = 'exists("' + parsed.table + '", inherits = FALSE) && is.data.frame(get("' + parsed.table + '"))';
      var existsShelter;
      try {
        existsShelter = await r.evalR(existsCheckCode);
      } catch (_eExists) {
        // The existence probe itself failing (e.g. R session not actually
        // ready) is exactly the same as "table not confirmed present" --
        // never fall through to nrow()/duckdb-in-R on an unproven table.
        return { error: 'pyodide-sql-unavailable' };
      }
      var existsRows = await existsShelter.toArray();
      var tableConfirmed = !!(existsRows && existsRows.length && (existsRows[0] === true || existsRows[0] === 'TRUE' || existsRows[0] === 1));
      if (!tableConfirmed) {
        // Missing/non-data.frame table -- refuse outright. Do not run
        // duckdb-in-R or nrow() against a name that is not confirmed bound;
        // an unbound name in webR can otherwise resolve through a stale
        // partial eval to a false 0 rather than a real error (the live bug
        // this hotfix fixes), so the confirmed-exists gate comes first and
        // is the only thing allowed to authorize either path below.
        return { error: 'pyodide-sql-unavailable' };
      }
      // duckdb-in-R path, only now that the table is CONFIRMED to exist as a
      // real data.frame -- best-effort, no install attempt here (spec B2.1
      // allows a quick import try; a slow install is not worth blocking the
      // narrow COUNT fallback that already works without it). Only accepted
      // if requireNamespace succeeded AND the query returns a finite value;
      // an empty/NA result from a real bound frame must not become a 0
      // success either.
      try {
        var dbShelter = await r.evalR(
          'if (requireNamespace("duckdb", quietly = TRUE)) { ' +
          'con <- duckdb::dbConnect(duckdb::duckdb()); duckdb::duckdb_register(con, "' + parsed.table + '", ' + parsed.table + '); ' +
          'res <- DBI::dbGetQuery(con, ' + JSON.stringify(statement.replace(/;\s*$/, '')) + '); DBI::dbDisconnect(con, shutdown = TRUE); res[[1]][1] } else { NA }'
        );
        var dbRows = await dbShelter.toArray();
        var dbVal = dbRows && dbRows.length ? Number(dbRows[0]) : NaN;
        if (!isNaN(dbVal) && isFinite(dbVal)) {
          var dbScalars = {}; dbScalars[parsed.alias] = dbVal;
          return { rowCount: 1, rows: [dbScalars], scalars: dbScalars, engine: 'webr-duckdb' };
        }
      } catch (_eDbR) { /* duckdb R package not available or query failed; fall through to nrow() */ }
      // Narrow fallback: the table is already confirmed above to be a real,
      // bound R data.frame by the notebook prelude (e.g. `t <-
      // data.frame(...)`). Only COUNT(*) is answered this way -- anything
      // else stays refused.
      var shelter = await r.evalR('nrow(' + parsed.table + ')');
      var rows = await shelter.toArray();
      var n = rows && rows.length ? Number(rows[0]) : NaN;
      if (isNaN(n) || !isFinite(n)) return { error: 'pyodide-sql-unavailable' };
      var scalars = {}; scalars[parsed.alias] = n;
      return { rowCount: 1, rows: [scalars], scalars: scalars, engine: 'webr-df' };
    } catch (_eR) {
      return { error: 'pyodide-sql-unavailable' };
    }
  }

  /* Published as window.runProofSecondEngine. Matches the {rowCount, rows?,
     scalars?, error?} shape js/proof-harness/second-engine.js's
     normalizeSecondRun() already understands (it also tolerates the
     {result:{...}} wrapper shape, but this bridge returns the flat shape
     directly since it controls both ends). */
  /* HOTFIX_SECOND_ENGINE_SQLITE_SQL_SPEC.md: bridge priority order, updated
     again.

     Root cause this hotfix closes: micropip.install("duckdb") can NEVER
     succeed inside Pyodide -- PyPI ships only native wheels for the duckdb
     package, and there is no such wheel in the Pyodide lockfile at all
     (HOTFIX_PH_V1_2_TABLE_DEPTH_SPEC.md treated this as a flaky/best-effort
     install; it is actually a structural impossibility on this platform).
     So on essentially every real device, ensureDuckdbInPyodide() honestly
     resolves false, and until now the bridge's only real-table fallback
     was runViaPyodidePandasCount -- COUNT(*) only. Any other statement
     (SUM, GROUP BY, JOIN, WHERE, ...) had no full-SQL path at all and fell
     straight to webR's equally-narrow COUNT(*)-only fallback or the
     honest unavailable error. This hotfix inserts the new pyodide-sqlite
     full-SQL path (stdlib sqlite3, always present, no install) between
     duckdb and pandas, so the priority is now, in order:
       1. pyodide-duckdb   (if duckdb-in-pyodide ready + register + sql ok;
                            rare in practice, kept for any future Pyodide
                            lockfile that does ship it)
       2. pyodide-sqlite   (NEW -- full arbitrary SQL via stdlib sqlite3,
                            registers every dg_csv_* table, default path
                            for real corroboration on essentially every
                            device)
       3. pyodide-pandas   (narrow COUNT(*) only, if the sqlite path threw
                            or found no dg_csv_<table> at all)
       4. trivial literal  (SELECT 1 / SELECT <int> AS alias, no FROM)
       5. hardened webR    (never returns n=0 for a missing table)
       6. {error:'pyodide-sql-unavailable'} */
  async function runProofSecondEngineBridge(statement) {
    try {
      if (!window.DataGlowPython || typeof window.DataGlowPython.loadRuntime !== 'function') {
        var literalNoPython = evalTrivialLiteralSelect(statement);
        if (literalNoPython) return literalNoPython;
        return await runViaWebRNarrowCount(statement);
      }
      var py = await window.DataGlowPython.loadRuntime();
      if (typeof window.DataGlowPython.buildHelper === 'function') {
        try { window.DataGlowPython.buildHelper(py); } catch (_eSync) { /* dataset sync is best-effort; a failed sync still allows a literal/sqlite/pandas/duckdb probe */ }
      }
      var duckdbOk = await ensureDuckdbInPyodide(py);
      if (duckdbOk) {
        try {
          return await runViaPyodideDuckdb(py, statement);
        } catch (_eRun) {
          // duckdb loaded but this particular statement failed (e.g. a
          // table that has no dg_csv_* source to register, or a dialect
          // feature duckdb-in-pyodide's version does not support) -- fall
          // through to sqlite, then pandas, then the literal probe, then
          // webR, rather than silently pretending the run succeeded.
          var sqliteAfterDuckdbFail = await runViaPyodideSqlite(py, statement);
          if (sqliteAfterDuckdbFail && !sqliteAfterDuckdbFail.error) return sqliteAfterDuckdbFail;
          var pandasAfterFail = await runViaPyodidePandasCount(py, statement);
          if (pandasAfterFail) return pandasAfterFail;
          var literalAfterFail = evalTrivialLiteralSelect(statement);
          if (literalAfterFail) return literalAfterFail;
          if (sqliteAfterDuckdbFail && sqliteAfterDuckdbFail.error) return sqliteAfterDuckdbFail;
          return await runViaWebRNarrowCount(statement);
        }
      }
      // duckdb-in-pyodide is unavailable (the structural micropip-install
      // impossibility this hotfix documents) -- try the new pyodide-sqlite
      // full-SQL path next, BEFORE falling through to the narrow pandas
      // COUNT-only path, since sqlite can answer the same COUNT(*) AND
      // everything else (SUM, GROUP BY, JOIN, WHERE, ...) pandas cannot.
      var sqliteResult = await runViaPyodideSqlite(py, statement);
      if (sqliteResult && !sqliteResult.error) return sqliteResult;
      // sqlite genuinely ran and failed (a real dialect/runtime error, per
      // spec "Dialect honesty") OR found no dg_csv_* tables to register at
      // all (null) -- either way, fall through to the narrow pandas COUNT
      // path next; if pandas also cannot answer, surface the sqlite error
      // (if any) rather than a generic unavailable, so the UI can show the
      // real dialect failure per spec "UI may show engine name".
      var pandasResult = await runViaPyodidePandasCount(py, statement);
      if (pandasResult) return pandasResult;
      var literalFallback = evalTrivialLiteralSelect(statement);
      if (literalFallback) return literalFallback;
      if (sqliteResult && sqliteResult.error) return sqliteResult;
      return await runViaWebRNarrowCount(statement);
    } catch (_eOuter) {
      return { error: 'pyodide-sql-unavailable' };
    }
  }

  function installSecondEngineBridge() {
    if (typeof window.runProofSecondEngine === 'function') return; // already installed (idempotent)
    window.runProofSecondEngine = runProofSecondEngineBridge;
  }

  /* ---------------------------- styles ------------------------------------ */

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;',
      'border-radius:10px;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}',
      '#' + BTN_ID + ':hover{color:var(--text,#E8EAED)}',
      '#' + BTN_ID + ' .dg-ph-dot{width:7px;height:7px;border-radius:50%;background:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);z-index:12095;',
      'display:none;flex-direction:column;background:var(--surface,#151820);',
      'border-left:1px solid var(--border,#282D38);box-shadow:-18px 0 48px rgba(0,0,0,.45)}',
      '#' + PANEL_ID + '.open{display:flex}',
      '#' + PANEL_ID + ' .dg-ph-head{display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border,#282D38)}',
      '#' + PANEL_ID + ' .dg-ph-title{font-size:16px;font-weight:800;margin:0}',
      '#' + PANEL_ID + ' .dg-ph-sub{font-size:12px;color:var(--text-muted,#9AA1AE);margin:4px 0 0;line-height:1.55}',
      '#' + PANEL_ID + ' .dg-ph-x{min-height:44px;min-width:44px;border:none;background:transparent;',
      'color:var(--text-muted,#9AA1AE);font-size:22px;cursor:pointer;border-radius:10px;flex:0 0 auto}',
      '#' + TABS_ID + '{display:flex;gap:4px;padding:0 14px;border-bottom:1px solid var(--border,#282D38);',
      'flex-wrap:wrap}',
      '#' + TABS_ID + ' .dg-ph-tab{min-height:40px;padding:0 12px;border:none;background:transparent;',
      'color:var(--text-muted,#9AA1AE);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;',
      'border-bottom:2px solid transparent}',
      '#' + TABS_ID + ' .dg-ph-tab.active{color:var(--text,#E8EAED);border-bottom-color:var(--primary,#20C5B5)}',
      '#' + TABS_ID + ' .dg-ph-tab:hover{color:var(--text,#E8EAED)}',
      '#' + BODY_ID + '{flex:1;overflow-y:auto;padding:14px 18px;-webkit-overflow-scrolling:touch}',
      '#' + PANEL_ID + ' label{display:block;font-size:11.5px;font-weight:700;letter-spacing:.02em;',
      'color:var(--text-muted,#9AA1AE);margin:14px 0 6px;text-transform:uppercase}',
      '#' + PANEL_ID + ' label:first-child{margin-top:0}',
      '#' + PANEL_ID + ' textarea, #' + PANEL_ID + ' input[type=text]{width:100%;box-sizing:border-box;',
      'background:var(--bg,#0E1117);border:1px solid var(--border,#282D38);border-radius:10px;',
      'color:var(--text,#E8EAED);font:inherit;font-size:12.5px;padding:9px 10px;resize:vertical}',
      '#' + PANEL_ID + ' textarea.dg-ph-statement{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:76px}',
      '#' + PANEL_ID + ' textarea.dg-ph-claim{min-height:44px}',
      '#' + PANEL_ID + ' textarea.dg-ph-cartridge{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:120px;font-size:11px}',
      '#' + PANEL_ID + ' .dg-ph-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '#' + PANEL_ID + ' .dg-ph-btn{min-height:38px;padding:0 13px;border-radius:10px;font:inherit;font-size:12.5px;',
      'font-weight:700;cursor:pointer;border:1px solid var(--border,#282D38);background:transparent;',
      'color:var(--text-muted,#9AA1AE)}',
      '#' + PANEL_ID + ' .dg-ph-btn.primary{background:var(--primary,#20C5B5);color:#04201C;border-color:transparent}',
      '#' + PANEL_ID + ' .dg-ph-btn.primary:disabled{opacity:.45;cursor:not-allowed}',
      '#' + PANEL_ID + ' .dg-ph-btn:hover:not(:disabled){opacity:.9}',
      '#' + PANEL_ID + ' .dg-ph-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;',
      'border-radius:999px;font-size:13px;font-weight:800;letter-spacing:.02em;margin-top:14px}',
      '#' + PANEL_ID + ' .dg-ph-chip.GREEN{background:rgba(32,197,181,.14);color:var(--primary,#20C5B5);',
      'border:1px solid rgba(32,197,181,.4)}',
      '#' + PANEL_ID + ' .dg-ph-chip.RED{background:rgba(229,83,75,.14);color:var(--danger,#E5534B);',
      'border:1px solid rgba(229,83,75,.4)}',
      '#' + PANEL_ID + ' .dg-ph-chip.GRAY{background:rgba(154,161,174,.14);color:var(--text-muted,#9AA1AE);',
      'border:1px solid rgba(154,161,174,.4)}',
      '#' + PANEL_ID + ' .dg-ph-chip.AMBER{background:rgba(230,178,44,.14);color:#E6B22C;',
      'border:1px solid rgba(230,178,44,.4)}',
      '#' + PANEL_ID + ' .dg-ph-reason{font-size:12.5px;line-height:1.55;color:var(--text-secondary,#B4B8C0);margin:8px 0 0}',
      '#' + PANEL_ID + ' .dg-ph-receipt{margin-top:14px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--border,#282D38);font-size:12px;line-height:1.7;color:var(--text-secondary,#B4B8C0)}',
      '#' + PANEL_ID + ' .dg-ph-receipt dt{color:var(--text-muted,#9AA1AE);display:inline}',
      '#' + PANEL_ID + ' .dg-ph-receipt dd{display:inline;margin:0 0 0 6px}',
      '#' + PANEL_ID + ' .dg-ph-receipt .dg-ph-kv{display:block}',
      '#' + PANEL_ID + ' .dg-ph-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;',
      'word-break:break-all;color:var(--text-faint,var(--text-muted,#9AA1AE))}',
      '#' + PANEL_ID + ' .dg-ph-note{font-size:11px;line-height:1.5;color:var(--text-faint,var(--text-muted,#9AA1AE));',
      'padding:12px 2px 4px}',
      '#' + PANEL_ID + ' .dg-ph-engine-missing{margin-top:10px;padding:8px 12px;border-radius:10px;',
      'background:rgba(154,161,174,.14);border:1px solid rgba(154,161,174,.4);',
      'color:var(--text-muted,#9AA1AE);font-size:11.5px}',
      '#' + PANEL_ID + ' .dg-ph-confirmed{margin-top:10px;font-size:12px;font-weight:700;color:var(--primary,#20C5B5)}',
      '#' + PANEL_ID + ' .dg-ph-inbox-item{padding:10px 12px;border-radius:10px;border:1px solid var(--border,#282D38);',
      'margin-bottom:8px}',
      '#' + PANEL_ID + ' .dg-ph-inbox-item .dg-ph-inbox-claim{font-size:12.5px;font-weight:700;color:var(--text,#E8EAED);',
      'margin:0 0 4px}',
      '#' + PANEL_ID + ' .dg-ph-inbox-item .dg-ph-inbox-status{font-size:11px;font-weight:700;letter-spacing:.02em;',
      'text-transform:uppercase}',
      '#' + PANEL_ID + ' .dg-ph-inbox-actions{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}',
      '#' + PANEL_ID + ' .dg-ph-empty{font-size:12.5px;color:var(--text-muted,#9AA1AE);padding:16px 4px}',
      '#' + PANEL_ID + ' .dg-ph-vault-item{padding:8px 10px;border-radius:8px;border:1px solid var(--border,#282D38);',
      'margin-bottom:6px;font-size:12px;color:var(--text-secondary,#B4B8C0)}',
      '#' + PANEL_ID + ' .dg-ph-vault-summary{font-size:12.5px;margin-top:10px;font-weight:700}',
      '#' + PANEL_ID + ' .dg-ph-vault-summary.has-escaped{color:var(--danger,#E5534B)}',
      '#' + PANEL_ID + ' .dg-ph-vault-summary.all-caught{color:var(--primary,#20C5B5)}',
      '@media (max-width:700px){',
      '#' + BTN_ID + '{min-height:44px}',
      '#' + PANEL_ID + '{width:100%;left:0;border-left:none}',
      '#' + PANEL_ID + ' .dg-ph-head{position:sticky;top:0;z-index:2;background:var(--surface,#151820)}',
      '#' + BODY_ID + '{padding:12px 14px}',
      '}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------------------------- panel ------------------------------------ */

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Proof Harness');
    var tabsHtml = v1FlagOn()
      ? '<div id="' + TABS_ID + '">' +
          '<button type="button" class="dg-ph-tab" data-ph-tab="inbox">Inbox</button>' +
          '<button type="button" class="dg-ph-tab" data-ph-tab="prove">Prove</button>' +
          '<button type="button" class="dg-ph-tab" data-ph-tab="vault">Vault</button>' +
          '<button type="button" class="dg-ph-tab" data-ph-tab="cartridge">Cartridge</button>' +
        '</div>'
      : '';
    panel.innerHTML =
      '<div class="dg-ph-head">' +
        '<div style="min-width:0">' +
          '<p class="dg-ph-title">VERDICT</p>' +
          '<p class="dg-ph-sub">Paste a claim, prove it on this device, get a receipt you can re-run.</p>' +
        '</div>' +
        '<button type="button" class="dg-ph-x" data-ph-close aria-label="Close">&#215;</button>' +
      '</div>' +
      tabsHtml +
      '<div id="' + BODY_ID + '"></div>';
    document.body.appendChild(panel);
    panel.querySelector('[data-ph-close]').addEventListener('click', closePanel);
    if (v1FlagOn()) {
      var tabButtons = panel.querySelectorAll('[data-ph-tab]');
      for (var i = 0; i < tabButtons.length; i++) {
        tabButtons[i].addEventListener('click', function (ev) {
          setActiveTab(ev.currentTarget.getAttribute('data-ph-tab'));
        });
      }
    }
    return panel;
  }

  function setActiveTab(tab) {
    _activeTab = tab;
    var tabButtons = document.querySelectorAll('#' + TABS_ID + ' [data-ph-tab]');
    for (var i = 0; i < tabButtons.length; i++) {
      var isActive = tabButtons[i].getAttribute('data-ph-tab') === tab;
      tabButtons[i].classList.toggle('active', isActive);
    }
    renderBody();
  }

  function verdictChip(state) {
    var label = state === 'GREEN' ? 'GREEN . proven'
      : state === 'RED' ? 'RED . refuted'
      : state === 'AMBER' ? 'AMBER . stale, re-prove required'
      : 'GRAY . not provable';
    return '<div class="dg-ph-chip ' + esc(state) + '">' + esc(label) + '</div>';
  }

  function receiptDetails(receipt, proposal, run, corroboration) {
    if (!receipt) return '';
    var duration = run && typeof run.durationMs === 'number' ? run.durationMs + ' ms' : 'not run';
    var rowCount = run && typeof run.rowCount === 'number' ? String(run.rowCount) : 'n/a';
    var html = '<div class="dg-ph-receipt">' +
      '<span class="dg-ph-kv"><dt>Row count:</dt><dd>' + esc(rowCount) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Duration:</dt><dd>' + esc(duration) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Engine:</dt><dd>' + esc(proposal.engine) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Statement:</dt><dd class="dg-ph-hash">' + esc(proposal.statement) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Proposal digest:</dt><dd class="dg-ph-hash">' + esc(proposal.digest) + '</dd></span>' +
      '<span class="dg-ph-kv"><dt>Receipt hash:</dt><dd class="dg-ph-hash">' + esc(receipt.hash) + '</dd></span>';
    if (corroboration && corroboration.ran === true) {
      html += '<span class="dg-ph-kv"><dt>Second engine:</dt><dd>' + esc(corroboration.engine) +
        ', agrees: ' + esc(String(corroboration.agrees)) + '</dd></span>';
    }
    html += '</div>';
    return html;
  }

  /* ---------------------------- Prove tab (v0 body, unchanged) ----------- */

  function renderProveTab() {
    var e = engine();
    if (!e) {
      return '<div class="dg-ph-note">The Proof Harness engine is unavailable, so nothing can be proven here.</div>';
    }

    var claimText = _lastProposal && _lastProposal.claimText ? _lastProposal.claimText : '';
    var statementText = _lastProposal ? _lastProposal.statement : '';
    var canUseLastSql = (function () {
      var input = document.getElementById('sql-input');
      return !!(input && input.value && input.value.trim());
    })();

    var html = '';
    html += '<label for="dg-ph-claim">Claim</label>' +
      '<textarea id="dg-ph-claim" class="dg-ph-claim" placeholder="Paste the number or sentence you want proven, e.g. total revenue is 101018">' + esc(claimText) + '</textarea>';
    if (canUseLastSql) {
      html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn" data-ph-use-last-sql>Use last SQL result</button></div>';
    }

    if (v2FlagOn() && e && typeof e.excelClaimTextToSql === 'function') {
      /* PROOF_HARNESS_V2_SPEC.md B2: the claim field may already carry a
         pasted Excel-style formula (e.g. =SUM(claim_amount)); this control
         reads whatever is currently in the claim box, parses it with the
         SAME excel-claim.js the pure engine exports, and on a successful
         parse fills the statement box below from the parser's own SQL,
         never a model-composed guess. A failed parse fills nothing and
         shows the honest rejection reason instead. */
      html += '<label for="dg-ph-excel-table">Table for Excel-style claims (optional if named in the formula)</label>' +
        '<input type="text" id="dg-ph-excel-table" placeholder="e.g. claims_example">';
      html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn" data-ph-excel-fill>Use Excel-style claim</button></div>';
      if (_lastExcelClaimResult) {
        if (_lastExcelClaimResult.rejected) {
          html += '<div class="dg-ph-note">Excel-style claim not recognized: ' + esc(_lastExcelClaimResult.reason) + '</div>';
        } else {
          html += '<div class="dg-ph-note">Excel-style claim filled: ' + esc(_lastExcelClaimResult.statement) + '</div>';
        }
      }
    }

    html += '<label for="dg-ph-statement">Proposal statement (editable SQL)</label>' +
      '<textarea id="dg-ph-statement" class="dg-ph-statement" placeholder="select count(*) as n from your_table">' + esc(statementText) + '</textarea>';

    html += '<label for="dg-ph-expected-rowcount">Expected row count (optional)</label>' +
      '<input type="text" id="dg-ph-expected-rowcount" placeholder="e.g. 42" value="' +
      esc(_lastProposal && _lastProposal.expected && _lastProposal.expected.rowCount !== undefined ? _lastProposal.expected.rowCount : '') + '">';

    html += '<div class="dg-ph-row">' +
      '<button type="button" class="dg-ph-btn primary" data-ph-prove>Prove</button>' +
      '<button type="button" class="dg-ph-btn primary" data-ph-confirm' + (_lastResult && _lastResult.verdict ? '' : ' disabled') + '>Confirm</button>' +
      '</div>';

    if (_lastResult && _lastResult.verdict) {
      html += verdictChip(_lastResult.verdict.state);
      html += '<p class="dg-ph-reason">' + esc(_lastResult.verdict.reason) +
        (_lastResult.verdict.blocker ? ' ' + esc(_lastResult.verdict.blocker) : '') + '</p>';
      html += receiptDetails(_lastResult.receipt, _lastResult.proposal, _lastResult.run, _lastResult.corroboration);
      if (v1FlagOn() && _lastResult.corroboration && _lastResult.corroboration.ran === true && _lastResult.corroboration.agrees === true) {
        /* PROOF_HARNESS_V1_1_SPEC.md B4: a short, honest note naming the
           second engine that actually agreed, distinct from the receipt's
           own detail line above (which is always shown; this note is the
           at-a-glance version). agrees===false is not handled here since
           decideVerdict() already turns that into RED, which the verdict
           chip above already communicates; this note is additive, never a
           second source of truth for pass/fail. */
        html += '<div class="dg-ph-note">Second engine (' + esc(_lastResult.corroboration.engine || 'second engine') + ') agreed.</div>';
      } else if (v1FlagOn() && _lastResult.corroboration && _lastResult.corroboration.ran !== true) {
        html += '<div class="dg-ph-note">Second engine not ready. GREEN is single-engine (v0 strength).</div>';
      }
      if (v2FlagOn() && _lastResult.adversarial) {
        /* PROOF_HARNESS_V2_SPEC.md A3: a short, honest note when the
           adversary pack ran and passed. A failed pack is not restated
           here since the verdict chip above is already RED with reason
           code adversary-fail in that case; this note is additive, never
           a second source of truth for pass/fail (same discipline as the
           v1.1 second-engine note above). */
        if (_lastResult.adversarial.ran === true && _lastResult.adversarial.failCount === 0) {
          html += '<div class="dg-ph-note">Adversary pack passed (' + esc(_lastResult.adversarial.passCount) + ' attacks).</div>';
        } else if (_lastResult.adversarial.ran === true && _lastResult.adversarial.skipped !== true) {
          html += '<div class="dg-ph-note">Adversary pack: ' + esc(_lastResult.adversarial.failCount) + ' of ' +
            esc(_lastResult.adversarial.failCount + _lastResult.adversarial.passCount) + ' attack(s) disagreed.</div>';
        } else if (_lastResult.adversarial.skipped === true) {
          html += '<div class="dg-ph-note">Adversary pack skipped: ' + esc(_lastResult.adversarial.reason || 'this statement shape is not rewriteable yet.') + '</div>';
        }
      }
      /* Hotfix (feat/proof-harness-v0-engine-window): a chip alone does not
         say WHY this came back non-GREEN when the reason is "no engine",
         which is a fixable app state, not a claim problem. This note is only
         shown for the run this Prove click just produced (cleared the next
         time Prove runs with an engine present), and never overrides the
         verdict chip or blocker text above; it is purely additive. */
      if (_lastEngineMissing) {
        html += '<div class="dg-ph-note dg-ph-engine-missing">The SQL engine was not ready when Prove ran, so this could not reach DuckDB. Open the SQL tab once to start it, then Prove again.</div>';
      }
    }

    if (_lastConfirm) {
      if (_lastConfirm.confirmed) {
        html += '<p class="dg-ph-confirmed">Confirmed by ' + esc(_lastConfirm.by) + ' at ' + esc(_lastConfirm.at) + '. Bound to this exact statement.</p>';
      } else {
        html += '<p class="dg-ph-reason">' + esc(_lastConfirm.reason) + '</p>';
      }
    }

    html += '<div class="dg-ph-note">Nothing here uploads. The statement runs on your own device against the same DuckDB engine the SQL tab uses. A false green is treated as a bug, so an unclear result comes back gray with the missing piece named, never a guess.</div>';

    return html;
  }

  /* ---------------------------- Inbox tab (v1) ---------------------------- */

  function renderInboxTab() {
    var e = engine();
    if (!e || typeof e.statusLabel !== 'function') {
      return '<div class="dg-ph-note">The Proof Harness engine is unavailable, so the inbox cannot be shown.</div>';
    }
    var box = inbox();
    var items = box ? box.list() : [];
    if (items.length === 0) {
      return '<div class="dg-ph-empty">Nothing waiting for review yet. Prove a claim on the Prove tab to add it here.</div>';
    }
    var html = '';
    for (var i = items.length - 1; i >= 0; i--) {
      var item = items[i];
      var label = e.statusLabel(item.status);
      html += '<div class="dg-ph-inbox-item">' +
        '<p class="dg-ph-inbox-claim">' + esc(item.claimText || item.statement || 'Untitled claim') + '</p>' +
        '<span class="dg-ph-inbox-status">' + esc(label) + '</span>';
      if (item.status === 'awaiting-confirm') {
        html += '<div class="dg-ph-inbox-actions">' +
          '<button type="button" class="dg-ph-btn primary" data-ph-inbox-confirm="' + esc(item.id) + '">Confirm</button>' +
          '<button type="button" class="dg-ph-btn" data-ph-inbox-reject="' + esc(item.id) + '">Reject</button>' +
          '</div>';
      } else if (item.status === 'pending-prove') {
        html += '<div class="dg-ph-inbox-actions">' +
          '<button type="button" class="dg-ph-btn primary" data-ph-inbox-open="' + esc(item.id) + '">Open in Prove</button>' +
          '</div>';
      } else {
        html += '<div class="dg-ph-inbox-actions">' +
          '<button type="button" class="dg-ph-btn" data-ph-inbox-open="' + esc(item.id) + '">Open</button>' +
          '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  /* ---------------------------- Vault tab (v1) ---------------------------- */

  function renderVaultTab() {
    var e = engine();
    if (!e || typeof e.getVaultTests !== 'function') {
      return '<div class="dg-ph-note">The Proof Harness engine is unavailable, so the vault cannot be shown.</div>';
    }
    var tests = e.getVaultTests();
    var html = '<div class="dg-ph-note">Every refuted claim and every rejection is kept here as a durable local test, so a fixed regression can be re-checked and a repeated mistake gets caught again.</div>';
    if (tests.length === 0) {
      html += '<div class="dg-ph-empty">The vault is empty. It fills in automatically whenever a claim comes back RED or is rejected.</div>';
      return html;
    }
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      html += '<div class="dg-ph-vault-item">' + esc(t.claimText || t.statement) +
        ' (source: ' + esc(t.source) + ')</div>';
    }
    html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn primary" data-ph-vault-run>Run vault check</button></div>';
    if (_lastVaultRun) {
      var cls = _lastVaultRun.escaped > 0 ? 'has-escaped' : 'all-caught';
      html += '<p class="dg-ph-vault-summary ' + cls + '">' + esc(_lastVaultRun.caught) + ' of ' + esc(_lastVaultRun.total) +
        ' still caught, ' + esc(_lastVaultRun.escaped) + ' escaped.</p>';
    }
    return html;
  }

  /* ---------------------------- Cartridge tab (v1) ------------------------ */

  function renderCartridgeTab() {
    var e = engine();
    if (!e || typeof e.exportCartridge !== 'function') {
      return '<div class="dg-ph-note">The Proof Harness engine is unavailable, so cartridges cannot be built here.</div>';
    }
    var html = '<div class="dg-ph-note">A cartridge carries the proven statement, its expected values, and a verdict, but zero rows of source data, so a proof can travel without the data moving.</div>';
    html += '<label>Export the current proven claim</label>';
    if (_lastResult && _lastResult.verdict && _lastResult.verdict.state === 'GREEN') {
      html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn primary" data-ph-cartridge-export>Export cartridge</button></div>';
    } else {
      html += '<div class="dg-ph-empty">Prove a claim to GREEN on the Prove tab first, then come back here to export it.</div>';
    }
    if (_lastCartridgeExport) {
      html += '<textarea class="dg-ph-cartridge" readonly>' + esc(_lastCartridgeExport) + '</textarea>';
      html += '<div class="dg-ph-row">' +
        '<button type="button" class="dg-ph-btn" data-ph-cartridge-copy>Copy JSON</button>' +
        '<button type="button" class="dg-ph-btn primary" data-ph-cartridge-reprove>Re-prove on this device</button>' +
        '</div>';
      html += '<div class="dg-ph-note">Re-runs this exact export against the live engine right here, right now, using the same round trip an importer on another device would run.</div>';
      if (_lastCartridgeReprove) {
        html += verdictChip(_lastCartridgeReprove.state);
        html += '<p class="dg-ph-reason">' + esc(_lastCartridgeReprove.reason) + '</p>';
      }
    }
    html += '<label for="dg-ph-cartridge-import">Import a cartridge to re-check on your data</label>';
    html += '<textarea id="dg-ph-cartridge-import" class="dg-ph-cartridge" placeholder="Paste a proof cartridge JSON here"></textarea>';
    html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn primary" data-ph-cartridge-import>Import and re-check</button></div>';
    if (_lastCartridgeImport) {
      html += verdictChip(_lastCartridgeImport.state);
      html += '<p class="dg-ph-reason">' + esc(_lastCartridgeImport.reason) + '</p>';
    }

    if (v2FlagOn() && typeof e.exportMeshAttestation === 'function') {
      /* PROOF_HARNESS_V2_SPEC.md C2: a mesh attestation carries digests,
         a schema fingerprint, and the verdict, but never a row/sample/cell
         value beyond the already-proven aggregate scalars -- two devices
         can agree or diverge on a claim without either one ever sending
         the other its data, reusing the same zero-rows posture as the
         cartridge above. */
      html += '<label>Export a mesh attestation (from the last GREEN)</label>';
      if (_lastResult && _lastResult.verdict && _lastResult.verdict.state === 'GREEN') {
        html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn primary" data-ph-mesh-export>Export mesh attestation</button></div>';
      } else {
        html += '<div class="dg-ph-empty">Prove a claim to GREEN on the Prove tab first, then come back here to export an attestation.</div>';
      }
      if (_lastMeshExport) {
        html += '<textarea class="dg-ph-cartridge" readonly>' + esc(_lastMeshExport) + '</textarea>';
      }
      html += '<label for="dg-ph-mesh-compare">Paste another attestation to compare</label>';
      html += '<textarea id="dg-ph-mesh-compare" class="dg-ph-cartridge" placeholder="Paste a proof mesh attestation JSON here"></textarea>';
      html += '<div class="dg-ph-row"><button type="button" class="dg-ph-btn primary" data-ph-mesh-compare>Compare attestation</button></div>';
      if (_lastMeshCompare) {
        if (_lastMeshCompare.rejected) {
          html += '<p class="dg-ph-reason">' + esc(_lastMeshCompare.reason) + '</p>';
        } else {
          html += '<p class="dg-ph-reason">' + (_lastMeshCompare.agree ? 'Agree.' : 'Diverge.') +
            (_lastMeshCompare.divergences && _lastMeshCompare.divergences.length
              ? ' Divergent field(s): ' + esc(_lastMeshCompare.divergences.map(function (d) { return d.field; }).join(', ')) + '.'
              : '') + '</p>';
        }
      }
    }

    return html;
  }

  /* ---------------------------- render / wire ----------------------------- */

  function renderBody() {
    var body = document.getElementById(BODY_ID);
    if (!body) return;

    if (!v1FlagOn()) {
      body.innerHTML = renderProveTab();
      wireProveTab(body);
      return;
    }

    var html;
    if (_activeTab === 'prove') { html = renderProveTab(); }
    else if (_activeTab === 'vault') { html = renderVaultTab(); }
    else if (_activeTab === 'cartridge') { html = renderCartridgeTab(); }
    else { html = renderInboxTab(); _activeTab = 'inbox'; }

    body.innerHTML = html;

    if (_activeTab === 'prove') wireProveTab(body);
    else if (_activeTab === 'vault') wireVaultTab(body);
    else if (_activeTab === 'cartridge') wireCartridgeTab(body);
    else wireInboxTab(body);
  }

  function wireProveTab(body) {
    var useLastSqlBtn = body.querySelector('[data-ph-use-last-sql]');
    if (useLastSqlBtn) {
      useLastSqlBtn.addEventListener('click', function () {
        var input = document.getElementById('sql-input');
        var stmt = body.querySelector('#dg-ph-statement');
        if (input && stmt) {
          stmt.value = input.value;
          toast('Statement loaded from the SQL editor.', 'info');
        }
      });
    }

    var excelFillBtn = body.querySelector('[data-ph-excel-fill]');
    if (excelFillBtn) {
      excelFillBtn.addEventListener('click', function () { onExcelClaimFill(body); });
    }

    var proveBtn = body.querySelector('[data-ph-prove]');
    if (proveBtn) {
      proveBtn.addEventListener('click', function () { onProve(body); });
    }

    var confirmBtn = body.querySelector('[data-ph-confirm]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () { onConfirm(); });
    }
  }

  function wireInboxTab(body) {
    var confirmBtns = body.querySelectorAll('[data-ph-inbox-confirm]');
    for (var i = 0; i < confirmBtns.length; i++) {
      confirmBtns[i].addEventListener('click', function (ev) { onInboxConfirm(ev.currentTarget.getAttribute('data-ph-inbox-confirm')); });
    }
    var rejectBtns = body.querySelectorAll('[data-ph-inbox-reject]');
    for (var j = 0; j < rejectBtns.length; j++) {
      rejectBtns[j].addEventListener('click', function (ev) { onInboxReject(ev.currentTarget.getAttribute('data-ph-inbox-reject')); });
    }
    var openBtns = body.querySelectorAll('[data-ph-inbox-open]');
    for (var k = 0; k < openBtns.length; k++) {
      openBtns[k].addEventListener('click', function (ev) { onInboxOpen(ev.currentTarget.getAttribute('data-ph-inbox-open')); });
    }
  }

  function wireVaultTab(body) {
    var runBtn = body.querySelector('[data-ph-vault-run]');
    if (runBtn) {
      runBtn.addEventListener('click', function () { onVaultRun(); });
    }
  }

  function wireCartridgeTab(body) {
    var exportBtn = body.querySelector('[data-ph-cartridge-export]');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () { onCartridgeExport(); });
    }
    var copyBtn = body.querySelector('[data-ph-cartridge-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () { onCartridgeCopy(); });
    }
    var reproveBtn = body.querySelector('[data-ph-cartridge-reprove]');
    if (reproveBtn) {
      reproveBtn.addEventListener('click', function () { onCartridgeReprove(); });
    }
    var importBtn = body.querySelector('[data-ph-cartridge-import]');
    if (importBtn) {
      importBtn.addEventListener('click', function () { onCartridgeImport(body); });
    }
    var meshExportBtn = body.querySelector('[data-ph-mesh-export]');
    if (meshExportBtn) {
      meshExportBtn.addEventListener('click', function () { onMeshExport(); });
    }
    var meshCompareBtn = body.querySelector('[data-ph-mesh-compare]');
    if (meshCompareBtn) {
      meshCompareBtn.addEventListener('click', function () { onMeshCompare(body); });
    }
  }

  /* ---------------------------- Prove actions (v0, unchanged) ------------- */

  async function onProve(body) {
    var e = engine();
    if (!e) { toast('Proof Harness engine unavailable.', 'error'); return; }

    var claimText = (body.querySelector('#dg-ph-claim') || {}).value || '';
    var statement = (body.querySelector('#dg-ph-statement') || {}).value || '';
    var expectedRowCountRaw = (body.querySelector('#dg-ph-expected-rowcount') || {}).value || '';
    var expected = {};
    if (expectedRowCountRaw.trim() !== '' && !isNaN(Number(expectedRowCountRaw))) {
      expected.rowCount = Number(expectedRowCountRaw);
    }

    var runQuery = resolveRunQuery();
    _lastEngineMissing = !runQuery;
    if (!runQuery) {
      /* GRAY-friendly path: the engine is not reachable yet (SQL tab has not
         warmed window.engine / window.resolveDrillSqlRunQuery). Still run the
         full cycle below with a throwing runQuery so runProofCycle's own
         never-throw discipline turns this into a definite RED/GRAY result
         and a receipt, exactly like any other run failure -- Prove always
         completes a cycle, it never just stops silently. The toast fires
         immediately so the user does not wait on the cycle to learn why,
         and renderBody() below adds a persistent GRAY note once the cycle
         result is on screen, since a toast alone can be missed or dismissed. */
      toast('SQL engine not ready in this canvas.', 'error');
    }

    var result = await e.runProofCycle({
      claimText: claimText,
      statement: statement,
      engine: 'duckdb',
      expected: expected,
      author: 'human',
      runQuery: runQuery || function () { throw new Error('SQL engine not ready in this canvas.'); },
    });

    if (!result.ok) {
      toast(result.error || 'The proposal could not be built.', 'error');
      return;
    }

    _lastProposal = result.proposal;
    _lastResult = result;
    _lastConfirm = null;

    if (v1FlagOn() && inbox()) {
      try {
        var box = inbox();
        var matchingPending = box.list().filter(function (it) {
          return it.status === 'pending-prove' && it.statement === result.proposal.statement;
        })[0];
        if (matchingPending) {
          box.recordCycleResult(matchingPending.id, result);
        } else {
          var newItem = box.enqueue({ claimText: result.proposal.claimText, statement: result.proposal.statement, expected: result.proposal.expected });
          box.recordCycleResult(newItem.id, result);
        }
      } catch (_e) {}
    }

    if (window.DataGlowTrustLedger && typeof window.DataGlowTrustLedger.record === 'function') {
      try {
        window.DataGlowTrustLedger.record({
          kind: 'gate-verdict',
          subject: 'Proof Harness',
          summary: 'A claim was proven with verdict ' + result.verdict.state + '.',
          outcome: result.verdict.state === 'GREEN' ? 'clear' : (result.verdict.state === 'RED' ? 'blocked' : 'caution'),
          actor: 'you',
          detail: { state: result.verdict.state, reasonCode: result.verdict.reasonCode, digest: result.proposal.digest },
        });
      } catch (_e) {}
    } else if (typeof window.ledgerAppendFromSurface === 'function') {
      try {
        window.ledgerAppendFromSurface('proof-harness-verdict', {
          state: result.verdict.state,
          reasonCode: result.verdict.reasonCode,
          digest: result.proposal.digest,
        });
      } catch (_e) {}
    }

    renderBody();
    toast('Verdict: ' + result.verdict.state, result.verdict.state === 'GREEN' ? 'success' : (result.verdict.state === 'RED' ? 'error' : 'info'));
  }

  /* ---------------------------- Excel claim fill action (v2) ------------- */

  function onExcelClaimFill(body) {
    var e = engine();
    if (!e || typeof e.excelClaimTextToSql !== 'function') return;
    var claimBox = body.querySelector('#dg-ph-claim');
    var tableBox = body.querySelector('#dg-ph-excel-table');
    var stmtBox = body.querySelector('#dg-ph-statement');
    var claimText = (claimBox && claimBox.value) || '';
    var defaultTable = (tableBox && tableBox.value && tableBox.value.trim()) || undefined;
    var result = e.excelClaimTextToSql(claimText, defaultTable);
    _lastExcelClaimResult = result;
    if (!result.rejected && stmtBox) {
      /* Fills the EDITABLE statement box from the parser's own SQL, never a
         hidden or model-composed string -- the Prove button below still
         only ever executes proposal.statement, which is exactly what is
         now visible here, matching doctrine #2 for the normal Prove path. */
      stmtBox.value = result.statement;
      toast('Excel-style claim parsed and filled into the statement.', 'success');
    } else if (result.rejected) {
      toast('Excel-style claim not recognized: ' + result.reason, 'error');
    }
    renderBody();
  }

  async function onConfirm() {
    var e = engine();
    if (!e || !_lastResult || !_lastResult.proposal) return;
    var body = document.getElementById(BODY_ID);
    var currentStatement = (body && body.querySelector('#dg-ph-statement') || {}).value || '';
    var proposalToCheck = Object.assign({}, _lastResult.proposal, { statement: currentStatement.trim() });
    var confirmResult = await e.confirmProposal(proposalToCheck, { by: 'local-user' });
    _lastConfirm = confirmResult;
    renderBody();
    toast(confirmResult.confirmed ? 'Confirmed and bound to this statement.' : confirmResult.reason, confirmResult.confirmed ? 'success' : 'error');
  }

  /* ---------------------------- Inbox actions (v1) ------------------------ */

  function onInboxConfirm(id) {
    var box = inbox();
    if (!box) return;
    box.confirm(id, { confirmed: true, by: 'local-user', at: new Date().toISOString() });
    renderBody();
    toast('Confirmed.', 'success');
  }

  async function onInboxReject(id) {
    var e = engine();
    var box = inbox();
    if (!box) return;
    var item = box.get(id);
    box.reject(id, 'Rejected from the inbox.');
    if (e && item && typeof e.rejectProposal === 'function') {
      try {
        await e.rejectProposal({ claimText: item.claimText, statement: item.statement, expected: item.expected }, { by: 'local-user', reason: 'Rejected from the inbox.' });
      } catch (_e) {}
    }
    renderBody();
    toast('Rejected and added to the vault.', 'info');
  }

  function onInboxOpen(id) {
    var box = inbox();
    if (!box) return;
    var item = box.get(id);
    if (!item) return;
    _lastProposal = item.proposal || { claimText: item.claimText, statement: item.statement, expected: item.expected, engine: 'duckdb' };
    _lastResult = item.verdict ? { ok: true, proposal: _lastProposal, run: item.run, verdict: item.verdict, receipt: item.receipt, corroboration: null } : null;
    _lastConfirm = null;
    setActiveTab('prove');
  }

  /* ---------------------------- Vault actions (v1) ------------------------ */

  async function onVaultRun() {
    var e = engine();
    if (!e || typeof e.runVaultCheck !== 'function') return;
    var runQuery = resolveRunQuery();
    if (!runQuery) {
      toast('SQL engine not ready in this canvas.', 'error');
      return;
    }
    var result = await e.runVaultCheck(runQuery);
    _lastVaultRun = result;
    renderBody();
    toast(result.escaped > 0 ? (result.escaped + ' regression(s) escaped. Review the vault.') : 'All vault tests still caught.', result.escaped > 0 ? 'error' : 'success');
  }

  /* ---------------------------- Cartridge actions (v1) -------------------- */

  async function onCartridgeExport() {
    var e = engine();
    if (!e || typeof e.exportCartridge !== 'function' || !_lastResult) return;
    var exported = await e.exportCartridge({
      proposal: _lastResult.proposal,
      verdict: _lastResult.verdict,
      run: _lastResult.run,
      receipt: _lastResult.receipt,
    });
    if (exported.rejected) {
      toast(exported.reason, 'error');
      return;
    }
    _lastCartridgeExport = e.serializeCartridge ? e.serializeCartridge(exported.cartridge) : JSON.stringify(exported.cartridge, null, 2);
    _lastCartridgeReprove = null;
    renderBody();
    toast('Cartridge exported. Zero rows of data included.', 'success');
  }

  async function onCartridgeReprove() {
    var e = engine();
    if (!e || typeof e.importCartridge !== 'function' || !_lastCartridgeExport) return;
    var runQuery = resolveRunQuery();
    if (!runQuery) {
      toast('SQL engine not ready in this canvas.', 'error');
      return;
    }
    /* Flexible-args form 3 (PROOF_HARNESS_V1_1_SPEC.md A1): pass the last
       exported cartridge text straight through as the positional first
       argument, with runQuery in opts; compareClaimToRun is intentionally
       OMITTED here so the wrapper auto-injects the harness's own scorer
       (A1's "never default to an always-fail stub when the harness owns
       the scorer"), exercising that exact path from the live UI, not just
       from tests. */
    var result = await e.importCartridge(_lastCartridgeExport, { runQuery: runQuery });
    _lastCartridgeReprove = result;
    renderBody();
    toast('Re-prove verdict: ' + result.state, result.ok ? 'success' : 'error');
  }

  function onCartridgeCopy() {
    if (!_lastCartridgeExport) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(_lastCartridgeExport);
        toast('Cartridge JSON copied.', 'success');
        return;
      }
    } catch (_e) {}
    toast('Copy not available here. Select the text manually.', 'info');
  }

  async function onCartridgeImport(body) {
    var e = engine();
    if (!e || typeof e.importCartridge !== 'function') return;
    var text = (body.querySelector('#dg-ph-cartridge-import') || {}).value || '';
    var runQuery = resolveRunQuery();
    var result = await e.importCartridge({
      cartridgeText: text,
      runQuery: runQuery || function () { throw new Error('SQL engine not ready in this canvas.'); },
      compareClaimToRun: e.compareClaimToRun,
    });
    _lastCartridgeImport = result;
    renderBody();
    toast('Import verdict: ' + result.state, result.ok ? 'success' : 'error');
  }

  /* ---------------------------- Mesh attestation actions (v2) ------------ */

  /* HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md #4 (mesh prove script note):
     `exportMeshAttestation` (js/proof-harness/mesh-attestation.js) is an
     `async function` -- it awaits `sha256Hex` internally to build
     `inputDigest`/`attestationHash`. This handler is itself declared
     `async` and already `await`s the call below, so a caller reading
     `onMeshExport()`'s own return value (there is none awaited at the
     click-handler call site further down -- a fire-and-forget UI click is
     the correct, standard pattern here) still gets the fully-resolved
     attestation inside this function before `_lastMeshExport` is set and
     `renderBody()` runs. Confirmed correct as-is; documented per spec so a
     future edit does not accidentally drop the `await` on the line below. */
  async function onMeshExport() {
    var e = engine();
    if (!e || typeof e.exportMeshAttestation !== 'function' || !_lastResult) return;
    /* Deliberately rebuild a row-free run summary here rather than passing
       _lastResult.run through as-is: the live DuckDB run's own .result
       carries the actual proven rows (needed by the Prove tab/receipt to
       show a row count), and mesh-attestation.js's forbidden-key scan
       correctly refuses ANY payload carrying a rows field, anywhere, so a
       raw pass-through would always be rejected here. Only rowCount and
       the already-proven scalar values -- never .result / .rows itself --
       cross into the attestation, matching the module's own contract. */
    var safeRun = _lastResult.run ? { status: _lastResult.run.status, rowCount: _lastResult.run.rowCount, scalars: _lastResult.run.scalars || {}, error: _lastResult.run.error || null } : null;
    var exported = await e.exportMeshAttestation({
      proposal: _lastResult.proposal,
      verdict: _lastResult.verdict,
      run: safeRun,
      receipt: _lastResult.receipt,
    });
    if (exported.rejected) {
      toast(exported.reason, 'error');
      return;
    }
    _lastMeshExport = JSON.stringify(exported.attestation, null, 2);
    _lastMeshCompare = null;
    renderBody();
    toast('Mesh attestation exported. Zero rows of data included.', 'success');
  }

  function onMeshCompare(body) {
    var e = engine();
    if (!e || typeof e.importMeshAttestation !== 'function' || typeof e.compareMeshAttestations !== 'function') return;
    var text = (body.querySelector('#dg-ph-mesh-compare') || {}).value || '';
    var otherImported = e.importMeshAttestation(text);
    if (otherImported.rejected) {
      _lastMeshCompare = { rejected: true, reason: otherImported.reason };
      renderBody();
      toast('Attestation not recognized: ' + otherImported.reason, 'error');
      return;
    }
    if (!_lastMeshExport) {
      _lastMeshCompare = { rejected: true, reason: 'Export a mesh attestation from this device first, then compare.' };
      renderBody();
      toast('Export a mesh attestation from this device first.', 'error');
      return;
    }
    var mineImported = e.importMeshAttestation(_lastMeshExport);
    if (mineImported.rejected) {
      _lastMeshCompare = { rejected: true, reason: mineImported.reason };
      renderBody();
      return;
    }
    var comparison = e.compareMeshAttestations(mineImported.attestation, otherImported.attestation);
    _lastMeshCompare = comparison;
    renderBody();
    toast(comparison.agree ? 'Attestations agree.' : 'Attestations diverge.', comparison.agree ? 'success' : 'error');
  }

  /* ---------------------------- open / close ------------------------------ */

  function isOpen() {
    var panel = document.getElementById(PANEL_ID);
    return !!(panel && panel.classList.contains('open'));
  }

  function openPanel() {
    if (!flagOn()) return false;
    ensurePanel().classList.add('open');
    if (v1FlagOn()) setActiveTab(_activeTab || 'inbox');
    else renderBody();
    return true;
  }

  function closePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('open');
  }

  /* ---------------------------- mounting --------------------------------- */

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open the Proof Harness');
    btn.title = 'VERDICT: prove a claim locally and get a receipt';
    btn.innerHTML = '<span class="dg-ph-dot" aria-hidden="true"></span><span>VERDICT</span>';
    btn.addEventListener('click', function () {
      if (isOpen()) closePanel(); else openPanel();
    });
    /* Next to Trust, so the whole "prove it, then trust it" posture reads as
       one row of buttons. Falls back the same way Trust Ledger's own button
       does when neither anchor exists. */
    var anchor = document.getElementById('dg-trust-ledger-btn') || document.getElementById('dg-air-gap-btn') || document.getElementById('dg-shield-packs-btn');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      if (anchor.style.position === 'fixed') {
        btn.style.position = 'fixed';
        btn.style.bottom = '16px';
        btn.style.right = '400px';
        btn.style.zIndex = '12000';
      }
      return;
    }
    var toolbar = document.querySelector('#nav-right, .dg-toolbar, #dg-top-bar, .top-bar, header');
    if (!toolbar) {
      toolbar = document.body;
      btn.style.position = 'fixed';
      btn.style.bottom = '16px';
      btn.style.right = '400px';
      btn.style.zIndex = '12000';
    }
    toolbar.appendChild(btn);
  }

  function boot() {
    if (flagOn()) {
      injectButton();
      ensurePanel();
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closePanel();
      });
    }
    /* v1.1: install the window.runProofSecondEngine host bridge so
       resolveSecondEngine() can find it before the first Prove click. This
       call only assigns a function reference; it does not itself load
       Pyodide or install duckdb (those happen lazily, only when a claim is
       actually proven and corroboration is attempted). */
    if (v1FlagOn()) installSecondEngineBridge();
    /* Nothing new to publish on window: js/proof-harness/index.js already
       publishes window.DataGlowProofHarness with the pure engine calls this
       module wires into buttons. Publishing a second global here would be a
       second source of truth for exactly the thing doctrine #5 says must not
       fork. */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 860); });
  } else {
    setTimeout(boot, 860);
  }
})();
/* ---- end js/proof-harness/data-glow-proof-harness-canvas.js ---- */

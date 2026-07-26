# Hotfix: load Pyodide `sqlite3` package before second-engine SQL — Result

## Bug (live-proven on `945166e`, per `HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md`)

Diagnostic run on https://dataglow-platform.pplx.app surfaced:

```
ModuleNotFoundError: No module named 'sqlite3'
The module 'sqlite3' is unvendored from the Python standard library in the Pyodide distribution.
You can install it by calling:
  await micropip.install("sqlite3") in Python, or
  await pyodide.loadPackage("sqlite3") in JavaScript
```

CSV globals (`dg_csv_claims_example`) were present and correctly registered.
The previous proxy/None hotfix (#626, `HOTFIX_SQLITE_PROXY_MESH_SPEC.md`) was
necessary but not sufficient: it fixed how `runViaPyodideSqlite` *interprets*
the generated snippet's result globals, but it never addressed why the
snippet's own `import ... sqlite3 ...` line failed in the first place.
`pyodide-pandas` COUNT still worked because that path never imports
`sqlite3` at all — which is exactly why the bug was invisible to COUNT-only
smoke tests and only showed up once the sqlite full-SQL rung was actually
exercised live.

## Root cause

Pyodide does **not** bundle the CPython stdlib `sqlite3` module in its core
runtime image. It is a separate, unvendored package that Pyodide ships
alongside `pandas`/`numpy`/`matplotlib`, fetched from the same CDN
(jsdelivr) lockfile, but only importable after
`await pyodide.loadPackage('sqlite3')` has resolved — the exact same
pattern `js/runtimes-viz/python-runtime.js`'s `initPyodideRuntime()` already
uses for `pandas`/`numpy` (`await pyodide.loadPackage(['pandas', 'numpy'])`)
and `matplotlib`.

Every `buildSqliteRegisterAndQuerySnippet(...)`-generated Python snippet
begins with `import pandas as pd, io, sqlite3, json, re as _dg_re`, all
inside a `try/except` that correctly captured the resulting
`ModuleNotFoundError` into `_dg_second_engine_sqlite_error` — so the failure
was *reported* honestly, but the pyodide-sqlite rung of the fallback ladder
(the one rung that can answer `SUM`/`GROUP BY`/`JOIN`/`WHERE`, not just a
bare `COUNT(*)`) could never actually be reached on a real device. Nothing
in the bridge ever called `pyodide.loadPackage('sqlite3')`.

## Fix

`js/proof-harness/data-glow-proof-harness-canvas.js`:

- New `function ensureSqlite3InPyodide(py)`:
  - Resolves a "loader" in priority order: (1) `py` itself, when it exposes
    `loadPackage` (true for every real caller today — both the canvas
    notebook-lite bridge's `loadPyodide()` and
    `js/runtimes-viz/python-runtime.js`'s `initPyodideRuntime()` hand back
    the full Pyodide API object, not a restricted proxy); (2)
    `window.DataGlowPython.getPyodide?.()` as an alternate seam if `py`
    itself lacks `loadPackage`; (3) otherwise honestly resolves `false` —
    `runPythonAsync` alone cannot install packages.
  - Calls `loader.loadPackage('sqlite3')` — the package comes from the
    Pyodide CDN/lockfile (jsdelivr), already allowlisted; this is **not** a
    pypi/micropip install and is therefore not subject to the "no native
    wheel exists" structural impossibility that permanently blocks
    `ensureDuckdbInPyodide`'s micropip fallback.
  - Wrapped in the existing `withTimeout(...)` helper at
    `SQLITE3_LOAD_TIMEOUT_MS = 12000` (~12s, per spec).
  - After `loadPackage` resolves, calls `py.runPython('import sqlite3')` to
    positively confirm the import succeeds (spec step 3), not just trust
    `loadPackage`'s own resolution.
  - Caches its result in a shared `_sqlite3ReadyPromise` (a promise, not a
    boolean) so concurrent/repeated calls in one session share a single
    in-flight/settled load instead of re-issuing the CDN fetch every time.
  - Never throws — any failure (CDN error, timeout, missing loader) resolves
    `false`, letting the caller fall through to `pyodide-pandas` exactly as
    it already does for any other sqlite-path failure. No fabricated
    result is ever produced.
- `runViaPyodideSqlite(py, statement)`: now `await ensureSqlite3InPyodide(py)`
  as its first step, before `buildSqliteRegisterAndQuerySnippet(...)` runs —
  matching spec item 2 ("Call `ensureSqlite3InPyodide(py)` … at start of
  `runViaPyodideSqlite`").

### Mesh export `await` check (spec item 4)

Investigated whether any canvas UI call site invokes the async
`exportMeshAttestation` (`js/proof-harness/mesh-attestation.js`, declared
`export async function exportMeshAttestation(args)`) without awaiting it.

**Finding: already correct, no code change needed.** The only call site,
`onMeshExport()` in `data-glow-proof-harness-canvas.js`, is itself declared
`async function onMeshExport()` and does
`var exported = await e.exportMeshAttestation({...})` before reading
`exported.rejected`/`exported.attestation`. The click handler
(`meshExportBtn.addEventListener('click', function () { onMeshExport(); })`)
does not itself await the returned promise, but that is the standard,
correct fire-and-forget DOM event-handler pattern — `onMeshExport`'s own
body already awaits everything it needs before mutating `_lastMeshExport`
and calling `renderBody()`. A doc comment was added directly above
`onMeshExport` referencing this spec item, so a future edit does not
accidentally drop the internal `await`. This is locked in as a regression
test (see below) rather than a functional change.

## Tests

New `test/hotfix-pyodide-load-sqlite3.test.mjs` (30 assertions, all passing):

1. `ensureSqlite3InPyodide` is present verbatim in the shipped source, calls
   `loadPackage('sqlite3')`, is wrapped in `withTimeout`, caches via
   `_sqlite3ReadyPromise`, never throws (returns `false` on failure), and
   confirms `import sqlite3` after load.
2. `runViaPyodideSqlite` calls `ensureSqlite3InPyodide(py)` before running
   the register+query snippet (position-checked, not just presence).
3. End-to-end against a mock Pyodide object with a real `loadPackage`
   seam: `SELECT COUNT(*)` / `SELECT SUM(...)` now succeed via
   `engine: 'pyodide-sqlite'` once the package "loads" (previously these
   would have failed with `ModuleNotFoundError` against the same mock).
4. Caching: a second `runViaPyodideSqlite` call (same or a fresh mock `py`
   sharing the module-level cache) does **not** call `loadPackage` again.
5. Failure paths: a rejecting `loadPackage` (simulated CDN failure) never
   throws out of `runViaPyodideSqlite` and instead surfaces the honest
   `{error}` shape; a hanging `loadPackage` is bounded by the timeout
   (`ensureSqlite3InPyodide` resolves `false`, confirmed to not block
   indefinitely).
6. Mesh: `onMeshExport` is confirmed `async` and confirmed to `await
   e.exportMeshAttestation(...)`; `exportMeshAttestation` itself is
   confirmed declared `async` in `mesh-attestation.js`.

Updated existing suites whose mock `py` objects needed a `loadPackage` /
`import sqlite3` seam added to their harness assembly (their own
assertions/mocked SQL behavior are otherwise unchanged):

- `test/hotfix-second-engine-sqlite-sql.test.mjs` — mock `py.loadPackage`
  now handles any package name (was already permissive), mock
  `py.runPython` now also accepts `'import sqlite3'`; harness now includes
  `ensureSqlite3InPyodide` + a short mock timeout constant. **61 passed, 0
  failed** (was 53 passed / 8 failed immediately after the source change,
  before this harness update — confirms the harness, not the fix, needed
  updating).
- `test/hotfix-sqlite-proxy-mesh-export.test.mjs` — harness now includes
  `ensureSqlite3InPyodide` + `withTimeout`; the proxy-faithful mock has no
  `loadPackage` at all, so `ensureSqlite3InPyodide` honestly falls to its
  "no loader available" branch and resolves `false` without throwing,
  exactly per spec, and the rest of the mock's `runPythonAsync` behavior
  (which does not model package loading) is unaffected. **65 passed, 0
  failed** (was 65 passed with an uncaught `TypeError` crash before the
  harness update, because the un-extracted `ensureSqlite3InPyodide` call
  threw `ReferenceError` inside `runViaPyodideSqlite`'s own catch, which
  masked every result as `null`).

Regression run across the full proof-harness suite after the fix + canvas
re-injection, all green:

- `hotfix-pyodide-load-sqlite3.test.mjs`: 30 passed, 0 failed
- `hotfix-second-engine-sqlite-sql.test.mjs`: 61 passed, 0 failed
- `hotfix-sqlite-proxy-mesh-export.test.mjs`: 65 passed, 0 failed
- `proof-harness-v1-2-second-engine-depth.test.mjs`: 83 passed, 0 failed
- `proof-harness-v2-adversary-excel-mesh.test.mjs`: 83 passed, 0 failed
- `hotfix-ph-primary-scalars-bigint.test.mjs`: 44 passed, 0 failed
- `proof-harness-v0-engine-window.test.mjs`: 18 passed, 0 failed
- `proof-harness-v0.test.mjs`: 73 passed, 0 failed
- `proof-harness-v1-1-bridge.test.mjs`: 28 passed, 0 failed
- `proof-harness-v1-1.test.mjs`: 46 passed, 0 failed
- `proof-harness-v1.test.mjs`: 129 passed, 0 failed

**Total: 660 passed, 0 failed** across all proof-harness-related suites.

## Build / integrity

- Re-ran `python3 inject_proof_harness_v2.py` to rebuild
  `canvas/index.html` from the updated
  `js/proof-harness/data-glow-proof-harness-canvas.js` (the UI module is
  inlined verbatim, byte-for-byte, between its `UI_MARK`/`UI_END_MARK`
  markers — no engine-side pure module changed in this hotfix, so only the
  UI block changed).
- `npm run check:canvas-integrity` initially failed as expected (source
  changed, canvas not yet re-injected; canvas changed outside injection;
  file-size drift) — all three are the expected signal for "you edited the
  tracked source and rebuilt the canvas, now record it."
- `npm run check:canvas-integrity -- --update` refreshed
  `canvas/integrity.manifest.json`.
- `npm run check:canvas-integrity` (no flag) now reports **canvas bundle
  integrity OK** — syntax, marker pairing, tracked-module hashes, ship-path
  guards, and exact byte count all green.

## Files changed

- `js/proof-harness/data-glow-proof-harness-canvas.js` — `ensureSqlite3InPyodide`,
  its call from `runViaPyodideSqlite`, and a doc comment on `onMeshExport`.
- `canvas/index.html` — re-injected from the above.
- `canvas/integrity.manifest.json` — re-recorded hashes/byte count.
- `test/hotfix-pyodide-load-sqlite3.test.mjs` — new hotfix test file.
- `test/hotfix-second-engine-sqlite-sql.test.mjs` — mock/harness updated for
  the new `ensureSqlite3InPyodide` dependency (no assertion changes).
- `test/hotfix-sqlite-proxy-mesh-export.test.mjs` — harness updated for the
  new `ensureSqlite3InPyodide` dependency (no assertion changes).

## Spec reference

`HOTFIX_PYODIDE_LOAD_SQLITE3_SPEC.md` (this repo).

## PR

Branch: `fix/pyodide-load-sqlite3` — **do not merge** until confirmed.

PR: (recorded below once opened)
Commit SHA: (recorded below once pushed)

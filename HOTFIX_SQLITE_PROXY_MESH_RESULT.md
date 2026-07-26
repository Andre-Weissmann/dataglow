# Hotfix: pyodide-sqlite Pyodide proxy handling + mesh/excel public API — Result

## Bug (live-proven on b9add21, per `HOTFIX_SQLITE_PROXY_MESH_SPEC.md`)
Markers present; GREEN + adversary pack passed; but:
- `COUNT(*)` second engine fell to `pyodide-pandas` — `pyodide-sqlite` never
  won, even though the sqlite path exists and should be preferred.
- `SELECT SUM(1)` surfaced `pyodide-sql-unavailable` — a statement shape
  only sqlite (not the narrow pandas COUNT fallback) can ever answer.
- Mesh export returned an empty object / null digests.

## Root cause 1 — Pyodide proxy None vs error, and payload conversion
`runViaPyodideSqlite` read `window` globals written by the generated Python
snippet (`_dg_second_engine_sqlite_error`, `_dg_second_engine_sqlite_payload`,
`_dg_second_engine_sqlite_tables_registered`) using a raw
`v !== undefined && v !== null` truthiness check, and passed the payload
directly into `JSON.parse`.

In a real Pyodide runtime, a Python global left at its default `None` value
does not come back into JS as `undefined`/`null` — it comes back as a
**PyProxy object** wrapping `None`, which is neither `undefined` nor `null`
but stringifies to the literal text `"None"`. The old check treated that
proxy as "truthy, therefore a real error", so **every successful sqlite run**
(which leaves the error global at `None`) was misclassified as failed,
sending the bridge into its `pyodide-pandas` fallback instead — exactly the
live-proven symptom (`COUNT(*)` never resolves via sqlite, and
`SUM(...)`/`pyodide-sql-unavailable` can never be answered by the narrower
pandas path at all).

The payload had the same defect in reverse: it needed unwrapping via
`.toJs()`/`.toString()` before `JSON.parse`, not a direct parse of a proxy
object.

### Fix
`js/proof-harness/data-glow-proof-harness-canvas.js`:
- New `function pyToJs(v)` — converts a possible Pyodide proxy (or plain
  value) into a real JS value: `null`/`undefined` → `null`; an object
  exposing `.toJs()` → the result of `.toJs({ create_proxies: false })`
  (wrapped in try/catch, falls through to string coercion on throw); a
  real string → returned unchanged; anything else → `String(v)` in a
  try/catch, `null` on total failure. This deliberately never throws, even
  on primitives with no `.toJs` (a small, safe hardening beyond the spec's
  literal code sketch).
- New `function isRealPyodideErrorValue(v)` — calls `pyToJs(v)`, treats
  `null`/`undefined`, an empty/whitespace-only string, and the literal text
  `"None"` as "not a real error"; anything else non-empty is a real error.
  This directly implements the spec's inline rule ("error: only real
  strings; ignore null/undefined/''/'None'").
- `runViaPyodideSqlite` rewritten to:
  - Read the error global via `pyToJs` + `isRealPyodideErrorValue` instead
    of raw identity checks.
  - Read the payload global via `pyToJs`, treat `null`/`undefined`/`''`/
    `'None'` as "no payload" before calling `JSON.parse`.
  - Read the registered-tables global via `pyToJs`, falling back to the
    original JS-derived `tableNames` if the converted value isn't an array.

## Root cause 2 — no Python-side table discovery fallback
When the JS-side `listCsvGlobalTableNames(py.globals)` proxy-iteration walk
returned an empty list (proxy iteration is not always reliable immediately
after `buildHelper(py)` runs), the generated Python snippet had nothing to
register and the query could never succeed, regardless of what CSV globals
actually existed in the Pyodide namespace.

### Fix
`buildSqliteRegisterAndQuerySnippet(statement, tableNames)` rewritten:
non-empty `tableNames` still takes the original, unchanged explicit-name
path (`globals()["dg_csv_<name>"]` lookups). When `tableNames` is empty, the
generated Python now imports `re as _dg_re` and walks `list(globals())`
itself, matching the same `^dg_csv_(.+)$` convention as the JS-side
`DG_CSV_GLOBAL_RE`, sanitizing each discovered name via
`_dg_re.sub(r"[^a-zA-Z0-9_]", "_", _dg_name)` (mirroring the JS-side
sanitization), and registering every match via `to_sql`, same as the
explicit path.

## Root cause 3 — mesh/excel public API (investigation result: no bug found)
Spec asked to "publish `exportMeshAttestation`, `importMeshAttestation`,
`compareMeshAttestations`, `parseExcelAggregateClaim`, `excelClaimToSql` on
`window.DataGlowProofHarness`." Investigation of the pre-existing code
found this was **already correctly implemented**:
- `js/proof-harness/index.js` (lines ~562, ~606-613) already re-exports
  `exportMeshAttestation`, `importMeshAttestation`, `compareMeshAttestations`,
  `verifyMeshAttestationHash`, `parseExcelAggregateClaim`, `excelClaimToSql`,
  `excelClaimTextToSql` onto the object published as
  `window.DataGlowProofHarness`.
- `inject_proof_harness_v2.py` (lines ~118-124) already includes the same
  six keys in the hardcoded canvas-rebuild object literal used to produce
  `canvas/index.html`.
- The canvas Mesh tab's `onMeshExport()`/`onMeshCompare(body)` already call
  `engine().exportMeshAttestation(...)`, `engine().importMeshAttestation(...)`,
  `engine().compareMeshAttestations(...)` with correct argument shapes.
- `js/proof-harness/mesh-attestation.js` and `js/proof-harness/excel-claim.js`
  both correctly export all required pure functions.

**No source change was made for root cause 3.** The live-proven "mesh export
returned empty object / null digests" symptom was not reproducible against
the pure `mesh-attestation.js` module in isolation (see Tests, below) —
this hotfix locks the already-correct wiring in place with regression tests
per the spec's "Tests" section rather than changing working code. If the
live symptom recurs, the next investigation should focus on the caller's
input shape (e.g. a stale/incompatible `proposal`/`verdict`/`run`/`receipt`
object at the call site) rather than the export wiring itself.

## Fix summary per file
| File | Change |
|---|---|
| `js/proof-harness/data-glow-proof-harness-canvas.js` | New `pyToJs`, `isRealPyodideErrorValue` helpers; rewrote `buildSqliteRegisterAndQuerySnippet` (Python-side discovery fallback) and `runViaPyodideSqlite` (proxy-safe error/payload/table-list reads) |
| `test/hotfix-second-engine-sqlite-sql.test.mjs` | Updated the empty-table-list assertion for the new discovery-loop Python shape; updated the mock `runPythonAsync` to simulate discovery; added `pyToJs`/`isRealPyodideErrorValue` sources into the harness assembly (the harness previously omitted them, causing `ReferenceError`s that were silently swallowed and misread as sqlite failures during this hotfix's development) |
| `test/hotfix-sqlite-proxy-mesh-export.test.mjs` (new) | Dedicated hotfix test file — see Tests below |
| `canvas/index.html` | Re-generated via `inject_proof_harness_v2.py` from the fixed `js/proof-harness/*.js` sources |
| `canvas/integrity.manifest.json` | Hashes refreshed via `check:canvas-integrity -- --update` |
| `js/proof-harness/index.js`, `inject_proof_harness_v2.py`, `js/proof-harness/mesh-attestation.js`, `js/proof-harness/excel-claim.js` | No changes — confirmed already correct for root cause 3 |

## Tests
New dedicated file `test/hotfix-sqlite-proxy-mesh-export.test.mjs` (65
assertions) covers the spec's "Tests" section:
1. **Unit: `pyToJs` None/error handling** — `null`/`undefined` → `null`;
   real strings pass through; a PyProxy-shaped None value (no `.toJs()`,
   `toString()` → `"None"`) converts to the string `"None"`, never the
   object itself; a proxy whose `.toJs()` returns `null` converts to
   `null`; throwing `.toJs()`/`.toString()` never propagates.
2. **Unit: `isRealPyodideErrorValue`** — reproduces the exact live bug: a
   PyProxy representing Python `None` is truthy under the old
   `!== undefined && !== null` check but must never be treated as an error;
   genuine error strings (bare or proxy-wrapped) are still correctly
   flagged as real errors.
3. **`buildSqliteRegisterAndQuerySnippet` discovery fallback** — empty
   `tableNames` emits `list(globals())`-based discovery Python with the
   `^dg_csv_(.+)$` convention and `to_sql` registration; non-empty
   `tableNames` still takes the original explicit-name path unchanged.
4. **End-to-end `runViaPyodideSqlite` against a fully PyProxy-shaped mock**
   (every global — error flag, payload, table list — wrapped in
   proxy-like objects, never a bare JS value, matching real Pyodide
   behavior): `COUNT(*)` and `SUM(...)` both succeed and correctly tag
   `engine: 'pyodide-sqlite'`; a genuine sqlite error (missing table) is
   still correctly surfaced, proving the None-vs-error fix never masks a
   real failure; the Python-side discovery fallback finds a table end to
   end even when the JS-side listing throws.
5. **Mesh/Excel API presence** — `window.DataGlowProofHarness` publishes
   `exportMeshAttestation`, `importMeshAttestation`, `compareMeshAttestations`,
   `verifyMeshAttestationHash`, `parseExcelAggregateClaim`, `excelClaimToSql`
   in `inject_proof_harness_v2.py`, `js/proof-harness/index.js`, and the
   shipped `canvas/index.html` bundle.
6. **Mesh export round trip** — a real `exportMeshAttestation` →
   `importMeshAttestation` → `compareMeshAttestations` cycle through the
   exact pure-module surface the canvas Mesh tab calls, confirming a
   non-empty attestation object with a real `sha256:`-prefixed
   `attestationHash` and `schemaFingerprint` (never an empty object or
   null digest).

Full regression suite, all green:

| Suite | Result |
|---|---|
| `node test/proof-harness-v0.test.mjs` | 73 passed |
| `node test/proof-harness-v0-engine-window.test.mjs` | 18 passed |
| `node test/proof-harness-v1.test.mjs` | 129 passed |
| `node test/proof-harness-v1-1.test.mjs` | 46 passed |
| `node test/proof-harness-v1-1-bridge.test.mjs` | 28 passed |
| `node test/proof-harness-v1-2-second-engine-depth.test.mjs` | 83 passed |
| `node test/hotfix-ph-primary-scalars-bigint.test.mjs` | 44 passed |
| `node test/proof-harness-v2-adversary-excel-mesh.test.mjs` | 83 passed |
| `node test/hotfix-second-engine-sqlite-sql.test.mjs` | 61 passed |
| `node test/hotfix-sqlite-proxy-mesh-export.test.mjs` (new) | 65 passed |
| **Total** | **630 passed, 0 failed** |

`npm run check:canvas-integrity` (post `--update`): syntax OK (3 inline
`<script>` blocks parsed), markers OK (336 inlined module paths / 307
closing markers, tracked modules correctly paired), tracked OK (68 modules
verified against `canvas/integrity.manifest.json`), ship-path checks OK,
publish OK (`canvas/index.html` at the recorded 6,355,122 bytes).

## Delivery
- Branch: `fix/sqlite-proxy-mesh-export`
- Base: `main` @ `b9add21` (Proof Harness v2.0 foundation, #625)
- Commit SHA: see PR / `git log -1` on the branch (recorded below once
  committed)
- PR (OPEN, **not merged**): recorded below once opened

Files changed: `js/proof-harness/data-glow-proof-harness-canvas.js`,
`test/hotfix-second-engine-sqlite-sql.test.mjs`,
`test/hotfix-sqlite-proxy-mesh-export.test.mjs` (new), `canvas/index.html`,
`canvas/integrity.manifest.json`, `HOTFIX_SQLITE_PROXY_MESH_RESULT.md` (new).

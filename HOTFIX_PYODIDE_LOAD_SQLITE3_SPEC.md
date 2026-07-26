# Hotfix SPEC — load Pyodide `sqlite3` package before second-engine SQL

## Live root cause (proven)

Diagnostic on https://dataglow-platform.pplx.app (`945166e`):

```
ModuleNotFoundError: No module named 'sqlite3'
The module 'sqlite3' is unvendored from the Python standard library in the Pyodide distribution.
You can install it by calling:
  await micropip.install("sqlite3") in Python, or
  await pyodide.loadPackage("sqlite3") in JavaScript
```

CSV globals present (`dg_csv_claims_example`). Proxy/None hotfix was necessary but not sufficient. `pyodide-pandas` COUNT still worked because it never imports sqlite3.

## Fix

In `data-glow-proof-harness-canvas.js` (and inject):

1. `ensureSqlite3InPyodide(py)`:
   - Prefer `py.loadPackage?.('sqlite3')` if py is the full pyodide API
   - Else try `window.DataGlowPython.getPyodide?.()` / whatever the runtime exposes
   - Else `await py.runPythonAsync` cannot load packages — need the pyodide module
   - Mirror how `js/runtimes-viz/python-runtime.js` already does `pyodide.loadPackage(['pandas','numpy'])`
   - Cache promise; timeout ~12s; on failure return false (fall through to pandas COUNT)
   - Package comes from Pyodide CDN (jsdelivr) — allowlisted, not pypi duckdb

2. Call `ensureSqlite3InPyodide(py)` at start of `runViaPyodideSqlite` (or once in bridge before sqlite path)

3. After load, `import sqlite3` must succeed

4. Mesh prove script note: `exportMeshAttestation` is **async** — callers must `await` (document in RESULT; fix any canvas UI that forgets await)

## Tests

- Unit: ensure function exists; snippet still builds
- Mock loadPackage called before run
- Existing suites pass

## PR

`fix/pyodide-load-sqlite3` — do NOT merge until confirm.

# DataGlow — Deployment Checklist

## Required HTTP Headers (#4 — COOP/COEP for DuckDB multi-threading)

DuckDB-WASM's multi-threaded (EH) build requires `SharedArrayBuffer`, which is
blocked by modern browsers unless the page is Cross-Origin Isolated.

**Add these headers to every hosting platform you deploy DataGlow to:**

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### GitHub Pages — `_headers` file (at repo root)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### Cloudflare Pages — `_headers` file (at repo root, same format as above)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### Vercel — `vercel.json`

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy",  "value": "require-corp" }
      ]
    }
  ]
}
```

### Nginx

```nginx
add_header Cross-Origin-Opener-Policy  "same-origin"   always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

### Local dev (already works)

`localhost` is considered a secure context; `crossOriginIsolated` is typically
true in Chrome/Edge without extra headers. Firefox requires the headers even on
localhost. Safari requires the headers on all environments.

### What happens if you skip the headers

DataGlow still works — DuckDB falls back to single-threaded (mvp) mode.
You lose parallel query execution but all features remain functional.
The `[DataGlow DuckDB]` console message tells you which mode is active.

---

## DuckDB-WASM Version Pin (#5)

Vendored version: **1.29.0** (`assets/duckdb/duckdb-wasm.package.json`)

Before upgrading:
1. Confirm the new version passes the Safari crash regression (Issue #1058).
2. Test XLSX ingestion on Safari (Issue #1956: read_xlsx() WASM crash).
3. Run the full test suite: `npm test`.
4. Update `PINNED_DUCKDB_WASM_VERSION` in `js/app-shell/duckdb-config.js`.

---

## Memory64 — DO NOT USE (#6)

WebAssembly Memory64 is NOT deployable across all browsers in 2026:
- Chrome: behind origin trial
- Firefox: behind a flag
- **Safari: NO support**

Do not build any DataGlow feature that depends on Memory64 until all three
major browser engines ship it in stable releases. Search for `MEMORY64_BLOCKED`
in the codebase to audit compliance.

---

## Server Offload — Opt-in Only (#8)

The `serverOffload` feature flag is **off by default** and must never be turned
on automatically. DataGlow's privacy guarantee is local-first: data never leaves
the browser unless the user explicitly chooses an external source. If you build a
server offload integration, gate it behind `isEnabled('serverOffload')` AND a
user-provided endpoint URL. Never make server offload the default query path.

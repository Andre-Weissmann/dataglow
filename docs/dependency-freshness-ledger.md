# DATAGLOW — Dependency Freshness Ledger

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: npm run test:deps-freshness -->

- Generated: `2026-07-23T13:20:01.517Z`
- Registry reachable: yes
- Dependencies tracked: **5** (🟢 5 ok · 🟡 0 warn · 🔴 0 fail)
- Staleness: 2 current · 2 patch · 1 minor · 0 major behind
- Security advisories (npm audit): **2** (🔴 0 fail-level · 🟡 2 warn-level)

> Gate: **FAIL** if any dependency is more than 2 majors behind, or if `npm audit` reports a high/critical advisory. **WARN** at ≥1 major, ≥5 minors, or ≥25 patches behind.

## Dependencies

| Status | Package | Type | Current | Latest | Behind | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 🟢 ok | `@duckdb/duckdb-wasm` | prod | 1.29.0 | 1.33.1-dev57.0 | 4 minor | latest is a prerelease |
| 🟢 ok | `@duckdb/node-api` | dev | 1.5.4-r.1 | 1.5.5-r.1 | 1 patch | latest is a prerelease |
| 🟢 ok | `@modelcontextprotocol/sdk` | prod | 1.29.0 | 1.29.0 | — | — |
| 🟢 ok | `@openmined/psi.js` | prod | 2.0.2 | 2.0.6 | 4 patch | — |
| 🟢 ok | `playwright-chromium` | dev | 1.61.1 | 1.61.1 | — | — |

## Security advisories

| Gate | Package | Severity | Vulnerable range | Fix available |
| --- | --- | --- | --- | --- |
| 🟡 warn | `@hono/node-server` | moderate | <2.0.5 | yes |
| 🟡 warn | `@modelcontextprotocol/sdk` | moderate | >=1.25.0 | yes |

---
_Automated by `.github/scripts/dependency-freshness.mjs` (the `dependency-freshness` CI job). This file is regenerated on every run; edit the script, not the report._

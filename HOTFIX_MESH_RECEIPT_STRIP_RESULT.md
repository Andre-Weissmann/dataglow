# Hotfix: mesh export rejects on full receipt (nested rows) — Result

## Bug (as diagnosed)
The Mesh tab's Export button (`onMeshExport()` in
`js/proof-harness/data-glow-proof-harness-canvas.js`) called:

```js
var exported = await e.exportMeshAttestation({
  proposal: _lastResult.proposal,
  verdict: _lastResult.verdict,
  run: safeRun,
  receipt: _lastResult.receipt,
});
```

`_lastResult.receipt` is the **full receipt ledger entry** produced by
`receipt.js`'s `createReceiptLedger().append()` (`{index, prevHash, hash,
ts, record: {predicate: {inputs, run, corroboration, adversarial,
environment, ...}}}`), not a `{hash}` shape. `predicate.inputs` is a
free-form per-input descriptor array (`buildReceiptPredicate` in
`receipt.js`) that can carry a nested `rows`/`samples`/`csv`/`cells`/
`sheetData` key without any single call site "meaning" to put it there.
`mesh-attestation.js`'s `exportMeshAttestation()` recursively scans its
**entire** input and refuses outright if any forbidden key is found
anywhere — by design (`PROOF_HARNESS_V2_SPEC.md` pillar C: zero rows may
ever cross into an attestation) — so passing the raw ledger entry caused
every mesh export to be rejected. `exportMeshAttestation` only ever reads
`receipt.hash` (`mesh-attestation.js` line 175); the rest of the ledger
entry was never needed at this call site.

## Fix
**File:** `js/proof-harness/data-glow-proof-harness-canvas.js`, `onMeshExport()`.

1. **Receipt reduced to hash-only** before the call:
   ```js
   var safeReceipt = (_lastResult.receipt && typeof _lastResult.receipt.hash === 'string')
     ? { hash: _lastResult.receipt.hash }
     : null;
   ```
   passed as `receipt: safeReceipt`.
2. **Proposal rebuilt from known-safe fields** (`statement`, `engine`,
   `expected`, `tables`, `claimText`, `author`, `modelId`, `digest`), with
   `expected` additionally re-scanned by a local `meshContainsForbiddenKey()`
   helper (mirrors `mesh-attestation.js`'s own `FORBIDDEN_KEYS` list) and
   dropped to `{}` if it ever carries a forbidden key — defense-in-depth
   against a future Excel-claim/adversarial payload smuggling `rows` into
   `expected`.
3. **Explicit `environment: {}`** added to the `exportMeshAttestation` call
   so a future edit that starts forwarding a live environment/debug object
   is a visible diff against this deliberate empty default, not a silent
   gap.

Full diff of the handler is in
`js/proof-harness/data-glow-proof-harness-canvas.js` (search
`HOTFIX_MESH_RECEIPT_STRIP_SPEC.md`).

## Re-injection
`python3 inject_proof_harness_v2.py` re-inlined the updated canvas UI module
into `canvas/index.html` ("Replaced existing Proof Harness block with v2
(251251 chars)."). `npm run check:canvas-integrity -- --update` then
re-recorded the module hash, the inlined-copy hash, and the whole-file byte
count in `canvas/integrity.manifest.json`. A follow-up plain
`npm run check:canvas-integrity` (no `--update`) confirms everything is
clean:

```
ok  syntax: 3 inline <script> block(s) parsed
ok  markers: 336 inlined module path(s) in canvas/index.html, 307 closing marker(s); tracked modules correctly paired
ok  tracked: 68 module(s) verified against canvas/integrity.manifest.json
ok  ship path: desktop stage script still stages index.html + js/
ok  ship path: build.sh still guards canvas/index.html against a stale src/ rebuild
ok  publish: canvas/index.html is the recorded 6362766 bytes
check-canvas-integrity: canvas bundle integrity OK
```

## Tests
New file `test/hotfix-mesh-receipt-strip.test.mjs` (15 assertions), built
around a **real** ledger entry from `receipt.js`'s own
`createReceiptLedger()`/`buildReceiptPredicate()` (not a hand-rolled
stand-in), calling `js/proof-harness/mesh-attestation.js`'s
`exportMeshAttestation()` directly (the pure module the canvas calls through
`engine()`):

- Passing the full ledger entry (with a `rows` field nested in
  `predicate.inputs[0]`) as `receipt` **reproduces the bug**:
  `rejected === true`, reason names the `rows` field.
- Reducing that same entry to `{ hash: entry.hash }` first (the fix)
  **succeeds**: `rejected === false`, and `attestation.receiptHash` exactly
  equals the original entry's hash — proves no information the module
  actually uses was lost.
- A receipt with no string `.hash` (`{}` or `null`) still exports with
  `receiptHash: null` — confirms the existing `mesh-attestation.js` contract
  is unaffected.
- A `proposal.expected` carrying a forbidden key is still refused
  independent of the receipt fix (defense-in-depth check).
- The full canvas-shaped payload (safe proposal + safe run + hash-only
  receipt + empty environment) exports successfully end to end.

Full proof-harness suite, all green:

| Suite | Result |
|---|---|
| `node test/proof-harness-v0.test.mjs` | 73 passed |
| `node test/proof-harness-v0-engine-window.test.mjs` | 18 passed |
| `node test/proof-harness-v1.test.mjs` | 129 passed |
| `node test/proof-harness-v1-1.test.mjs` | 46 passed |
| `node test/proof-harness-v1-1-bridge.test.mjs` | 28 passed |
| `node test/proof-harness-v1-2-second-engine-depth.test.mjs` | 83 passed |
| `node test/proof-harness-v2-adversary-excel-mesh.test.mjs` | 83 passed |
| `node test/hotfix-mesh-receipt-strip.test.mjs` (new) | 15 passed |
| **Total** | **475 passed, 0 failed** |

## Delivery
- Branch: `fix/mesh-receipt-strip`
- Base: `main` @ `aab0350c155146d5516621c36c00ab1b3fd33b4f`
- Commit SHA: `7c2535c3d270fc4f50e78880fef9e960c14e097e`
- PR (OPEN, **not merged**): https://github.com/Andre-Weissmann/dataglow/pull/628

Files changed: `js/proof-harness/data-glow-proof-harness-canvas.js`,
`canvas/index.html`, `canvas/integrity.manifest.json`,
`test/hotfix-mesh-receipt-strip.test.mjs` (new),
`HOTFIX_MESH_RECEIPT_STRIP_SPEC.md` (new).

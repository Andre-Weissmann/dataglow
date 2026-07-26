# Hotfix SPEC — mesh export rejects on full receipt (nested rows)

## Bug

The Mesh tab's Export button (`onMeshExport()` in
`js/proof-harness/data-glow-proof-harness-canvas.js`) calls:

```js
var exported = await e.exportMeshAttestation({
  proposal: _lastResult.proposal,
  verdict: _lastResult.verdict,
  run: safeRun,
  receipt: _lastResult.receipt,
});
```

`_lastResult.receipt` is **not** a `{hash}` shape. It is the full ledger
entry returned by `receipt.js`'s `createReceiptLedger().append()`
(`js/proof-harness/index.js`'s `recordReceipt()`):

```js
{ index, prevHash, hash, ts,
  record: { _type, subject, predicate: { claim, proposal, inputs, run,
                                          corroboration, adversarial,
                                          environment, verdict, confirm } } }
```

`predicate.inputs` is declared as `Array.isArray(p.inputs) ? p.inputs : []`
in `buildReceiptPredicate` (`receipt.js`) — a field that exists precisely to
carry per-input dataset descriptors, and is exactly the kind of place a
`rows`/`samples`/`csv`/`cells`/`sheetData` key can end up nested arbitrarily
deep without any single call site "meaning" to put it there. `predicate.run`
and `predicate.corroboration`/`adversarial` are similarly free-form
sub-objects fed by whatever the live run/second-engine/adversary pack
produced.

`mesh-attestation.js`'s `exportMeshAttestation()` recursively scans its
*entire* input (`findForbiddenKey`, forbidden keys `rows`, `samples`, `csv`,
`cells`, `sheetData`) and refuses outright if any are found anywhere in the
args tree — by design, per `PROOF_HARNESS_V2_SPEC.md` pillar C (zero rows may
ever cross into an attestation). Passing the raw ledger entry as `receipt`
means any `rows`-shaped field nested inside `predicate.inputs` (or a stray
`rows`/`samples` key surfacing inside `predicate.run`/`corroboration`/
`adversarial` from a live engine result) causes **every** mesh export to be
rejected — not just for input that legitimately carries rows, but as a
false-positive footgun baked into the call site itself, since the receipt
was never meant to be passed whole in the first place.

The fix is narrow: `exportMeshAttestation` only ever reads
`receipt.hash` (`mesh-attestation.js` line 175:
`receiptHash: a.receipt && typeof a.receipt.hash === 'string' ? a.receipt.hash : null`).
The full ledger entry was never needed at this call site.

## Fix

**File:** `js/proof-harness/data-glow-proof-harness-canvas.js`, `onMeshExport()`.

1. **Receipt → hash-only.** Replace `receipt: _lastResult.receipt` with a
   pre-extracted, hash-only object:
   ```js
   var safeReceipt = (_lastResult.receipt && typeof _lastResult.receipt.hash === 'string')
     ? { hash: _lastResult.receipt.hash }
     : null;
   ```
   passed as `receipt: safeReceipt`. This is the only field
   `exportMeshAttestation` reads from `receipt`, so nothing is lost; every
   nested field of the ledger entry (`record.predicate.inputs`, etc.) is
   dropped before it ever reaches the forbidden-key scan.

2. **Proposal → strip nested rows defensively.** `_lastResult.proposal`
   (a frozen `Proposal` from `proposal.js`) does not carry a `rows`-shaped
   field today (`statement`, `engine`, `expected`, `tables`, `claimText`,
   `author`, `modelId`, `digest` only) — but `expected` is a caller-supplied
   plain object with no field allowlist, so a future/adversarial claim
   payload could smuggle a `rows` key into `expected` (e.g. an Excel-claim
   round-trip that echoes raw cell data). Build a `safeProposal` that carries
   only the known-safe fields and re-scans `expected` for forbidden keys,
   dropping it (empty object) if any are found, rather than passing
   `_lastResult.proposal` through as-is. Belt-and-suspenders: the module's
   own `findForbiddenKey` already covers this, but the canvas should not
   forward more than it needs to regardless.

3. **Environment guard.** `safeRun`/`receipt` are the only sources of a
   free-form sub-object today; there is no separate `environment` argument
   passed from the canvas (mesh-attestation.js defaults `environment` to
   `{}` when the caller does not supply one). Add an explicit
   `environment: {}` to the `exportMeshAttestation` call so the canvas never
   accidentally starts forwarding a live environment/debug object later
   without this same hash-only/rows-free discipline being applied to it
   first — and so a future call-site edit that adds `environment:
   someLiveObject` is a visible diff against this deliberate `{}`, not a
   silent gap.

## Tests

New assertions appended to
`test/proof-harness-v2-adversary-excel-mesh.test.mjs` section 8
(mesh-attestation.js), simulating the canvas's own extraction logic
end-to-end via `exportMeshAttestation` directly (the pure module the canvas
calls through `engine()`):

- A `receipt` shaped like a **real ledger entry** (`{index, prevHash, hash,
  ts, record: {predicate: {inputs: [{rows: [[1,2,3]]}], ...}}}`) passed
  **whole** to `exportMeshAttestation` is **rejected** (`rejected === true`,
  reason mentions the forbidden field) — proves the pre-fix call shape
  fails exactly as diagnosed.
- The **same** ledger entry, reduced to `{ hash: entry.hash }` (the fix's
  extraction) before being passed to `exportMeshAttestation`, **succeeds**
  (`rejected === false`) and the resulting attestation's `receiptHash`
  equals `entry.hash` — proves the fix preserves the one field that
  mattered.
- A regression guard confirming a `receipt` object that is present but has
  no string `.hash` (e.g. `{}` or `null`) still exports successfully with
  `receiptHash: null`, matching `mesh-attestation.js`'s existing contract.

## PR

`fix/mesh-receipt-strip` — do NOT merge until confirmed.
RESULT: `HOTFIX_MESH_RECEIPT_STRIP_RESULT.md`

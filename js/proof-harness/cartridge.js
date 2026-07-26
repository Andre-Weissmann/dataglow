// ============================================================
// DATAGLOW - Proof Harness v1: Proof Cartridge (portable proof)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V1_SPEC.md, pillar 3: a confirmed GREEN receipt should be
// able to travel -- exported as a portable JSON cartridge someone else can
// re-run on their own device to check the SAME claim against their OWN data,
// without ever moving the source rows themselves. A cartridge carries the
// proposal digest, statement, expected values, verdict, environment, and
// input schema fingerprints if present, but ZERO ROWS of source data by
// default -- that is the whole point: "prove it travels, the data does not."
// A `sha256`-style hash over the payload gives the cartridge a signature-like
// integrity check (this is a content hash, not a cryptographic signature by
// a private key; exportCartridge()/importCartridge() are both explicit about
// that, matching the honest-naming discipline every other provenance module
// in this codebase follows -- see js/provenance/ai-touch-ledger.js's header).
//
// Import re-executes the statement via the caller's injected `runQuery` on
// the IMPORTER's own data; if the result no longer matches what the
// cartridge recorded, importCartridge() returns a precise divergence report
// and REFUSES to call it GREEN -- a cartridge is a claim to re-check, never
// a certificate to trust blindly.
//
// PURITY: no DOM, no network. `runQuery` is the only injected side effect.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const CARTRIDGE_TYPE = 'dataglow/proof-cartridge/v1';

/** SHA-256 of a string, lowercase hex. Same algorithm as every other proof-harness module. */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Recursively sort object keys so JSON.stringify output is canonical
// regardless of insertion order, mirroring receipt.js's sortDeep.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * Build a portable proof cartridge from a confirmed GREEN prove cycle
 * result (the same shape runProofCycle() returns). Carries ZERO ROWS of
 * source data by default -- only the digest, statement, expected values,
 * verdict, environment, and (if supplied) input schema fingerprints.
 *
 * Refuses (returns {rejected:true, reason}) when the supplied result was not
 * a GREEN verdict: exporting a cartridge is only meaningful for a claim that
 * was actually proven, matching the spec's "export a portable JSON cartridge
 * from a confirmed GREEN receipt".
 *
 * @param {{proposal: object, verdict: {state:string}, receipt?: object,
 *          run?: {durationMs?:number, rowCount?:number}, environment?: object,
 *          schemaFingerprints?: object}} args
 * @returns {Promise<{rejected:true, reason:string} | {rejected:false, cartridge:object}>}
 */
export async function exportCartridgeCore(args) {
  const a = isPlainObject(args) ? args : {};
  const proposal = a.proposal;
  const verdict = a.verdict;

  if (!isPlainObject(proposal) || typeof proposal.statement !== 'string' || !proposal.statement.trim()) {
    return { rejected: true, reason: 'A proposal with a statement is required to export a cartridge.' };
  }
  if (!isPlainObject(verdict) || verdict.state !== 'GREEN') {
    return { rejected: true, reason: 'Only a confirmed GREEN result can be exported as a proof cartridge.' };
  }

  const payload = {
    _type: CARTRIDGE_TYPE,
    proposalDigest: proposal.digest || null,
    statement: proposal.statement,
    engine: proposal.engine || 'duckdb',
    claimText: proposal.claimText || null,
    expected: isPlainObject(proposal.expected) ? proposal.expected : {},
    tables: Array.isArray(proposal.tables) ? proposal.tables.slice() : [],
    verdict: { state: verdict.state, reasonCode: verdict.reasonCode || null },
    environment: isPlainObject(a.environment) ? a.environment : {},
    schemaFingerprints: isPlainObject(a.schemaFingerprints) ? a.schemaFingerprints : {},
    receiptHash: a.receipt && typeof a.receipt.hash === 'string' ? a.receipt.hash : null,
    rowCountAtExport: a.run && typeof a.run.rowCount === 'number' ? a.run.rowCount : null,
    rows: [], // deliberately always empty: zero rows of source data by default
    exportedAt: new Date().toISOString(),
  };

  const hash = await sha256Hex(JSON.stringify(sortDeep(payload)));
  return { rejected: false, cartridge: { ...payload, cartridgeHash: `sha256:${hash}` } };
}

/**
 * Public exportCartridge(): thin wrapper over exportCartridgeCore(). Kept as
 * its own named export (rather than just an alias) so a caller that imports
 * cartridge.js directly -- e.g. an existing test -- keeps working under the
 * `exportCartridge` name unchanged, while index.js/the canvas inject import
 * and call `exportCartridgeCore` directly instead of binding a `Pure` alias
 * that the inject script's import-stripping would otherwise leave undefined.
 * @param {{proposal: object, verdict: {state:string}, receipt?: object,
 *          run?: {durationMs?:number, rowCount?:number}, environment?: object,
 *          schemaFingerprints?: object}} args
 * @returns {Promise<{rejected:true, reason:string} | {rejected:false, cartridge:object}>}
 */
export async function exportCartridge(args) {
  return exportCartridgeCore(args);
}

/**
 * Serialize a cartridge object to a JSON string suitable for a file download
 * or copy-to-clipboard. Pure formatting only.
 * @param {object} cartridge
 */
export function serializeCartridge(cartridge) {
  return JSON.stringify(cartridge, null, 2);
}

/**
 * Parse a cartridge from a JSON string (file contents or pasted text). Also
 * tolerates a caller mistakenly passing an object instead of a string --
 * most commonly exportCartridge()'s own return value ({rejected, cartridge})
 * passed straight through without unwrapping `.cartridge`, or the cartridge
 * object itself (already parsed) -- both are unwrapped/accepted directly
 * rather than failing a JSON.parse on a non-string. Never throws: malformed
 * JSON or a wrong shape returns {rejected:true, reason}.
 * @param {string|object} text a JSON string, an already-parsed cartridge
 *   object, or an exportCartridge() result ({rejected:false, cartridge}) to
 *   unwrap
 */
export function parseCartridge(text) {
  let parsed;
  if (isPlainObject(text)) {
    // Caller passed an object rather than a JSON string. Accept the two
    // shapes that are actually useful here instead of forcing every caller
    // to remember to unwrap/stringify first:
    //   1. exportCartridge()'s own {rejected:false, cartridge:{...}} result
    //   2. an already-parsed cartridge object ({_type: CARTRIDGE_TYPE, ...})
    if (isPlainObject(text.cartridge) && text.cartridge._type === CARTRIDGE_TYPE) {
      parsed = text.cartridge;
    } else {
      parsed = text;
    }
  } else {
    try {
      parsed = JSON.parse(String(text));
    } catch (_e) {
      return { rejected: true, reason: 'That is not valid JSON, so it cannot be read as a proof cartridge.' };
    }
  }
  if (!isPlainObject(parsed) || parsed._type !== CARTRIDGE_TYPE) {
    return { rejected: true, reason: `That JSON is not a ${CARTRIDGE_TYPE} cartridge.` };
  }
  if (typeof parsed.statement !== 'string' || !parsed.statement.trim()) {
    return { rejected: true, reason: 'The cartridge is missing its statement.' };
  }
  return { rejected: false, cartridge: parsed };
}

/**
 * Verify a cartridge's own integrity hash (recompute and compare), catching a
 * hand-edited or corrupted cartridge before it is ever re-run. This is a
 * content-hash check, not a cryptographic signature verification -- it
 * proves the cartridge has not changed since export, not who exported it.
 * @param {object} cartridge
 */
export async function verifyCartridgeHash(cartridge) {
  if (!isPlainObject(cartridge) || typeof cartridge.cartridgeHash !== 'string') {
    return { valid: false, reason: 'No cartridge hash to verify.' };
  }
  const { cartridgeHash, ...rest } = cartridge;
  const recomputed = await sha256Hex(JSON.stringify(sortDeep(rest)));
  const expected = `sha256:${recomputed}`;
  return {
    valid: expected === cartridgeHash,
    reason: expected === cartridgeHash ? 'Cartridge hash matches; unedited since export.' : 'Cartridge hash does not match its contents; it may have been edited or corrupted.',
  };
}

/**
 * Normalize importCartridge()'s call shape to a single canonical args
 * object. PROOF_HARNESS_V1_1_SPEC.md pillar A1 requires this pure module to
 * accept all three of:
 *   1. `{ cartridgeText, runQuery, compareClaimToRun? }` (v1 shape, unchanged)
 *   2. The whole `exportCartridge()` result (`{rejected:false, cartridge}`)
 *      passed AS `cartridgeText` -- parseCartridge() already unwraps that
 *      object shape, so this is really just "args.cartridgeText happens to
 *      be an exportCartridge() result object instead of a JSON string",
 *      which the existing parseCartridge() call handles without any change
 *      here; kept as an explicit, tested case rather than an accident.
 *   3. Convenience positional form: `importCartridge(cartridgeOrText, opts)`
 *      where `cartridgeOrText` is either a JSON string, an already-parsed
 *      cartridge object, or an `exportCartridge()` result, and `opts` carries
 *      `{ runQuery, compareClaimToRun? }`.
 * This function ONLY reshapes arguments; it never decides pass/fail. Never
 * throws.
 * @param {object|string} argsOrCartridge
 * @param {object} [maybeOpts]
 * @returns {{cartridgeText:*, runQuery:Function|undefined, compareClaimToRun:Function|undefined}}
 */
export function normalizeImportArgs(argsOrCartridge, maybeOpts) {
  // Form 3: positional (cartridgeOrText, opts). Distinguished from form 1/2
  // (a single plain-object args bag already carrying `cartridgeText`) by
  // checking whether a SECOND argument was actually supplied, or the first
  // argument is a bare string/already-parsed cartridge rather than an args
  // envelope with its own `cartridgeText` key.
  if (maybeOpts !== undefined || typeof argsOrCartridge === 'string' ||
      (isPlainObject(argsOrCartridge) && !Object.prototype.hasOwnProperty.call(argsOrCartridge, 'cartridgeText'))) {
    const o = isPlainObject(maybeOpts) ? maybeOpts : {};
    return {
      cartridgeText: argsOrCartridge,
      runQuery: o.runQuery,
      compareClaimToRun: o.compareClaimToRun,
    };
  }
  // Form 1/2: single args bag.
  const a = isPlainObject(argsOrCartridge) ? argsOrCartridge : {};
  return {
    cartridgeText: a.cartridgeText,
    runQuery: a.runQuery,
    compareClaimToRun: a.compareClaimToRun,
  };
}

/**
 * Import a cartridge: re-execute its statement via the caller's injected
 * `runQuery` (the importer's own live engine, on the importer's own data),
 * then compare the fresh result to the cartridge's recorded expectation
 * using the caller-supplied `compareClaimToRun`. Refuses GREEN on any
 * mismatch or hash-integrity failure, returning a precise divergence report
 * naming exactly what did not match -- never a guess, matching every other
 * proof-harness refuse-to-guess discipline.
 *
 * Accepts THREE call shapes (see normalizeImportArgs()'s doc comment):
 *   1. `importCartridge({ cartridgeText, runQuery, compareClaimToRun? })`
 *   2. `importCartridge({ cartridgeText: <exportCartridge() result>, runQuery, ... })`
 *   3. `importCartridge(cartridgeOrText, { runQuery, compareClaimToRun? })`
 * This pure module never auto-injects `compareClaimToRun` when omitted --
 * that auto-inject (never defaulting to an always-fail stub when the
 * harness owns the scorer) is the WRAPPER's job
 * (`DataGlowProofHarness.importCartridge` in index.js), since this module
 * has no import of score-claim.js's `compareClaimToRun` to fall back to
 * without breaking its own zero-dependency purity. A caller of THIS
 * function directly (e.g. a test, or a caller that truly wants no
 * comparison) that omits `compareClaimToRun` gets the existing always-fail
 * stub below, unchanged from v1.
 *
 * @param {{cartridgeText: string|object, runQuery: (sql:string) => Promise<*>,
 *          compareClaimToRun?: Function}|string|object} args cartridgeText is
 *   normally a JSON string, but parseCartridge() also tolerates an object
 *   here (e.g. exportCartridge()'s {rejected, cartridge} result passed
 *   straight through by mistake) -- see parseCartridge()'s doc comment. args
 *   itself may also be the cartridge/text directly (positional form), with
 *   `opts` as the second parameter.
 * @param {{runQuery?:Function, compareClaimToRun?:Function}} [opts] only used
 *   in the positional call form.
 * @returns {Promise<{ok:boolean, state:'GREEN'|'RED'|'GRAY', reason:string,
 *   divergence: Array<object>, cartridge?: object}>}
 */
export async function importCartridgeCore(args, opts) {
  const a = normalizeImportArgs(args, opts);
  const parsedResult = parseCartridge(a.cartridgeText);
  if (parsedResult.rejected) {
    return { ok: false, state: 'GRAY', reason: parsedResult.reason, divergence: [] };
  }
  const cartridge = parsedResult.cartridge;

  const integrity = await verifyCartridgeHash(cartridge);
  if (!integrity.valid) {
    return { ok: false, state: 'RED', reason: integrity.reason, divergence: [{ field: 'cartridgeHash', expected: cartridge.cartridgeHash, got: null }], cartridge };
  }

  if (typeof a.runQuery !== 'function') {
    return { ok: false, state: 'GRAY', reason: 'No engine available to re-run this cartridge on your own data.', divergence: [], cartridge };
  }

  let run;
  try {
    const result = await a.runQuery(cartridge.statement);
    const rowCount = Array.isArray(result && result.rows) ? result.rows.length
      : (typeof (result && result.rowCount) === 'number' ? result.rowCount : null);
    run = { status: 'ok', rowCount, scalars: {}, result, error: null };
  } catch (err) {
    return {
      ok: false,
      state: 'RED',
      reason: 'The statement could not be re-run on your data.',
      divergence: [{ field: 'run', expected: 'ok', got: err && err.message ? err.message : String(err) }],
      cartridge,
    };
  }

  const compare = typeof a.compareClaimToRun === 'function' ? a.compareClaimToRun : () => ({ pass: false, mismatches: [{ field: 'result', expected: null, got: null }] });
  const comparison = compare(cartridge.expected, run);

  if (!comparison.pass) {
    return {
      ok: false,
      state: 'RED',
      reason: 'Re-running this cartridge on your data does not reproduce what the cartridge recorded.',
      divergence: comparison.mismatches || [],
      cartridge,
    };
  }

  return { ok: true, state: 'GREEN', reason: 'Re-running this cartridge on your data reproduces what the cartridge recorded.', divergence: [], cartridge };
}

/**
 * Public importCartridge(): thin wrapper over importCartridgeCore(). Kept as
 * its own named export (rather than just an alias) so a caller that imports
 * cartridge.js directly -- e.g. an existing test -- keeps working under the
 * `importCartridge` name unchanged, while index.js/the canvas inject import
 * and call `importCartridgeCore` directly instead of binding a `Pure` alias
 * that the inject script's import-stripping would otherwise leave undefined.
 * @param {{cartridgeText: string|object, runQuery: (sql:string) => Promise<*>,
 *          compareClaimToRun?: Function}|string|object} args
 * @param {{runQuery?:Function, compareClaimToRun?:Function}} [opts]
 */
export async function importCartridge(args, opts) {
  return importCartridgeCore(args, opts);
}

export const PROOF_CARTRIDGE_TYPE = CARTRIDGE_TYPE;

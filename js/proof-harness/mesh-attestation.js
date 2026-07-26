// ============================================================
// DATAGLOW - Proof Harness v2.0: Proof Mesh attestation (PH-19 slice)
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V2_SPEC.md pillar C: two people should be able to compare
// whether they proved the SAME thing without either of them sending the
// other any rows. A mesh attestation is a small, row-free JSON document
// carrying digests + a schema fingerprint + the verdict -- enough to agree
// or diverge offline, with zero source data ever crossing the wire. This is
// explicitly the FOUNDATION slice (live WebRTC exchange over Rooms'
// `createWebRTCMesh` is residual, per the spec): export/import/compare of a
// file, not a live multi-peer session.
//
// An attestation is stricter than a Proof Cartridge (cartridge.js): a
// cartridge already carries zero rows by design but still carries the full
// statement text and expected values so an importer can RE-RUN it. A mesh
// attestation additionally forbids the raw expected/observed scalar values
// themselves from ever being required to compare -- two attestations can
// AGREE purely on digest/verdict-state equality, with the actual numbers
// only present if the caller chose to include them in `run.scalars` (never
// mandatory, and this module still refuses to import/export any row-bearing
// field regardless of what a caller supplies).
//
// PURITY: no DOM, no network. crypto.subtle only, same as every other
// proof-harness ledger/hash module (receipt.js, cartridge.js). Never throws:
// a malformed/tampered/row-bearing attestation is REJECTED with a reason,
// never silently accepted.

const MESH_ATTESTATION_TYPE = 'dataglow/proof-mesh-attestation/v1';

// Any of these keys, anywhere reachable from the top level of an
// export/import payload, means "this actually carries source data" and must
// be refused outright -- the whole point of an attestation is that it never
// needs to. Checked recursively (see containsForbiddenKey) so a caller
// cannot bury `rows` one level deeper (e.g. inside `run.rows`) and slip past
// a shallow check.
const FORBIDDEN_KEYS = Object.freeze(['rows', 'samples', 'csv', 'cells', 'sheetData']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** SHA-256 of a string, lowercase hex. Same algorithm as every other
 * proof-harness ledger/hash module (receipt.js/cartridge.js). */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Recursively sort object keys so JSON.stringify output is canonical
// regardless of insertion order, matching receipt.js's/cartridge.js's
// sortDeep exactly (restated here, not imported, for the same
// independent-inlining reason every proof-harness pure module restates it).
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
 * Recursively check whether any forbidden (row-bearing) key exists anywhere
 * in `value`'s object tree, at any depth. Array elements are also walked,
 * since a `samples` array or a nested `{rows:[...]}` a caller stuffed into
 * some other field is exactly the leak this guards against.
 * @param {*} value
 * @returns {string|null} the first forbidden key found, or null
 */
function findForbiddenKey(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.includes(key)) return key;
      const found = findForbiddenKey(value[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Build a schema fingerprint from column names + types ONLY (never values):
 * a stable, sorted string like `col1:int,col2:varchar`. Accepts either an
 * array of `{name, type}` descriptors or a plain `{name: type}` map. Never
 * throws; returns null when nothing usable is supplied, so a caller that
 * has no schema info yet does not get a fabricated fingerprint.
 * @param {Array<{name:string,type?:string}>|object|null|undefined} schema
 */
export function buildSchemaFingerprint(schema) {
  if (!schema) return null;
  const pairs = [];
  if (Array.isArray(schema)) {
    for (const col of schema) {
      if (isPlainObject(col) && typeof col.name === 'string') {
        pairs.push(`${col.name}:${typeof col.type === 'string' ? col.type : 'unknown'}`);
      } else if (typeof col === 'string') {
        pairs.push(`${col}:unknown`);
      }
    }
  } else if (isPlainObject(schema)) {
    for (const key of Object.keys(schema)) {
      pairs.push(`${key}:${typeof schema[key] === 'string' ? schema[key] : 'unknown'}`);
    }
  }
  if (pairs.length === 0) return null;
  return pairs.sort().join(',');
}

/**
 * Export a row-free proof mesh attestation from a proven cycle result
 * (the same {proposal, verdict, run, receipt} shape runProofCycle() and
 * cartridge.js's exportCartridgeCore() both accept). Carries ONLY: type,
 * version, createdAt, the proposal's digest, the statement text (text only,
 * never row values), expected, verdict state/reasonCode, the receipt hash,
 * environment, schemaFingerprint, and inputDigest.
 *
 * Refuses (returns {rejected:true, reason}) when:
 *   - there is no proposal/statement to attest to
 *   - the caller (accidentally or otherwise) supplied a forbidden row-bearing
 *     field anywhere in `run` or elsewhere in the args -- this is the one
 *     export path where a caller mistake must never produce a document that
 *     LOOKS row-free but silently is not.
 *
 * @param {{proposal:object, verdict:{state:string, reasonCode?:string},
 *          run?:object, receipt?:{hash?:string}, schemaFingerprint?:string,
 *          datasetNameHash?:string, environment?:object}} args
 * @returns {Promise<{rejected:true, reason:string} | {rejected:false, attestation:object}>}
 */
export async function exportMeshAttestation(args) {
  const a = isPlainObject(args) ? args : {};
  const proposal = a.proposal;
  const verdict = a.verdict;

  if (!isPlainObject(proposal) || typeof proposal.statement !== 'string' || !proposal.statement.trim()) {
    return { rejected: true, reason: 'A proposal with a statement is required to export a mesh attestation.' };
  }
  if (!isPlainObject(verdict) || typeof verdict.state !== 'string') {
    return { rejected: true, reason: 'A verdict is required to export a mesh attestation.' };
  }

  const forbidden = findForbiddenKey(a);
  if (forbidden) {
    return { rejected: true, reason: `Refusing to export: the input carries a "${forbidden}" field. A mesh attestation is row-free by design.` };
  }

  // inputDigest: a hash of column names+types only (schemaFingerprint), or
  // the caller's own dataset fileHash if one was supplied -- either way,
  // never a hash over actual cell values.
  const schemaFingerprint = typeof a.schemaFingerprint === 'string' && a.schemaFingerprint.trim()
    ? a.schemaFingerprint.trim()
    : buildSchemaFingerprint(a.schema);
  const inputDigestSource = typeof a.datasetNameHash === 'string' && a.datasetNameHash.trim()
    ? a.datasetNameHash.trim()
    : (schemaFingerprint || '');
  const inputDigest = inputDigestSource ? await sha256Hex(inputDigestSource) : null;

  const payload = {
    _type: MESH_ATTESTATION_TYPE,
    version: 1,
    createdAt: new Date().toISOString(),
    proposalDigest: proposal.digest || null,
    statement: proposal.statement,
    engine: proposal.engine || 'duckdb',
    expected: isPlainObject(proposal.expected) ? proposal.expected : {},
    verdict: { state: verdict.state, reasonCode: verdict.reasonCode || null },
    receiptHash: a.receipt && typeof a.receipt.hash === 'string' ? a.receipt.hash : null,
    environment: isPlainObject(a.environment) ? a.environment : {},
    schemaFingerprint: schemaFingerprint || null,
    inputDigest,
  };

  const hash = await sha256Hex(JSON.stringify(sortDeep(payload)));
  return { rejected: false, attestation: { ...payload, attestationHash: `sha256:${hash}` } };
}

/**
 * Import (parse + validate) a mesh attestation from a JSON string or an
 * already-parsed object (also tolerating exportMeshAttestation()'s own
 * `{rejected:false, attestation}` result passed straight through, same
 * unwrap convenience as cartridge.js's parseCartridge). REJECTS outright if
 * any forbidden row-bearing key is present anywhere in the parsed document,
 * regardless of where it was hidden -- an attestation that carries rows is
 * not a bug to route around, it is refused entirely.
 *
 * Never throws.
 * @param {string|object} raw
 * @returns {{rejected:true, reason:string} | {rejected:false, attestation:object}}
 */
export function importMeshAttestation(raw) {
  let parsed;
  if (isPlainObject(raw)) {
    if (isPlainObject(raw.attestation) && raw.attestation._type === MESH_ATTESTATION_TYPE) {
      parsed = raw.attestation;
    } else {
      parsed = raw;
    }
  } else {
    try {
      parsed = JSON.parse(String(raw));
    } catch (_e) {
      return { rejected: true, reason: 'That is not valid JSON, so it cannot be read as a mesh attestation.' };
    }
  }

  if (!isPlainObject(parsed) || parsed._type !== MESH_ATTESTATION_TYPE) {
    return { rejected: true, reason: `That JSON is not a ${MESH_ATTESTATION_TYPE} attestation.` };
  }

  const forbidden = findForbiddenKey(parsed);
  if (forbidden) {
    return { rejected: true, reason: `Refusing to import: this attestation carries a "${forbidden}" field. A mesh attestation must be row-free.` };
  }

  if (typeof parsed.statement !== 'string' || !parsed.statement.trim()) {
    return { rejected: true, reason: 'The attestation is missing its statement.' };
  }
  if (!isPlainObject(parsed.verdict) || typeof parsed.verdict.state !== 'string') {
    return { rejected: true, reason: 'The attestation is missing its verdict state.' };
  }

  return { rejected: false, attestation: parsed };
}

/**
 * Verify a mesh attestation's own content hash (recompute and compare),
 * catching a hand-edited or corrupted attestation before it is compared
 * against another. Content-hash check, not a cryptographic signature by a
 * private key -- proves the attestation has not changed since export, not
 * who exported it (same honest framing as cartridge.js's verifyCartridgeHash).
 * @param {object} attestation
 */
export async function verifyMeshAttestationHash(attestation) {
  if (!isPlainObject(attestation) || typeof attestation.attestationHash !== 'string') {
    return { valid: false, reason: 'No attestation hash to verify.' };
  }
  const { attestationHash, ...rest } = attestation;
  const recomputed = await sha256Hex(JSON.stringify(sortDeep(rest)));
  const expected = `sha256:${recomputed}`;
  return {
    valid: expected === attestationHash,
    reason: expected === attestationHash ? 'Attestation hash matches; unedited since export.' : 'Attestation hash does not match its contents; it may have been edited or corrupted.',
  };
}

/**
 * Compare two mesh attestations. Agreement requires EITHER:
 *   a) both `proposalDigest`s match (same executable claim, byte for byte), OR
 *   b) both `statement` (trimmed) and `expected` (deep-equal) match,
 * AND, in either case, both `verdict.state`s match.
 * Any other case lists every divergent field by name -- definition
 * (statement/expected/proposalDigest), input (schemaFingerprint/inputDigest),
 * or verdict (verdict.state) -- never a bare "these disagree" with no detail,
 * matching every other proof-harness refuse-to-guess discipline.
 *
 * Never throws.
 * @param {object} a
 * @param {object} b
 * @returns {{agree:boolean, divergences: Array<{field:string, a:*, b:*}>}}
 */
export function compareMeshAttestations(a, b) {
  const x = isPlainObject(a) ? a : {};
  const y = isPlainObject(b) ? b : {};
  const divergences = [];

  const xDigest = typeof x.proposalDigest === 'string' ? x.proposalDigest : null;
  const yDigest = typeof y.proposalDigest === 'string' ? y.proposalDigest : null;
  const digestsMatch = xDigest !== null && yDigest !== null && xDigest === yDigest;

  const xStatement = typeof x.statement === 'string' ? x.statement.trim() : '';
  const yStatement = typeof y.statement === 'string' ? y.statement.trim() : '';
  const statementsMatch = xStatement !== '' && xStatement === yStatement;

  const xExpected = JSON.stringify(sortDeep(isPlainObject(x.expected) ? x.expected : {}));
  const yExpected = JSON.stringify(sortDeep(isPlainObject(y.expected) ? y.expected : {}));
  const expectedMatch = xExpected === yExpected;

  const definitionAgrees = digestsMatch || (statementsMatch && expectedMatch);
  if (!definitionAgrees) {
    if (!digestsMatch) divergences.push({ field: 'proposalDigest', a: xDigest, b: yDigest });
    if (!statementsMatch) divergences.push({ field: 'statement', a: x.statement || null, b: y.statement || null });
    if (!expectedMatch) divergences.push({ field: 'expected', a: isPlainObject(x.expected) ? x.expected : {}, b: isPlainObject(y.expected) ? y.expected : {} });
  }

  const xVerdictState = isPlainObject(x.verdict) ? x.verdict.state : null;
  const yVerdictState = isPlainObject(y.verdict) ? y.verdict.state : null;
  const verdictAgrees = xVerdictState !== null && xVerdictState === yVerdictState;
  if (!verdictAgrees) {
    divergences.push({ field: 'verdict.state', a: xVerdictState, b: yVerdictState });
  }

  // Input digest / schema fingerprint divergence is reported ADDITIONALLY
  // (never gates `agree` on its own) when both sides actually supplied one
  // and they differ -- two devices proving the SAME definition against
  // DIFFERENT underlying data is worth surfacing, but is not by itself a
  // disagreement about the claim or the verdict.
  if (typeof x.inputDigest === 'string' && typeof y.inputDigest === 'string' && x.inputDigest !== y.inputDigest) {
    divergences.push({ field: 'inputDigest', a: x.inputDigest, b: y.inputDigest });
  }
  if (typeof x.schemaFingerprint === 'string' && typeof y.schemaFingerprint === 'string' && x.schemaFingerprint !== y.schemaFingerprint) {
    divergences.push({ field: 'schemaFingerprint', a: x.schemaFingerprint, b: y.schemaFingerprint });
  }

  return {
    agree: definitionAgrees && verdictAgrees,
    divergences,
  };
}

export const PROOF_MESH_ATTESTATION_TYPE = MESH_ATTESTATION_TYPE;
export const MESH_ATTESTATION_FORBIDDEN_KEYS = FORBIDDEN_KEYS;

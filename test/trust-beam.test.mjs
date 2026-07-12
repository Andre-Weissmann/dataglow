// ============================================================
// DATAGLOW — Trust Beam unit tests
// ============================================================
// Exercises the pure serializer (js/provenance/trust-beam.js) that turns an
// existing Verifiable Check Seal into a self-contained, URL-fragment-safe link a
// recipient with ZERO DataGlow install can re-verify in any browser. NO browser,
// NO network, NO DuckDB: crypto.subtle is available in modern Node, so the real
// seal (from js/provenance/verifiable-check-seal.js) is minted and the real
// verifySeal() runs unchanged. It covers:
//   • encode → decode round-trip fidelity (byte-for-byte seal reproduction),
//   • a TAMPERED beam payload FAILS re-verification (genuine tamper detection via
//     the existing verifySeal — not just a re-labelled string),
//   • buildBeamUrl produces a well-formed URL whose fragment carries the payload,
//   • a zero-upload source guard (no network primitive in the module).
//
// RUN WITH:  node test/trust-beam.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeBeam,
  decodeBeam,
  buildBeamUrl,
  readBeamPayloadFromFragment,
  BEAM_KIND,
  BEAM_VERSION,
  BEAM_FRAGMENT_KEY,
  BEAM_DISCLAIMER,
} from '../js/provenance/trust-beam.js';
import {
  sealCheckResult,
  verifySeal,
  CHECK_SEAL_KIND,
} from '../js/provenance/verifiable-check-seal.js';
import { runAnalysisContract } from '../js/validation/analysis-contract.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function sampleRows() {
  return [
    { id: 1, customer_id: 10, amount: 5.0, is_test: false },
    { id: 2, customer_id: 10, amount: 7.5, is_test: false },
    { id: 3, customer_id: 11, amount: 2.0, is_test: true },
  ];
}

const sampleSchema = {
  tables: {
    orders: {
      columns: [{ name: 'id' }, { name: 'customer_id' }, { name: 'amount' }, { name: 'is_test' }],
      rowCount: 3,
      approxDistinct: {},
    },
  },
};

async function makeSeal() {
  const report = runAnalysisContract('SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id', sampleSchema);
  return sealCheckResult(report, {
    check: { name: 'Local Analysis Contract', kind: 'local-analysis-contract' },
    params: 'SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id',
    dataset: { name: 'Orders', rowCount: 3, columnNames: ['id', 'customer_id', 'amount', 'is_test'] },
    data: sampleRows(),
    generatedAt: '2026-07-12T00:00:00.000Z',
    dataglow: { version: 'test', build: 'unit' },
  });
}

async function main() {
  const seal = await makeSeal();

  // --- 1. encode/decode round-trip fidelity ---------------------------------
  {
    const payload = encodeBeam(seal);
    ok(typeof payload === 'string' && payload.length > 0, 'encodeBeam returns a non-empty string');
    ok(/^[A-Za-z0-9\-_]+$/.test(payload), 'beam payload is URL-safe base64url (no +, /, =, or reserved chars)');

    const decoded = decodeBeam(payload);
    ok(decoded.kind === CHECK_SEAL_KIND, 'decoded artifact is a Verifiable Check Seal');
    // Byte-for-byte fidelity: the seal survives the round-trip losslessly.
    ok(JSON.stringify(decoded) === JSON.stringify(seal), 'decodeBeam reproduces the original seal byte-for-byte');
    ok(decoded.commitment.merkleRoot === seal.commitment.merkleRoot, 'committed Merkle root survives the round-trip');
    ok(decoded.disclosedClaims.length === seal.disclosedClaims.length, 'all disclosed claims survive the round-trip');

    // A round-tripped seal still verifies with the EXISTING verifySeal (commitment layer).
    const v = await verifySeal(decoded);
    ok(v.valid === true && v.commitmentValid === true, 'a decoded seal re-verifies (commitment intact)');

    // And still detects matching vs modified data through the beam.
    const vMatch = await verifySeal(decoded, sampleRows());
    ok(vMatch.valid === true && vMatch.dataMatch === true, 'decoded seal matches the original data');
  }

  // --- 2. Unicode fidelity (statements/disclaimer carry em-dashes/ellipses) --
  {
    const decoded = decodeBeam(encodeBeam(seal));
    ok(decoded.disclaimer === seal.disclaimer, 'non-ASCII disclaimer text survives UTF-8 round-trip intact');
    const df = decoded.disclosedClaims.find(c => c.type === 'data_fingerprint');
    const of = seal.disclosedClaims.find(c => c.type === 'data_fingerprint');
    ok(df.statement === of.statement, 'claim statements with … survive the round-trip');
  }

  // --- 3. A TAMPERED beam payload FAILS re-verification (the key property) ---
  {
    // Decode, silently flip a sealed result value, re-encode into a new beam — a
    // realistic "attacker edits the shared link" scenario. The commitment must break.
    const decoded = decodeBeam(encodeBeam(seal));
    const statusClaim = decoded.disclosedClaims.find(c => c.type === 'result_status');
    statusClaim.value = 'pass-but-actually-tampered';
    const tamperedPayload = encodeBeam(decoded);
    const reDecoded = decodeBeam(tamperedPayload);
    const v = await verifySeal(reDecoded);
    ok(v.commitmentValid === false, 'TAMPER DETECTED: an altered claim breaks the commitment through the beam');
    ok(v.valid === false, 'a tampered beam is INVALID');
    ok(v.claims.some(c => !c.valid), 'the tampered claim is reported as a non-member of the committed set');
  }

  // --- 4. A corrupted payload string is rejected cleanly --------------------
  {
    let threw = false;
    try { decodeBeam('not*valid*base64url!!'); } catch { threw = true; }
    ok(threw, 'decodeBeam rejects a non-base64url string');

    let threw2 = false;
    try { decodeBeam(''); } catch { threw2 = true; }
    ok(threw2, 'decodeBeam rejects an empty payload');

    // Valid base64url but wrong contents (not a beam envelope) is rejected.
    let threw3 = false;
    try { decodeBeam(encodeBeamRaw({ hello: 'world' })); } catch { threw3 = true; }
    ok(threw3, 'decodeBeam rejects a valid-base64url payload that is not a beam envelope');
  }

  // --- 5. encodeBeam refuses a non-seal input -------------------------------
  {
    let threw = false;
    try { encodeBeam({ kind: 'something-else' }); } catch { threw = true; }
    ok(threw, 'encodeBeam refuses to wrap a non-seal object');
  }

  // --- 6. buildBeamUrl produces a well-formed URL ---------------------------
  {
    const base = 'https://example.org/app/verify-beam.html';
    const url = buildBeamUrl(seal, base);
    ok(url.startsWith(base + '#' + BEAM_FRAGMENT_KEY + '='), 'buildBeamUrl puts the payload in a named URL fragment');
    // It must parse as a real URL and keep the payload in the fragment, not the query.
    const parsed = new URL(url);
    ok(parsed.origin === 'https://example.org' && parsed.pathname === '/app/verify-beam.html',
      'buildBeamUrl preserves the base origin and path');
    ok(parsed.search === '', 'buildBeamUrl keeps the payload out of the query string (nothing sent to a server)');
    ok(parsed.hash.length > 1, 'buildBeamUrl carries the whole seal in the fragment');

    // The fragment round-trips back to the original seal.
    const payload = readBeamPayloadFromFragment(parsed.hash);
    ok(payload != null, 'readBeamPayloadFromFragment extracts the payload from the fragment');
    ok(JSON.stringify(decodeBeam(payload)) === JSON.stringify(seal), 'the URL fragment decodes back to the original seal');

    // An existing fragment on the base URL is replaced, not duplicated.
    const url2 = buildBeamUrl(seal, base + '#stale');
    ok((url2.match(/#/g) || []).length === 1, 'buildBeamUrl replaces any pre-existing fragment (single "#")');

    // A missing/empty base URL is rejected.
    let threw = false;
    try { buildBeamUrl(seal, ''); } catch { threw = true; }
    ok(threw, 'buildBeamUrl rejects an empty base URL');
  }

  // --- 7. readBeamPayloadFromFragment tolerance -----------------------------
  {
    ok(readBeamPayloadFromFragment('#beam=abc') === 'abc', 'reads beam= from a hash with leading #');
    ok(readBeamPayloadFromFragment('beam=abc') === 'abc', 'reads beam= without a leading #');
    ok(readBeamPayloadFromFragment('abc') === 'abc', 'treats a bare fragment as the raw payload');
    ok(readBeamPayloadFromFragment('') === null, 'returns null for an empty fragment');
    ok(readBeamPayloadFromFragment('#') === null, 'returns null for a bare #');
    ok(readBeamPayloadFromFragment(null) === null, 'returns null for a non-string');
  }

  // --- 8. Envelope carries the honest disclaimer/markers --------------------
  {
    ok(BEAM_KIND === 'dataglow-trust-beam' && BEAM_VERSION === 1, 'stable kind/version constants');
    ok(/NOT a zero-knowledge proof/i.test(BEAM_DISCLAIMER), 'beam disclaimer states it is NOT a zero-knowledge proof');
    ok(/NOT that the underlying data is accurate|not that the data/i.test(BEAM_DISCLAIMER) || /NOT.*accurate/i.test(BEAM_DISCLAIMER),
      'beam disclaimer states it does not attest data accuracy');
    ok(/never sent anywhere|no upload/i.test(BEAM_DISCLAIMER), 'beam disclaimer states the fragment is never uploaded');
  }

  // --- 9. Zero-upload source guard ------------------------------------------
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/;
    const src = readFileSync(join(here, '..', 'js', 'provenance', 'trust-beam.js'), 'utf8');
    ok(!netRe.test(src), 'zero-upload: js/provenance/trust-beam.js contains no network primitive');
    // Honest naming: forbidden overclaim terms may appear only in a disclaiming line.
    const forbidden = ['zero-knowledge', 'zkp', 'blockchain', 'certified'];
    const lines = src.split('\n');
    for (const term of forbidden) {
      const offending = lines.filter(l =>
        new RegExp(`\\b${term}\\b`, 'i').test(l) && !/\b(not|never|avoid|no|isn't|nor)\b/i.test(l));
      ok(offending.length === 0, `honest-naming: "${term}" only ever appears in a disclaiming line`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// Helper for test 4: produce a valid base64url string whose decoded JSON is NOT a
// beam envelope, without going through encodeBeam's seal guard. Mirrors the
// module's own base64url encoding so the payload is genuinely well-formed.
function encodeBeamRaw(obj) {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const t = (b0 << 16) | (b1 << 8) | b2;
    out += B[(t >> 18) & 63] + B[(t >> 12) & 63];
    if (i + 1 < bytes.length) out += B[(t >> 6) & 63];
    if (i + 2 < bytes.length) out += B[t & 63];
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });

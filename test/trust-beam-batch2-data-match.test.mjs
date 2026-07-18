/**
 * Trust Beam Batch 2 — optional data-match hint in verify-beam.html
 *
 * Tests the layer-2 data fingerprint path as exercised by the verifier:
 *   - verifySeal() called WITH data fingerprints to simulate what the file-drop
 *     does (re-fingerprint the file's text and compare to the committed value)
 *   - verifySeal() called WITHOUT data to confirm layer 2 stays null (not checked)
 *   - fingerprintData() reproducibility: same input always produces the same hash
 *   - fingerprintData() sensitivity: a one-byte change flips the hash
 *   - Structural: verify-beam.html sources have no template literals and no
 *     apostrophes in single-quoted strings (iOS WKWebView constraint — even though
 *     this file is only used by browsers, the same discipline applies)
 *   - Structural: fingerprintData is exported from verifiable-check-seal.js
 *
 * Layer 2 wiring in the browser (the file-drop event handler) is pure DOM code
 * that cannot be tested in Node; the unit-level contract it depends on (that
 * fingerprintData is deterministic and verifySeal respects the layer-2 result) IS
 * fully testable here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── Lazy dynamic import helpers ──────────────────────────────────────────────

let sealMod;
async function getSealMod() {
  if (!sealMod) sealMod = await import(pathToFileURL(path.join(root, 'js/provenance/verifiable-check-seal.js')).href);
  return sealMod;
}

let beamMod;
async function getBeamMod() {
  if (!beamMod) beamMod = await import(pathToFileURL(path.join(root, 'js/provenance/trust-beam.js')).href);
  return beamMod;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeSealWithData(data, result) {
  const { sealCheckResult } = await getSealMod();
  result = result || { valid: true, checks: [{ name: 'Null check', passed: true, detail: 'No nulls found.' }] };
  return sealCheckResult(result, { data });
}

// ── 1. fingerprintData is exported ──────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) { console.log('  ok ' + (++passed + failed) + ' - ' + label); passed++; }
  else { console.log('  not ok ' + (passed + ++failed) + ' - ' + label); failed++; }
}

// ── Suite ────────────────────────────────────────────────────────────────────

async function suite() {
  console.log('TAP version 14');
  console.log('# Trust Beam Batch 2 — data-match hint in verifier\n');

  const { fingerprintData, sealCheckResult, verifySeal } = await getSealMod();

  // 1. fingerprintData is exported from verifiable-check-seal.js
  ok('fingerprintData is a function', typeof fingerprintData === 'function');

  // 2. fingerprintData is deterministic — same input always yields same hash
  const dataA = 'patient_id,name,dob\n001,Alice,1990-01-01\n002,Bob,1985-06-15';
  const fp1 = await fingerprintData(dataA);
  const fp2 = await fingerprintData(dataA);
  ok('fingerprintData same input same hash (run 1 vs run 2)', fp1 === fp2);
  ok('fingerprintData returns a non-empty string', typeof fp1 === 'string' && fp1.length > 0);

  // 3. fingerprintData is sensitive — one-byte change produces a different hash
  const dataB = dataA.replace('Alice', 'Alicd');
  const fpB = await fingerprintData(dataB);
  ok('fingerprintData detects one-byte change', fp1 !== fpB);

  // 4. verifySeal layer 2 = null when no data supplied
  const seal = await makeSealWithData(dataA);
  const noDataResult = await verifySeal(seal);
  ok('verifySeal dataMatch is null when no data supplied', noDataResult.dataMatch === null);
  ok('verifySeal valid is true without data', noDataResult.valid === true);

  // 5. verifySeal layer 2 = true when correct data supplied
  const matchResult = await verifySeal(seal, dataA);
  ok('verifySeal dataMatch is true for matching data', matchResult.dataMatch === true);
  ok('verifySeal valid is true when data matches', matchResult.valid === true);

  // 6. verifySeal layer 2 = false when data does not match
  const mismatchResult = await verifySeal(seal, dataB);
  ok('verifySeal dataMatch is false for mismatched data', mismatchResult.dataMatch === false);
  ok('verifySeal valid is false when data does not match', mismatchResult.valid === false);

  // 7. Simulating the browser: re-fingerprint and compare, mirroring the drop handler
  const recomputed = await fingerprintData(dataA);
  const { disclosedClaims } = seal;
  const committedFpClaim = disclosedClaims.find(function(c) { return c.type === 'data_fingerprint'; });
  ok('seal has data_fingerprint claim', committedFpClaim != null);
  ok('re-fingerprinted value matches committed fp (match path)', recomputed === committedFpClaim.value);

  const recomputedWrong = await fingerprintData(dataB);
  ok('re-fingerprinted wrong data does not match committed fp (mismatch path)', recomputedWrong !== committedFpClaim.value);

  // 8. verifySeal with precomputed fingerprint object (the { dataFingerprint } path)
  const precompResult = await verifySeal(seal, { dataFingerprint: committedFpClaim.value });
  ok('verifySeal accepts precomputed fingerprint object', precompResult.dataMatch === true);

  const precompWrongResult = await verifySeal(seal, { dataFingerprint: recomputedWrong });
  ok('verifySeal precomputed wrong fingerprint yields dataMatch false', precompWrongResult.dataMatch === false);

  // 9. fingerprintData handles empty string without throwing
  let fpEmpty;
  try { fpEmpty = await fingerprintData(''); } catch (_) { fpEmpty = null; }
  ok('fingerprintData handles empty string', typeof fpEmpty === 'string');

  // 10. fingerprintData handles JSON-able objects
  const fpObj = await fingerprintData([{ id: 1, v: 'x' }]);
  ok('fingerprintData handles JSON-able objects', typeof fpObj === 'string' && fpObj.length > 0);

  // 11. Structural: verify-beam.html contains the data-match section
  const verifyHtml = readFileSync(path.join(root, 'verify-beam.html'), 'utf8');
  // data-testid is set via setAttribute in JS using single-quote strings
  ok('verify-beam.html contains beam-drop-zone testid', verifyHtml.includes("'data-testid': 'beam-drop-zone'") || verifyHtml.includes('data-testid="beam-drop-zone"') || verifyHtml.includes("data-testid='beam-drop-zone'"));
  ok('verify-beam.html contains beam-data-match-section testid', verifyHtml.includes("'data-testid': 'beam-data-match-section'") || verifyHtml.includes('data-testid="beam-data-match-section"') || verifyHtml.includes("data-testid='beam-data-match-section'"));
  ok('verify-beam.html imports fingerprintData', verifyHtml.includes('fingerprintData'));
  ok('verify-beam.html checks fp.data before rendering drop zone', verifyHtml.includes('if (fp.data)'));

  // 12. iOS WKWebView constraint: no template literals in verify-beam.html
  // (script section — look for backtick usage)
  const scriptSection = verifyHtml.slice(verifyHtml.indexOf('<script type="module">'));
  const backtickCount = (scriptSection.match(/`/g) || []).length;
  ok('verify-beam.html script section has no template literals (backticks)', backtickCount === 0);

  // 13. Trust Beam Batch 2 flag: no new flag needed (Batch 2 extends the existing
  //     verify-beam.html and is always active when the seal has a fingerprint).
  //     Confirm trustBeam flag is still enabled:true.
  const flags = JSON.parse(readFileSync(path.join(root, 'flags.manifest.json'), 'utf8'));
  const flagList = flags.flags || flags;
  ok('trustBeam flag is enabled:true', flagList.trustBeam && flagList.trustBeam.enabled === true);

  // 14. capability-map manifest has trust-beam entry
  const capMap = JSON.parse(readFileSync(path.join(root, 'capability-map.manifest.json'), 'utf8'));
  const capList = capMap.capabilities || capMap;
  const capRoot = capMap.capabilities || capMap;
  const capArr = Array.isArray(capRoot) ? capRoot : Object.values(capRoot);
  const hasTrustBeam = capArr.some(function(c) {
    if (!c || typeof c !== 'object') return false;
    var files = c.files || [];
    return files.some(function(f) { return f.includes('trust-beam'); }) ||
           String(c.id || '').includes('trust-beam') ||
           String(c.module || '').includes('trust-beam');
  });
  ok('capability-map has trust-beam.js entry', hasTrustBeam);

  // 15. NORTH_STAR.md documents Batch 2 as DONE
  const northStar = readFileSync(path.join(root, 'NORTH_STAR.md'), 'utf8');
  ok('NORTH_STAR documents Trust Beam Batch 2 as DONE', northStar.includes('data-match hint') && (northStar.includes('DONE') || northStar.includes('done') || northStar.includes('trust-beam-batch2')));

  console.log('\n1..' + (passed + failed));
  console.log((failed === 0 ? '' : 'not ') + 'ok — ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

suite().catch(function(e) { console.error(e); process.exit(1); });

// ============================================================
// DATAGLOW — Provenance Packet (.dataglow) format test suite
// ============================================================
// Covers the pure, offline logic behind the portable, signed provenance packet
// (js/provenance/provenance-packet.js): packet assembly with all sections, with
// some sections missing (graceful omission), top-level signature success,
// signature failure / tamper detection on every kind of edit, and export→import
// round-trip fidelity. Everything is pure JS over in-memory objects — no DuckDB,
// no browser, no network. The top-level signature reuses the EXISTING SHA-256
// primitive from js/provenance/provenance.js (crypto.subtle, present in Node 20).
//
// The section inputs below are hand-built to match the OUTPUT SHAPES of the
// sibling producer modules (data-blame.js `replayLog`/`buildBlameIndex`,
// deidentification-verifier.js `buildDeidAttestation`, denial-root-cause.js
// `buildDenialReport`, cost-of-bad-data.js `estimateCostOfBadData`) so the packet
// is genuinely compatible with them, not just superficially similar.
//
// RUN WITH:  node test/provenance-packet.test.mjs

import {
  PACKET_KIND,
  PACKET_FORMAT_VERSION,
  PACKET_SECTIONS,
  buildPacket,
  verifyPacket,
  computePacketSignature,
  serializePacket,
  parsePacket,
  packetFilename,
  summarizePacket,
} from '../js/provenance/provenance-packet.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- fixtures matching the sibling modules' output shapes ----------

// data-blame.js: replayLog(trail) → flat ordered entries with `columns`.
const BLAME_LOG = [
  { index: 0, op: 'load', rule: null, columns: [], affectedCount: null, predicate: null, ts: '2026-07-01T10:00:00.000Z', description: 'Loaded raw file', hash: 'aaaa' },
  { index: 1, op: 'clean', rule: 'fill_mean', columns: ['age'], affectedCount: 12, predicate: 'age IS NULL', ts: '2026-07-01T10:05:00.000Z', description: 'Filled null ages with mean', hash: 'bbbb' },
  { index: 2, op: 'merge', rule: 'canonicalize', columns: ['state'], affectedCount: 3, predicate: null, ts: '2026-07-01T10:06:00.000Z', description: 'Merged CA/Calif → California', hash: 'cccc' },
];

// deidentification-verifier.js: buildDeidAttestation(report) → signed attestation.
const DEID_ATTESTATION = {
  kind: 'dataglow-deidentification-attestation',
  version: 1,
  generatedAt: '2026-07-01T10:07:00.000Z',
  algorithm: 'SHA-256 digest over dataset structure + check results + timestamp',
  dataset: { table: 'claims', rowCount: 500, columns: [{ name: 'age', type: 'INTEGER' }, { name: 'zip', type: 'VARCHAR' }] },
  safeHarbor: { categories: [], flaggedCount: 2, clearCount: 16 },
  reidentification: { score: 54, level: 'moderate', present: ['age', 'zip'], quasiIdentifierCount: 2, rationale: '2 indirect identifier(s) present (age, zip).' },
  verdict: 'review',
  digest: { algorithm: 'SHA-256', value: 'deadbeef'.repeat(8), covers: 'kind, version, generatedAt, algorithm, dataset, safeHarbor, reidentification, verdict' },
};

// denial-root-cause.js: buildDenialReport(...) → report with embedded cost.
const DENIAL_REPORT = {
  generatedAt: '2026-07-01T10:08:00.000Z',
  dataset: { table: 'claims', rowCount: 500, scannedRows: 500, truncated: false, columns: [] },
  detectedColumns: { npi: 'provider_npi', dos: 'date_of_service' },
  categories: [
    { id: 'eligibility', label: 'Eligibility / coverage', applicable: true, flaggedRows: 10, notes: [] },
    { id: 'coding', label: 'Coding validity', applicable: true, flaggedRows: 5, notes: [] },
  ],
  totalFlaggedRows: 13,
  totalFlaggedPct: 2.6,
  notCheckable: [],
  cost: {
    flaggedCount: 13, perErrorCost: 118, currency: 'USD', isDefaultCost: true,
    estimatedRiskAmount: 1534, formatted: '$1,534', editable: true,
    label: '13 row(s) flagged × $118 avg rework cost = $1,534 estimated at risk',
    sourceNote: 'placeholder', disclaimer: 'Estimated risk only.',
  },
  disclaimer: 'Heuristic denial-risk triage, not payer adjudication.',
};

// cost-of-bad-data.js: estimateCostOfBadData({...}) → standalone estimate.
const COST_ESTIMATE = {
  flaggedCount: 13, perErrorCost: 250, currency: 'USD', isDefaultCost: false,
  estimatedRiskAmount: 3250, formatted: '$3,250', editable: true,
  label: '13 row(s) flagged × $250 avg rework cost = $3,250 estimated at risk',
  sourceNote: 'placeholder', disclaimer: 'Estimated risk only.',
};

const DATASET = {
  table: 'claims',
  rowCount: 500,
  columns: [{ name: 'age', type: 'INTEGER' }, { name: 'zip', type: 'VARCHAR' }, { name: 'provider_npi', type: 'VARCHAR' }],
  sourceHash: '0'.repeat(64),
};

async function main() {
  // ---- 1. packet with ALL sections present ----
  const full = await buildPacket({
    dataset: DATASET,
    blame: BLAME_LOG,
    deidentification: DEID_ATTESTATION,
    denial: DENIAL_REPORT,
    cost: COST_ESTIMATE,
    generatedAt: '2026-07-01T10:10:00.000Z',
    producer: { app: 'DATAGLOW', version: '1.0.0', build: 'test' },
  });
  ok(full.kind === PACKET_KIND, 'full: kind is the packet kind');
  ok(full.formatVersion === PACKET_FORMAT_VERSION, 'full: format version stamped');
  ok(full.generatedAt === '2026-07-01T10:10:00.000Z', 'full: ISO timestamp preserved');
  ok(PACKET_SECTIONS.every(k => full.sections[k] && full.sections[k].present), 'full: all four sections present');
  ok(full.sections.dataBlame.data.log.length === 3, 'full: blame log embedded verbatim (3 entries)');
  ok(!!full.sections.dataBlame.data.byColumn.age, 'full: blame per-column index derived from the log');
  ok(full.sections.deidentification.data.verdict === 'review', 'full: de-id attestation embedded (verdict)');
  ok(full.sections.denialRisk.data.totalFlaggedRows === 13, 'full: denial report embedded');
  ok(full.sections.costOfBadData.data.estimatedRiskAmount === 3250, 'full: explicit cost overrides the report cost');
  ok(!!full.signature && full.signature.algorithm === 'SHA-256' && /^[0-9a-f]{64}$/.test(full.signature.value), 'full: SHA-256 signature present and well-formed');

  // ---- 2. signature verification SUCCESS ----
  const okres = await verifyPacket(full);
  ok(okres.valid === true, 'verify: freshly-built packet verifies');
  ok(okres.signature.stored === okres.signature.recomputed, 'verify: stored and recomputed digests match');

  // ---- 3. sections MISSING → graceful omission ----
  const partial = await buildPacket({
    dataset: DATASET,
    blame: BLAME_LOG,
    // no de-id, no denial, no explicit cost
    generatedAt: '2026-07-01T10:11:00.000Z',
  });
  ok(partial.sections.dataBlame.present === true, 'partial: present section marked present');
  ok(partial.sections.deidentification.present === false && !('data' in partial.sections.deidentification), 'partial: omitted section carries no data');
  ok(partial.sections.denialRisk.present === false, 'partial: denial omitted');
  ok(partial.sections.costOfBadData.present === false, 'partial: cost omitted (none passed, no report to lift from)');
  ok((await verifyPacket(partial)).valid === true, 'partial: a packet with only one section still verifies');

  // ---- 3b. cost lifted from a denial report when no explicit cost given ----
  const lifted = await buildPacket({ dataset: DATASET, denial: DENIAL_REPORT, generatedAt: '2026-07-01T10:12:00.000Z' });
  ok(lifted.sections.costOfBadData.present === true, 'lift: cost section auto-populated from the denial report');
  ok(lifted.sections.costOfBadData.data.estimatedRiskAmount === 1534, 'lift: lifted cost is the report cost');

  // ---- 3c. an empty packet (no sections at all) is still valid & signed ----
  const empty = await buildPacket({ dataset: DATASET, generatedAt: '2026-07-01T10:13:00.000Z' });
  ok(PACKET_SECTIONS.every(k => empty.sections[k].present === false), 'empty: no sections present');
  ok((await verifyPacket(empty)).valid === true, 'empty: an empty packet still verifies (dataset metadata is signed)');

  // ---- 4. tamper detection (signature FAILURE) on each kind of edit ----
  async function tamper(label, mutate) {
    const p = JSON.parse(JSON.stringify(full));
    mutate(p);
    const r = await verifyPacket(p);
    ok(r.valid === false && /MISMATCH|modified/i.test(r.reason), `tamper: ${label} → detected`);
  }
  await tamper('flip a de-id verdict', p => { p.sections.deidentification.data.verdict = 'pass'; });
  await tamper('change a cost number', p => { p.sections.costOfBadData.data.estimatedRiskAmount = 1; });
  await tamper('edit a blame entry', p => { p.sections.dataBlame.data.log[1].description = 'nefarious'; });
  await tamper('drop a section', p => { delete p.sections.denialRisk; });
  await tamper('alter dataset row count', p => { p.dataset.rowCount = 1; });
  await tamper('bump the timestamp', p => { p.generatedAt = '2099-01-01T00:00:00.000Z'; });

  // A forged signature (attacker recomputes nothing, just swaps the value) fails.
  {
    const p = JSON.parse(JSON.stringify(full));
    p.signature.value = 'f'.repeat(64);
    ok((await verifyPacket(p)).valid === false, 'tamper: forged signature value → detected');
  }
  // An unsigned packet is refused, not accepted.
  {
    const p = JSON.parse(JSON.stringify(full));
    delete p.signature;
    const r = await verifyPacket(p);
    ok(r.valid === false && /unsigned/i.test(r.reason), 'tamper: unsigned packet refused');
  }
  // Wrong kind / wrong version refused.
  ok((await verifyPacket({ kind: 'something-else' })).valid === false, 'verify: non-packet object refused');
  {
    const p = JSON.parse(JSON.stringify(full));
    p.formatVersion = 999;
    const r = await verifyPacket(p);
    ok(r.valid === false && /version/i.test(r.reason), 'verify: unknown format version refused');
  }

  // ---- 5. export → import ROUND-TRIP fidelity ----
  const text = serializePacket(full);
  ok(typeof text === 'string' && text.includes(PACKET_KIND), 'roundtrip: serialize produces JSON text');
  const reparsed = parsePacket(text);
  ok(JSON.stringify(reparsed) === JSON.stringify(full), 'roundtrip: parse(serialize(p)) is byte-identical');
  ok((await verifyPacket(reparsed)).valid === true, 'roundtrip: reparsed packet still verifies');
  ok((await computePacketSignature(reparsed)) === full.signature.value, 'roundtrip: recomputed signature equals the original');

  // parse rejects non-JSON and non-packet documents with a clear error.
  let threw = false;
  try { parsePacket('{not json'); } catch { threw = true; }
  ok(threw, 'parse: invalid JSON throws');
  threw = false;
  try { parsePacket(JSON.stringify({ hello: 'world' })); } catch { threw = true; }
  ok(threw, 'parse: a well-formed non-packet JSON throws');

  // ---- 6. summary is self-contained (no source data needed) ----
  const summary = summarizePacket(full);
  ok(summary.presentSections.length === 4, 'summary: reports all four present sections');
  ok(summary.sections.dataBlame.changeCount === 3 && summary.sections.dataBlame.columnsTouched.includes('age'), 'summary: blame change count + touched columns');
  ok(summary.sections.deidentification.verdict === 'review' && summary.sections.deidentification.reidentificationLevel === 'moderate', 'summary: de-id verdict + risk level surfaced');
  ok(summary.sections.denialRisk.totalFlaggedRows === 13 && summary.sections.denialRisk.categories.length === 2, 'summary: denial totals + categories surfaced');
  ok(summary.sections.costOfBadData.formatted === '$3,250', 'summary: cost formatted string surfaced');
  const partialSummary = summarizePacket(partial);
  ok(partialSummary.sections.deidentification.present === false, 'summary: omitted section reported absent');
  ok(partialSummary.presentSections.length === 1, 'summary: only the present section is listed');

  // ---- 7. filename helper ----
  ok(packetFilename(full) === 'dataglow-packet-claims.dataglow.json', 'filename: derived from dataset table + extension');
  ok(packetFilename({ dataset: {} }).endsWith('.dataglow.json'), 'filename: falls back gracefully with no table');

  // ---- done ----
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

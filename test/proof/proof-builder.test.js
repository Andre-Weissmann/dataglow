// ============================================================
// DATAGLOW — Proof Export builder test suite
// ============================================================
// Pure Node, no DOM, no DuckDB, no network.
// RUN WITH: node test/proof/proof-builder.test.js

import {
  buildProof,
  canExportProof,
  serializeProof,
  verifyProof,
  generateVerificationReport,
} from '../../js/proof/proof-builder.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- Fixtures ----------

const findingsClean = [
  { severity: 'warning', column: 'claim_amount', message: 'Outlier values detected', rowsAffected: 12, suggestedFix: 'Cap at 99th percentile', status: 'open' },
  { severity: 'info', column: 'patient_id', message: 'All values unique', rowsAffected: 0, suggestedFix: null, status: 'open' },
];

const findingsWithUnresolvedCritical = [
  { severity: 'critical', column: 'diagnosis_code', message: 'Referential integrity broken', rowsAffected: 40, suggestedFix: 'Re-map codes', status: 'open' },
  { severity: 'warning', column: 'claim_amount', message: 'Outlier values detected', rowsAffected: 12, suggestedFix: null, status: 'open' },
];

const findingsWithResolvedCritical = [
  { severity: 'critical', column: 'diagnosis_code', message: 'Referential integrity broken', rowsAffected: 40, suggestedFix: 'Re-map codes', status: 'resolved' },
  { severity: 'warning', column: 'claim_amount', message: 'Outlier values detected', rowsAffected: 12, suggestedFix: null, status: 'open' },
];

const memoryStoreFixture = {
  records: [
    { id: 'r1', type: 'file_loaded', actor: 'human', timestamp: '2026-07-10T10:00:00.000Z' },
    { id: 'r2', type: 'validation_resolved', actor: 'human', timestamp: '2026-07-11T09:00:00.000Z' },
  ],
};

function stubSummarizeMemory(store) {
  return { totalDecisions: (store.records || []).length, agentFixes: 0, humanEdits: 1 };
}
function stubGenerateTimeline(store) {
  return (store.records || []).map((r) => `${r.actor} did ${r.type} at ${r.timestamp}`);
}
function stubComputeProvenanceHash(store) {
  return `djb2:stub-${(store.records || []).length}`;
}
function stubExportNDJSON(store) {
  return (store.records || []).map((r) => JSON.stringify(r)).join('\n');
}
function stubComputeStoryHash(storyDoc) {
  return `djb2:story-${storyDoc.title ? storyDoc.title.length : 0}`;
}
function stubRenderMarkdown(storyDoc) {
  return `# ${storyDoc.title}\n\nSome markdown content for the story that is definitely longer than five hundred characters once repeated. `.repeat(10);
}

const fullDeps = {
  summarizeMemory: stubSummarizeMemory,
  generateTimeline: stubGenerateTimeline,
  computeProvenanceHash: stubComputeProvenanceHash,
  exportNDJSON: stubExportNDJSON,
  computeStoryHash: stubComputeStoryHash,
  renderMarkdown: stubRenderMarkdown,
};

const storyDocFixture = {
  version: 1,
  title: 'Analysis of claims_Q2_2026.csv',
  sections: [{ id: 'summary', type: 'summary', content: { overallHealth: 90 } }],
};

function baseSession(overrides = {}) {
  return {
    datasetName: 'claims_Q2_2026.csv',
    rowCount: 14203,
    columnCount: 18,
    sourceFileHash: 'djb2:abc12345',
    validationFindings: findingsClean,
    memoryStore: memoryStoreFixture,
    storyDoc: storyDocFixture,
    generatedAt: '2026-07-19T15:00:00.000Z',
    toolVersion: 'DataGlow Canvas v1',
    ...overrides,
  };
}

function main() {
  // ---------- buildProof: shape ----------
  {
    const proof = buildProof(baseSession(), fullDeps);

    ok(proof.version === 1, 'buildProof: version is 1');
    ok(proof.format === 'dataglow-proof', 'buildProof: format is dataglow-proof');
    ok(typeof proof.generatedAt === 'string', 'buildProof: generatedAt is a string');
    ok(proof.toolVersion === 'DataGlow Canvas v1', 'buildProof: toolVersion matches session');

    ok(isObj(proof.dataset), 'buildProof: dataset section is an object');
    ok(proof.dataset.name === 'claims_Q2_2026.csv', 'buildProof: dataset.name matches session');
    ok(proof.dataset.rowCount === 14203, 'buildProof: dataset.rowCount matches session');
    ok(proof.dataset.columnCount === 18, 'buildProof: dataset.columnCount matches session');
    ok(proof.dataset.sourceFileHash === 'djb2:abc12345', 'buildProof: dataset.sourceFileHash matches session');

    ok(isObj(proof.validation), 'buildProof: validation section is an object');
    ok(proof.validation.totalFindings === 2, 'buildProof: validation.totalFindings counts findings');
    ok(proof.validation.warningCount === 1, 'buildProof: validation.warningCount is correct');
    ok(proof.validation.criticalCount === 0, 'buildProof: validation.criticalCount is correct');
    ok(Array.isArray(proof.validation.findings) && proof.validation.findings.length === 2, 'buildProof: validation.findings includes full findings list');
    ok(typeof proof.validation.validationHash === 'string' && proof.validation.validationHash.startsWith('djb2:'), 'buildProof: validation.validationHash is a djb2 string');

    ok(isObj(proof.memory), 'buildProof: memory section is an object');
    ok(proof.memory.totalRecords === 2, 'buildProof: memory.totalRecords matches memoryStore');
    ok(isObj(proof.memory.summary), 'buildProof: memory.summary comes from summarizeMemory dep');
    ok(Array.isArray(proof.memory.timeline) && proof.memory.timeline.length === 2, 'buildProof: memory.timeline comes from generateTimeline dep');
    ok(typeof proof.memory.provenanceHash === 'string' && proof.memory.provenanceHash.startsWith('djb2:'), 'buildProof: memory.provenanceHash is a djb2 string derived from the embedded ndjson');
    ok(typeof proof.memory.ndjson === 'string' && proof.memory.ndjson.includes('file_loaded'), 'buildProof: memory.ndjson comes from exportNDJSON dep');

    ok(isObj(proof.story), 'buildProof: story section is an object');
    ok(proof.story.included === true, 'buildProof: story.included is true when storyDoc provided');
    ok(proof.story.storyHash === stubComputeStoryHash(storyDocFixture), 'buildProof: story.storyHash comes from computeStoryHash dep');
    ok(typeof proof.story.markdownPreview === 'string' && proof.story.markdownPreview.length <= 500, 'buildProof: story.markdownPreview is capped at 500 chars');

    ok(isObj(proof.integrity), 'buildProof: integrity section is an object');
    ok(typeof proof.integrity.packageHash === 'string' && proof.integrity.packageHash.startsWith('djb2:'), 'buildProof: integrity.packageHash is a djb2 string');
    ok(proof.integrity.algorithm === 'djb2', 'buildProof: integrity.algorithm is djb2');
    ok(typeof proof.integrity.note === 'string' && proof.integrity.note.length > 0, 'buildProof: integrity.note explains the upgrade path');
  }

  // ---------- buildProof: determinism ----------
  {
    const proofA = buildProof(baseSession(), fullDeps);
    const proofB = buildProof(baseSession(), fullDeps);
    ok(proofA.validation.validationHash === proofB.validation.validationHash, 'buildProof: validationHash is deterministic across identical builds');

    const reorderedFindings = [...findingsClean].reverse();
    const proofReordered = buildProof(baseSession({ validationFindings: reorderedFindings }), fullDeps);
    ok(proofA.validation.validationHash === proofReordered.validation.validationHash, 'buildProof: validationHash is order-independent (sorted before hashing)');
  }

  // ---------- buildProof: packageHash computed last ----------
  {
    const proof = buildProof(baseSession(), fullDeps);
    const { integrity, ...rest } = proof;
    const recomputed = JSON.stringify(rest);
    // packageHash must be a hash over everything EXCEPT integrity — verify
    // that changing a field outside integrity changes the packageHash,
    // proving it was computed over the fully-assembled non-integrity object.
    const proofChanged = buildProof(baseSession({ rowCount: 99999 }), fullDeps);
    ok(proof.integrity.packageHash !== proofChanged.integrity.packageHash, 'buildProof: packageHash changes when an upstream field changes (computed last, over everything)');
    ok(typeof recomputed === 'string', 'buildProof: package minus integrity serializes cleanly');
  }

  // ---------- buildProof: no deps (placeholders) ----------
  {
    const proof = buildProof(baseSession({ storyDoc: null }));
    ok(proof.memory.summary && proof.memory.summary.placeholder === true, 'buildProof: memory.summary is a placeholder when summarizeMemory not injected');
    ok(Array.isArray(proof.memory.timeline) && proof.memory.timeline.length === 0, 'buildProof: memory.timeline is empty array when generateTimeline not injected');
    ok(typeof proof.memory.provenanceHash === 'string', 'buildProof: memory.provenanceHash still has a fallback value when dep not injected');
    ok(proof.story.included === false, 'buildProof: story.included is false when storyDoc is null');
    ok(proof.story.storyHash === null, 'buildProof: story.storyHash is null when storyDoc is null');
    ok(proof.story.markdownPreview === null, 'buildProof: story.markdownPreview is null when storyDoc is null');
  }

  // ---------- canExportProof ----------
  {
    const r1 = canExportProof(findingsClean);
    ok(r1.allowed === true, 'canExportProof: allowed=true when no critical findings');
    ok(r1.blockedBy === null, 'canExportProof: blockedBy=null when allowed');

    const r2 = canExportProof(findingsWithUnresolvedCritical);
    ok(r2.allowed === false, 'canExportProof: allowed=false when unresolved critical finding exists');
    ok(r2.blockedBy && r2.blockedBy.severity === 'critical', 'canExportProof: blockedBy references the unresolved critical finding');

    const r3 = canExportProof(findingsWithResolvedCritical);
    ok(r3.allowed === true, 'canExportProof: allowed=true when critical finding is resolved');
    ok(r3.blockedBy === null, 'canExportProof: blockedBy=null when critical finding resolved');

    const r4 = canExportProof([]);
    ok(r4.allowed === true, 'canExportProof: allowed=true for empty findings list');

    const r5 = canExportProof(undefined);
    ok(r5.allowed === true, 'canExportProof: allowed=true when findings is undefined (defensive)');
  }

  // ---------- serializeProof ----------
  {
    const proof = buildProof(baseSession(), fullDeps);
    const serialized = serializeProof(proof);
    ok(typeof serialized === 'string', 'serializeProof: returns a string');

    let parsed;
    let parseOk = true;
    try { parsed = JSON.parse(serialized); } catch (_e) { parseOk = false; }
    ok(parseOk, 'serializeProof: output is valid JSON');
    ok(parsed && parsed._comment === 'DataGlow Proof Package — verify with verifyProof()', 'serializeProof: includes _comment field with expected value');
    ok(parsed && parsed.version === 1, 'serializeProof: parsed JSON preserves proof fields');
    ok(serialized.includes('\n  '), 'serializeProof: output is pretty-printed (indented)');
  }

  // ---------- verifyProof: round trip ----------
  {
    const proof = buildProof(baseSession(), fullDeps);
    const result = verifyProof(proof);
    ok(result.valid === true, 'verifyProof: passes on a freshly built proof (round-trip)');
    ok(Array.isArray(result.checks) && result.checks.length === 4, 'verifyProof: returns 4 checks');
    const names = result.checks.map((c) => c.name);
    ok(names.includes('validationHash'), 'verifyProof: checks include validationHash');
    ok(names.includes('provenanceHash'), 'verifyProof: checks include provenanceHash');
    ok(names.includes('storyHash'), 'verifyProof: checks include storyHash');
    ok(names.includes('packageHash'), 'verifyProof: checks include packageHash');
    ok(result.checks.every((c) => c.passed === true), 'verifyProof: every individual check passes on a valid proof');
  }

  // ---------- verifyProof: tamper detection ----------
  {
    const proof = buildProof(baseSession(), fullDeps);

    // Tamper validationHash directly.
    const tamperedValidation = { ...proof, validation: { ...proof.validation, validationHash: 'djb2:deadbeef' } };
    const rV = verifyProof(tamperedValidation);
    ok(rV.valid === false, 'verifyProof: detects tampered validationHash (overall invalid)');
    ok(rV.checks.find((c) => c.name === 'validationHash').passed === false, 'verifyProof: validationHash check fails specifically');

    // Tamper packageHash directly.
    const tamperedPackage = { ...proof, integrity: { ...proof.integrity, packageHash: 'djb2:00000000' } };
    const rP = verifyProof(tamperedPackage);
    ok(rP.valid === false, 'verifyProof: detects tampered packageHash (overall invalid)');
    ok(rP.checks.find((c) => c.name === 'packageHash').passed === false, 'verifyProof: packageHash check fails specifically');

    // Tamper rowCount (upstream field) — should cascade into packageHash failing.
    const tamperedRowCount = { ...proof, dataset: { ...proof.dataset, rowCount: 1 } };
    const rR = verifyProof(tamperedRowCount);
    ok(rR.valid === false, 'verifyProof: detects tampered rowCount (changes packageHash)');
    ok(rR.checks.find((c) => c.name === 'packageHash').passed === false, 'verifyProof: rowCount tampering fails the packageHash check');
  }

  // ---------- generateVerificationReport ----------
  {
    const proof = buildProof(baseSession(), fullDeps);
    const validResult = verifyProof(proof);
    const report = generateVerificationReport(validResult, proof);
    ok(typeof report === 'string', 'generateVerificationReport: returns a string');
    ok(report.includes('VERIFIED'), 'generateVerificationReport: includes "VERIFIED" on a valid proof');
    ok(report.includes('claims_Q2_2026.csv'), 'generateVerificationReport: includes dataset name');
    ok(report.includes('Rows: 14203'), 'generateVerificationReport: includes row count');

    const tampered = { ...proof, integrity: { ...proof.integrity, packageHash: 'djb2:00000000' } };
    const tamperedResult = verifyProof(tampered);
    const tamperedReport = generateVerificationReport(tamperedResult, tampered);
    ok(tamperedReport.includes('TAMPERED'), 'generateVerificationReport: includes "TAMPERED" when verify fails');

    const noStoryProof = buildProof(baseSession({ storyDoc: null }), fullDeps);
    const noStoryResult = verifyProof(noStoryProof);
    const noStoryReport = generateVerificationReport(noStoryResult, noStoryProof);
    ok(noStoryReport.includes('NOT INCLUDED'), 'generateVerificationReport: handles story not included');
  }

  // ---------- story included vs not ----------
  {
    const withStory = buildProof(baseSession(), fullDeps);
    ok(withStory.story.included === true && withStory.story.storyHash !== null, 'buildProof: proof with story included has non-null storyHash');

    const withoutStory = buildProof(baseSession({ storyDoc: null }), fullDeps);
    ok(withoutStory.story.included === false && withoutStory.story.storyHash === null, 'buildProof: proof without story has included=false and storyHash=null');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

main();

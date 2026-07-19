// ============================================================
// DATAGLOW — RAG Validation Bridge test suite
// ============================================================
// Pure, browser-free unit tests for js/rag/rag-validation-bridge.js.
// Mocks queryVecFn (the transformers.js WebWorker bridge stand-in) to
// return fixed vectors and verifies citation attachment behavior:
//   - a finding whose mocked query vector closely matches a KB entry
//     gets a `citation` attached with the expected text/source/score
//   - a finding whose mocked query vector matches nothing above the
//     threshold gets `citation: null`
//   - the minScore threshold is respected (boundary case)
//
// RUN WITH:  node test/rag/rag-validation-bridge.test.js
// ============================================================

import { attachCitationsToFindings } from '../../js/rag/rag-validation-bridge.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

const knowledgeBase = [
  { id: 'hc_001', text: 'HIPAA Safe Harbor removes 18 identifier categories.', source: 'HIPAA §164.514', embedding: [1, 0, 0] },
  { id: 'hc_008', text: 'CMS defines 30-day readmission windows from discharge.', source: 'CMS HRRP', embedding: [0, 1, 0] },
  { id: 'hc_012', text: 'CPT codes are five-character procedure codes.', source: 'AMA CPT', embedding: [0, 0, 1] },
];

// ------------------------------------------------------------
// Case 1: strong match above threshold -> citation attached
// ------------------------------------------------------------
{
  const findings = [
    { message: 'Patient identifiers were not removed before export', severity: 'high' },
  ];

  // Mock queryVecFn: always returns a vector nearly identical to hc_001's embedding.
  const mockQueryVecFn = async (text) => {
    ok(text === findings[0].message, 'mockQueryVecFn: called with the finding message');
    return [0.99, 0.01, 0];
  };

  const result = await attachCitationsToFindings(findings, knowledgeBase, mockQueryVecFn);

  ok(result === findings, 'attachCitationsToFindings: returns the same findings array (mutated in place)');
  ok(result[0].citation !== null, 'attachCitationsToFindings: citation attached for a strong match');
  ok(result[0].citation.source === 'HIPAA §164.514', `attachCitationsToFindings: citation source is hc_001's source (got ${result[0].citation.source})`);
  ok(result[0].citation.text === 'HIPAA Safe Harbor removes 18 identifier categories.', 'attachCitationsToFindings: citation text matches hc_001');
  ok(result[0].citation.score > 0.65, `attachCitationsToFindings: citation score exceeds 0.65 threshold (got ${result[0].citation.score.toFixed(4)})`);
}

// ------------------------------------------------------------
// Case 2: weak/no match below threshold -> citation is null
// ------------------------------------------------------------
{
  const findings = [
    { message: 'Unrelated formatting inconsistency in export footer', severity: 'low' },
  ];

  // Mock returns a vector equidistant from all KB entries (low similarity to each).
  const mockQueryVecFn = async () => [0.3, 0.3, 0.3];

  const result = await attachCitationsToFindings(findings, knowledgeBase, mockQueryVecFn);

  ok(result[0].citation === null, 'attachCitationsToFindings: citation is null when no KB entry exceeds the threshold');
}

// ------------------------------------------------------------
// Case 3: multiple findings processed independently
// ------------------------------------------------------------
{
  const findings = [
    { message: 'Readmission window miscalculated' },
    { message: 'CPT modifier missing on claim line' },
  ];

  const vectorsByMessage = {
    'Readmission window miscalculated': [0, 0.98, 0.02],
    'CPT modifier missing on claim line': [0, 0.02, 0.98],
  };

  const mockQueryVecFn = async (text) => vectorsByMessage[text];

  const result = await attachCitationsToFindings(findings, knowledgeBase, mockQueryVecFn);

  ok(result[0].citation && result[0].citation.source === 'CMS HRRP', 'attachCitationsToFindings: first finding matched to CMS HRRP entry');
  ok(result[1].citation && result[1].citation.source === 'AMA CPT', 'attachCitationsToFindings: second finding matched to AMA CPT entry');
}

// ------------------------------------------------------------
// Case 4: custom minScore threshold is respected
// ------------------------------------------------------------
{
  const findings = [{ message: 'Borderline similarity case' }];
  const mockQueryVecFn = async () => [0.8, 0.2, 0]; // score against hc_001 will be high but not 1.0

  const strict = await attachCitationsToFindings([...findings], knowledgeBase, mockQueryVecFn, 0.99);
  ok(strict[0].citation === null, 'attachCitationsToFindings: a very high minScore (0.99) rejects a good-but-imperfect match');

  const lenient = await attachCitationsToFindings([...findings], knowledgeBase, mockQueryVecFn, 0.5);
  ok(lenient[0].citation !== null, 'attachCitationsToFindings: a lower minScore (0.5) accepts the same match');
}

// ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

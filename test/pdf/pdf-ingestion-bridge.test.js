// ============================================================
// DATAGLOW — PDF Ingestion Bridge test suite
// ============================================================
// Pure, browser-free unit tests for js/pdf/pdf-ingestion-bridge.js.
// Covers:
//   validatePDFText()          — valid text, empty text, >50k word warning
//   buildPDFManifest()         — estimatedChunks math, processingSteps shape
//   buildPDFIngestionSummary() — headline/chipLabel content
//   preparePDFForRAG()         — full RAG wiring (chunkText + addUserDocument)
//
// NOTE on preparePDFForRAG(): pdf-ingestion-bridge.js imports the REAL
// chunkText() from js/rag/rag-core.js and the REAL addUserDocument() from
// js/rag/user-knowledge-store.js (both landed in PR #381,
// feat/rag-user-knowledge). This test suite exercises preparePDFForRAG()
// against those real modules directly — no mocking is required since both
// dependencies are pure, side-effect-light, in-memory logic that runs
// identically under plain `node`.
//
// If you are running this test in a checkout where js/rag/rag-core.js or
// js/rag/user-knowledge-store.js are not yet present (e.g. testing this
// PR in isolation before PR #381 has merged), the import at the top of
// pdf-ingestion-bridge.js will fail. In that situation, either:
//   (a) stub the two imports with simple inline implementations
//       (chunkText returning naive fixed-size word windows, and
//       addUserDocument being a no-op returning a chunk count), or
//   (b) skip this file's preparePDFForRAG() tests and rely on
//       test/rag/rag-core.test.js + test/rag/user-knowledge-store.test.js
//       for integration coverage of the underlying RAG primitives.
// This suite takes approach (a) is NOT needed here because both RAG
// modules are vendored alongside this PR — see js/rag/ in this branch.
//
// RUN WITH:  node test/pdf/pdf-ingestion-bridge.test.js
// ============================================================

import {
  buildPDFManifest,
  validatePDFText,
  preparePDFForRAG,
  buildPDFIngestionSummary,
} from '../../js/pdf/pdf-ingestion-bridge.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ------------------------------------------------------------
// validatePDFText
// ------------------------------------------------------------
{
  const words = [];
  for (let i = 1; i <= 200; i++) words.push(`word${i}`);
  const normalText = words.join(' ');

  const validResult = validatePDFText(normalText, 'sample.pdf');
  ok(validResult.valid === true, 'validatePDFText: normal text is valid');
  ok(validResult.wordCount === 200, `validatePDFText: wordCount is 200 (got ${validResult.wordCount})`);
  ok(validResult.error === undefined, 'validatePDFText: no error on valid text');

  const emptyResult = validatePDFText('', 'empty.pdf');
  ok(emptyResult.valid === false, 'validatePDFText: empty string is invalid');
  ok(
    emptyResult.error === 'PDF appears to be image-only or encrypted. Text extraction requires a text-based PDF.',
    'validatePDFText: empty string produces the expected error message',
  );
  ok(emptyResult.wordCount === 0, 'validatePDFText: empty string has wordCount 0');

  const shortResult = validatePDFText('too short', 'short.pdf');
  ok(shortResult.valid === false, 'validatePDFText: text under 50 chars is invalid');

  const bigWords = [];
  for (let i = 1; i <= 50001; i++) bigWords.push(`w${i}`);
  const bigText = bigWords.join(' ');
  const bigResult = validatePDFText(bigText, 'big.pdf');
  ok(bigResult.valid === true, 'validatePDFText: >50k word doc is still valid');
  ok(
    bigResult.warning === 'Large document. Chunking may take a moment.',
    'validatePDFText: >50k word doc produces the expected warning',
  );
  ok(bigResult.wordCount === 50001, `validatePDFText: big doc wordCount is 50001 (got ${bigResult.wordCount})`);
}

// ------------------------------------------------------------
// buildPDFManifest
// ------------------------------------------------------------
{
  const manifest = buildPDFManifest('HIPAA Privacy Rule.pdf', 1.2, 5);

  ok(manifest.fileName === 'HIPAA Privacy Rule.pdf', 'buildPDFManifest: fileName passed through');
  ok(manifest.fileSizeMb === 1.2, 'buildPDFManifest: fileSizeMb passed through');
  ok(manifest.pageCount === 5, 'buildPDFManifest: pageCount passed through');
  ok(manifest.sourceName === 'HIPAA Privacy Rule', 'buildPDFManifest: sourceName strips .pdf extension');
  ok(manifest.ingestionMode === 'rag_knowledge_base', 'buildPDFManifest: ingestionMode is rag_knowledge_base');
  ok(
    manifest.estimatedChunks === Math.ceil(5 * 2.5),
    `buildPDFManifest: estimatedChunks = ceil(pageCount * 2.5) (got ${manifest.estimatedChunks})`,
  );
  ok(
    Array.isArray(manifest.processingSteps) && manifest.processingSteps.length === 4,
    `buildPDFManifest: processingSteps has 4 items (got ${manifest.processingSteps.length})`,
  );
  ok(
    manifest.processingSteps.includes('read_pdf_as_arraybuffer') &&
    manifest.processingSteps.includes('extract_text_via_pdfjs') &&
    manifest.processingSteps.includes('chunk_and_index_via_rag') &&
    manifest.processingSteps.includes('make_available_for_agent_citations'),
    'buildPDFManifest: processingSteps contains the expected 4 named steps',
  );

  // Odd page count exercises the ceil() rounding behavior explicitly.
  const oddManifest = buildPDFManifest('odd.pdf', 0.5, 3);
  ok(
    oddManifest.estimatedChunks === 8,
    `buildPDFManifest: ceil(3 * 2.5) = 8 (got ${oddManifest.estimatedChunks})`,
  );
}

// ------------------------------------------------------------
// preparePDFForRAG — wires rag-core.js chunkText + user-knowledge-store.js addUserDocument
// ------------------------------------------------------------
{
  const words = [];
  for (let i = 1; i <= 500; i++) words.push(`term${i}`);
  const docText = words.join(' ');

  const prepResult = preparePDFForRAG(docText, 'coding-manual.pdf');

  ok(prepResult.sourceName === 'coding-manual.pdf', 'preparePDFForRAG: sourceName defaults to fileName');
  ok(prepResult.chunkCount > 0, `preparePDFForRAG: chunkCount > 0 (got ${prepResult.chunkCount})`);
  ok(prepResult.wordCount === 500, `preparePDFForRAG: wordCount is 500 (got ${prepResult.wordCount})`);
  ok(prepResult.status === 'indexed', 'preparePDFForRAG: status is "indexed"');
  ok(prepResult.availableForCitations === true, 'preparePDFForRAG: availableForCitations is true');
  ok(
    typeof prepResult.note === 'string' && prepResult.note.length > 0,
    'preparePDFForRAG: note is a non-empty string',
  );

  // Custom sourceName option overrides fileName
  const customPrep = preparePDFForRAG(docText, 'coding-manual.pdf', { sourceName: 'ICD-10 Manual' });
  ok(customPrep.sourceName === 'ICD-10 Manual', 'preparePDFForRAG: options.sourceName overrides fileName');
}

// ------------------------------------------------------------
// buildPDFIngestionSummary
// ------------------------------------------------------------
{
  const manifest = buildPDFManifest('HIPAA Privacy Rule.pdf', 1.2, 5);
  const prepResult = {
    sourceName: 'HIPAA Privacy Rule.pdf',
    chunkCount: 12,
    wordCount: 847,
    status: 'indexed',
    availableForCitations: true,
    note: 'Embeddings will be computed by the WebWorker bridge. Citations are available after embedding completes.',
  };

  const summary = buildPDFIngestionSummary(manifest, prepResult);

  ok(
    summary.headline.includes('HIPAA Privacy Rule.pdf'),
    `buildPDFIngestionSummary: headline contains fileName (got "${summary.headline}")`,
  );
  ok(
    summary.headline.includes('12'),
    `buildPDFIngestionSummary: headline contains chunk count (got "${summary.headline}")`,
  );
  ok(
    summary.chipLabel.includes('chunks'),
    `buildPDFIngestionSummary: chipLabel contains "chunks" (got "${summary.chipLabel}")`,
  );
  ok(
    typeof summary.detail === 'string' && summary.detail.length > 0,
    'buildPDFIngestionSummary: detail is a non-empty string',
  );
}

// ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

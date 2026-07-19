// ============================================================
// DATAGLOW — RAG Core test suite
// ============================================================
// Pure, browser-free unit tests for js/rag/rag-core.js.
// Covers:
//   chunkText()        — word-count chunking + overlap on a 300-word sample
//   cosineSimilarity() — known-vector numeric check (tolerance 0.001)
//   retrieveTopK()     — ranked retrieval over 5 mock knowledge entries
//
// RUN WITH:  node test/rag/rag-core.test.js
// ============================================================

import { chunkText, cosineSimilarity, retrieveTopK } from '../../js/rag/rag-core.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ------------------------------------------------------------
// chunkText — 300-word sample, chunk count + overlap
// ------------------------------------------------------------
{
  const words = [];
  for (let i = 1; i <= 300; i++) words.push(`word${i}`);
  const sample = words.join(' ');

  const chunks = chunkText(sample, 200, 20, 'sample-doc');

  // step = 200 - 20 = 180. start=0 -> [0,200); start=180 -> [180,300)
  ok(chunks.length === 2, `chunkText: 300 words @ size 200 / overlap 20 produces 2 chunks (got ${chunks.length})`);

  const firstWords = chunks[0].text.split(/\s+/);
  const secondWords = chunks[1].text.split(/\s+/);
  ok(firstWords.length === 200, `chunkText: first chunk has 200 words (got ${firstWords.length})`);
  ok(secondWords.length === 120, `chunkText: second chunk has remaining 120 words (got ${secondWords.length})`);

  // overlap check: last 20 words of chunk 0 should equal first 20 words of chunk 1
  const tailOfFirst = firstWords.slice(-20).join(' ');
  const headOfSecond = secondWords.slice(0, 20).join(' ');
  ok(tailOfFirst === headOfSecond, 'chunkText: consecutive chunks share the expected 20-word overlap');

  ok(chunks.every((c) => c.source === 'sample-doc'), 'chunkText: every chunk carries the provided source label');
  ok(chunks[0].id === 'chunk_0' && chunks[1].id === 'chunk_1', 'chunkText: chunk ids are sequential');

  // Edge cases
  ok(chunkText('').length === 0, 'chunkText: empty string yields no chunks');
  const tiny = chunkText('one two three', 200, 20, 'tiny-doc');
  ok(tiny.length === 1 && tiny[0].text === 'one two three', 'chunkText: text shorter than chunkSize yields a single chunk');
}

// ------------------------------------------------------------
// cosineSimilarity — known vectors
// ------------------------------------------------------------
{
  // Identical vectors -> similarity 1
  ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 0.001,
    'cosineSimilarity: identical vectors ~= 1');

  // Orthogonal vectors -> similarity 0
  ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0) < 0.001,
    'cosineSimilarity: orthogonal vectors ~= 0');

  // Opposite vectors -> similarity -1
  ok(Math.abs(cosineSimilarity([1, 2, 3], [-1, -2, -3]) - (-1)) < 0.001,
    'cosineSimilarity: opposite vectors ~= -1');

  // Known non-trivial case: A=[1,2,3], B=[4,5,6]
  // dot = 4+10+18=32; |A|=sqrt(14)=3.74166; |B|=sqrt(77)=8.77496
  // cos = 32 / (3.74166*8.77496) = 32 / 32.8477 ≈ 0.97463
  const expected = 0.97463;
  const actual = cosineSimilarity([1, 2, 3], [4, 5, 6]);
  ok(Math.abs(actual - expected) < 0.001,
    `cosineSimilarity: [1,2,3] vs [4,5,6] ~= ${expected} (got ${actual.toFixed(5)})`);

  // Zero-magnitude vector guarded (no divide-by-zero / NaN)
  ok(cosineSimilarity([0, 0, 0], [1, 2, 3]) === 0,
    'cosineSimilarity: zero-magnitude vector returns 0 instead of NaN');
}

// ------------------------------------------------------------
// retrieveTopK — 5 mock knowledge entries, 1 query vector
// ------------------------------------------------------------
{
  const knowledgeBase = [
    { id: 'kb_1', text: 'Entry about cats', source: 'doc-a', embedding: [1, 0, 0] },
    { id: 'kb_2', text: 'Entry about dogs', source: 'doc-b', embedding: [0.9, 0.1, 0] },
    { id: 'kb_3', text: 'Entry about cars', source: 'doc-c', embedding: [0, 1, 0] },
    { id: 'kb_4', text: 'Entry about boats', source: 'doc-d', embedding: [0, 0, 1] },
    { id: 'kb_5', text: 'Entry about planes', source: 'doc-e', embedding: [-1, 0, 0] },
  ];

  const queryVec = [1, 0, 0]; // should match kb_1 exactly, kb_2 closely, kb_5 as worst

  const top2 = retrieveTopK(queryVec, knowledgeBase, 2);
  ok(top2.length === 2, `retrieveTopK: returns k=2 results (got ${top2.length})`);
  ok(top2[0].id === 'kb_1', `retrieveTopK: top result is the exact match kb_1 (got ${top2[0].id})`);
  ok(Math.abs(top2[0].score - 1) < 0.001, 'retrieveTopK: top result score ~= 1');
  ok(top2[1].id === 'kb_2', `retrieveTopK: second result is the closest match kb_2 (got ${top2[1].id})`);
  ok(top2[0].score >= top2[1].score, 'retrieveTopK: results are sorted descending by score');

  const all = retrieveTopK(queryVec, knowledgeBase, 5);
  ok(all[all.length - 1].id === 'kb_5', 'retrieveTopK: worst match (opposite vector) ranks last');

  const defaultK = retrieveTopK(queryVec, knowledgeBase);
  ok(defaultK.length === 2, 'retrieveTopK: default k is 2');
}

// ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

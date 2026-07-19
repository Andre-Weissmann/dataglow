// ============================================================
// DATAGLOW — User Knowledge Store test suite
// ============================================================
// Pure, browser-free unit tests for js/rag/user-knowledge-store.js.
// Covers all 5 exports:
//   addUserDocument()       — chunk count returned, entries shaped correctly
//   getUserKnowledgeBase()  — reflects current in-memory array
//   setChunkEmbedding()     — finds chunk by id and sets its embedding
//   getUserKnowledgeStats() — documentCount / chunkCount summary
//   clearUserKnowledge()    — empties the array and resets stats
//
// RUN WITH:  node test/rag/user-knowledge-store.test.js
// ============================================================

import {
  addUserDocument,
  getUserKnowledgeBase,
  clearUserKnowledge,
  getUserKnowledgeStats,
  setChunkEmbedding,
} from '../../js/rag/user-knowledge-store.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// Ensure a clean slate before this test file's assertions run, in case
// module state leaked from another test process (defensive only —
// each `node` invocation gets a fresh module instance).
clearUserKnowledge();

// ------------------------------------------------------------
// addUserDocument — chunk count + entry shape
// ------------------------------------------------------------
{
  const words = [];
  for (let i = 1; i <= 300; i++) words.push(`word${i}`);
  const sample = words.join(' ');

  const chunkCount = addUserDocument(sample, 'sop-manual.pdf');

  // step = 200 - 20 = 180. start=0 -> [0,200); start=180 -> [180,300)
  ok(chunkCount === 2, `addUserDocument: 300-word doc produces 2 chunks (got ${chunkCount})`);

  const kb = getUserKnowledgeBase();
  ok(kb.length === 2, `addUserDocument: knowledge base has 2 entries after insert (got ${kb.length})`);
  ok(kb.every((c) => c.source === 'sop-manual.pdf'), 'addUserDocument: every chunk carries the provided sourceName');
  ok(kb.every((c) => c.embedding === null), 'addUserDocument: every chunk is inserted with embedding: null');
  ok(kb.every((c) => typeof c.id === 'string' && c.id.length > 0), 'addUserDocument: every chunk has a non-empty string id');
  ok(new Set(kb.map((c) => c.id)).size === kb.length, 'addUserDocument: chunk ids are unique');

  // Adding a second document appends rather than replaces.
  const secondCount = addUserDocument('short policy text here', 'policy.txt');
  ok(secondCount === 1, `addUserDocument: short doc yields 1 chunk (got ${secondCount})`);
  ok(getUserKnowledgeBase().length === 3, `addUserDocument: second insert appends to existing entries (got ${getUserKnowledgeBase().length})`);

  // Empty text yields no chunks and does not throw.
  const emptyCount = addUserDocument('', 'empty.txt');
  ok(emptyCount === 0, 'addUserDocument: empty text yields 0 chunks');
  ok(getUserKnowledgeBase().length === 3, 'addUserDocument: empty-text insert does not add entries');
}

// ------------------------------------------------------------
// getUserKnowledgeStats — documentCount / chunkCount
// ------------------------------------------------------------
{
  const stats = getUserKnowledgeStats();
  ok(stats.documentCount === 2, `getUserKnowledgeStats: documentCount reflects 2 distinct sources (got ${stats.documentCount})`);
  ok(stats.chunkCount === 3, `getUserKnowledgeStats: chunkCount reflects 3 total chunks (got ${stats.chunkCount})`);
}

// ------------------------------------------------------------
// setChunkEmbedding — finds by id, sets embedding
// ------------------------------------------------------------
{
  const kb = getUserKnowledgeBase();
  const targetId = kb[0].id;
  const vector = [0.1, 0.2, 0.3];

  const result = setChunkEmbedding(targetId, vector);
  ok(result === true, 'setChunkEmbedding: returns true when a matching chunk is found');

  const updated = getUserKnowledgeBase().find((c) => c.id === targetId);
  ok(Array.isArray(updated.embedding) && updated.embedding.length === 3, 'setChunkEmbedding: embedding field is set on the matching chunk');
  ok(updated.embedding[0] === 0.1 && updated.embedding[1] === 0.2 && updated.embedding[2] === 0.3, 'setChunkEmbedding: embedding vector values match what was passed in');

  // Other chunks are unaffected.
  const untouched = getUserKnowledgeBase().filter((c) => c.id !== targetId);
  ok(untouched.every((c) => c.embedding === null), 'setChunkEmbedding: only the targeted chunk is updated, others remain null');

  // Unknown id returns false and does not throw.
  const missingResult = setChunkEmbedding('nonexistent_id', [1, 2, 3]);
  ok(missingResult === false, 'setChunkEmbedding: returns false for an id that does not exist');
}

// ------------------------------------------------------------
// clearUserKnowledge — resets array and stats
// ------------------------------------------------------------
{
  clearUserKnowledge();
  ok(getUserKnowledgeBase().length === 0, 'clearUserKnowledge: knowledge base array is emptied');

  const stats = getUserKnowledgeStats();
  ok(stats.documentCount === 0 && stats.chunkCount === 0, `clearUserKnowledge: stats reset to zero (got documentCount=${stats.documentCount}, chunkCount=${stats.chunkCount})`);

  // Store remains usable after clearing.
  const countAfterClear = addUserDocument('fresh text after clearing', 'fresh.txt');
  ok(countAfterClear === 1, 'clearUserKnowledge: store remains usable for new inserts after clearing');
  clearUserKnowledge();
}

// ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

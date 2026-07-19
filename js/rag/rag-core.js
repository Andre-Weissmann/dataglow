// ============================================================
// DATAGLOW — RAG Core (chunker, cosine similarity, retrieval)
// ============================================================
//
// BOUNDARY NOTE (read this before touching this file):
//
// This module is PURE JAVASCRIPT LOGIC ONLY. It has no external
// dependencies, does not call `fetch`, does not touch the network, and
// does not use any browser-only APIs (no `localStorage`, no `window`,
// no DOM). It runs identically under plain `node` and inside the
// browser.
//
// DataGlow's in-browser embedding step (turning raw text into a numeric
// vector) is handled elsewhere, by transformers.js running inside a
// WebWorker. That embedding layer is deliberately NOT part of this
// module. This module never produces an embedding and never calls an
// embedding model — it only:
//   1. Chunks raw text into overlapping word windows (`chunkText`).
//   2. Compares two already-computed vectors (`cosineSimilarity`).
//   3. Ranks an in-memory knowledge base of { embedding, ... } entries
//      against an already-computed query vector (`retrieveTopK`).
//
// The caller is responsible for obtaining embeddings (e.g. from the
// transformers.js WebWorker bridge) and passing the resulting vectors
// into `retrieveTopK`. Keeping this boundary strict is what makes this
// module trivially unit-testable with plain mock vectors, with zero
// mocking of network calls or WASM/worker machinery.
//
// ============================================================

/**
 * Split text into overlapping, word-count-approximate chunks.
 *
 * Chunk size and overlap are measured in whitespace-delimited "words",
 * which is used as a cheap approximation for LLM tokens (good enough
 * for retrieval chunking; it is not a real tokenizer).
 *
 * @param {string} text - The raw source text to chunk.
 * @param {number} [chunkSize=200] - Approximate number of words per chunk.
 * @param {number} [overlap=20] - Number of words shared between consecutive chunks.
 * @param {string} [source='unknown'] - Source label attached to every chunk.
 * @returns {Array<{ id: string, text: string, source: string }>}
 */
function chunkText(text, chunkSize = 200, overlap = 20, source = 'unknown') {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  if (chunkSize <= 0) throw new Error('chunkSize must be > 0');
  if (overlap < 0) throw new Error('overlap must be >= 0');
  if (overlap >= chunkSize) throw new Error('overlap must be smaller than chunkSize');

  const words = text.trim().split(/\s+/);
  const step = chunkSize - overlap;
  const chunks = [];

  let start = 0;
  let index = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    const chunkWords = words.slice(start, end);
    chunks.push({
      id: `chunk_${index}`,
      text: chunkWords.join(' '),
      source,
    });
    index += 1;
    if (end >= words.length) break;
    start += step;
  }

  return chunks;
}

/**
 * Compute the cosine similarity between two equal-length numeric vectors.
 *
 * cosine(A, B) = (A · B) / (||A|| * ||B||)
 *
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} A float in [-1, 1]. Returns 0 if either vector has
 *   zero magnitude (avoids division by zero).
 */
function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) {
    throw new Error('cosineSimilarity expects two numeric arrays');
  }
  if (vecA.length !== vecB.length) {
    throw new Error('cosineSimilarity expects vectors of equal length');
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/**
 * Retrieve the top-k most similar knowledge base entries for a given
 * query embedding vector.
 *
 * This function does NOT compute embeddings. `queryVec` and every
 * `embedding` field in `knowledgeBase` must already be numeric vectors
 * produced by an external embedding step (transformers.js WebWorker).
 *
 * @param {number[]} queryVec - The query embedding vector.
 * @param {Array<{ id: string, text: string, source: string, embedding: number[] }>} knowledgeBase
 * @param {number} [k=2] - Number of top results to return.
 * @returns {Array<{ id: string, text: string, source: string, score: number }>}
 *   Sorted descending by score (cosine similarity).
 */
function retrieveTopK(queryVec, knowledgeBase, k = 2) {
  if (!Array.isArray(knowledgeBase)) {
    throw new Error('retrieveTopK expects knowledgeBase to be an array');
  }

  const scored = knowledgeBase.map((entry) => ({
    id: entry.id,
    text: entry.text,
    source: entry.source,
    score: cosineSimilarity(queryVec, entry.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(0, k));
}

export { chunkText, cosineSimilarity, retrieveTopK };

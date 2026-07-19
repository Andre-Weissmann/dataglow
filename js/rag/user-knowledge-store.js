// ============================================================
// DATAGLOW — User Knowledge Store (in-memory, RAG-ready)
// ============================================================
//
// This module lets analysts paste or upload their own domain reference
// documents (SOPs, coding manuals, policy docs) and have them chunked
// and indexed locally so they can be cited during validation via RAG
// retrieval (see js/rag/rag-core.js).
//
// BOUNDARY NOTE: this module is PURE IN-MEMORY JAVASCRIPT LOGIC ONLY.
// It has no external dependencies, does not call `fetch`, does not use
// `localStorage`, and does not touch any other browser-only API. All
// state lives in a single in-memory array for the lifetime of the page.
//
// Embeddings are set to null at insert time. The caller (WebWorker
// bridge) is responsible for running transformers.js embedding on each
// chunk and calling setChunkEmbedding(id, vector) before retrieval.
//
// ============================================================

import { chunkText } from './rag-core.js';

/**
 * In-memory knowledge base of user-uploaded document chunks.
 * Each entry: { id, text, source, embedding }
 * @type {Array<{ id: string, text: string, source: string, embedding: (number[]|null) }>}
 */
let userKnowledgeBase = [];

/**
 * Tracks the distinct source document names that have been added, so
 * getUserKnowledgeStats() can report a document count in addition to a
 * chunk count.
 * @type {Set<string>}
 */
let documentSources = new Set();

/**
 * Chunk a user-supplied document and add the resulting chunks to the
 * in-memory user knowledge base.
 *
 * Embeddings are set to null at insert time. The caller (WebWorker
 * bridge) is responsible for running transformers.js embedding on each
 * chunk and calling setChunkEmbedding(id, vector) before retrieval.
 *
 * @param {string} text - The raw document text to chunk and index.
 * @param {string} sourceName - A human-readable label for the source
 *   document (e.g. a filename or pasted-document title).
 * @returns {number} The number of chunks added.
 */
function addUserDocument(text, sourceName) {
  const rawChunks = chunkText(text, 200, 20, sourceName);

  if (rawChunks.length === 0) return 0;

  const prefix = `user_${documentSources.size}_${userKnowledgeBase.length}`;

  const entries = rawChunks.map((chunk, i) => ({
    id: `${prefix}_${i}_${chunk.id}`,
    text: chunk.text,
    source: sourceName,
    embedding: null,
  }));

  userKnowledgeBase.push(...entries);
  documentSources.add(sourceName);

  return entries.length;
}

/**
 * Return the current in-memory user knowledge base.
 * @returns {Array<{ id: string, text: string, source: string, embedding: (number[]|null) }>}
 */
function getUserKnowledgeBase() {
  return userKnowledgeBase;
}

/**
 * Clear all user-uploaded document chunks from the in-memory store.
 * @returns {void}
 */
function clearUserKnowledge() {
  userKnowledgeBase = [];
  documentSources = new Set();
}

/**
 * Report summary statistics about the current user knowledge base.
 * @returns {{ documentCount: number, chunkCount: number }}
 */
function getUserKnowledgeStats() {
  return {
    documentCount: documentSources.size,
    chunkCount: userKnowledgeBase.length,
  };
}

/**
 * Set the embedding vector for a previously added chunk, identified by
 * id. This is how the WebWorker transformers.js embedding bridge
 * completes indexing for a chunk after addUserDocument() has inserted
 * it with `embedding: null`.
 *
 * @param {string} id - The chunk id returned via getUserKnowledgeBase().
 * @param {number[]} vector - The computed embedding vector.
 * @returns {boolean} true if a matching chunk was found and updated,
 *   false otherwise.
 */
function setChunkEmbedding(id, vector) {
  const entry = userKnowledgeBase.find((chunk) => chunk.id === id);
  if (!entry) return false;
  entry.embedding = vector;
  return true;
}

export {
  addUserDocument,
  getUserKnowledgeBase,
  clearUserKnowledge,
  getUserKnowledgeStats,
  setChunkEmbedding,
};

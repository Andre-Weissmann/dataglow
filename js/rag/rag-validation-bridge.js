// ============================================================
// DATAGLOW — RAG Validation Bridge
// ============================================================
//
// BOUNDARY NOTE:
//
// This module wires DataGlow's validation findings to the RAG knowledge
// base (see js/rag/rag-core.js) so that findings can be annotated with a
// supporting domain-knowledge citation.
//
// It does NOT compute embeddings itself. The `queryVecFn` parameter is
// supplied by the transformers.js WebWorker bridge elsewhere in the
// app — it is intentionally injected (dependency injection) rather than
// imported/called directly, so this module stays fully testable with a
// plain mock function and never needs a real embedding model, a
// WebWorker, or a network call in its test suite.
//
// ============================================================

import { retrieveTopK } from './rag-core.js';

const DEFAULT_MIN_SCORE = 0.65;
const DEFAULT_TOP_K = 1;

/**
 * @callback QueryVecFn
 * @param {string} text - The text to embed (e.g. a finding's message).
 * @returns {Promise<number[]>|number[]} The resulting embedding vector.
 */

/**
 * Attach a supporting citation from the knowledge base to each finding.
 *
 * For every finding in `findings`, this calls `queryVecFn(finding.message)`
 * to obtain an embedding vector (supplied externally — see the module
 * boundary note above), then uses `retrieveTopK` from rag-core.js to find
 * the single best-matching knowledge base entry. If that entry's cosine
 * similarity score exceeds `minScore` (default 0.65), a `citation` object
 * is attached to the finding; otherwise `citation` is set to `null`.
 *
 * Findings are mutated in place AND returned (same array) for convenience.
 *
 * @param {Array<{ message: string, [key: string]: any }>} findings
 * @param {Array<{ id: string, text: string, source: string, embedding: number[] }>} knowledgeBase
 * @param {QueryVecFn} queryVecFn - Injected embedding function (transformers.js WebWorker bridge).
 * @param {number} [minScore=0.65] - Minimum cosine similarity required to attach a citation.
 * @returns {Promise<Array<{ message: string, citation: { text: string, source: string, score: number } | null, [key: string]: any }>>}
 */
async function attachCitationsToFindings(findings, knowledgeBase, queryVecFn, minScore = DEFAULT_MIN_SCORE) {
  if (!Array.isArray(findings)) {
    throw new Error('attachCitationsToFindings expects findings to be an array');
  }
  if (typeof queryVecFn !== 'function') {
    throw new Error('attachCitationsToFindings expects queryVecFn to be a function');
  }

  for (const finding of findings) {
    const queryVec = await queryVecFn(finding.message);
    const [top] = retrieveTopK(queryVec, knowledgeBase, DEFAULT_TOP_K);

    if (top && top.score > minScore) {
      finding.citation = {
        text: top.text,
        source: top.source,
        score: top.score,
      };
    } else {
      finding.citation = null;
    }
  }

  return findings;
}

export { attachCitationsToFindings };

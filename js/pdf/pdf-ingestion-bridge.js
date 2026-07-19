// ============================================================
// DATAGLOW — PDF Ingestion Bridge
// ============================================================
//
// This module wires PDF files dropped onto the Universal Drop Zone into
// DataGlow's existing RAG pipeline (see js/rag/rag-core.js and
// js/rag/user-knowledge-store.js, PR #381 feat/rag-user-knowledge).
//
// BOUNDARY NOTE (read this before touching this file):
//
// This module is PURE JAVASCRIPT LOGIC ONLY. It does NOT import PDF.js
// and does NOT touch the DOM, `fetch`, or any browser-only API. PDF text
// extraction happens in the UI layer (see the scaffold in
// js/pdf/pdfjs-extractor.scaffold.js, which loads PDF.js from a CDN and
// calls page.getTextContent() per page). By the time anything in this
// file runs, the PDF's text has already been extracted into a plain
// JavaScript string. This module receives that string and:
//   1. Builds a display manifest describing the incoming PDF
//      (buildPDFManifest).
//   2. Validates the extracted text is usable before indexing
//      (validatePDFText).
//   3. Chunks the text and adds it to the in-memory RAG knowledge base
//      via rag-core.js's chunkText() and user-knowledge-store.js's
//      addUserDocument() (preparePDFForRAG).
//   4. Builds a display-ready summary for the tab strip / chat UI
//      (buildPDFIngestionSummary).
//
// This module REQUIRES js/rag/rag-core.js and js/rag/user-knowledge-store.js
// to be importable — it imports `chunkText` and `addUserDocument` directly
// from those modules. If those modules are not present (e.g. this PR is
// tested in isolation before PR #381 merges), preparePDFForRAG() will fail
// to import; see test/pdf/pdf-ingestion-bridge.test.js for how this is
// handled in tests.
//
// IMPORTANT: an ingested PDF does NOT appear in the data grid. Unlike a
// CSV/XLSX/JSON drop, a PDF has no tabular shape to render — its content
// goes into the RAG knowledge base ONLY. The agent will cite this document
// by its fileName whenever a validation finding's content matches text
// pulled from the PDF (see docs/pdf-ingestion.md for the end-to-end story).
//
// ============================================================

import { chunkText } from '../rag/rag-core.js';
import { addUserDocument } from '../rag/user-knowledge-store.js';

/**
 * Build a display manifest for a PDF that is about to be ingested.
 *
 * This is pure bookkeeping — it does not read the PDF or touch the RAG
 * pipeline. It is used by the UI layer to render the drop-zone tab/chip
 * for the PDF before (and while) extraction + indexing happens.
 *
 * @param {string} fileName - The original PDF file name (e.g. "HIPAA Privacy Rule.pdf").
 * @param {number} fileSizeMb - The file size in megabytes.
 * @param {number} pageCount - The number of pages in the PDF (from PDF.js `pdf.numPages`).
 * @returns {{
 *   fileName: string,
 *   fileSizeMb: number,
 *   pageCount: number,
 *   sourceName: string,
 *   ingestionMode: 'rag_knowledge_base',
 *   estimatedChunks: number,
 *   processingSteps: string[]
 * }}
 */
function buildPDFManifest(fileName, fileSizeMb, pageCount) {
  const sourceName = typeof fileName === 'string' ? fileName.replace(/\.pdf$/i, '') : fileName;

  return {
    fileName,
    fileSizeMb,
    pageCount,
    sourceName,
    ingestionMode: 'rag_knowledge_base',
    estimatedChunks: Math.ceil(pageCount * 2.5),
    processingSteps: [
      'read_pdf_as_arraybuffer',
      'extract_text_via_pdfjs',
      'chunk_and_index_via_rag',
      'make_available_for_agent_citations',
    ],
  };
}

/**
 * Validate that PDF.js-extracted text is usable for RAG indexing.
 *
 * @param {string} extractedText - The full text extracted from the PDF by PDF.js.
 * @param {string} fileName - The original PDF file name, used only in messaging.
 * @returns {{ valid: boolean, error?: string, warning?: string, wordCount: number }}
 */
function validatePDFText(extractedText, fileName) {
  const text = typeof extractedText === 'string' ? extractedText : '';
  const trimmed = text.trim();
  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;

  if (trimmed.length < 50) {
    return {
      valid: false,
      error: 'PDF appears to be image-only or encrypted. Text extraction requires a text-based PDF.',
      wordCount,
    };
  }

  if (wordCount > 50000) {
    return {
      valid: true,
      warning: 'Large document. Chunking may take a moment.',
      wordCount,
    };
  }

  return { valid: true, wordCount };
}

/**
 * Chunk PDF-extracted text and index it into the RAG user knowledge base.
 *
 * Wires js/rag/rag-core.js's chunkText() (for the returned chunk count)
 * and js/rag/user-knowledge-store.js's addUserDocument() (which performs
 * the actual chunking + insertion into the in-memory knowledge base)
 * together behind a single PDF-flavored entry point.
 *
 * @param {string} extractedText - The full text extracted from the PDF by PDF.js.
 * @param {string} fileName - The original PDF file name.
 * @param {{ chunkSize?: number, overlap?: number, sourceName?: string }} [options]
 * @returns {{
 *   sourceName: string,
 *   chunkCount: number,
 *   wordCount: number,
 *   status: 'indexed',
 *   availableForCitations: true,
 *   note: string
 * }}
 */
function preparePDFForRAG(extractedText, fileName, options = {}) {
  const chunkSize = options.chunkSize || 200;
  const overlap = options.overlap || 20;
  const sourceName = options.sourceName || fileName;

  const text = typeof extractedText === 'string' ? extractedText : '';
  const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

  const previewChunks = chunkText(text, chunkSize, overlap, sourceName);
  addUserDocument(text, sourceName);

  return {
    sourceName,
    chunkCount: previewChunks.length,
    wordCount,
    status: 'indexed',
    availableForCitations: true,
    note: 'Embeddings will be computed by the WebWorker bridge. Citations are available after embedding completes.',
  };
}

/**
 * Build a display-ready summary of a completed PDF ingestion, for the
 * tab strip chip and any chat/UI messaging.
 *
 * @param {ReturnType<typeof buildPDFManifest>} manifest
 * @param {ReturnType<typeof preparePDFForRAG>} prepResult
 * @returns {{ headline: string, detail: string, chipLabel: string }}
 */
function buildPDFIngestionSummary(manifest, prepResult) {
  const fileName = manifest && manifest.fileName;
  const wordCount = prepResult && prepResult.wordCount;
  const chunkCount = prepResult && prepResult.chunkCount;

  return {
    headline: `${fileName} — ${wordCount} words indexed in ${chunkCount} chunks`,
    detail: 'Available as a citation source for validation findings. Ask the agent about this document.',
    chipLabel: `${chunkCount} chunks`,
  };
}

export {
  buildPDFManifest,
  validatePDFText,
  preparePDFForRAG,
  buildPDFIngestionSummary,
};

// ============================================================
// DATAGLOW — Cleaning Crew: PDF Profiler station (Batch 1 of N)
// ============================================================
// WHAT THIS IS: the FIRST station of "the DataGlow Cleaning Crew" — an on-device,
// multi-agent ingestion pipeline (Profiler → Extractor → Cleaner → Validator →
// Documenter). Batch 1 ships ONLY the PROFILER, for exactly ONE new format: PDF
// text extraction via PDF.js. It answers a single question about an uploaded PDF —
// "how much of this is actually extractable text vs. scanned images?" — and hands
// the extracted per-page text on as an ordinary queryable dataset.
//
// DELIBERATELY OUT OF SCOPE (future batches): OCR (Tesseract.js) for scanned
// pages, audio (Whisper), the Extractor/Cleaner/Validator/Documenter stations,
// semantic chunking/embeddings/vector stores, and any persistence of past runs.
//
// Identity split (same convention as js/runtimes-viz/glow-canvas.js and
// js/drill-floor/drill-floor.js): the summarization, warning, row-shaping and
// readiness-gate wiring are PURE, deterministic, DOM-free and Node-testable —
// they take ALREADY-EXTRACTED per-page text as plain data. Only ensurePdfjs()
// (a lazy CDN loader) and profilePdf() (real PDF.js parsing) touch the browser,
// exactly like python-runtime.js's loadPyodideScript()/initPyodideRuntime(); those
// two are browser-only and are NOT unit-tested in Node.
//
// ZERO cloud calls: PDF.js parses entirely client-side in a Web Worker. Nothing
// about a PDF ever leaves the browser. No AI API keys, no network egress.

import { computeReadinessGate, explainGateReasons } from '../gate/readiness-gate.js';

// Stable UMD build of PDF.js. v4+ ships ESM-only (pdf.min.mjs), which does not
// expose a global via a classic <script> tag; the v3 UMD build sets the global
// `pdfjsLib`, mirroring how python-runtime.js's loadPyodideScript() relies on a
// script-set global (`loadPyodide`). The matching worker is loaded from the same
// versioned path so the API and worker never drift.
const PDFJS_VERSION = '3.11.174';
const PDFJS_CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;

// ---------- PURE: summarize already-extracted per-page text ----------

// Trim + coerce a page's text to a plain string (defensive against null/undefined
// or non-string content that a runtime might hand back for an empty page).
function pageText(text) {
  return typeof text === 'string' ? text : '';
}

/**
 * Summarize an array of already-extracted per-page results into the profile the
 * Profiler station reports. PURE — takes plain data, never touches PDF.js/DOM,
 * never throws. A page "has text" when its extracted text is non-empty after
 * trimming (a page whose text layer yielded only whitespace counts as no text).
 *
 * @param {Array<{page:number, text:string}>} pages per-page extracted text
 * @returns {{
 *   pageCount:number,
 *   pagesWithText:number,
 *   pagesWithoutText:number,
 *   extractedText:Array<{page:number, text:string}>,
 *   hasExtractableText:boolean,
 *   warnings:string[]
 * }}
 */
export function summarizePdfProfile(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const extractedText = list.map((p, i) => ({
    page: Number.isFinite(p && p.page) ? p.page : i + 1,
    text: pageText(p && p.text),
  }));
  const pageCount = extractedText.length;
  const pagesWithText = extractedText.filter((p) => p.text.trim().length > 0).length;
  const pagesWithoutText = pageCount - pagesWithText;
  const hasExtractableText = pagesWithText > 0;

  const warnings = [];
  if (pageCount === 0) {
    warnings.push('No pages were found in this PDF.');
  } else if (pagesWithoutText === pageCount) {
    warnings.push(
      `No extractable text found across all ${pageCount} page(s) (this PDF is likely ` +
      `scanned images) — OCR support is not yet available.`,
    );
  } else if (pagesWithoutText > 0) {
    warnings.push(
      `${pagesWithoutText} of ${pageCount} page(s) have no extractable text (likely ` +
      `scanned images) — OCR support is not yet available.`,
    );
  }

  return { pageCount, pagesWithText, pagesWithoutText, extractedText, hasExtractableText, warnings };
}

/**
 * Shape a profile into rows for loadRowsAsDataset — one row per page so the PDF's
 * text becomes an ordinary queryable table (columns: page_number, text). PURE.
 * Every page yields a row (scanned pages get an empty text string) so the row
 * count always equals the page count — nothing is silently dropped.
 * @param {ReturnType<typeof summarizePdfProfile>} profile
 * @returns {Array<{page_number:number, text:string}>}
 */
export function pdfProfileToRows(profile) {
  const pages = (profile && Array.isArray(profile.extractedText)) ? profile.extractedText : [];
  return pages.map((p) => ({ page_number: p.page, text: p.text }));
}

// The columns of the dataset a profiled PDF becomes.
export const PDF_DATASET_COLUMNS = ['page_number', 'text'];

/**
 * Translate a profile into readiness-gate layer results (the {layer,status,summary}
 * shape computeReadinessGate consumes). PURE. The gate treats:
 *   - zero extractable text across all pages -> a hard 'fail' (gate BLOCKS);
 *   - some pages without text (but not all)  -> a 'warn' alongside a 'pass'
 *     (gate PASSES with a warning);
 *   - all pages with text                    -> a single 'pass'.
 * @param {ReturnType<typeof summarizePdfProfile>} profile
 * @returns {Array<{layer:string, status:string, summary:string}>}
 */
export function buildPdfGateLayers(profile) {
  const p = profile || {};
  const pageCount = Number(p.pageCount) || 0;
  const layers = [];
  if (p.hasExtractableText) {
    layers.push({
      layer: 'PDF text extraction',
      status: 'pass',
      summary: `Extracted text from ${p.pagesWithText} of ${pageCount} page(s).`,
    });
    if (Number(p.pagesWithoutText) > 0) {
      layers.push({
        layer: 'PDF page coverage',
        status: 'warn',
        summary: `${p.pagesWithoutText} of ${pageCount} page(s) have no extractable text ` +
          `(likely scanned images) — OCR support is not yet available.`,
      });
    }
  } else {
    layers.push({
      layer: 'PDF text extraction',
      status: 'fail',
      summary: pageCount === 0
        ? 'No pages were found in this PDF.'
        : `No extractable text found across all ${pageCount} page(s) — this PDF is likely ` +
          `scanned images and OCR support is not yet available.`,
    });
  }
  return layers;
}

/**
 * Run the AI Readiness Gate over a PDF profile. PURE (delegates to the pure gate
 * module) — never throws. Returns the gate verdict plus a human-readable
 * explanation, so a caller can both branch on `gate.agentConsumable` and show the
 * reasons. Zero extractable text -> agentConsumable:false; partial text ->
 * agentConsumable:true with a warning surfaced.
 * @param {ReturnType<typeof summarizePdfProfile>} profile
 * @param {object} [options] forwarded to computeReadinessGate (e.g. {threshold})
 * @returns {{gate:object, explanation:string, layers:Array}}
 */
export function evaluatePdfReadiness(profile, options = {}) {
  const layers = buildPdfGateLayers(profile);
  const gate = computeReadinessGate(layers, null, options);
  return { gate, explanation: explainGateReasons(gate), layers };
}

// ---------- BROWSER-ONLY: lazy PDF.js loader + real parsing ----------

let pdfjsScriptPromise = null;

// PDF.js is a large runtime, so its loader is fetched from the CDN on demand —
// only when the FIRST PDF is actually profiled — never eagerly on tab open or app
// load. Mirrors python-runtime.js's loadPyodideScript(): check the script-set
// global first, else inject a classic <script> with onload/onerror, then point the
// worker at the matching versioned CDN file. Returns the loaded pdfjsLib global.
export function ensurePdfjs() {
  if (typeof pdfjsLib !== 'undefined') {
    ensurePdfWorker(pdfjsLib);
    return Promise.resolve(pdfjsLib);
  }
  if (!pdfjsScriptPromise) {
    pdfjsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${PDFJS_CDN_BASE}pdf.min.js`;
      script.onload = () => {
        if (typeof pdfjsLib === 'undefined') {
          reject(new Error('PDF.js loaded but did not expose the pdfjsLib global.'));
          return;
        }
        ensurePdfWorker(pdfjsLib);
        resolve(pdfjsLib);
      };
      script.onerror = () => reject(new Error('Failed to load the PDF.js runtime from the CDN.'));
      document.head.appendChild(script);
    });
  }
  return pdfjsScriptPromise;
}

function ensurePdfWorker(lib) {
  if (lib && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN_BASE}pdf.worker.min.js`;
  }
}

/**
 * Profile a PDF File: lazily load PDF.js, extract text from every page, and
 * return the summarized profile. BROWSER-ONLY (real PDF.js parsing) — not covered
 * by Node tests, exactly like Pyodide/WebR. The pure summarization it delegates to
 * (summarizePdfProfile) IS tested against injected per-page text.
 * @param {File|Blob} file the uploaded PDF
 * @returns {Promise<ReturnType<typeof summarizePdfProfile>>}
 */
export async function profilePdf(file) {
  const lib = await ensurePdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = (content.items || []).map((it) => (it && it.str) || '').join(' ').trim();
    pages.push({ page: n, text });
  }
  return summarizePdfProfile(pages);
}

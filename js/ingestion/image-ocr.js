// ============================================================
// DATAGLOW — Image OCR (Tesseract.js, client-side, zero upload)
// ============================================================
// Extracts text from image files (.png, .jpg, .jpeg, .webp, .bmp, .gif)
// using Tesseract.js running entirely in the browser — no cloud call,
// no upload, no API key. Raw OCR text is then passed through the
// text-line-parser to produce {line_number, content} rows for DuckDB.
//
// Architecture (same split as audio-structurer.js and pdf-profiler.js):
//   - PURE exports (testable in Node): parseOcrText, buildOcrDataset,
//     inferOcrKind, scoreOcrConfidence
//   - Browser-only: ensureTesseract(), runOcr(imageFile) — not exported
//     from this module for test purposes
//
// Zero-upload guarantee: Tesseract.js runs as a Web Worker in the browser.
// The image bytes never leave the device.
// ============================================================

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];
export const IMAGE_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];

/**
 * Whether a file name looks like a supported image.
 */
export function isImageFile(fileName) {
  if (typeof fileName !== 'string') return false;
  const ext = /\.[^./\\]+$/.exec(fileName.toLowerCase());
  return ext ? IMAGE_EXTENSIONS.includes(ext[0]) : false;
}

/**
 * Parse raw OCR text output into line-numbered rows.
 * Reuses the same shape as text-line-parser for consistency.
 * @param {string} rawText - raw string from Tesseract
 * @param {object} [opts]
 * @param {boolean} [opts.skipEmpty=true]
 * @returns {{ rows: Array<{line_number: number, content: string}>, lineCount: number, skippedEmpty: number }}
 */
export function parseOcrText(rawText, opts = {}) {
  const { skipEmpty = true } = opts;
  if (typeof rawText !== 'string') return { rows: [], lineCount: 0, skippedEmpty: 0 };
  const lines = rawText.split('\n');
  const rows = [];
  let skippedEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i].replace(/\r$/, '');
    if (skipEmpty && content.trim() === '') { skippedEmpty++; continue; }
    rows.push({ line_number: rows.length + 1, content });
  }
  return { rows, lineCount: lines.length, skippedEmpty };
}

/**
 * Infer what kind of content was OCR'd from the extracted lines.
 * Returns 'table' | 'form' | 'prose' | 'code' | 'mixed' | 'unknown'.
 */
export function inferOcrKind(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return 'unknown';
  const sample = lines.slice(0, 30).map(l => (typeof l === 'string' ? l : l.content || ''));
  const tabularPattern = /\s{2,}|\t|\|/; // multiple spaces, tabs, pipe separators
  const formPattern = /:\s*$|:\s+\w/; // "Label: value" or "Field:"
  const codePattern = /^\s*(def |function |SELECT |FROM |import |var |const |let |if \(|for \()/i;
  const numericPattern = /^\s*[\d,.$%()+-]+\s*$/;
  let tabHits = 0, formHits = 0, codeHits = 0, numHits = 0;
  for (const line of sample) {
    if (tabularPattern.test(line)) tabHits++;
    if (formPattern.test(line)) formHits++;
    if (codePattern.test(line)) codeHits++;
    if (numericPattern.test(line)) numHits++;
  }
  if (codeHits >= 3) return 'code';
  if (tabHits >= Math.floor(sample.length * 0.4) || numHits >= Math.floor(sample.length * 0.4)) return 'table';
  if (formHits >= 3) return 'form';
  if (sample.every(l => l.trim().length > 30)) return 'prose';
  return 'mixed';
}

/**
 * Score OCR confidence from Tesseract's word-level confidence array.
 * Returns { mean, low, grade: 'high'|'medium'|'low'|'poor' }.
 */
export function scoreOcrConfidence(confidences) {
  if (!Array.isArray(confidences) || confidences.length === 0) {
    return { mean: 0, low: 0, grade: 'poor' };
  }
  const nums = confidences.filter(n => typeof n === 'number' && n >= 0);
  if (nums.length === 0) return { mean: 0, low: 0, grade: 'poor' };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const low = Math.min(...nums);
  const grade = mean >= 85 ? 'high' : mean >= 70 ? 'medium' : mean >= 50 ? 'low' : 'poor';
  return { mean: Math.round(mean * 10) / 10, low: Math.round(low * 10) / 10, grade };
}

/**
 * Build a DataGlow-compatible dataset from OCR results.
 */
export function buildOcrDataset(parsed, fileName, kind, confidenceScore) {
  const gradeNote = {
    high: 'OCR confidence is high — text extraction is reliable.',
    medium: 'OCR confidence is moderate — review extracted text for accuracy.',
    low: 'OCR confidence is low — image may be blurry or low-resolution. Verify key values.',
    poor: 'OCR confidence is very low — consider using a higher-resolution image.'
  };
  return {
    columns: ['line_number', 'content'],
    rows: parsed.rows,
    meta: {
      source: fileName,
      format: 'image',
      kind,
      lineCount: parsed.lineCount,
      skippedEmpty: parsed.skippedEmpty,
      ocrConfidence: confidenceScore,
      note: `Image OCR (Tesseract.js, client-side). ${gradeNote[confidenceScore?.grade || 'poor']} Content detected as: ${kind}.`
    }
  };
}

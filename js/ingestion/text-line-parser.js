// ============================================================
// DATAGLOW — Text / Log Line Parser
// ============================================================
// Converts plain text (.txt, .log) into a queryable row dataset.
// Each line becomes one row: { line_number, content }.
// Empty lines are preserved as rows with empty content so line
// numbers stay accurate. Pure logic — no browser APIs, no async,
// Node-testable.
//
// Zero-upload / local-first: caller already has the text in memory.
// ============================================================

/**
 * Parse a plain text string into an array of row objects.
 * @param {string} text - full file content as a string
 * @param {object} [opts]
 * @param {boolean} [opts.skipEmpty=false] - if true, omit blank lines
 * @param {number} [opts.maxLines=500000] - hard cap (safety)
 * @returns {{ rows: Array<{line_number: number, content: string}>, lineCount: number, skippedEmpty: number }}
 */
export function parseTextLines(text, opts = {}) {
  const { skipEmpty = false, maxLines = 500_000 } = opts;
  if (typeof text !== 'string') return { rows: [], lineCount: 0, skippedEmpty: 0 };

  const raw = text.split('\n');
  const rows = [];
  let skippedEmpty = 0;

  for (let i = 0; i < raw.length && rows.length < maxLines; i++) {
    const content = raw[i].replace(/\r$/, ''); // strip Windows \r
    if (skipEmpty && content.trim() === '') {
      skippedEmpty++;
      continue;
    }
    rows.push({ line_number: i + 1, content });
  }

  return { rows, lineCount: raw.length, skippedEmpty };
}

/**
 * Infer whether a text file looks like a structured log (has timestamps,
 * severity levels, or bracket patterns) vs. freeform prose.
 * Returns 'log' | 'prose' | 'delimited' | 'unknown'.
 * @param {string[]} sampleLines - first 20 lines
 * @returns {'log'|'prose'|'delimited'|'unknown'}
 */
export function inferTextKind(sampleLines) {
  if (!Array.isArray(sampleLines) || sampleLines.length === 0) return 'unknown';
  const sample = sampleLines.slice(0, 20);
  const tsPattern = /^\d{4}-\d{2}-\d{2}|^\[\d{2}[:/]\d{2}/;
  const severityPattern = /\b(INFO|WARN|WARNING|ERROR|DEBUG|CRITICAL|FATAL|TRACE)\b/i;
  const delimPattern = /\t|,(?=\S)/;
  let tsHits = 0, sevHits = 0, delimHits = 0;
  for (const line of sample) {
    if (tsPattern.test(line)) tsHits++;
    if (severityPattern.test(line)) sevHits++;
    if (delimPattern.test(line)) delimHits++;
  }
  if (tsHits >= 3 || sevHits >= 3) return 'log';
  if (delimHits >= Math.floor(sample.length * 0.7)) return 'delimited';
  if (sample.every(l => l.trim().length > 40)) return 'prose';
  return 'unknown';
}

/**
 * Build a DataGlow-compatible dataset summary from parsed text rows.
 * @param {{ rows: Array<{line_number:number,content:string}>, lineCount:number }} parsed
 * @param {string} fileName
 * @param {'log'|'prose'|'delimited'|'unknown'} kind
 * @returns {{ columns: string[], rows: object[], meta: object }}
 */
export function buildTextDataset(parsed, fileName, kind) {
  return {
    columns: ['line_number', 'content'],
    rows: parsed.rows,
    meta: {
      source: fileName,
      format: 'txt',
      kind,
      lineCount: parsed.lineCount,
      skippedEmpty: parsed.skippedEmpty || 0,
      note: kind === 'log'
        ? 'Log file detected — timestamps and severity levels present. Query content for patterns.'
        : kind === 'delimited'
        ? 'Delimited text detected — consider renaming to .csv or .tsv for richer column parsing.'
        : 'Plain text loaded as line-numbered rows. Use SQL LIKE/REGEXP on content column.'
    }
  };
}

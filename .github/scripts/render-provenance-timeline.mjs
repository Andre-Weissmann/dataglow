// ============================================================
// DATAGLOW — Provenance timeline renderer (GENERATED FILE WRITER)
// ============================================================
// Part of the "living manifest" automation. It reads the repository's own git
// history and renders a plain, chronological timeline of what shipped, grouped
// by month, into docs/PROVENANCE_TIMELINE.md.
//
// APPROACH (deliberately simple v1): this renders a markdown timeline table from
// merge/commit dates + subjects + PR numbers parsed out of `git log`. It does NOT
// try to reuse js/visualize.js, which is a browser-only chart builder that
// depends on the DOM and Plotly and cannot run standalone in Node/CI; forcing it
// into a headless context would add a browser dependency to a docs job for no
// real gain. A markdown table renders natively on GitHub, needs no runtime, and
// stays diff-friendly. Cross-referencing each commit to the capability areas it
// changed is intentionally left out of v1 (see the ticket) to avoid
// over-engineering; the capability dashboard already ties areas to code.
//
// The parsing/rendering (`parseLog`, `renderTimeline`) are pure functions so they
// are unit-testable and side-effect free; only the CLI shells out to `git` and
// writes the file. It NEVER touches runtime app code.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT_NAME = join('docs', 'PROVENANCE_TIMELINE.md');
// NUL-delimited fields per record, NUL-NUL between records — robust against any
// character (including newlines and pipes) appearing inside a commit subject.
const LOG_FORMAT = '%H%x1f%aI%x1f%s%x1e';

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Parse `git log` output produced with LOG_FORMAT into structured records.
 * Pure — takes the raw string, returns an array newest-first.
 * @param {string} raw
 * @returns {Array<{hash:string, dateISO:string, subject:string, pr:number|null}>}
 */
export function parseLog(raw) {
  const records = [];
  for (const chunk of raw.split('\x1e')) {
    const rec = chunk.replace(/^\s+/, '');
    if (!rec) continue;
    const [hash, dateISO, subject = ''] = rec.split('\x1f');
    if (!hash || !dateISO) continue;
    const m = subject.match(/\(#(\d+)\)\s*$/);
    records.push({
      hash: hash.trim(),
      dateISO: dateISO.trim(),
      subject: subject.trim(),
      pr: m ? Number(m[1]) : null,
    });
  }
  return records;
}

const REPO_URL = 'https://github.com/Andre-Weissmann/dataglow';

function monthKey(dateISO) {
  return dateISO.slice(0, 7); // YYYY-MM
}

/**
 * Render parsed records as a markdown timeline grouped by month. Pure.
 * @param {Array<{hash:string, dateISO:string, subject:string, pr:number|null}>} records
 * @param {{generatedAt?: string}} [opts]
 * @returns {string}
 */
export function renderTimeline(records, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [];
  lines.push('# DATAGLOW — Provenance timeline');
  lines.push('');
  lines.push(
    'A chronological record of what shipped, generated from this repository\'s git ' +
      'history (commit dates, subjects, and PR numbers). Newest first, grouped by ' +
      'month. This file is generated on every merge to `main` — do not edit it by ' +
      'hand; run `npm run docs:provenance`.'
  );
  lines.push('');
  lines.push(`- Generated: \`${generatedAt}\``);
  lines.push(`- Commits recorded: **${records.length}**`);
  lines.push('');

  if (records.length === 0) {
    lines.push('_No commit history available (a shallow clone with no history will be empty; the CI job checks out full history)._');
    lines.push('');
    return lines.join('\n');
  }

  let currentMonth = null;
  for (const r of records) {
    const mk = monthKey(r.dateISO);
    if (mk !== currentMonth) {
      if (currentMonth !== null) lines.push('');
      lines.push(`## ${mk}`);
      lines.push('');
      lines.push('| Date | PR | Change |');
      lines.push('| --- | --- | --- |');
      currentMonth = mk;
    }
    const date = r.dateISO.slice(0, 10);
    const pr = r.pr ? `[#${r.pr}](${REPO_URL}/pull/${r.pr})` : '—';
    // Strip the trailing "(#NN)" from the subject since the PR gets its own column.
    const change = escapeCell(r.subject.replace(/\s*\(#\d+\)\s*$/, ''));
    lines.push(`| ${date} | ${pr} | ${change} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- CLI: read git history, render timeline, write if changed --------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.PROVENANCE_ROOT || process.cwd();
  let raw = '';
  try {
    raw = execFileSync('git', ['-C', root, 'log', '--no-merges', `--format=${LOG_FORMAT}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    process.stderr.write(`error: git log failed: ${e.message}\n`);
    process.exit(1);
  }

  const records = parseLog(raw);
  const md = renderTimeline(records);
  const outPath = join(root, OUT_NAME);

  const { readFileSync } = await import('node:fs');
  const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
  // Ignore the volatile "Generated:" line when deciding whether to rewrite, so an
  // unchanged history doesn't produce a churn commit every run.
  const strip = (s) => (s == null ? s : s.replace(/- Generated: `[^`]*`/, ''));
  if (strip(prev) === strip(md)) {
    process.stdout.write('provenance timeline already up to date.\n');
    process.exit(0);
  }
  writeFileSync(outPath, md);
  process.stdout.write(`provenance timeline written to ${OUT_NAME} (${records.length} commits).\n`);
  process.exit(0);
}

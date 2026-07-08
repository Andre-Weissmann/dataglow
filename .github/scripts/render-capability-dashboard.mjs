// ============================================================
// DATAGLOW — README capability dashboard renderer (GENERATED FILE WRITER)
// ============================================================
// Part of the "living manifest" automation. It reads the SAME hand-authored
// source of truth that the capability-map drift gate validates
// (capability-map.manifest.json) and renders a plain markdown table of every
// documented capability into README.md, between two HTML comment markers:
//
//   <!-- CAPABILITY_TABLE_START --> ... <!-- CAPABILITY_TABLE_END -->
//
// Because it renders from the exact file capability-drift.mjs checks, the README
// table can never silently disagree with the gated manifest. The rendering
// (`renderTable`) and the marker splice (`spliceReadme`) are pure functions so
// they are unit-testable and have no side effects; only the CLI at the bottom
// touches the filesystem, and only when the content actually changed.
//
// This script writes README.md but NEVER touches runtime app code (js/,
// index.html, css/, sw.js, manifest.webmanifest) — it is docs automation only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'capability-map.manifest.json';
const README_NAME = 'README.md';
export const START_MARKER = '<!-- CAPABILITY_TABLE_START -->';
export const END_MARKER = '<!-- CAPABILITY_TABLE_END -->';

function escapeCell(s) {
  // Escape the one character that would break a markdown table cell.
  return String(s).replace(/\|/g, '\\|');
}

/**
 * Render the capability table as markdown. Pure — no I/O.
 * Columns: Capability area | Name | Files. The area is shown once per group and
 * left blank on subsequent rows so the grouping reads cleanly; rows preserve the
 * manifest order so the table is deterministic.
 * @param {{capabilities?: Array<{area?:string,name?:string,id?:string,files?:string[]}>}} manifest
 * @returns {string}
 */
export function renderTable(manifest) {
  const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  const lines = [];
  lines.push('| Capability area | Name | Files |');
  lines.push('| --- | --- | --- |');

  let prevArea = null;
  for (const cap of caps) {
    const area = cap.area || '(uncategorized)';
    const name = cap.name || cap.id || '(unnamed)';
    const files = Array.isArray(cap.files) ? cap.files : [];
    const areaCell = area === prevArea ? '' : escapeCell(area);
    const filesCell = files.length
      ? files.map((f) => `\`${escapeCell(f)}\``).join(', ')
      : '_none_';
    lines.push(`| ${areaCell} | ${escapeCell(name)} | ${filesCell} |`);
    prevArea = area;
  }

  const areaCount = new Set(caps.map((c) => c.area || '(uncategorized)')).size;
  lines.push('');
  lines.push(
    `_${caps.length} capabilities across ${areaCount} areas, generated from ` +
      `\`${MANIFEST_NAME}\` — the same file the capability-map drift gate validates. ` +
      'Do not edit by hand; run `npm run docs:dashboard`._'
  );
  return lines.join('\n');
}

/**
 * Splice a freshly rendered table between the markers in an existing README.
 * Pure — takes the current README text, returns the new text. Throws if the
 * markers are missing or out of order (the workflow should fail loudly rather
 * than silently append).
 * @param {string} readme
 * @param {string} table
 * @returns {string}
 */
export function spliceReadme(readme, table) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `README markers not found. Expected ${START_MARKER} and ${END_MARKER} in ${README_NAME}.`
    );
  }
  if (end < start) {
    throw new Error(`README markers out of order: ${END_MARKER} appears before ${START_MARKER}.`);
  }
  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${table}\n${after}`;
}

// --- CLI: rewrite README between markers if the table changed --------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.DASHBOARD_ROOT || process.cwd();
  const manifestPath = join(root, MANIFEST_NAME);
  const readmePath = join(root, README_NAME);

  if (!existsSync(manifestPath)) {
    process.stderr.write(`error: manifest not found: ${MANIFEST_NAME}\n`);
    process.exit(1);
  }
  if (!existsSync(readmePath)) {
    process.stderr.write(`error: ${README_NAME} not found\n`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const readme = readFileSync(readmePath, 'utf8');
  const table = renderTable(manifest);
  const next = spliceReadme(readme, table);

  if (next === readme) {
    process.stdout.write('capability dashboard already up to date.\n');
    process.exit(0);
  }
  writeFileSync(readmePath, next);
  process.stdout.write('capability dashboard regenerated in README.md.\n');
  process.exit(0);
}

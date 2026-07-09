// ============================================================
// DATAGLOW — Wiki-gap detector (ISSUE OPENER, no content generation)
// ============================================================
// Part of the "living manifest" automation. It compares the distinct capability
// AREAS in capability-map.manifest.json (the gated source of truth) against a
// maintainer-kept list of areas that already have a wiki page
// (docs/wiki-coverage.json). For every area in the manifest but NOT in that
// coverage list, it opens a GitHub issue titled "Wiki page needed: <area>" so
// the gap becomes a visible backlog item. It deliberately does NOT write any wiki
// content — a human decides what the page says.
//
// Safety:
//   * Idempotent — before creating an issue it searches existing issues (any
//     state) for the exact title and skips if one is already there, so re-running
//     on every merge does not spam duplicates.
//   * Per-run cap (WIKI_GAP_MAX_NEW, default 5) bounds how many new issues a
//     single run can open, so seeding a large backlog fills in gradually across
//     merges instead of dumping dozens of issues at once.
//   * DRY_RUN=1 prints what it would do and calls no gh mutation.
//
// Gap computation (`findGaps`) is a pure function so it is unit-testable; only the
// CLI shells out to `gh`. This script never touches runtime app code.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST_NAME = 'capability-map.manifest.json';
const COVERAGE_NAME = join('docs', 'wiki-coverage.json');

/**
 * Compute the capability areas present in the manifest but absent from the
 * coverage list. Pure. Returns area names in first-seen manifest order.
 * @param {{capabilities?: Array<{area?:string}>}} manifest
 * @param {{documented?: string[]}} coverage
 * @returns {string[]}
 */
export function findGaps(manifest, coverage) {
  const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  const documented = new Set(
    (Array.isArray(coverage?.documented) ? coverage.documented : []).map((s) => String(s).trim())
  );
  const gaps = [];
  const seen = new Set();
  for (const cap of caps) {
    const area = (cap.area || '').trim();
    if (!area || seen.has(area)) continue;
    seen.add(area);
    if (!documented.has(area)) gaps.push(area);
  }
  return gaps;
}

export function issueTitle(area) {
  return `Wiki page needed: ${area}`;
}

function issueBody(area, files) {
  const fileList = files.length
    ? files.map((f) => `- \`${f}\``).join('\n')
    : '_(no backing files listed in the manifest)_';
  return [
    `The **${area}** capability area is defined in \`${MANIFEST_NAME}\` but has no wiki page yet.`,
    '',
    'This issue was opened automatically by the wiki-gap detector',
    `(\`.github/scripts/wiki-gap-detector.mjs\`) so the gap is a tracked backlog item.`,
    'It does not contain the page — a maintainer writes that.',
    '',
    'Backing modules for this area (from the capability map):',
    '',
    fileList,
    '',
    '---',
    'When the wiki page for this area is written, add the area name to the',
    `\`documented\` array in \`${COVERAGE_NAME}\` so the detector stops filing this issue.`,
  ].join('\n');
}

/** Files mapped to an area, deduped, for the issue body. */
function filesForArea(manifest, area) {
  const out = [];
  const seen = new Set();
  for (const cap of manifest.capabilities || []) {
    if ((cap.area || '').trim() !== area) continue;
    for (const f of cap.files || []) {
      if (!seen.has(f)) { seen.add(f); out.push(f); }
    }
  }
  return out;
}

function issueExists(title) {
  // Search titles only; check any state so a closed "won't do" issue isn't reopened.
  const out = execFileSync(
    'gh',
    ['issue', 'list', '--state', 'all', '--search', `in:title ${title}`, '--json', 'title', '--limit', '100'],
    { encoding: 'utf8' }
  );
  let rows = [];
  try { rows = JSON.parse(out); } catch { rows = []; }
  return rows.some((r) => (r.title || '').trim() === title.trim());
}

// --- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = process.env.WIKI_GAP_ROOT || process.cwd();
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const maxNew = Number(process.env.WIKI_GAP_MAX_NEW || 5);

  const manifestPath = join(root, MANIFEST_NAME);
  const coveragePath = join(root, COVERAGE_NAME);
  if (!existsSync(manifestPath)) {
    process.stderr.write(`error: manifest not found: ${MANIFEST_NAME}\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const coverage = existsSync(coveragePath)
    ? JSON.parse(readFileSync(coveragePath, 'utf8'))
    : { documented: [] };

  const gaps = findGaps(manifest, coverage);
  process.stdout.write(`wiki-gap detector: ${gaps.length} area(s) without a wiki page.\n`);
  if (gaps.length === 0) {
    process.stdout.write('all capability areas are covered.\n');
    process.exit(0);
  }

  let created = 0;
  let skipped = 0;
  for (const area of gaps) {
    if (created >= maxNew) {
      process.stdout.write(`reached per-run cap (WIKI_GAP_MAX_NEW=${maxNew}); ${gaps.length - created - skipped} gap(s) deferred to a later run.\n`);
      break;
    }
    const title = issueTitle(area);

    if (dryRun) {
      process.stdout.write(`[dry-run] would ensure issue: "${title}"\n`);
      continue;
    }

    let exists = false;
    try { exists = issueExists(title); }
    catch (e) { process.stderr.write(`warning: issue search failed for "${title}": ${e.message}\n`); }
    if (exists) {
      process.stdout.write(`exists, skipping: "${title}"\n`);
      skipped += 1;
      continue;
    }

    const body = issueBody(area, filesForArea(manifest, area));
    try {
      const url = execFileSync(
        'gh',
        ['issue', 'create', '--title', title, '--body', body, '--label', 'documentation'],
        { encoding: 'utf8' }
      ).trim();
      process.stdout.write(`created: ${url}\n`);
      created += 1;
    } catch (e) {
      // A missing label shouldn't block the backlog item; retry without it.
      try {
        const url = execFileSync('gh', ['issue', 'create', '--title', title, '--body', body], {
          encoding: 'utf8',
        }).trim();
        process.stdout.write(`created (no label): ${url}\n`);
        created += 1;
      } catch (e2) {
        process.stderr.write(`error: failed to create issue "${title}": ${e2.message}\n`);
      }
    }
  }

  process.stdout.write(`done: ${created} created, ${skipped} already existed.\n`);
  process.exit(0);
}

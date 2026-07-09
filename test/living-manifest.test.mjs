// ============================================================
// DATAGLOW — Living-manifest automation test suite
// ============================================================
// Unit-tests the PURE functions behind the "living manifest" docs automation:
//   * render-capability-dashboard.mjs — renderTable / spliceReadme
//   * render-provenance-timeline.mjs   — parseLog / renderTimeline
//   * wiki-gap-detector.mjs            — findGaps / issueTitle
// None of these touch the network or `gh`; only the CLI wrappers do, and those
// are not exercised here. Fixtures are inline objects/strings so the assertions
// are deterministic and never depend on the real tree.
//
// RUN WITH:  node test/living-manifest.test.mjs

import { renderTable, spliceReadme, START_MARKER, END_MARKER } from '../.github/scripts/render-capability-dashboard.mjs';
import { parseLog, renderTimeline } from '../.github/scripts/render-provenance-timeline.mjs';
import { findGaps, issueTitle } from '../.github/scripts/wiki-gap-detector.mjs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // --- renderTable -----------------------------------------------------------
  {
    const manifest = {
      capabilities: [
        { id: 'a1', area: 'Area One', name: 'First', files: ['js/a.js', 'js/b.js'] },
        { id: 'a2', area: 'Area One', name: 'Second', files: ['js/c.js'] },
        { id: 'b1', area: 'Area Two', name: 'Third', files: [] },
      ],
    };
    const table = renderTable(manifest);
    ok(table.includes('| Capability area | Name | Files |'), 'renderTable: has header row');
    ok(table.includes('| Area One | First | `js/a.js`, `js/b.js` |'), 'renderTable: first row shows area + files');
    ok(table.includes('|  | Second | `js/c.js` |'), 'renderTable: repeated area blanked on second row');
    ok(table.includes('| Area Two | Third | _none_ |'), 'renderTable: new area shown, empty files -> _none_');
    ok(table.includes('3 capabilities across 2 areas'), 'renderTable: footer counts areas and capabilities');
  }

  // --- renderTable escapes pipes --------------------------------------------
  {
    const table = renderTable({ capabilities: [{ area: 'A|B', name: 'n', files: [] }] });
    ok(table.includes('A\\|B'), 'renderTable: escapes pipe in area name');
  }

  // --- spliceReadme ----------------------------------------------------------
  {
    const readme = `# Title\n\n${START_MARKER}\nOLD CONTENT\n${END_MARKER}\n\n## After\n`;
    const next = spliceReadme(readme, 'NEW TABLE');
    ok(next.includes('NEW TABLE'), 'spliceReadme: inserts new content');
    ok(!next.includes('OLD CONTENT'), 'spliceReadme: removes old content');
    ok(next.startsWith('# Title'), 'spliceReadme: preserves text before markers');
    ok(next.trimEnd().endsWith('## After'), 'spliceReadme: preserves text after markers');
    ok(next.includes(START_MARKER) && next.includes(END_MARKER), 'spliceReadme: keeps both markers');
    // Idempotent: splicing the same table again is a no-op.
    ok(spliceReadme(next, 'NEW TABLE') === next, 'spliceReadme: idempotent for unchanged table');
  }
  {
    let threw = false;
    try { spliceReadme('# no markers here', 'X'); } catch { threw = true; }
    ok(threw, 'spliceReadme: throws when markers missing');
  }

  // --- parseLog --------------------------------------------------------------
  {
    const US = '\x1f', RS = '\x1e';
    const raw =
      `abc123${US}2026-07-08T12:00:00-05:00${US}Add optional Tauri v1 desktop shell (#44)${RS}` +
      `def456${US}2026-06-30T09:00:00-05:00${US}A plain commit with no PR${RS}`;
    const recs = parseLog(raw);
    ok(recs.length === 2, 'parseLog: parses two records');
    ok(recs[0].pr === 44, 'parseLog: extracts PR number from trailing (#NN)');
    ok(recs[1].pr === null, 'parseLog: null PR when no (#NN)');
    ok(recs[0].dateISO.startsWith('2026-07-08'), 'parseLog: keeps ISO date');
  }
  {
    // A subject containing a pipe/newline must not corrupt records (NUL-delimited).
    const US = '\x1f', RS = '\x1e';
    const raw = `h${US}2026-01-01T00:00:00Z${US}weird | subject (#7)${RS}`;
    const recs = parseLog(raw);
    ok(recs.length === 1 && recs[0].pr === 7, 'parseLog: tolerates pipe in subject');
  }

  // --- renderTimeline --------------------------------------------------------
  {
    const recs = [
      { hash: 'a', dateISO: '2026-07-08T12:00:00-05:00', subject: 'Add X (#44)', pr: 44 },
      { hash: 'b', dateISO: '2026-06-30T09:00:00-05:00', subject: 'Add Y (#40)', pr: 40 },
    ];
    const md = renderTimeline(recs, { generatedAt: '2026-07-08T00:00:00Z' });
    ok(md.includes('## 2026-07'), 'renderTimeline: groups by month (July)');
    ok(md.includes('## 2026-06'), 'renderTimeline: groups by month (June)');
    ok(md.includes('[#44](https://github.com/Andre-Weissmann/dataglow/pull/44)'), 'renderTimeline: links PR');
    ok(md.includes('| 2026-07-08 |') && md.includes('Add X |'), 'renderTimeline: row has date and stripped subject');
    ok(!md.includes('(#44)'), 'renderTimeline: strips trailing (#NN) from change column');
    ok(md.includes('Commits recorded: **2**'), 'renderTimeline: reports commit count');
  }
  {
    const md = renderTimeline([]);
    ok(md.includes('No commit history available'), 'renderTimeline: handles empty history');
  }

  // --- findGaps / issueTitle -------------------------------------------------
  {
    const manifest = {
      capabilities: [
        { area: 'Alpha' }, { area: 'Alpha' }, { area: 'Beta' }, { area: 'Gamma' },
      ],
    };
    ok(JSON.stringify(findGaps(manifest, { documented: [] })) === JSON.stringify(['Alpha', 'Beta', 'Gamma']),
      'findGaps: distinct areas in order when none documented');
    ok(JSON.stringify(findGaps(manifest, { documented: ['Beta'] })) === JSON.stringify(['Alpha', 'Gamma']),
      'findGaps: excludes documented areas');
    ok(findGaps(manifest, { documented: ['Alpha', 'Beta', 'Gamma'] }).length === 0,
      'findGaps: empty when all documented');
    ok(issueTitle('Alpha') === 'Wiki page needed: Alpha', 'issueTitle: expected format');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

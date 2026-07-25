// ============================================================
// DATAGLOW - Tests: GlassBox (Bundle 5, A15)
// ============================================================
// js/glassbox/glass-box.js models one panel: a finding, and underneath it the
// code that produced it. These tests pin the four promises the header makes:
//   1. finding first, proof underneath. The field order of the returned object
//      IS the reading order, so it is asserted literally
//   2. it never writes the code it shows. No source means an honest gap, never
//      a plausible reconstruction
//   3. it never grades. A gate that was not handed over cannot produce a
//      passing chip, and no badges at all means 'unknown', never 'good'
//   4. nothing here runs anything
//
// The gate fixtures are pushed through the REAL engines where one exists, so a
// change in publish-safe's verdict shape fails here rather than shipping a
// mislabelled chip.
//
// RUN WITH:  node test/glass-box.test.mjs

import assert from 'node:assert/strict';
import {
  GLASS_BOX_KIND,
  GLASS_BOX_VERSION,
  GLASS_BOX_LANGUAGES,
  GLASS_BOX_BADGE_LEVELS,
  GLASS_BOX_MAX_LINES,
  GLASS_BOX_DISCLAIMER,
  PUBLIC_API_SURFACE,
  truncateSource,
  glassBoxBadges,
  buildGlassBox,
  renderGlassBoxText,
  glassBoxToggleLabel,
  DataGlowGlassBox,
} from '../js/glassbox/glass-box.js';
import { evaluatePublishSafe } from '../js/gate/publish-safe.js';
import { computeReadinessGate } from '../js/gate/readiness-gate.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.message}`);
  }
}

const EM_DASH = '—';
const SQL = 'SELECT payer, SUM(amount) AS total\nFROM claims\nWHERE denied = true\nGROUP BY payer';

// ---- constants ----

await test('the kind, languages and badge levels are the contract a surface reads', () => {
  assert.equal(GLASS_BOX_KIND, 'dataglow-glass-box');
  assert.equal(GLASS_BOX_VERSION, 1);
  assert.deepEqual([...GLASS_BOX_LANGUAGES], ['sql', 'python', 'r', 'text']);
  assert.deepEqual([...GLASS_BOX_BADGE_LEVELS], ['good', 'warn', 'bad', 'unknown']);
  assert.ok(GLASS_BOX_MAX_LINES > 0);
});

await test('the disclaimer says reading the code is the only way to be sure', () => {
  assert.match(GLASS_BOX_DISCLAIMER, /only way to be sure/);
  assert.ok(!GLASS_BOX_DISCLAIMER.includes(EM_DASH));
});

// ---- truncation ----

await test('short source is shown whole and is not called truncated', () => {
  const cut = truncateSource(SQL);
  assert.equal(cut.truncated, false);
  assert.equal(cut.lineCount, 4);
  assert.equal(cut.shownLines, 4);
  assert.equal(cut.text, SQL);
});

await test('long source is cut from the end, because the first lines say what it reads', () => {
  const src = Array.from({ length: 200 }, (_v, i) => 'line ' + i).join('\n');
  const cut = truncateSource(src);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lineCount, 200);
  assert.equal(cut.shownLines, GLASS_BOX_MAX_LINES);
  assert.ok(cut.text.startsWith('line 0'));
  assert.ok(!cut.text.includes('line 199'));
});

await test('the window can be narrowed by the caller and a silly window is ignored', () => {
  const src = 'a\nb\nc\nd';
  assert.equal(truncateSource(src, 2).text, 'a\nb');
  assert.equal(truncateSource(src, 0).truncated, false);
  assert.equal(truncateSource(src, -3).truncated, false);
  assert.equal(truncateSource(src, 'two').truncated, false);
});

await test('nothing to show reports nothing rather than an empty line', () => {
  for (const v of [null, undefined, '', 42, {}]) {
    const cut = truncateSource(v);
    assert.equal(cut.text, '');
    assert.equal(cut.lineCount, 0);
    assert.equal(cut.truncated, false);
  }
});

// ---- badges: it never grades ----

await test('a gate that was not handed over produces no chip at all', () => {
  assert.deepEqual(glassBoxBadges({}), []);
  assert.deepEqual(glassBoxBadges(null), []);
  assert.deepEqual(glassBoxBadges('nonsense'), []);
  assert.deepEqual(glassBoxBadges({ sentinel: {}, gate: {}, phi: {}, airGap: {}, publishSafe: {} }), []);
});

await test('a sentinel failure outranks a warning and says why in words', () => {
  const bad = glassBoxBadges({ flags: [] }).length;
  assert.equal(bad, 0, 'the bag is keyed by gate name, not passed raw');
  const chips = glassBoxBadges({
    sentinel: { flags: [{ severity: 'fail' }, { severity: 'warn' }] },
  });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].level, 'bad');
  assert.match(chips[0].label, /1 to fix/);
  assert.match(chips[0].why, /can change this number/);
});

await test('a clean sentinel run is a chip, because it did run', () => {
  const chips = glassBoxBadges({ sentinel: { flags: [] } });
  assert.equal(chips[0].level, 'good');
  assert.match(chips[0].label, /clean/);
});

await test('the real readiness gate maps onto one chip carrying its own score', () => {
  const ready = computeReadinessGate(
    [{ layer: 'types', status: 'pass', summary: 'ok' }, { layer: 'ranges', status: 'pass', summary: 'ok' }],
    null,
  );
  const chips = glassBoxBadges({ gate: ready });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].level, 'good');
  assert.match(chips[0].label, /Readiness:/);

  const held = computeReadinessGate([{ layer: 'types', status: 'fail', summary: 'text where numbers go' }], null);
  assert.equal(glassBoxBadges({ gate: held })[0].level, 'bad');
});

await test('a PHI match is a warning and says plainly that nothing was removed', () => {
  const chips = glassBoxBadges({ phi: { sensitiveFound: true } });
  assert.equal(chips[0].level, 'warn');
  assert.match(chips[0].why, /Nothing was removed/);
  assert.equal(glassBoxBadges({ phi: { sensitiveFound: false } })[0].level, 'good');
});

await test('air gap off is unknown, not bad, and says the refusal is not armed', () => {
  const off = glassBoxBadges({ airGap: { active: false } })[0];
  assert.equal(off.level, 'unknown');
  assert.match(off.why, /not armed/);
  assert.equal(glassBoxBadges({ airGap: { active: true } })[0].level, 'good');
});

await test('the real Publish-Safe verdict maps onto a chip', () => {
  const verdict = evaluatePublishSafe({
    destination: 'this-device',
    artifact: 'this result',
    phi: { available: true, sensitiveFound: false, findings: [] },
    readiness: 'not-applicable',
  });
  const chips = glassBoxBadges({ publishSafe: verdict });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].level, 'good');
  assert.equal(glassBoxBadges({ publishSafe: { level: 'blocked' } })[0].level, 'bad');
  assert.equal(glassBoxBadges({ publishSafe: { level: 'invented' } })[0].level, 'unknown');
});

await test('the chip order is fixed, so one result never renders two arrangements', () => {
  const chips = glassBoxBadges({
    publishSafe: { level: 'clear' },
    airGap: { active: true },
    phi: { sensitiveFound: false },
    gate: { agentConsumable: true },
    sentinel: { flags: [] },
  });
  assert.deepEqual(chips.map((c) => c.id), ['sentinel', 'gate', 'phi', 'air-gap', 'publish-safe']);
});

await test('a malformed gate is a missing badge, never a crash', () => {
  const chips = glassBoxBadges({ sentinel: { flags: [null, 7, 'x'] }, gate: { agentConsumable: 'yes' } });
  assert.equal(chips.length, 1);
  assert.equal(chips[0].level, 'good');
});

// ---- the model: finding first, proof underneath ----

await test('the field order of the model is the reading order of the panel', () => {
  const model = buildGlassBox({ surface: 'SQL result', source: SQL, language: 'sql' });
  assert.deepEqual(Object.keys(model), [
    'kind', 'version', 'surface', 'finding', 'math', 'badges', 'missing', 'level', 'disclaimer',
  ]);
});

await test('a surface that handed over its SQL gets it back verbatim', () => {
  const model = buildGlassBox({
    surface: 'SQL result', headline: '4 payers.', detail: 'Grouped by payer.',
    language: 'sql', source: SQL, engine: 'DuckDB-WASM',
  });
  assert.equal(model.math.available, true);
  assert.equal(model.math.source, SQL);
  assert.equal(model.math.language, 'sql');
  assert.equal(model.math.engine, 'DuckDB-WASM');
  assert.equal(model.finding.headline, '4 payers.');
  assert.equal(model.surface, 'SQL result');
});

await test('no source means an honest gap, and says nothing was reconstructed', () => {
  const model = buildGlassBox({ surface: 'a transform summary' });
  assert.equal(model.math.available, false);
  assert.equal(model.math.source, '');
  const code = model.missing.find((m) => m.what === 'the code');
  assert.ok(code, 'the absent code must be named');
  assert.match(code.why, /Nothing has been reconstructed/);
  assert.match(code.why, /would look checkable and be wrong/);
});

await test('no gate at all is unknown and says so, never a clean result', () => {
  const model = buildGlassBox({ source: SQL });
  assert.equal(model.level, 'unknown');
  assert.equal(model.badges.length, 0);
  const gap = model.missing.find((m) => m.what === 'the gates');
  assert.match(gap.why, /absence of evidence, not a clean result/);
});

await test('the worst chip decides the panel level', () => {
  const good = buildGlassBox({ source: SQL, gates: { airGap: { active: true } } });
  assert.equal(good.level, 'good');
  const warn = buildGlassBox({
    source: SQL, gates: { airGap: { active: true }, phi: { sensitiveFound: true } },
  });
  assert.equal(warn.level, 'warn');
  const bad = buildGlassBox({
    source: SQL,
    gates: { phi: { sensitiveFound: true }, sentinel: { flags: [{ severity: 'fail' }] } },
  });
  assert.equal(bad.level, 'bad');
});

await test('an air gap chip alone leaves the panel unknown rather than passing it', () => {
  const model = buildGlassBox({ source: SQL, gates: { airGap: { active: false } } });
  assert.equal(model.level, 'unknown');
});

await test('an unknown language falls back to text rather than being echoed', () => {
  assert.equal(buildGlassBox({ source: 'x', language: 'brainfuck' }).math.language, 'text');
  assert.equal(buildGlassBox({ source: 'x' }).math.language, 'text');
  assert.equal(buildGlassBox({ source: 'x', language: 'python' }).math.language, 'python');
});

await test('a surface with nothing at all still gets a model, and it is honest', () => {
  for (const bad of [undefined, null, 'nonsense', 42, []]) {
    const model = buildGlassBox(bad);
    assert.equal(model.kind, GLASS_BOX_KIND);
    assert.equal(model.surface, 'this result');
    assert.equal(model.math.available, false);
    assert.equal(model.level, 'unknown');
    assert.equal(model.missing.length, 2);
  }
});

await test('a long cell is summarised and the panel reports the cut', () => {
  const src = Array.from({ length: 90 }, (_v, i) => 'row(' + i + ')').join('\n');
  const model = buildGlassBox({ source: src, language: 'python', maxLines: 10 });
  assert.equal(model.math.truncated, true);
  assert.equal(model.math.shownLines, 10);
  assert.equal(model.math.lineCount, 90);
});

// ---- rendering ----

await test('the copied text carries the finding, the code, the chips and the gaps', () => {
  const model = buildGlassBox({
    surface: 'SQL result', headline: '4 payers.', detail: 'Grouped by payer.',
    language: 'sql', source: SQL, engine: 'DuckDB-WASM',
    gates: { sentinel: { flags: [] }, phi: { sensitiveFound: true } },
  });
  const text = renderGlassBoxText(model);
  assert.match(text, /^4 payers\./);
  assert.match(text, /Grouped by payer\./);
  assert.match(text, /Ran by: DuckDB-WASM \(sql\)/);
  assert.ok(text.includes(SQL), 'the code a person copies must be the code that ran');
  assert.match(text, /Checks:/);
  assert.match(text, /Query Sentinel: clean/);
  assert.ok(!/Not shown:/.test(text), 'a panel with code and chips has no gap to report');
  assert.ok(text.endsWith(GLASS_BOX_DISCLAIMER));
});

await test('the copied text names the gaps when there are gaps', () => {
  const text = renderGlassBoxText(buildGlassBox({ surface: 'a transform summary' }));
  assert.match(text, /Not shown:/);
  assert.match(text, /the code:/);
  assert.match(text, /the gates:/);
  assert.ok(!/Ran by:/.test(text), 'there is no engine to name when no code was handed over');
});

await test('the copied text reports a cut instead of pretending it is whole', () => {
  const src = Array.from({ length: 90 }, (_v, i) => 's' + i).join('\n');
  const text = renderGlassBoxText(buildGlassBox({ source: src, maxLines: 5 }));
  assert.match(text, /Showing the first 5 of 90 lines\./);
});

await test('rendering something that is not a model says so', () => {
  assert.equal(renderGlassBoxText(null), 'No math to show.');
  assert.equal(renderGlassBoxText({}), 'No math to show.');
  assert.equal(renderGlassBoxText('nonsense'), 'No math to show.');
});

await test('no visible string anywhere in a full panel carries an em dash', () => {
  const model = buildGlassBox({
    surface: 'SQL result', headline: '4 payers.', language: 'sql', source: SQL, engine: 'DuckDB-WASM',
    gates: {
      sentinel: { flags: [{ severity: 'fail' }] }, gate: { agentConsumable: false, score: 40 },
      phi: { sensitiveFound: true }, airGap: { active: false }, publishSafe: { level: 'caution' },
    },
  });
  assert.ok(!renderGlassBoxText(model).includes(EM_DASH), 'an em dash reached product text');
  assert.ok(!glassBoxToggleLabel(model).includes(EM_DASH));
});

await test('the toggle names the language when there is code, and stays honest when there is not', () => {
  assert.equal(glassBoxToggleLabel(buildGlassBox({ source: SQL, language: 'sql' })), 'Show the math (SQL)');
  assert.equal(glassBoxToggleLabel(buildGlassBox({ source: 'x', language: 'python' })), 'Show the math (python)');
  assert.equal(glassBoxToggleLabel(buildGlassBox({})), 'Show the math');
  assert.equal(glassBoxToggleLabel(null), 'Show the math');
});

// ---- the read-only guarantee ----

await test('the public surface shows math and nothing else', () => {
  assert.deepEqual([...PUBLIC_API_SURFACE], [
    'truncateSource', 'glassBoxBadges', 'buildGlassBox', 'renderGlassBoxText', 'glassBoxToggleLabel',
  ]);
  for (const name of PUBLIC_API_SURFACE) {
    assert.ok(!/^(apply|write|mutate|run|execute|save|delete)/.test(name), `${name} sounds like an action`);
  }
});

await test('DataGlowGlassBox publishes everything a canvas wire needs', () => {
  for (const key of PUBLIC_API_SURFACE.concat([
    'GLASS_BOX_KIND', 'GLASS_BOX_VERSION', 'GLASS_BOX_LANGUAGES', 'GLASS_BOX_MAX_LINES', 'GLASS_BOX_DISCLAIMER',
  ])) {
    assert.ok(key in DataGlowGlassBox, `${key} missing from the namespace`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

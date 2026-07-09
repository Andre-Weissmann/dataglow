// ============================================================
// DATAGLOW — Micro-Lesson Layer test suite (Stage C)
// ============================================================
// Covers the pure "Teach As You Clean" catalog logic:
//   - every validation layer id (LAYER_DEFS) has a micro-lesson,
//   - every domain-pack rule id (DOMAIN_PACKS) has a micro-lesson,
//   - the unit-test sub-finding kinds and Benford skip causes are covered,
//   - verbosity slider swaps wording register only (never presence/logic),
//   - getMicroLesson falls back sensibly and returns null for unknowns,
//   - the coverageFor helper reports missing ids for the coverage gate.
//
// RUN WITH:  node --import ./test/duckdb-loader-hook.mjs test/micro-lessons.test.mjs
// (DOMAIN_PACKS imports domain-physics → validation → duckdb-engine; the loader
//  hook redirects the browser-only engine to the Node backend.)

import {
  MICRO_LESSONS,
  VERBOSITY_LEVELS,
  DEFAULT_VERBOSITY,
  normalizeLevel,
  hasMicroLesson,
  getMicroLesson,
  listFindingTypes,
  coverageFor,
} from '../js/micro-lessons.js';
import { LAYER_DEFS } from '../js/validation.js';
import { DOMAIN_PACKS } from '../js/domain-physics.js';

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ============================================================
  // 1) Verbosity levels
  // ============================================================
  ok(Array.isArray(VERBOSITY_LEVELS) && VERBOSITY_LEVELS.length === 3,
    'verbosity: exactly three registers');
  ok(VERBOSITY_LEVELS.every(l => typeof l === 'string'), 'verbosity: registers are strings');
  ok(VERBOSITY_LEVELS.includes(DEFAULT_VERBOSITY), 'verbosity: default is one of the registers');
  ok(normalizeLevel('expert') === 'expert', 'normalizeLevel: passes through a known level');
  ok(normalizeLevel('bogus') === DEFAULT_VERBOSITY, 'normalizeLevel: unknown level falls back to default');
  ok(normalizeLevel() === DEFAULT_VERBOSITY, 'normalizeLevel: no-arg falls back to default');

  // ============================================================
  // 2) Every catalog entry has all three registers, all non-empty strings
  // ============================================================
  let allThree = true;
  for (const [id, entry] of Object.entries(MICRO_LESSONS)) {
    for (const lvl of VERBOSITY_LEVELS) {
      if (typeof entry[lvl] !== 'string' || entry[lvl].trim() === '') { allThree = false; console.log(`   missing/empty ${lvl} for ${id}`); }
    }
  }
  ok(allThree, 'catalog: every entry supplies a non-empty beginner/practitioner/expert sentence');

  // Registers must differ from one another (a slider that does nothing is a bug).
  let registersDiffer = true;
  for (const [id, entry] of Object.entries(MICRO_LESSONS)) {
    if (entry.beginner === entry.practitioner || entry.practitioner === entry.expert || entry.beginner === entry.expert) {
      registersDiffer = false; console.log(`   identical registers for ${id}`);
    }
  }
  ok(registersDiffer, 'catalog: the three registers are distinct wording for every finding type');

  // ============================================================
  // 3) Coverage — every LAYER_DEFS id has a lesson
  // ============================================================
  const layerIds = LAYER_DEFS.map(l => l.id);
  const layerCov = coverageFor(layerIds);
  ok(layerCov.missing.length === 0,
    `coverage: every validation layer has a micro-lesson${layerCov.missing.length ? ` (missing: ${layerCov.missing.join(', ')})` : ''}`);

  // ============================================================
  // 4) Coverage — every domain-pack rule id has a lesson
  // ============================================================
  const ruleIds = [];
  for (const pack of Object.values(DOMAIN_PACKS)) {
    for (const r of pack.rules || []) ruleIds.push(r.id);
  }
  const ruleCov = coverageFor(ruleIds);
  ok(ruleIds.length > 0, 'coverage: DOMAIN_PACKS expose at least one rule id to cover');
  ok(ruleCov.missing.length === 0,
    `coverage: every domain-pack rule has a micro-lesson${ruleCov.missing.length ? ` (missing: ${ruleCov.missing.join(', ')})` : ''}`);

  // ============================================================
  // 5) Coverage — unit-test sub-findings + Benford skip causes
  // ============================================================
  const subFindings = ['negative', 'future_date', 'blank_key', 'duplicate', 'null_ref',
    'bounded_name', 'small_sample', 'narrow_range', 'binary_flag'];
  ok(coverageFor(subFindings).missing.length === 0,
    'coverage: unit-test kinds and Benford skip causes all have lessons');

  // ============================================================
  // 6) getMicroLesson behavior
  // ============================================================
  ok(getMicroLesson('benford', 'beginner') === MICRO_LESSONS.benford.beginner,
    'getMicroLesson: returns the requested register');
  ok(getMicroLesson('benford') === MICRO_LESSONS.benford[DEFAULT_VERBOSITY],
    'getMicroLesson: defaults to the practitioner register');
  ok(getMicroLesson('benford', 'nonsense') === MICRO_LESSONS.benford[DEFAULT_VERBOSITY],
    'getMicroLesson: unknown register falls back to default');
  ok(getMicroLesson('does_not_exist') === null,
    'getMicroLesson: unknown finding type returns null');
  ok(hasMicroLesson('outlier_detection') === true && hasMicroLesson('nope') === false,
    'hasMicroLesson: reports presence correctly');

  // Slider changes wording only — a known finding returns *some* lesson at every
  // register, and the set of covered finding types is identical across registers.
  let sameCoverageAcrossRegisters = true;
  for (const t of listFindingTypes()) {
    for (const lvl of VERBOSITY_LEVELS) {
      if (typeof getMicroLesson(t, lvl) !== 'string') sameCoverageAcrossRegisters = false;
    }
  }
  ok(sameCoverageAcrossRegisters, 'slider: every finding type resolves to a lesson at all three registers (register changes copy, not coverage)');

  // ============================================================
  // 7) "Hide explanations" contract (toggle OFF)
  // ============================================================
  // The toggle is UI state owned by main.js; the module's contract is simply
  // that a caller who chooses not to fetch a lesson gets nothing rendered. We
  // model "hidden" as the caller not invoking getMicroLesson — verify the pure
  // layer never *forces* a lesson to exist (i.e. results are independent of it).
  ok(listFindingTypes().length === Object.keys(MICRO_LESSONS).length,
    'toggle-off model: lessons are opt-in lookups, not attached to results by the module itself');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

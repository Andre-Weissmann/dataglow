// ============================================================
// DATAGLOW - R1 Project Run contract test
// ============================================================
// Proves R1_PROJECT_RUN_SPEC.md's acceptance criteria at the level a plain
// Node script can prove: no browser, no DOM. Three kinds of checks:
//
//   1. Direct import of the pure engine (js/spine/project-run.js) to
//      exercise the seven fixed steps, buildProjectRun()'s auto-advance and
//      blocked-skip-over ordering, the dataset-name hash + storage key
//      derivation, normalizeStoredStatuses()'s never-throw defaulting, and
//      the toStoredStatuses()/setManualStatus() round trip.
//   2. String/regex checks against canvas/index.html (AUTHORITATIVE) and
//      flags.manifest.json to confirm the canvas UI module is actually
//      inlined exactly once, the projectRun flag is registered with a
//      description and flagOffBehavior, and the module claims
//      window.openProjects only when nothing else already has (flag-off /
//      no-clobber safety).
//   3. An em-dash sweep over every new/changed source file this feature
//      touches, per the SPEC's "No em dash in visible UI" line.
//
// RUN WITH: node --test test/r1-project-run.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECT_RUN_KIND,
  PROJECT_RUN_VERSION,
  PROJECT_RUN_STATUSES,
  PROJECT_RUN_STORAGE_PREFIX,
  PROJECT_RUN_TITLE,
  PROJECT_RUN_STEPS,
  hashDatasetKey,
  storageKeyForDataset,
  normalizeStoredStatuses,
  buildProjectRun,
  toStoredStatuses,
  setManualStatus,
  nextStep,
  projectRunChipLabel,
  DataGlowProjectRun,
} from '../js/spine/project-run.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const EM_DASH = '\u2014';

function read(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8');
}

const canvas = read('canvas/index.html');
const flagsManifest = JSON.parse(read('flags.manifest.json'));
const engineSrc = read('js/spine/project-run.js');
const canvasUiSrc = read('js/spine/data-glow-project-run-canvas.js');

const STEP_IDS = PROJECT_RUN_STEPS.map(s => s.id);

// ------------------------------------------------------------
// Shape of the seven fixed steps.
// ------------------------------------------------------------

describe('R1 Project Run: seven fixed steps', () => {
  it('names exactly the SPEC order: Ingest, Purpose, Validate, Scout, Prove, Narrate, Export', () => {
    assert.deepEqual(STEP_IDS, ['ingest', 'purpose', 'validate', 'scout', 'prove', 'narrate', 'export']);
  });

  it('every step is frozen and carries the fields the canvas UI depends on', () => {
    for (const step of PROJECT_RUN_STEPS) {
      assert.ok(Object.isFrozen(step), `${step.id} should be frozen`);
      assert.equal(typeof step.ordinal, 'number');
      assert.equal(typeof step.title, 'string');
      assert.equal(typeof step.oneLine, 'string');
      assert.equal(typeof step.doneWhen, 'string');
      assert.equal(typeof step.opens, 'string');
    }
  });

  it('ordinals are 1..7 in order', () => {
    assert.deepEqual(PROJECT_RUN_STEPS.map(s => s.ordinal), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('PROJECT_RUN_STATUSES is exactly todo/doing/done/blocked', () => {
    assert.deepEqual(PROJECT_RUN_STATUSES, ['todo', 'doing', 'done', 'blocked']);
  });

  it('kind/version/title/prefix are stable identifiers', () => {
    assert.equal(PROJECT_RUN_KIND, 'dataglow-project-run');
    assert.equal(PROJECT_RUN_VERSION, 1);
    assert.equal(PROJECT_RUN_TITLE, 'Project Run');
    assert.equal(PROJECT_RUN_STORAGE_PREFIX, 'dataglow.projectRun.');
  });
});

// ------------------------------------------------------------
// hashDatasetKey / storageKeyForDataset: deterministic, per-dataset.
// ------------------------------------------------------------

describe('R1 Project Run: dataset-name hash and storage key', () => {
  it('hashDatasetKey is deterministic for the same input', () => {
    assert.equal(hashDatasetKey('claims_2026.csv'), hashDatasetKey('claims_2026.csv'));
  });

  it('hashDatasetKey differs for different inputs (ordinary case)', () => {
    assert.notEqual(hashDatasetKey('a.csv'), hashDatasetKey('b.csv'));
  });

  it('hashDatasetKey never throws on non-string input', () => {
    assert.doesNotThrow(() => hashDatasetKey(null));
    assert.doesNotThrow(() => hashDatasetKey(undefined));
    assert.doesNotThrow(() => hashDatasetKey(42));
  });

  it('storageKeyForDataset is prefixed and stable', () => {
    const key = storageKeyForDataset('data.csv');
    assert.ok(key.startsWith(PROJECT_RUN_STORAGE_PREFIX));
    assert.equal(key, storageKeyForDataset('data.csv'));
  });

  it('storageKeyForDataset falls back to "untitled" for empty/missing names', () => {
    const empty = storageKeyForDataset('');
    const missing = storageKeyForDataset(undefined);
    const untitled = storageKeyForDataset('untitled');
    assert.equal(empty, untitled);
    assert.equal(missing, untitled);
  });

  it('two different dataset names key to two different storage entries', () => {
    assert.notEqual(storageKeyForDataset('claims_2026.csv'), storageKeyForDataset('roster.xlsx'));
  });
});

// ------------------------------------------------------------
// normalizeStoredStatuses: never-throw defaulting.
// ------------------------------------------------------------

describe('R1 Project Run: normalizeStoredStatuses never throws', () => {
  it('null/undefined/garbage input defaults every step to todo', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      const norm = normalizeStoredStatuses(bad);
      for (const id of STEP_IDS) assert.equal(norm[id], 'todo');
    }
  });

  it('an unknown status value for a known step defaults that step to todo', () => {
    const norm = normalizeStoredStatuses({ ingest: 'not-a-real-status' });
    assert.equal(norm.ingest, 'todo');
  });

  it('a valid status value for a known step is preserved', () => {
    const norm = normalizeStoredStatuses({ prove: 'blocked' });
    assert.equal(norm.prove, 'blocked');
  });

  it('unknown extra keys are dropped, all seven known ids are always present', () => {
    const norm = normalizeStoredStatuses({ notAStep: 'done' });
    assert.equal(norm.notAStep, undefined);
    assert.deepEqual(Object.keys(norm).sort(), [...STEP_IDS].sort());
  });
});

// ------------------------------------------------------------
// buildProjectRun: auto-advance ordering.
// ------------------------------------------------------------

describe('R1 Project Run: buildProjectRun auto-advance', () => {
  it('an empty run (no signals, no stored state) starts at ingest, doing', () => {
    const run = buildProjectRun();
    assert.equal(run.currentId, 'ingest');
    assert.equal(run.doneCount, 0);
    assert.equal(run.complete, false);
    assert.equal(run.total, 7);
  });

  it('never throws on undefined/malformed input', () => {
    assert.doesNotThrow(() => buildProjectRun());
    assert.doesNotThrow(() => buildProjectRun(null));
    assert.doesNotThrow(() => buildProjectRun({ observed: null, stored: 'garbage' }));
  });

  it('a fully-observed run marks all seven steps done and complete', () => {
    const run = buildProjectRun({
      observed: {
        hasTable: true,
        purposeSigned: true,
        validationViewed: true,
        keepersCount: 1,
        proveGreenCount: 1,
        narrativeDraft: true,
        exportDone: true,
      },
    });
    assert.equal(run.doneCount, 7);
    assert.equal(run.complete, true);
    assert.equal(run.currentId, '');
    assert.equal(run.headline, 'This run is complete, start to finish.');
  });

  it('auto-advances to the first not-done step exactly (only one doing at a time)', () => {
    const run = buildProjectRun({
      observed: { hasTable: true, purposeSigned: true },
    });
    const statuses = run.steps.map(s => s.status);
    assert.deepEqual(statuses, ['done', 'done', 'doing', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(run.currentId, 'validate');
    assert.equal(statuses.filter(s => s === 'doing').length, 1);
  });

  it('scout requires keepersCount >= 1, prove requires proveGreenCount >= 1', () => {
    const zero = buildProjectRun({ observed: { keepersCount: 0, proveGreenCount: 0 } });
    const scoutStep = zero.steps.find(s => s.id === 'scout');
    const proveStep = zero.steps.find(s => s.id === 'prove');
    assert.notEqual(scoutStep.status, 'done');
    assert.notEqual(proveStep.status, 'done');

    const one = buildProjectRun({ observed: { hasTable: true, purposeSigned: true, validationViewed: true, keepersCount: 1 } });
    assert.equal(one.steps.find(s => s.id === 'scout').status, 'done');
  });

  it('a manually blocked step stays blocked and is skipped when picking the next doing step', () => {
    const stored = setManualStatus(normalizeStoredStatuses(), 'validate', 'blocked');
    const run = buildProjectRun({
      stored,
      observed: { hasTable: true, purposeSigned: true },
    });
    const statuses = run.steps.map(s => s.status);
    assert.deepEqual(statuses, ['done', 'done', 'blocked', 'doing', 'todo', 'todo', 'todo']);
    assert.equal(run.currentId, 'scout');
    assert.equal(run.blockedCount, 1);
  });

  it('blocked status is never inferred automatically from signals alone', () => {
    const run = buildProjectRun({ observed: {} });
    assert.equal(run.blockedCount, 0);
    assert.ok(run.steps.every(s => s.status !== 'blocked'));
  });

  it('headline reports a blocked-only remainder honestly when nothing is doing', () => {
    let stored = normalizeStoredStatuses();
    for (const id of STEP_IDS) stored = setManualStatus(stored, id, 'blocked');
    const run = buildProjectRun({ stored, observed: {} });
    assert.equal(run.currentId, '');
    assert.match(run.headline, /blocked/);
  });
});

// ------------------------------------------------------------
// toStoredStatuses / setManualStatus round trip.
// ------------------------------------------------------------

describe('R1 Project Run: persistence round trip', () => {
  it('toStoredStatuses(buildProjectRun(...)) reproduces the same statuses', () => {
    const run = buildProjectRun({ observed: { hasTable: true } });
    const stored = toStoredStatuses(run);
    assert.equal(stored.ingest, 'done');
    assert.equal(stored.purpose, 'doing');
    assert.deepEqual(Object.keys(stored).sort(), [...STEP_IDS].sort());
  });

  it('toStoredStatuses never throws on a malformed run', () => {
    assert.doesNotThrow(() => toStoredStatuses(null));
    assert.doesNotThrow(() => toStoredStatuses({}));
    const stored = toStoredStatuses(undefined);
    for (const id of STEP_IDS) assert.equal(stored[id], 'todo');
  });

  it('setManualStatus does not mutate its input and rejects unknown ids/statuses', () => {
    const base = normalizeStoredStatuses();
    const changed = setManualStatus(base, 'prove', 'blocked');
    assert.equal(base.prove, 'todo', 'original object must not be mutated');
    assert.equal(changed.prove, 'blocked');

    const unknownStep = setManualStatus(base, 'not-a-step', 'blocked');
    assert.deepEqual(unknownStep, base);

    const unknownStatus = setManualStatus(base, 'prove', 'not-a-status');
    assert.deepEqual(unknownStatus, base);
  });

  it('a full round trip through build -> store -> rebuild is stable (idempotent)', () => {
    const run1 = buildProjectRun({ observed: { hasTable: true, purposeSigned: true } });
    const stored1 = toStoredStatuses(run1);
    const run2 = buildProjectRun({ stored: stored1, observed: { hasTable: true, purposeSigned: true } });
    assert.deepEqual(run1.steps.map(s => s.status), run2.steps.map(s => s.status));
  });
});

// ------------------------------------------------------------
// nextStep / projectRunChipLabel.
// ------------------------------------------------------------

describe('R1 Project Run: nextStep and chip label', () => {
  it('nextStep returns the doing step object, or null when none', () => {
    const run = buildProjectRun({ observed: { hasTable: true } });
    const next = nextStep(run);
    assert.equal(next.id, 'purpose');

    const complete = buildProjectRun({
      observed: {
        hasTable: true, purposeSigned: true, validationViewed: true,
        keepersCount: 1, proveGreenCount: 1, narrativeDraft: true, exportDone: true,
      },
    });
    assert.equal(nextStep(complete), null);
  });

  it('nextStep never throws on malformed input', () => {
    assert.doesNotThrow(() => nextStep(null));
    assert.equal(nextStep(null), null);
    assert.equal(nextStep({}), null);
  });

  it('projectRunChipLabel formats "Project Run: N of 7"', () => {
    const run = buildProjectRun({ observed: { hasTable: true } });
    assert.equal(projectRunChipLabel(run), 'Project Run: 1 of 7');
  });

  it('projectRunChipLabel never throws on malformed input', () => {
    assert.doesNotThrow(() => projectRunChipLabel(null));
    assert.equal(projectRunChipLabel(null), PROJECT_RUN_TITLE);
  });
});

// ------------------------------------------------------------
// The aggregate namespace object matches every named export.
// ------------------------------------------------------------

describe('R1 Project Run: DataGlowProjectRun namespace', () => {
  it('publishes every named export under one object', () => {
    assert.equal(DataGlowProjectRun.PROJECT_RUN_KIND, PROJECT_RUN_KIND);
    assert.equal(DataGlowProjectRun.buildProjectRun, buildProjectRun);
    assert.equal(DataGlowProjectRun.hashDatasetKey, hashDatasetKey);
    assert.equal(DataGlowProjectRun.storageKeyForDataset, storageKeyForDataset);
    assert.equal(DataGlowProjectRun.setManualStatus, setManualStatus);
    assert.equal(DataGlowProjectRun.toStoredStatuses, toStoredStatuses);
    assert.equal(DataGlowProjectRun.nextStep, nextStep);
    assert.equal(DataGlowProjectRun.projectRunChipLabel, projectRunChipLabel);
  });
});

// ------------------------------------------------------------
// canvas/index.html (AUTHORITATIVE): inlined exactly once, markers paired.
// ------------------------------------------------------------

describe('R1 Project Run: canvas is authoritative and correctly inlined', () => {
  it('js/spine/project-run.js is inlined exactly once with a from/end pair', () => {
    const fromCount = (canvas.match(/\/\* ---- from js\/spine\/project-run\.js ---- \*\//g) || []).length;
    const endCount = (canvas.match(/\/\* ---- end js\/spine\/project-run\.js ---- \*\//g) || []).length;
    assert.equal(fromCount, 1);
    assert.equal(endCount, 1);
  });

  it('js/spine/data-glow-project-run-canvas.js is inlined exactly once with a from/end pair', () => {
    const fromCount = (canvas.match(/\/\* ---- from js\/spine\/data-glow-project-run-canvas\.js ---- \*\//g) || []).length;
    const endCount = (canvas.match(/\/\* ---- end js\/spine\/data-glow-project-run-canvas\.js ---- \*\//g) || []).length;
    assert.equal(fromCount, 1);
    assert.equal(endCount, 1);
  });

  it('the inlined engine section appears before the inlined canvas-UI section', () => {
    const enginePos = canvas.indexOf('/* ---- from js/spine/project-run.js ---- */');
    const uiPos = canvas.indexOf('/* ---- from js/spine/data-glow-project-run-canvas.js ---- */');
    assert.ok(enginePos > -1 && uiPos > -1);
    assert.ok(enginePos < uiPos);
  });
});

// ------------------------------------------------------------
// Entry point: claims window.openProjects only when nothing already has.
// ------------------------------------------------------------

describe('R1 Project Run: bottom-nav Projects entry point, no-clobber', () => {
  it('the canvas UI source only assigns window.openProjects behind a typeof guard', () => {
    assert.match(
      canvasUiSrc,
      /typeof window\.openProjects\s*!==\s*['"]function['"]/,
      'must check for an existing window.openProjects before defining one, per flag-off/no-clobber safety',
    );
  });

  it('canvas/index.html still calls openProjects() from the bottom nav Projects tab', () => {
    assert.match(canvas, /onclick="openProjects\(\)"/);
  });
});

// ------------------------------------------------------------
// flags.manifest.json: projectRun is registered with the required shape.
// ------------------------------------------------------------

describe('R1 Project Run: projectRun flag is registered', () => {
  it('flags.manifest.json has a projectRun entry with the required fields', () => {
    const entry = flagsManifest.flags && flagsManifest.flags.projectRun;
    assert.ok(entry, 'projectRun must exist in flags.manifest.json');
    assert.equal(typeof entry.enabled, 'boolean');
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 10);
    assert.equal(typeof entry.flagOffBehavior, 'string');
    assert.ok(entry.flagOffBehavior.length > 10);
  });

  it('the flagOffBehavior text documents that window.openProjects is left untouched when off', () => {
    const entry = flagsManifest.flags.projectRun;
    assert.match(entry.flagOffBehavior, /openProjects/);
  });
});

// ------------------------------------------------------------
// No em dash anywhere in the new/changed source files this feature touches.
// ------------------------------------------------------------

describe('R1 Project Run: no em dash in shipped UI-facing source', () => {
  const FILES = [
    'js/spine/project-run.js',
    'js/spine/data-glow-project-run-canvas.js',
  ];
  for (const f of FILES) {
    it(`${f} has no em dash`, () => {
      assert.doesNotMatch(read(f), new RegExp(EM_DASH));
    });
  }

  it('the projectRun flag description/flagOffBehavior text has no em dash', () => {
    const entry = flagsManifest.flags.projectRun;
    assert.doesNotMatch(entry.description, new RegExp(EM_DASH));
    assert.doesNotMatch(entry.flagOffBehavior, new RegExp(EM_DASH));
  });

  it('the inlined canvas sections for both new files carry no em dash', () => {
    const engineSection = canvas.slice(
      canvas.indexOf('/* ---- from js/spine/project-run.js ---- */'),
      canvas.indexOf('/* ---- end js/spine/project-run.js ---- */'),
    );
    const uiSection = canvas.slice(
      canvas.indexOf('/* ---- from js/spine/data-glow-project-run-canvas.js ---- */'),
      canvas.indexOf('/* ---- end js/spine/data-glow-project-run-canvas.js ---- */'),
    );
    assert.doesNotMatch(engineSection, new RegExp(EM_DASH));
    assert.doesNotMatch(uiSection, new RegExp(EM_DASH));
  });
});

// ------------------------------------------------------------
// Pure-module hygiene: no DOM/localStorage/network in the engine file.
// ------------------------------------------------------------

describe('R1 Project Run: engine module stays pure', () => {
  it('js/spine/project-run.js never calls localStorage, document, or fetch directly', () => {
    // Comments are allowed to mention these words (the file header explains
    // the pure-module boundary); only an actual call/property access counts.
    assert.doesNotMatch(engineSrc, /\blocalStorage\.(getItem|setItem|removeItem)\(/);
    assert.doesNotMatch(engineSrc, /\bdocument\.(querySelector|getElementById|createElement)/);
    assert.doesNotMatch(engineSrc, /\bfetch\(/);
  });

  it('js/spine/project-run.js has no stray export/import statement surviving after canvas rewrite', () => {
    // Mirrors inject_r1_project_run.py's own guard: a bare `export` object key
    // must be quoted so it cannot be mistaken for an ESM export statement.
    const lines = engineSrc.split('\n');
    for (const line of lines) {
      if (/^\s*export\b/.test(line) && !/^\s*export\s+(const|function|class)\b/.test(line)) {
        assert.fail(`suspicious bare "export" line survives naive detection: ${line}`);
      }
    }
  });
});

console.log('r1-project-run.test.mjs: all describe blocks registered');

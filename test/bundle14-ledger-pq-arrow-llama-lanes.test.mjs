// ============================================================
// DATAGLOW - Bundle 14: Repair Ledger, PQ-parity recipes, Arrow bridge
// deepen, llama sidecar fetch status, and polyglot project lanes.
// ============================================================
//
// Pure Node, no DOM. Canvas UI mount/unmount is covered separately in
// test/bundle14-canvas-ui.test.mjs using a real headless browser, the same
// split Bundle 13 used between test/polyglot-deepen-and-guard.test.mjs
// (engines) and test/trust-ledger-canvas-ui.test.mjs (mounted UI).
//
// RUN WITH:  node --test test/bundle14-ledger-pq-arrow-llama-lanes.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  REPAIR_LEDGER_KIND,
  REPAIR_LEDGER_KINDS,
  REPAIR_LEDGER_ENGINES,
  REPAIR_LEDGER_STATUSES,
  RERUNNABLE_KINDS,
  APPLIED_STEPS_EQUIVALENT,
  buildStep,
  appendStep,
  listSteps,
  stepsByStatus,
  canRerun,
  rerunPlan,
  stepReceiptLine,
  exportLedgerJson,
  exportLedgerMarkdown,
  wiringReport,
  ledgerSummary,
} from '../js/spine/repair-ledger.js';

import {
  PQ_PARITY_KIND,
  PQ_PARITY_HONESTY,
  APPLIED_STEPS_BLURB,
  PQ_PARITY_RECIPES,
  pqParityTopics,
  listPqParityRecipes,
  findPqParityRecipe,
  buildPqParityPack,
} from '../js/polyglot/pq-parity-recipes.js';

import {
  PROJECT_LANES_KIND,
  PROJECT_LANES,
  findLane,
  listLanes,
  buildProjectLanes,
} from '../js/polyglot/project-lanes.js';

import {
  ARROW_BRIDGE_STATES,
  ARROW_BRIDGE_STATUS_KINDS,
  BATCH_DTYPES,
  JSON_BRIDGE_ROW_LIMIT,
  BATCH_BRIDGE_CEILING,
  NEVER_UNLIMITED,
  buildArrowBridgeStatus,
  buildArrowBridgeStatusV2,
  encodeColumnBatch,
  decodeColumnBatch,
  roundTripFixture,
} from '../js/polyglot/arrow-bridge.js';

import {
  SIDECAR_FETCH_STATES,
  EXTERNAL_BIN_ENTRY,
  fetchSidecarStatus,
  sidecarPresence,
  checkPackagingAgreement,
} from '../js/ai/llama-sidecar-packaging.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EM_DASH = '\u2014';

function read(p) {
  return readFileSync(join(REPO_ROOT, p), 'utf8');
}

// ------------------------------------------------------------
// Repair Ledger
// ------------------------------------------------------------

describe('repair-ledger: shape', () => {
  it('names its kinds, engines and statuses', () => {
    assert.equal(REPAIR_LEDGER_KIND, 'dataglow-repair-ledger');
    assert.ok(REPAIR_LEDGER_KINDS.includes('sql_recipe_run'));
    assert.ok(REPAIR_LEDGER_KINDS.includes('summarize_tiles'));
    assert.deepEqual(REPAIR_LEDGER_ENGINES, ['sql', 'python', 'r', 'excel', 'system']);
    assert.deepEqual(REPAIR_LEDGER_STATUSES, ['applied', 'skipped', 'failed', 'proposed']);
    assert.deepEqual(RERUNNABLE_KINDS, ['sql_recipe_run']);
  });

  it('names the Applied Steps equivalence honestly, no M claim', () => {
    assert.match(APPLIED_STEPS_EQUIVALENT, /Applied Steps/);
    assert.match(APPLIED_STEPS_EQUIVALENT, /not Power Query M/i);
  });
});

describe('repair-ledger: append is append-only, in place', () => {
  it('appendStep mutates the given array and returns the new step', () => {
    const ledger = [];
    const s1 = appendStep(ledger, { kind: 'sql_recipe_run', engine: 'sql', title: 'Group by', code: 'SELECT 1', status: 'applied' });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0], s1);
    assert.equal(s1.status, 'applied');
    assert.equal(s1.rerunnable, true);

    const s2 = appendStep(ledger, { kind: 'type_guard', engine: 'excel', title: 'Type check', status: 'applied' });
    assert.equal(ledger.length, 2);
    assert.equal(s2.rerunnable, false, 'a decision kind is never rerunnable even when applied');
  });

  it('throws on a non-array ledger rather than silently doing nothing', () => {
    assert.throws(() => appendStep(null, {}));
    assert.throws(() => appendStep({}, {}));
  });

  it('two steps in the same millisecond still get distinct, sortable ids', () => {
    const ledger = [];
    const a = appendStep(ledger, { kind: 'export', title: 'a' });
    const b = appendStep(ledger, { kind: 'export', title: 'b' });
    assert.notEqual(a.id, b.id);
  });

  it('listSteps and stepsByStatus read without allowing external mutation', () => {
    const ledger = [];
    appendStep(ledger, { kind: 'sql_recipe_run', status: 'applied', title: 'a' });
    appendStep(ledger, { kind: 'sql_recipe_run', status: 'proposed', title: 'b' });
    const copy = listSteps(ledger);
    copy.push({ fake: true });
    assert.equal(ledger.length, 2, 'mutating the returned copy must not touch the real ledger');
    assert.equal(stepsByStatus(ledger, 'proposed').length, 1);
    assert.equal(stepsByStatus(ledger, 'failed').length, 0);
  });
});

describe('repair-ledger: rerun is honest, never executes', () => {
  it('canRerun/rerunPlan agree, and a rerunnable step gets back its exact code', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'sql_recipe_run', engine: 'sql', title: 'Dedup', code: 'SELECT DISTINCT * FROM t', status: 'applied' });
    assert.equal(canRerun(step), true);
    const plan = rerunPlan(step);
    assert.equal(plan.ok, true);
    assert.equal(plan.code, step.code);
    assert.match(plan.note, /nothing here executes it/i);
  });

  it('refuses a decision step with a specific reason, not a generic one', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'type_guard', engine: 'excel', title: 'Guard held', status: 'applied' });
    assert.equal(canRerun(step), false);
    const plan = rerunPlan(step);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /decision/i);
  });

  it('refuses a proposed (not applied) step even if the kind is rerunnable', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'sql_recipe_run', code: 'SELECT 1', status: 'proposed' });
    assert.equal(canRerun(step), false);
    assert.match(rerunPlan(step).reason, /not applied/i);
  });

  it('refuses a rerunnable-kind step with no code recorded', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'sql_recipe_run', status: 'applied' });
    assert.equal(canRerun(step), false);
    assert.match(rerunPlan(step).reason, /no code/i);
  });

  it('rerunPlan on garbage input reports "no step" rather than throwing', () => {
    assert.equal(rerunPlan(null).ok, false);
    assert.match(rerunPlan(null).reason, /no step/i);
  });
});

describe('repair-ledger: export', () => {
  it('exportLedgerJson round-trips through JSON.parse with the right shape', () => {
    const ledger = [];
    appendStep(ledger, { kind: 'sql_recipe_run', title: 'a', code: 'SELECT 1', status: 'applied' });
    const json = exportLedgerJson(ledger);
    const parsed = JSON.parse(json);
    assert.equal(parsed.kind, 'dataglow-repair-ledger');
    assert.equal(parsed.steps.length, 1);
    assert.ok(parsed.exportedAt);
  });

  it('exportLedgerMarkdown produces a table and handles an empty ledger', () => {
    const md = exportLedgerMarkdown([]);
    assert.match(md, /Repair Ledger/);
    assert.match(md, /nothing logged yet/);

    const ledger = [];
    appendStep(ledger, { kind: 'sql_recipe_run', title: 'Pipe | test', code: 'SELECT "a|b"', status: 'applied' });
    const md2 = exportLedgerMarkdown(ledger);
    assert.match(md2, /\\\|/, 'a literal pipe in code must be escaped so it does not break the table');
  });

  it('stepReceiptLine reads back engine, kind, summary and status', () => {
    const ledger = [];
    const step = appendStep(ledger, { kind: 'sql_recipe_run', engine: 'sql', title: 'Dedup', summary: 'Removed dupes', status: 'applied' });
    const line = stepReceiptLine(step);
    assert.match(line, /sql/);
    assert.match(line, /sql_recipe_run/);
    assert.match(line, /Removed dupes/);
    assert.match(line, /applied/);
  });
});

describe('repair-ledger: wiring report names the gap', () => {
  // Bundle 16 aligned WIRING_REPORT_KNOWN_SOURCES with the REAL
  // REPAIR_LEDGER_KINDS list (it IS that array now, not a second
  // hand-maintained list of aliases): 'csv_quarantine' -> 'quarantine_decision',
  // 'excel_hell' -> 'excel_hell_apply', 'sql_recipe' -> 'sql_recipe_run'. See
  // test/bundle16-ledger-wiring-drill-battery.test.mjs for the full Bundle 16
  // wiring-residuals coverage; these two cases are updated in place here so
  // this suite keeps testing the real kind names instead of retired aliases.
  it('lists every known source not yet fired', () => {
    const report = wiringReport({ firedSources: ['type_guard', 'summarize_tiles'] });
    assert.ok(report.unwired.includes('quarantine_decision'));
    assert.ok(report.unwired.includes('excel_hell_apply'));
    assert.equal(report.fired.length, 2);
    assert.match(report.headline, /2 of/);
  });

  it('says every surface fired when the full known list is present', () => {
    const known = ['load', 'quarantine_decision', 'type_guard', 'excel_hell_apply', 'sql_recipe_run', 'python_recipe', 'r_recipe', 'summarize_tiles', 'export'];
    const report = wiringReport({ firedSources: known });
    assert.equal(report.unwired.length, 0);
    assert.match(report.headline, /Every known surface/);
  });
});

describe('repair-ledger: summary', () => {
  it('counts by status and names the last step', () => {
    const ledger = [];
    appendStep(ledger, { kind: 'sql_recipe_run', status: 'applied', title: 'first' });
    appendStep(ledger, { kind: 'sql_recipe_run', status: 'failed', title: 'second' });
    const sum = ledgerSummary(ledger);
    assert.equal(sum.total, 2);
    assert.equal(sum.byStatus.applied, 1);
    assert.equal(sum.byStatus.failed, 1);
    assert.equal(sum.lastStep.title, 'second');
  });

  it('reports "no steps logged" on an empty ledger without throwing', () => {
    const sum = ledgerSummary([]);
    assert.equal(sum.total, 0);
    assert.match(sum.headline, /No steps logged/);
  });
});

// ------------------------------------------------------------
// PQ-parity recipes
// ------------------------------------------------------------

describe('pq-parity-recipes: registry has the minimum required set', () => {
  const REQUIRED_STEPS = [
    'promote-headers', 'change-type', 'fill-down', 'fill-up', 'split-column',
    'merge-queries-left', 'merge-queries-inner', 'merge-queries-full',
    'append-queries', 'group-by-aggregate', 'unpivot-dynamic', 'pivot',
    'remove-duplicates', 'replace-trim-clean', 'fuzzy-join-sketch',
  ];

  it('has every required recipe id, each with real SQL and no M', () => {
    const ids = PQ_PARITY_RECIPES.map((r) => r.id);
    for (const id of REQUIRED_STEPS) {
      assert.ok(ids.includes(id), `missing PQ-parity recipe: ${id}`);
    }
    for (const r of PQ_PARITY_RECIPES) {
      assert.ok(r.sql && r.sql.length > 10, `${r.id}: sql must be non-trivial`);
      assert.doesNotMatch(r.sql, /\bM\b.*query language/i);
      assert.doesNotMatch(r.sql, new RegExp(EM_DASH));
    }
  });

  it('the fuzzy join sketch names its own cost honestly', () => {
    const fj = findPqParityRecipe('fuzzy-join-sketch');
    assert.ok(fj);
    assert.match(fj.why, /O\(n\*m\)|cross product/i);
    assert.match(fj.sql, /jaro_winkler/);
  });

  it('append uses UNION BY NAME, not positional UNION ALL', () => {
    const ap = findPqParityRecipe('append-queries');
    assert.match(ap.sql, /UNION ALL BY NAME/);
  });

  it('listPqParityRecipes filters by topic and returns all with no topic', () => {
    const topics = pqParityTopics();
    assert.ok(topics.length >= 4);
    const all = listPqParityRecipes();
    assert.equal(all.length, PQ_PARITY_RECIPES.length);
    const joins = listPqParityRecipes('Joins');
    assert.ok(joins.length > 0);
    assert.ok(joins.every((r) => r.topic === 'Joins'));
  });

  it('buildPqParityPack states the honesty note and points at the Repair Ledger', () => {
    const pack = buildPqParityPack();
    assert.equal(pack.kind, PQ_PARITY_KIND);
    assert.match(pack.honesty, /not embedded/i);
    assert.match(pack.appliedStepsBlurb, /Repair Ledger|Applied Steps/i);
    assert.equal(pack.count, PQ_PARITY_RECIPES.length);
  });

  it('findPqParityRecipe returns null for an unknown id rather than throwing', () => {
    assert.equal(findPqParityRecipe('does-not-exist'), null);
  });
});

// ------------------------------------------------------------
// Arrow bridge deepen
// ------------------------------------------------------------

describe('arrow-bridge: v1 status is unchanged by the deepen', () => {
  it('buildArrowBridgeStatus still reports ready/partial/missing', () => {
    const s = buildArrowBridgeStatus({ duckdbArrow: false, pyarrow: false, pythonReady: false });
    assert.ok(ARROW_BRIDGE_STATES.includes(s.state));
    assert.match(NEVER_UNLIMITED, /no unlimited/i);
  });
});

describe('arrow-bridge: v2 four-state transfer kind', () => {
  it('names all four states', () => {
    assert.deepEqual(ARROW_BRIDGE_STATUS_KINDS, ['arrow_ipc', 'batch_bridge', 'json_bridge', 'missing']);
  });

  it('missing when python is not ready', () => {
    const v2 = buildArrowBridgeStatusV2({ pythonReady: false });
    assert.equal(v2.transferKind, 'missing');
  });

  it('batch_bridge when python is ready and typed arrays are available, arrow not ready', () => {
    const v2 = buildArrowBridgeStatusV2({ pythonReady: true, duckdbArrow: false, pyarrow: false });
    assert.equal(v2.transferKind, 'batch_bridge');
    assert.equal(v2.batchBridgeAvailable, true);
  });

  it('json_bridge when python is ready but typed arrays are declared unavailable', () => {
    const v2 = buildArrowBridgeStatusV2({ pythonReady: true, typedArraysAvailable: false });
    assert.equal(v2.transferKind, 'json_bridge');
  });

  it('arrow_ipc only when the underlying v1 status is ready', () => {
    const v2 = buildArrowBridgeStatusV2({ pythonReady: true, duckdbArrow: true, pyarrow: true });
    assert.equal(v2.transferKind, 'arrow_ipc');
  });

  it('never claims an unlimited row count regardless of transfer kind', () => {
    const v2 = buildArrowBridgeStatusV2({ pythonReady: true, rowLimit: JSON_BRIDGE_ROW_LIMIT });
    assert.equal(v2.rowLimit, JSON_BRIDGE_ROW_LIMIT);
    assert.match(BATCH_BRIDGE_CEILING, /no unlimited|does not remove the ceiling/i);
  });
});

describe('arrow-bridge: batch encode/decode and the fixture proof', () => {
  it('encodes and decodes a column with nulls exactly', () => {
    const values = [1, 2, null, 4, null];
    const batch = encodeColumnBatch(values, 'float64');
    assert.equal(batch.length, 5);
    assert.equal(batch.dtype, 'float64');
    assert.ok(batch.bytes > 0);
    const back = decodeColumnBatch(batch);
    assert.deepEqual(back, values);
  });

  it('defaults to float64 for an unknown dtype and never throws', () => {
    const batch = encodeColumnBatch([1, 2, 3], 'not-a-real-dtype');
    assert.equal(batch.dtype, 'float64');
  });

  it('decodeColumnBatch on garbage input returns an empty array', () => {
    assert.deepEqual(decodeColumnBatch(null), []);
    assert.deepEqual(decodeColumnBatch({}), []);
  });

  it('int32 dtype is supported', () => {
    assert.ok(BATCH_DTYPES.includes('int32'));
    const batch = encodeColumnBatch([1, -2, 3], 'int32');
    assert.equal(batch.dtype, 'int32');
    assert.deepEqual(decodeColumnBatch(batch), [1, -2, 3]);
  });

  it('roundTripFixture proves the encode/decode pair on a fixed input', () => {
    const proof = roundTripFixture();
    assert.equal(proof.ok, true);
    assert.ok(proof.bytes > 0);
    assert.match(proof.note, /decoded them back exactly/);
  });
});

// ------------------------------------------------------------
// Llama sidecar fetch status
// ------------------------------------------------------------

describe('llama-sidecar: three-state fetch status', () => {
  it('names all three states', () => {
    assert.deepEqual(SIDECAR_FETCH_STATES, ['missing', 'fetched_unwired', 'ready']);
  });

  it('missing when nothing is vendored for the triple', () => {
    const s = fetchSidecarStatus({ triple: 'x86_64-unknown-linux-gnu', presentTriples: [], externalBin: [] });
    assert.equal(s.state, 'missing');
  });

  it('fetched_unwired when vendored but externalBin does not declare it', () => {
    const s = fetchSidecarStatus({
      triple: 'x86_64-unknown-linux-gnu',
      presentTriples: ['x86_64-unknown-linux-gnu'],
      externalBin: [],
    });
    assert.equal(s.state, 'fetched_unwired');
    assert.equal(s.vendored, true);
    assert.equal(s.declared, false);
  });

  it('never claims ready purely from sidecarPresence; agrees with checkPackagingAgreement', () => {
    const present = sidecarPresence({ triple: 'x86_64-unknown-linux-gnu', presentTriples: ['x86_64-unknown-linux-gnu'] });
    assert.equal(present.ready, true, 'sanity: the lower-level presence check does say ready for this triple');
    const s = fetchSidecarStatus({
      triple: 'x86_64-unknown-linux-gnu',
      presentTriples: ['x86_64-unknown-linux-gnu'],
      externalBin: [EXTERNAL_BIN_ENTRY],
    });
    // fetchSidecarStatus always calls checkPackagingAgreement with
    // statusBundled:false, so declaring externalBin without also flipping the
    // runtime status constant still reads as a real disagreement, not ready.
    assert.equal(s.state, 'fetched_unwired');
    assert.equal(s.declared, true);
    assert.ok(s.agreementProblems.length > 0);
  });

  it('the fetch script documents --dry-run and --status in its usage header', () => {
    const src = read('scripts/fetch-llama-sidecar.mjs');
    assert.match(src, /--dry-run/);
    assert.match(src, /--status/);
    assert.match(src, /never touches the filesystem/i);
  });

  it('the docs file exists and states no binary is committed', () => {
    assert.ok(existsSync(join(REPO_ROOT, 'docs/desktop-llama-sidecar.md')));
    const doc = read('docs/desktop-llama-sidecar.md');
    assert.match(doc, /never committed|gitignore/i);
    assert.match(doc, /missing.*fetched_unwired.*ready|fetched_unwired/is);
  });
});

// ------------------------------------------------------------
// Project lanes
// ------------------------------------------------------------

describe('project-lanes: four lanes, honest hand-offs', () => {
  it('has exactly SQL, Python, Excel, R', () => {
    const ids = PROJECT_LANES.map((l) => l.id).sort();
    assert.deepEqual(ids, ['excel', 'python', 'r', 'sql']);
  });

  it('every lane names a concrete hand-off target and at least one limit', () => {
    for (const lane of PROJECT_LANES) {
      assert.ok(lane.handOffTo && lane.handOffTo.length > 5, `${lane.id}: handOffTo must be concrete`);
      assert.ok(Array.isArray(lane.limits) && lane.limits.length > 0, `${lane.id}: must name at least one limit`);
    }
  });

  it('SQL and Python are marked full-project capable; Excel and R are not', () => {
    assert.equal(findLane('sql').canDoWholeProject, true);
    assert.equal(findLane('python').canDoWholeProject, true);
    assert.equal(findLane('excel').canDoWholeProject, false);
    assert.equal(findLane('r').canDoWholeProject, false);
  });

  it('listLanes(true) returns only the full-project lanes', () => {
    const full = listLanes(true);
    assert.ok(full.every((l) => l.canDoWholeProject));
    assert.equal(full.length, 2);
  });

  it('buildProjectLanes never claims "any project"', () => {
    const model = buildProjectLanes();
    assert.equal(model.kind, PROJECT_LANES_KIND);
    assert.match(model.neverClaims, /any project/i);
    assert.equal(model.lanes.length, 4);
  });

  it('findLane returns null for an unknown id', () => {
    assert.equal(findLane('cobol'), null);
  });
});

// ------------------------------------------------------------
// No em dash anywhere in the five new/changed source files
// ------------------------------------------------------------

describe('bundle 14: no em dash in shipped UI-facing source', () => {
  const FILES = [
    'js/spine/repair-ledger.js',
    'js/spine/data-glow-repair-ledger-canvas.js',
    'js/polyglot/pq-parity-recipes.js',
    'js/polyglot/project-lanes.js',
    'js/polyglot/arrow-bridge.js',
    'js/ai/llama-sidecar-packaging.js',
    'scripts/fetch-llama-sidecar.mjs',
    'docs/desktop-llama-sidecar.md',
  ];
  for (const f of FILES) {
    it(`${f} has no em dash`, () => {
      assert.doesNotMatch(read(f), new RegExp(EM_DASH));
    });
  }
});

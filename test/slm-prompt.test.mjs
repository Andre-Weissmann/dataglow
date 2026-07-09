// ============================================================
// DATAGLOW — On-Device SLM prompt-construction tests
// ============================================================
// The model-loading / inference path needs WebGPU and is verified via the e2e
// graceful-degradation path (and manual testing in a WebGPU browser). What IS
// deterministic and unit-testable is the prompt-construction logic: given mock
// layer results + ledger + physics output, does it build the correct prompt?
//
// RUN WITH:  node test/slm-prompt.test.mjs

import {
  buildSynthesisPrompt,
  summarizeLayerResults,
  summarizeLedger,
  isWebGPUAvailable,
  MODEL_ID,
} from '../js/narrative/ondevice-llm.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- Layer-result summarization ----------
const mockResults = {
  unit_tests: { status: 'fail', summary: '2 unit test(s) failed.', detail: ['3 negative value(s) in "amount"', '1 blank key'] },
  confidence: { score: 72, grade: 'B', verdict: 'Usable with review', status: 'warn' },
  cross_column_logic: { status: 'pass', summary: 'No impossible cross-column combinations detected.' },
  categorical_consistency: { status: 'warn', summary: '1 inconsistent category cluster(s) found.', detail: ['"race" (sensitive category — merges disabled)'] },
};
{
  const s = summarizeLayerResults(mockResults);
  ok(/Unit Tests: \[FAIL\] 2 unit test\(s\) failed/.test(s), 'layer summary: generic layer renders status + summary');
  ok(/negative value/.test(s), 'layer summary: folds in a short detail list');
  ok(/Confidence: grade B \(score 72\/100\)/.test(s), 'layer summary: confidence layer renders grade + score');
  ok(/Cross-Column Logic: \[PASS\]/.test(s), 'layer summary: pass layers included with human-readable name');
}
ok(/no validation results/i.test(summarizeLayerResults(null)), 'layer summary: null results handled gracefully');
ok(/no validation results/i.test(summarizeLayerResults({})), 'layer summary: empty results handled gracefully');

// ---------- Ledger summarization ----------
const mockLedger = [
  { source: 'Categorical Consistency Engine', action: 'Flagged near-identical values in sensitive column "race" but disabled auto-merge.' },
  { source: 'Cross-Column Logical Consistency', action: 'Flagged 3 row(s) where "discharge" precedes "admit".' },
];
{
  const s = summarizeLedger(mockLedger);
  ok(/Categorical Consistency Engine/.test(s) && /disabled auto-merge/.test(s),
    'ledger summary: includes source and action');
  ok(s.split('\n').length === 2, 'ledger summary: one line per entry');
}
ok(/no assumptions/i.test(summarizeLedger([])), 'ledger summary: empty ledger handled gracefully');

// ---------- Full prompt construction ----------
{
  const { system, user, messages } = buildSynthesisPrompt({
    ledgerEntries: mockLedger,
    layerResults: mockResults,
    physicsOutput: { summary: 'BMI vs weight/height^2 consistent within 2% for 98% of rows.' },
  });

  ok(/data-quality reasoning assistant/i.test(system), 'prompt: system frames it as a data-quality assistant');
  ok(/NOT a medical|not a medical/i.test(system) && /clinical/i.test(system),
    'prompt: system explicitly disclaims medical/clinical reasoning (legal constraint)');

  ok(/## Assumption Ledger/.test(user), 'prompt: includes the Assumption Ledger section');
  ok(/disabled auto-merge/.test(user), 'prompt: embeds the actual ledger content');
  ok(/## Validation Layer Results/.test(user), 'prompt: includes the 20-layer results section');
  ok(/grade B \(score 72\/100\)/.test(user), 'prompt: embeds the actual layer summary');
  ok(/## Domain Physics Engine Output/.test(user) && /BMI vs weight/.test(user),
    'prompt: includes the Domain Physics Engine output when present');
  ok(/## Task/.test(user) && /plain-English/i.test(user), 'prompt: includes a clear synthesis task');

  ok(Array.isArray(messages) && messages.length === 2 &&
     messages[0].role === 'system' && messages[1].role === 'user',
    'prompt: messages array is a valid system+user chat payload');
}

// ---------- Physics output is optional ----------
{
  const { user } = buildSynthesisPrompt({ ledgerEntries: [], layerResults: mockResults });
  ok(!/Domain Physics Engine/.test(user), 'prompt: physics section omitted when no physics output provided');
}
// Physics output as a plain string and as an array of findings.
{
  const strU = buildSynthesisPrompt({ layerResults: {}, physicsOutput: 'Gravity check: OK' }).user;
  ok(/Domain Physics Engine Output/.test(strU) && /Gravity check: OK/.test(strU), 'prompt: string physics output rendered');
  const arrU = buildSynthesisPrompt({ layerResults: {}, physicsOutput: ['rule A held', 'rule B held'] }).user;
  ok(/- rule A held/.test(arrU) && /- rule B held/.test(arrU), 'prompt: array physics output rendered as bullets');
}

// ---------- Defaults / degradation surface ----------
ok(buildSynthesisPrompt().user.length > 0, 'prompt: builds with no arguments (all defaults)');
ok(typeof MODEL_ID === 'string' && MODEL_ID.length > 0, 'model id constant is defined');
ok(isWebGPUAvailable() === false, 'isWebGPUAvailable: returns false in Node (no navigator.gpu), never throws');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

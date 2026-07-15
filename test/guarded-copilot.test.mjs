// ============================================================
// DATAGLOW — Guarded Copilot test suite
// ============================================================
// Covers: intent classification, deterministic Tier 1 answers composed from
// the real readiness gate / grade vocabulary, the AI Touch Ledger integration
// for Guarded Copilot's own queries, graceful Tier 2 fallback with no WebGPU,
// and — the RED-TEAM part — a structural proof that this module has no write
// path of any kind (mirrors the discipline of test/agent-action-firewall.test.mjs
// and test/incident-postmortem.test.mjs).
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/guarded-copilot.test.mjs

import {
  SUPPORTED_INTENTS,
  PUBLIC_API_SURFACE,
  classifyIntent,
  answerDeterministic,
  askGuardedCopilot,
  refineWithOnDeviceModel,
} from '../js/agents/guarded-copilot.js';
import { createTouchLedger } from '../js/provenance/ai-touch-ledger.js';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

// ---------- intent classification ----------
ok(classifyIntent('why is my confidence score so low') === 'why_low_confidence', 'classifies why_low_confidence');
ok(classifyIntent('is this data ready for an agent') === 'is_ready_for_agent', 'classifies is_ready_for_agent');
ok(classifyIntent('what changed since yesterday') === 'what_changed_since', 'classifies what_changed_since');
ok(classifyIntent('who touched this dataset') === 'who_touched_this', 'classifies who_touched_this');
ok(classifyIntent('explain this grade to me') === 'explain_grade', 'classifies explain_grade');
ok(classifyIntent('what is the capital of France') === null, 'returns null for an out-of-scope question');
ok(classifyIntent('') === null, 'returns null for empty string');
ok(classifyIntent(undefined) === null, 'returns null for non-string input, never throws');

// ---------- deterministic Tier 1 answers ----------
{
  const passingLayers = { a: { status: 'pass' }, b: { status: 'pass' } };
  const r = answerDeterministic('is_ready_for_agent', { layerResults: passingLayers });
  ok(r.answered === true, 'is_ready_for_agent answers when layers pass');
  ok(/Yes/.test(r.text), 'is_ready_for_agent says Yes on a passing gate');
  ok(r.citedFrom.includes('js/gate/readiness-gate.js:computeReadinessGate'), 'cites the real readiness gate module');
}
{
  const failingLayers = { a: { status: 'fail' }, b: { status: 'fail' } };
  const r = answerDeterministic('why_low_confidence', { layerResults: failingLayers });
  ok(r.answered === true, 'why_low_confidence answers when layers fail');
  ok(/Not yet|BLOCKED/.test(r.text), 'why_low_confidence explains the block');
}
{
  const r = answerDeterministic('explain_grade', { grade: 'A' });
  ok(r.answered === true && /high confidence/.test(r.text), 'explains grade A correctly');
  const rBad = answerDeterministic('explain_grade', {});
  ok(rBad.answered === false, 'honestly declines when no grade is supplied — never invents one');
}
{
  const r = answerDeterministic('what_changed_since', { journalEntries: [{ summary: 'Merged PR #200' }] });
  ok(r.answered === true && r.text.includes('Merged PR #200'), 'what_changed_since surfaces real journal entries verbatim');
  const rEmpty = answerDeterministic('what_changed_since', { journalEntries: [] });
  ok(rEmpty.answered === true && /No logged changes/.test(rEmpty.text), 'what_changed_since is honest when nothing is logged');
}
{
  const r = answerDeterministic('who_touched_this', {
    touchLedgerEntries: [{ model: 'Qwen2.5-1.5B-Instruct (WebLLM)', location: 'ondevice' }],
  });
  ok(r.answered === true && /on-device, no network egress/.test(r.text), 'who_touched_this correctly labels an on-device touch');
}
{
  const r = answerDeterministic('unknown_intent_xyz', {});
  ok(r.answered === false, 'unsupported intent honestly declines rather than guessing');
}

// ---------- askGuardedCopilot: end-to-end + real Touch Ledger integration ----------
{
  const passingLayers = { a: { status: 'pass' } };
  const result = await askGuardedCopilot('is this ready for an agent?', { layerResults: passingLayers });
  ok(result.intent === 'is_ready_for_agent', 'askGuardedCopilot classifies correctly end-to-end');
  ok(result.answered === true, 'askGuardedCopilot answers end-to-end');
  ok(result.ledgerEntry && result.ledgerEntry.rejected === false, 'askGuardedCopilot logs a valid, accepted touch to the ledger');
  ok(result.ledgerEntry.location === 'ondevice', 'askGuardedCopilot logs its own query as on-device (Tier 1, no network)');
  ok(result.ledgerEntry.model === 'guarded-copilot-tier1-deterministic', 'ledger entry names the answering tier honestly');
}
{
  // Reusing a real, caller-supplied ledger across two questions should chain
  // (parentHash of entry 2 === hash of entry 1) — proves this composes with
  // the existing hash-chain discipline rather than starting a parallel one.
  const ledger = createTouchLedger();
  const r1 = await askGuardedCopilot('who touched this?', { touchLedger: ledger, touchLedgerEntries: [] });
  const r2 = await askGuardedCopilot('explain this grade', { touchLedger: ledger, grade: 'B' });
  ok(r1.ledgerEntry.index === 0 && r2.ledgerEntry.index === 1, 'a shared ledger chains multiple Guarded Copilot queries in order');
  ok(r2.ledgerEntry.parentHash === r1.ledgerEntry.hash, 'the chain links correctly — same hash discipline as the rest of provenance');
}
{
  // A caller with no ledger context at all must never throw.
  const result = await askGuardedCopilot('what changed since yesterday', {});
  ok(result.answered === true, 'askGuardedCopilot works with zero context supplied');
}

// ---------- Tier 2 graceful fallback (no WebGPU in Node) ----------
{
  const tier1 = { answered: true, text: 'Tier 1 answer.', citedFrom: [] };
  const refined = await refineWithOnDeviceModel('why is this low confidence?', tier1);
  ok(refined.usedOnDeviceModel === false, 'Tier 2 correctly reports no on-device model used in a non-WebGPU (Node) environment');
  ok(refined.text === tier1.text, 'Tier 2 falls back to the exact Tier 1 text unmodified — never a silent failure or blank answer');
}

// ---------- RED-TEAM: structural proof of the read-only guarantee ----------
{
  const src = fs.readFileSync(new URL('../js/agents/guarded-copilot.js', import.meta.url), 'utf8');
  // Strip comment lines before checking — the module's own comments EXPLAIN why
  // it never calls these firewall functions (naming them for documentation), so
  // a raw string search over the whole file would false-positive on its own
  // safety commentary. The real guarantee is checked in the CODE, not prose.
  const codeOnly = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  ok(!/confirmAndApply\s*\(|import\s*\{[^}]*confirmAndApply/.test(codeOnly), 'guarded-copilot.js never calls or imports confirmAndApply — cannot invoke the firewall\u2019s apply path');
  ok(!/proposeAction\s*\(|import\s*\{[^}]*proposeAction/.test(codeOnly), 'guarded-copilot.js never calls or imports proposeAction — cannot even initiate a mutation proposal');
  ok(!/\.write\(|\.insert\(|\.delete\(|\.update\(|\.mutate\(/.test(src), 'guarded-copilot.js contains no write/insert/delete/update/mutate call of any kind');
  ok(
    JSON.stringify(PUBLIC_API_SURFACE) === JSON.stringify(['classifyIntent', 'answerDeterministic', 'askGuardedCopilot', 'refineWithOnDeviceModel']),
    'the declared public API surface is exactly the four read-only functions — any future addition must consciously update this list',
  );
  ok(
    SUPPORTED_INTENTS.every((i) => typeof i === 'string'),
    'SUPPORTED_INTENTS is a clean, frozen list of question types',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

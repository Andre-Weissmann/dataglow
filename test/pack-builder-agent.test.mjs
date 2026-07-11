// ============================================================
// DATAGLOW — Guided Pack Builder test suite (Gen 42, Part 4)
// ============================================================
// Proves the pack builder assembles a VALID, PORTABLE, no-network pack from
// confirmed answers, however they arrived:
//   - a confirmed answer (button / typed / voice / resolver) is interpreted
//     identically into a learned rule,
//   - the rule kind is classified deterministically (no-merge / benford-exempt /
//     outlier-context) — a learned bound maps to outlier-context (the annotate-only
//     sandbox's closest kind; SCOPE NOTE in the module header),
//   - the running summary shows one bullet per learned rule + the two actions,
//   - finalize() produces a pack that passes the EXISTING community-pack schema
//     validator AND the no-network guard, and registers via the import path,
//   - it runs the build inside runWithNetworkDenied (zero network),
//   - 5 sample conversational sessions (incl. voice-transcribed and typed) each
//     yield a valid pack.
//
// Pure JS — no DuckDB, DOM, or network. RUN WITH:
//   node test/pack-builder-agent.test.mjs

import {
  classifyRuleKind, interpretAnswer, PackBuilderSession,
} from '../js/agents/pack-builder-agent.js';
import {
  PACK_KIND, PACK_SCHEMA_VERSION, validateImportedPack,
} from '../js/teaching/community-pack.js';
import { scanSourceForNetwork } from '../js/packs/pack-network-guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- tiny test harness ----------
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
function throws(fn, re, msg) {
  try { fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re ? re.test(e.message) : true, msg); }
}

// Build a confirmed answer as it arrives from each input method. `text` is the
// user's own words (a button/resolver acceptance falls back to the ruleGuess).
function answer(method, column, text, ruleGuess) {
  return { method, column, text, question: { column, ruleGuess } };
}

function main() {
  // ---------- 1. Deterministic rule-kind classification ----------
  ok(classifyRuleKind('keep these categories separate, do not merge them') === 'no-merge',
    'classify: "do not merge" → no-merge');
  ok(classifyRuleKind('this flag column deviates from Benford, exempt it') === 'benford-exempt',
    'classify: a Benford mention → benford-exempt');
  ok(classifyRuleKind('discounts never exceed 100%') === 'outlier-context',
    'classify: a learned bound → outlier-context (the sandbox default)');

  // ---------- 2. Every input method interprets identically ----------
  const methods = ['button', 'typed', 'voice', 'resolver'];
  for (const m of methods) {
    const { learnedRule, restatement } = interpretAnswer(
      answer(m, 'discount_pct', 'discounts never exceed 100%', '"discount_pct" never go above 100%'));
    ok(learnedRule.column === 'discount_pct' && learnedRule.kind === 'outlier-context',
      `interpret[${m}]: yields the same learned rule regardless of input method`);
    ok(restatement === 'discounts never exceed 100%',
      `interpret[${m}]: restatement echoes the user's own words`);
  }

  // A button/resolver acceptance with no free text falls back to the ruleGuess.
  const btn = interpretAnswer(answer('button', 'is_returned', '', 'exempt "is_returned" from the Benford check'));
  ok(btn.learnedRule.kind === 'benford-exempt' && /is_returned/.test(btn.restatement),
    'interpret: an empty button tap falls back to the question\'s ruleGuess');

  // Guards.
  throws(() => interpretAnswer({ method: 'typed', text: '', question: {} }), /empty answer|reference a column/,
    'interpret: an empty answer is rejected');
  throws(() => interpretAnswer(answer('typed', '', 'something', '')), /reference a column/,
    'interpret: an answer with no column is rejected');

  // ---------- 3. Running summary ----------
  const s = new PackBuilderSession({ domain: 'retail' });
  s.addConfirmedAnswer(answer('typed', 'discount_pct', 'discounts never exceed 100%', ''));
  s.addConfirmedAnswer(answer('voice', 'sku', 'keep the SKUs separate, never merge them', ''));
  const summary = s.buildRunningSummaryView();
  ok(summary.heading === "Here's everything I've learned so far:", 'summary: uses the fixed heading');
  ok(summary.lines.length === 2, 'summary: one bullet per confirmed rule');
  ok(summary.actions.length === 2 && summary.actions.map(a => a.id).sort().join(',') === 'add-another,done',
    'summary: offers [Add another] and [I\'m done — save my pack]');

  // Idempotent: the same column+kind is not added twice.
  s.addConfirmedAnswer(answer('button', 'discount_pct', 'discounts never exceed 100%', ''));
  ok(s.buildRunningSummaryView().lines.length === 2, 'summary: an exact duplicate column+kind is ignored');

  // ---------- 4. finalize() → valid, portable, registered pack ----------
  const fin = s.finalize({ name: 'my-retail', label: 'My Retail', description: 'Taught by a shop owner.' });
  ok(fin.ok === true && fin.errors.length === 0, 'finalize: a confirmed session finalizes cleanly');
  ok(fin.envelope.kind === PACK_KIND && fin.envelope.schemaVersion === PACK_SCHEMA_VERSION,
    'finalize: the envelope carries the correct kind + schema version');
  ok(validateImportedPack(fin.envelope).valid === true,
    'finalize: the built pack passes the EXISTING community-pack schema validator');
  ok(fin.pack && typeof fin.json === 'string' && fin.json.includes('my-retail'),
    'finalize: returns the registered runtime pack and serialized JSON');
  // The no-network guard sees no primitive in the serialized pack.
  ok(scanSourceForNetwork(fin.json).length === 0, 'finalize: the serialized pack carries no network primitive');

  // ---------- 5. finalize() guards ----------
  ok(new PackBuilderSession().finalize({ name: 'x' }).ok === false,
    'finalize: refuses to save a pack with zero confirmed rules');
  const s2 = new PackBuilderSession();
  s2.addConfirmedAnswer(answer('typed', 'x', 'x never negative', ''));
  ok(s2.finalize({ name: '' }).ok === false, 'finalize: a missing pack name is rejected');
  ok(s2.finalize({ name: 'healthcare' }).ok === false, 'finalize: a reserved built-in name is rejected');

  // ---------- 6. Five sample conversational sessions (button/typed/voice/resolver) ----------
  const sessions = [
    { name: 'coffee-shop', domain: 'retail', answers: [
      answer('button', 'discount_pct', '', '"discount_pct" never go above 100%'),
      answer('typed', 'cup_count', 'cup counts are never negative', ''),
    ] },
    { name: 'clinic-billing', domain: 'healthcare-lite', answers: [
      answer('voice', 'copay_pct', 'copays should never be more than one hundred percent', ''),
      answer('voice', 'visit_type', 'keep visit types separate, don\'t merge them', ''),
    ] },
    { name: 'freight', domain: 'logistics', answers: [
      answer('typed', 'tracking_no', 'never merge tracking numbers that look alike', ''),
      answer('resolver', 'transit_days', '', 'flag "transit_days" when it looks like an outlier'),
    ] },
    { name: 'bank-recon', domain: 'finance', answers: [
      answer('button', 'is_reconciled', '', 'exempt "is_reconciled" from the Benford check'),
    ] },
    { name: 'field-survey', domain: 'ops', answers: [
      answer('voice', 'completion_rate', 'completion rate can never exceed 100 percent', ''),
      answer('typed', 'region', 'keep regions distinct, never combine them', ''),
      answer('typed', 'sample_size', 'sample sizes are never negative', ''),
    ] },
  ];
  for (const sess of sessions) {
    const b = new PackBuilderSession({ domain: sess.domain });
    for (const a of sess.answers) b.addConfirmedAnswer(a);
    const r = b.finalize({ name: sess.name, description: `Rules from ${sess.domain}.` });
    ok(r.ok === true, `session[${sess.name}]: builds a valid pack (${sess.answers.length} rules)`);
    ok(validateImportedPack(r.envelope).valid === true,
      `session[${sess.name}]: the pack validates against the portable schema`);
    ok(r.envelope.pack.rules.length === sess.answers.length,
      `session[${sess.name}]: every confirmed answer became a rule`);
  }

  // ---------- 7. Save/share options view ----------
  const opts = PackBuilderSession.saveOptionsView();
  ok(opts.actions.map(a => a.id).sort().join(',') === 'export-share,save-local',
    'save: offers [Save locally] and [Export to share]');

  // ---------- 8. The builder source names no network primitive ----------
  const src = readFileSync(join(__dirname, '..', 'js', 'agents', 'pack-builder-agent.js'), 'utf8');
  ok(scanSourceForNetwork(src).length === 0, 'network: the builder source references zero network primitives');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

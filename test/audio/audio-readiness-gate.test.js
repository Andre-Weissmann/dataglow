// ============================================================
// DATAGLOW — Audio Ingestion: AI Readiness Gate test suite
// ============================================================
// Proves js/audio/audio-readiness-gate.js is honest and deterministic:
//   - a transcript with real text in every segment passes cleanly and is
//     agentConsumable,
//   - a transcript where every segment came back empty (no speech detected
//     anywhere) is a hard FAIL and is NOT agentConsumable -- mirrors the PDF
//     gate's "zero extractable text" case,
//   - a transcript with SOME empty segments (normal pauses/silence) is a
//     PASS with a warning layer, not penalized to a fail,
//   - an invalid/malformed segment array degrades to an honest fail rather
//     than throwing,
//   - the gate composes through the SAME js/gate/readiness-gate.js every
//     other source uses -- no parallel/invented scoring mechanism.
//
// Pure JS -- no DOM, no Worker, no network. RUN WITH:
//   node test/audio/audio-readiness-gate.test.js

import {
  buildAudioGateLayers,
  evaluateAudioReadiness,
} from '../../js/audio/audio-readiness-gate.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

function main() {
  // ---------- 1. All segments have real text: clean pass ----------
  const allText = [
    { timestamp: [0, 5], text: 'Hello and welcome to the call.' },
    { timestamp: [5, 12], text: 'Today we are discussing the quarterly numbers.' },
  ];
  const passLayers = buildAudioGateLayers(allText);
  ok(passLayers.length === 1, 'all-text: exactly one layer (no coverage warning needed)');
  ok(passLayers[0].status === 'pass', 'all-text: primary layer is pass');
  ok(/2 of 2/.test(passLayers[0].summary), 'all-text: summary cites 2 of 2 segments transcribed');

  const passResult = evaluateAudioReadiness(allText);
  ok(passResult.gate.agentConsumable === true, 'all-text: gate.agentConsumable is true');
  ok(passResult.gate.score === 100, 'all-text: score is 100');
  ok(typeof passResult.explanation === 'string' && passResult.explanation.length > 0,
     'all-text: explanation is a non-empty string');

  // ---------- 2. Every segment empty: hard fail, blocked from agent use ----------
  const allEmpty = [
    { timestamp: [0, 5], text: '' },
    { timestamp: [5, 10], text: '   ' },
  ];
  const failLayers = buildAudioGateLayers(allEmpty);
  ok(failLayers.length === 1, 'all-empty: exactly one layer');
  ok(failLayers[0].status === 'fail', 'all-empty: primary layer is fail');
  ok(/No speech was transcribed/.test(failLayers[0].summary), 'all-empty: summary explains no speech found');

  const failResult = evaluateAudioReadiness(allEmpty);
  ok(failResult.gate.agentConsumable === false, 'all-empty: gate.agentConsumable is false (blocked from agent use)');
  ok(failResult.gate.failingLayers.length === 1, 'all-empty: exactly one failing layer reported');

  // ---------- 3. Mixed: some empty segments is a warn, not a fail ----------
  const mixed = [
    { timestamp: [0, 3], text: 'Quick intro.' },
    { timestamp: [3, 8], text: '' },
    { timestamp: [8, 15], text: 'Then the real content starts here.' },
  ];
  const warnLayers = buildAudioGateLayers(mixed);
  ok(warnLayers.length === 2, 'mixed: two layers (primary pass + coverage warn)');
  ok(warnLayers[0].status === 'pass', 'mixed: primary layer is still pass (2 of 3 have text)');
  ok(warnLayers[1].status === 'warn', 'mixed: second layer is a warn, not a fail');
  ok(/1 of 3/.test(warnLayers[1].summary), 'mixed: warn summary cites 1 of 3 segments with no text');
  ok(/pauses, silence, or/.test(warnLayers[1].summary), 'mixed: warn summary frames silence as expected, not an error');

  const mixedResult = evaluateAudioReadiness(mixed);
  ok(mixedResult.gate.agentConsumable === true, 'mixed: partial silence coverage does not block agent use (still agentConsumable)');
  ok(mixedResult.gate.score > 0 && mixedResult.gate.score < 100, 'mixed: score reflects the warn (between 0 and 100)');

  // ---------- 4. Invalid input degrades to an honest fail, never throws ----------
  let threwOnEmptyArray = false;
  let emptyArrayLayers = null;
  try {
    emptyArrayLayers = buildAudioGateLayers([]);
  } catch {
    threwOnEmptyArray = true;
  }
  ok(threwOnEmptyArray === false, 'invalid-input: buildAudioGateLayers never throws, even on an empty array');
  ok(Array.isArray(emptyArrayLayers) && emptyArrayLayers[0].status === 'fail',
     'invalid-input: empty segment array reports a fail layer');

  let threwOnMalformed = false;
  try {
    buildAudioGateLayers([{ text: 'no timestamp field' }]);
  } catch {
    threwOnMalformed = true;
  }
  ok(threwOnMalformed === false, 'invalid-input: malformed segment (missing timestamp) never throws');

  const malformedResult = evaluateAudioReadiness(null);
  ok(malformedResult.gate.agentConsumable === false, 'invalid-input: null input is not agentConsumable');

  // ---------- 5. Composes through the shared readiness-gate module ----------
  // (structural check: the returned gate object has the same shape
  // js/gate/readiness-gate.js's computeReadinessGate produces for every
  // other source -- not a parallel invented shape.)
  ok('agentConsumable' in passResult.gate && 'score' in passResult.gate && 'threshold' in passResult.gate,
     'shared-gate: result carries the standard gate shape (agentConsumable/score/threshold)');
  ok('failingLayers' in passResult.gate, 'shared-gate: result carries failingLayers like every other gate consumer');

  // ---------- Summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

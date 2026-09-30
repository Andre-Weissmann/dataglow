import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudioReadiness } from '../../js/audio/audio-readiness-gate.js';
const text = [{ timestamp: [0, 2], text: 'A real sentence.' }];
test('nonempty text is blocked by default, not automatically approved', () => {
  const r = evaluateAudioReadiness(text);
  assert.equal(r.gate.agentConsumable, false);
  assert.match(r.explanation, /Human review/);
});
for (const humanConfirmed of [undefined, false, 'true', 1, null]) {
  test(`confirmation must be strict true: ${String(humanConfirmed)}`, () => {
    assert.equal(evaluateAudioReadiness(text, { humanConfirmed }).gate.agentConsumable, false);
  });
}
test('confirmed valid text passes structure and review, not speech accuracy', () => {
  const r = evaluateAudioReadiness(text, { humanConfirmed: true });
  assert.equal(r.gate.agentConsumable, true);
  assert.match(r.layers[0].summary, /does not prove/);
});
for (const segments of [null, [], [{ timestamp: [0, 2], text: '' }],
  [{ timestamp: [NaN, 2], text: 'bad' }], [{ timestamp: [3, 2], text: 'bad' }],
  [{ timestamp: [-1, 2], text: 'bad' }], [{ timestamp: [0, Infinity], text: 'bad' }],
  [{ text: 'missing times' }]]) {
  test(`invalid/empty remains blocked even if confirmed: ${JSON.stringify(segments)}`, () => {
    assert.equal(evaluateAudioReadiness(segments, { humanConfirmed: true }).gate.agentConsumable, false);
  });
}
test('threshold/force cannot bypass human review', () => {
  assert.equal(evaluateAudioReadiness(text, { threshold: 0, force: true }).gate.agentConsumable, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptReview } from '../../js/audio/transcript-review.js';
import { audioBufferToMono16k, writeMono16k, requireMediaConsent } from '../../js/audio/audio-pcm.js';
import { normalizeWhisperSegments, transcribePcm } from '../../js/audio/whisper-file-transcriber.js';
import { configureFlags } from '../../js/build/build-flags.js';
import { prepareVideoTranscript, prepareAudioTranscript, confirmMediaTranscript } from '../../js/app-shell/loaders.js';
const segments = () => [{ timestamp: [0, 2], text: 'One sentence.' }];
const approval = (extra = {}) => ({ confirmed: true, reviewer: 'Local analyst', revision: 0, ...extra });

test('preview is an isolated copy; original/preview mutations do not change pending data', () => {
  const raw = segments();
  const review = createTranscriptReview(raw, 'test');
  raw[0].text = 'tampered';
  const p = review.preview();
  p.structured.rows[0].text = 'tampered';
  assert.equal(review.preview().structured.rows[0].text, 'One sentence.');
  assert.equal(p.readiness.gate.agentConsumable, false);
});
for (const confirm of [{}, approval({ confirmed: 'true' }), approval({ reviewer: '' }),
  approval({ revision: 9 }), approval({ confirmed: false })]) {
  test(`bad confirmation does not invoke importer: ${JSON.stringify(confirm)}`, async () => {
    let writes = 0;
    const r = createTranscriptReview(segments(), 'test');
    await assert.rejects(r.confirmAndImport(confirm, () => writes++));
    assert.equal(writes, 0);
  });
}
test('edit invalidates previous approval, exact reviewed content is passed once', async () => {
  const r = createTranscriptReview(segments(), 'test');
  r.edit(0, '00123');
  await assert.rejects(r.confirmAndImport(approval(), () => assert.fail('write')));
  let writes = 0;
  const payload = await r.confirmAndImport(approval({ revision: 1 }), p => { writes++; return p; });
  assert.equal(payload.rows[0].text, '00123');
  assert.equal(payload.meta.humanConfirmed, true);
  assert.equal(payload.meta.reviewer, 'Local analyst');
  await assert.rejects(r.confirmAndImport(approval({ revision: 1 }), () => writes++));
  assert.equal(writes, 1);
});
test('double submit is locked before await, even while importer waits', async () => {
  const r = createTranscriptReview(segments(), 'test');
  let release;
  const first = r.confirmAndImport(approval(), () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(r.confirmAndImport(approval(), () => assert.fail('duplicate')));
  release('ok');
  assert.equal(await first, 'ok');
});
test('discarded and failed imports cannot be replayed', async () => {
  const r = createTranscriptReview(segments(), 'test');
  r.discard();
  await assert.rejects(r.confirmAndImport(approval(), () => assert.fail('write')));
  const failed = createTranscriptReview(segments(), 'test');
  await assert.rejects(failed.confirmAndImport(approval(), () => { throw Error('database unavailable'); }));
  await assert.rejects(failed.confirmAndImport(approval(), () => assert.fail('retry')));
});
test('empty text cannot be approved into a dataset', async () => {
  const r = createTranscriptReview([{ timestamp: [0, 1], text: ' ' }], 'empty');
  await assert.rejects(r.confirmAndImport(approval(), () => assert.fail('write')));
});
test('all stereo channels contribute, not just left channel', () => {
  const out = new Float32Array(2);
  writeMono16k(out, [new Float32Array([0, 0]), new Float32Array([1, 1])], 16000);
  assert.deepEqual([...out], [0.5, 0.5]);
});
test('8kHz upsamples; 48kHz downsamples to the correct 16kHz duration', () => {
  for (const sampleRate of [8000, 44100, 48000]) {
    const buf = { duration: 1, numberOfChannels: 1, sampleRate, getChannelData: () => new Float32Array(sampleRate).fill(.25) };
    const out = audioBufferToMono16k(buf);
    assert.equal(out.length, 16000);
    assert.equal(out[100], .25);
  }
});
test('timestamps retain gaps and trim negative encoder preroll', () => {
  const out = new Float32Array(4);
  writeMono16k(out, [new Float32Array([1, 1])], 16000, 2 / 16000);
  assert.deepEqual([...out], [0, 0, 1, 1]);
  writeMono16k(out, [new Float32Array([2, 3])], 16000, -1 / 16000);
  assert.equal(out[0], 3);
});
test('oversized or nonfinite samples fail closed', () => {
  assert.throws(() => writeMono16k(new Float32Array(1), [new Float32Array(2)], 16000));
  assert.throws(() => writeMono16k(new Float32Array(1), [new Float32Array([NaN])], 16000));
});
test('consent and cancellation are enforced below the UI', async () => {
  assert.throws(() => requireMediaConsent({ consent: 'true' }));
  const c = new AbortController();
  c.abort();
  assert.throws(() => requireMediaConsent({ consent: true, signal: c.signal }), { name: 'AbortError' });
  await assert.rejects(transcribePcm(new Float32Array(16), {}), /consent/);
});
test('model null final timestamp is bounded, missing/malformed times are not invented', () => {
  assert.deepEqual(normalizeWhisperSegments({ chunks: [{ timestamp: [0, null], text: 'hello' }] }, 2),
    [{ timestamp: [0, 2], text: 'hello' }]);
  assert.throws(() => normalizeWhisperSegments({ text: 'no chunks' }, 2));
  assert.throws(() => normalizeWhisperSegments({ chunks: [{ timestamp: [3, 2], text: 'wrong' }] }, 2));
});
test('direct loader calls respect flags, consent, and known review identity', async () => {
  configureFlags({});
  await assert.rejects(prepareVideoTranscript({}, { consent: true }), /disabled/);
  await assert.rejects(prepareAudioTranscript({}, { consent: true }), /disabled/);
  configureFlags({ cleaningCrew: { enabled: true }, audioTranscription: { enabled: true }, videoTranscription: { enabled: true } });
  await assert.rejects(prepareVideoTranscript({}, {}), /consent/);
  await assert.rejects(confirmMediaTranscript({ confirmAndImport: () => assert.fail('forged') }, approval()), /Unknown/);
});

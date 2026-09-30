// Structural coverage only; behavioral confirmation/UI tests live in
// media-review.test.mjs and video-browser.test.mjs. Copy alone proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tab = read('js/app-shell/tabs/cleaning-crew-tab.js');
const loaders = read('js/app-shell/loaders.js');
const flags = JSON.parse(read('flags.manifest.json')).flags;
test('audio has its existing boolean flag; video has a separate default-off flag', () => {
  assert.equal(typeof flags.audioTranscription.enabled, 'boolean');
  assert.equal(flags.videoTranscription.enabled, false);
});
test('tab explicitly gates both media stations', () => {
  assert.match(tab, /isEnabled\('audioTranscription'\)/);
  assert.match(tab, /isEnabled\('videoTranscription'\)/);
});
test('automatic file dispatch never transcribes audio or video', () => {
  const loadFile = loaders.slice(loaders.indexOf('export async function loadFile'), loaders.indexOf('export async function loadRowsAsDataset'));
  assert.doesNotMatch(loadFile, /prepareAudioTranscript|prepareVideoTranscript|transcribePcm/);
});
test('audio prepare does not call the engine or dataset loader', () => {
  const prepare = loaders.slice(loaders.indexOf('export async function prepareAudioTranscript'),
    loaders.indexOf('export async function confirmMediaTranscript'));
  assert.doesNotMatch(prepare, /loadRowsAsDataset|engine\.|addDataset/);
});
test('pending drafts are a private weak map, confirmation routes through revision guard', () => {
  assert.match(loaders, /const pendingMedia = new WeakMap/);
  assert.match(loaders, /review\.confirmAndImport\(confirmation/);
});

// Real demux + WebCodecs decoding. For UI/SQL tests ONLY, a request-level
// Whisper double gives deterministic output. Never count that as ASR proof.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-chromium';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.MEDIA_QA_OUTPUT || '/tmp/dataglow-media-qa';
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname);
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(await readFile(path));
  } catch { res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--use-angle=swiftshader'],
});
const results = [];
const pass = (name, detail = {}) => { results.push({ name, ...detail }); console.log('PASS', name, JSON.stringify(detail)); };
try {
  const page = await browser.newPage();
  const external = [];
  page.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith('blob:')) external.push(req.url()); });
  page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
  await page.goto(`${base}/test/video/harness.html`);
  // Exercise the actual vendored demuxer and browser AudioDecoder.
  for (const extension of ['mp4', 'mov', 'webm']) {
    const r = await page.evaluate(async ({ extension }) => {
      const { extractVideoAudio } = await import('/js/video/video-audio-extractor.js');
      const blob = await (await fetch(`/test/video/fixtures/right-channel.${extension}`)).blob();
      const r = await extractVideoAudio(new File([blob], `right-channel.${extension}`, { type: `video/${extension}` }), { consent: true });
      let power = 0;
      for (const v of r.audio) power += v * v;
      return { ...r.metadata, samples: r.audio.length, rms: Math.sqrt(power / r.audio.length) };
    }, { extension });
    assert.ok(r.samples >= 31000 && r.samples <= 33000);
    assert.ok(r.rms > .07 && r.rms < .16, 'right channel must be mixed into output');
    assert.equal(r.framesAnalyzed, false);
    pass(`real ${extension} decode, 16kHz mono, right-channel signal retained`, r);
  }
  const failures = await page.evaluate(async () => {
    const { extractVideoAudio } = await import('/js/video/video-audio-extractor.js');
    const noAudio = new File([await (await fetch('/test/video/fixtures/no-audio.mp4')).blob()], 'no-audio.mp4');
    const c = new AbortController(); c.abort();
    const unsupported = new File([await (await fetch('/test/video/fixtures/unsupported.mov')).blob()], 'unsupported.mov');
    const tooLong = new File([await (await fetch('/test/video/fixtures/too-long.mp4')).blob()], 'too-long.mp4');
    const checks = [
      () => extractVideoAudio(noAudio, { consent: true }),
      () => extractVideoAudio(new File(['junk'], 'corrupt.mp4'), { consent: true }),
      () => extractVideoAudio(noAudio, { consent: false }),
      () => extractVideoAudio(noAudio, { consent: true, signal: c.signal }),
      () => extractVideoAudio({ name: 'huge.mp4', type: 'video/mp4', size: 201 * 1024 * 1024 }, { consent: true }),
      () => extractVideoAudio(unsupported, { consent: true }),
      () => extractVideoAudio(tooLong, { consent: true }),
    ];
    const outcomes = [];
    for (const fn of checks) {
      try { await fn(); outcomes.push('unexpected success'); } catch (e) { outcomes.push(e.message); }
    }
    return outcomes;
  });
  assert.ok(failures.every(s => s !== 'unexpected success'));
  assert.match(failures[0], /no audio track/);
  pass('no-audio, corrupt, no-consent, cancelled, oversized, unsupported-codec and over-duration all reject', { failures });
  const multi = await page.evaluate(async () => {
    const { extractVideoAudio } = await import('/js/video/video-audio-extractor.js');
    const file = new File([await (await fetch('/test/video/fixtures/two-tracks.mp4')).blob()], 'two-tracks.mp4');
    return (await extractVideoAudio(file, { consent: true })).metadata;
  });
  assert.equal(multi.audioTrackCount, 2);
  assert.equal(multi.selectedTrack, 'primary');
  pass('multiple tracks are disclosed; one primary track is extracted', multi);
  assert.deepEqual(external, []);
  pass('real extraction made no third-party requests');

  if (process.env.MEDIA_REAL_WHISPER === '1') {
    // Separate opt-in development proof. Never runs in CI or quietly downloads
    // hundreds of MB with the ordinary deterministic browser tests.
    page.on('console', msg => console.log('ASR', msg.text().slice(0, 250)));
    const asr = await page.evaluate(async () => {
      const { extractVideoAudio } = await import('/js/video/video-audio-extractor.js');
      const { transcribePcm } = await import('/js/audio/whisper-file-transcriber.js');
      const file = new File([await (await fetch('/test/video/fixtures/speech.mp4')).blob()], 'speech.mp4');
      const { audio } = await extractVideoAudio(file, { consent: true });
      let last = '';
      try {
        const segments = await Promise.race([
          transcribePcm(audio, { consent: true, onProgress: p => {
            if (p.text !== last) { console.log(p.text); last = p.text; }
          } }),
          new Promise((_, reject) => setTimeout(() => reject(Error('Real Whisper proof timed out after 180s')), 180000)),
        ]);
        return { segments, gpu: !!navigator.gpu };
      } catch (e) { return { error: e.message, gpu: !!navigator.gpu }; }
    });
    await writeFile(resolve(output, 'real-whisper.json'), JSON.stringify(asr, null, 2));
    console.log('REAL WHISPER EVIDENCE', JSON.stringify(asr));
    if (!asr.error) pass('real WebGPU Whisper produced segments on synthetic speech', asr);
  }

  // New page module graph: replace ONLY model inference; decoding, loaders,
  // review UI, gate, provenance and DuckDB all remain production code.
  const ui = await browser.newPage();
  await ui.route('**/js/audio/whisper-file-transcriber.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export function isFileTranscriptionAvailable(){return true}
      export async function transcribePcm(pcm,options){
        if(options.consent !== true) throw Error('consent');
        window.__testInferenceCalls=(window.__testInferenceCalls||0)+1;
        if(window.__testDelay) await new Promise(r=>setTimeout(r,200));
        if(options.signal?.aborted) throw new DOMException('Cancelled. Nothing was imported.','AbortError');
        return [{timestamp:[0,1],text:'00123'},{timestamp:[1,2],text:'</textarea><img src=x onerror=alert(1)>'}];
      }
      export async function transcribeAudioFile(file,options){return transcribePcm(new Float32Array(32000),options)}
    `,
  }));
  await ui.goto(`${base}/test/video/harness.html`);
  await ui.evaluate(async () => {
    const { configureFlags } = await import('/js/build/build-flags.js');
    const { renderCleaningCrewTab } = await import('/js/app-shell/tabs/cleaning-crew-tab.js');
    const engine = await import('/js/app-shell/duckdb-engine.js');
    window.__state = (await import('/js/app-shell/state.js')).state;
    window.__engine = engine;
    window.__render = async (video = true, audio = true) => {
      configureFlags({ flags: { cleaningCrew: { enabled: true }, audioTranscription: { enabled: audio }, videoTranscription: { enabled: video } } });
      await renderCleaningCrewTab({ ensureDuckDB: () => engine.initDuckDB(), renderSidebar: () => {}, iconSvg: () => '', switchTab: () => {} });
    };
    await window.__render(false);
  });
  assert.equal(await ui.getByTestId('crew-video-station').count(), 0);
  assert.equal(await ui.evaluate(() => window.__testInferenceCalls || 0), 0);
  pass('flag-off video absent and no inference on mount');
  await ui.evaluate(() => window.__render());
  assert.equal(await ui.getByTestId('btn-crew-video').isDisabled(), true);
  // Simulated file change without consent must not even call the lower path.
  await ui.getByTestId('crew-video-input').setInputFiles(resolve(root, 'test/video/fixtures/right-channel.mp4'));
  assert.equal(await ui.evaluate(() => window.__testInferenceCalls || 0), 0);
  pass('file event without checkbox consent is inert');
  await ui.getByTestId('crew-video-optin').check();
  await ui.getByTestId('crew-video-input').setInputFiles(resolve(root, 'test/video/fixtures/right-channel.mp4'));
  await ui.getByTestId('crew-video-confirm').waitFor();
  assert.equal(await ui.evaluate(() => window.__state.datasets.length), 0);
  assert.equal(await ui.locator('[data-testid="crew-video-result"] img').count(), 0);
  assert.equal(await ui.getByTestId('crew-video-confirm').isDisabled(), true);
  pass('review is escaped and no dataset exists before confirmation');
  await ui.getByTestId('crew-video-reviewer').fill('Synthetic QA reviewer');
  await ui.getByTestId('crew-video-reviewed').check();
  await ui.locator('[data-segment="1"]').fill('Reviewed second segment');
  assert.equal(await ui.getByTestId('crew-video-reviewed').isChecked(), false);
  assert.equal(await ui.getByTestId('crew-video-confirm').isDisabled(), true);
  pass('editing invalidates checkbox approval');
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 375, 900], ['narrow', 320, 850]]) {
    await ui.setViewportSize({ width, height });
    const overflow = await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await ui.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    pass(`review UI no horizontal overflow at ${width}px`);
  }
  await ui.setViewportSize({ width: 1440, height: 1000 });
  await ui.getByTestId('crew-video-reviewed').check();
  await ui.getByTestId('crew-video-confirm').click();
  await ui.waitForFunction(() => window.__state.datasets.length === 1
    || document.querySelector('[data-testid="crew-video-status"]').textContent.startsWith('Import stopped'), null, { timeout: 90000 });
  assert.equal(await ui.evaluate(() => window.__state.datasets.length), 1,
    await ui.getByTestId('crew-video-status').textContent());
  const loaded = await ui.evaluate(async () => {
    const ds = window.__state.datasets[0];
    const result = await window.__engine.runQuery(`SELECT text, start_sec, end_sec FROM ${ds.table} ORDER BY segment_id`);
    return { ds, rows: result.rows };
  });
  assert.equal(loaded.ds.rowCount, 2);
  assert.equal(loaded.ds.transcriptReview.humanConfirmed, true);
  assert.equal(loaded.ds.transcriptReview.framesAnalyzed, false);
  assert.equal(loaded.rows[0].text, '00123'); // preserves transcript text, not 123
  assert.equal(loaded.rows[1].text, 'Reviewed second segment');
  pass('confirmed video import creates actual DuckDB rows and review provenance', loaded);
  const typing = await ui.evaluate(async () => {
    const e = window.__engine;
    await e.createTableFromRows('qa_transcript_text', ['text'], [{ text: '00123' }, { text: '00456' }], { preserveTextColumns: ['text'] });
    await e.createTableFromRows('qa_ordinary_numeric', ['value'], [{ value: '00123' }, { value: '00456' }]);
    const preserved = await e.runQuery('SELECT text FROM qa_transcript_text ORDER BY text');
    const ordinary = await e.runQuery('SELECT value FROM qa_ordinary_numeric ORDER BY value');
    return { preserved: preserved.rows, ordinary: ordinary.rows };
  });
  assert.deepEqual(typing.preserved, [{ text: '00123' }, { text: '00456' }]);
  assert.deepEqual(typing.ordinary, [{ value: 123 }, { value: 456 }]);
  pass('all-numeric transcript strings retain leading zeros; ordinary numeric inference is unchanged', typing);
  // Audio uses same real review boundary.
  await ui.getByTestId('crew-audio-optin').check();
  await ui.getByTestId('crew-audio-input').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from('test input') });
  await ui.getByTestId('crew-audio-confirm').waitFor();
  assert.equal(await ui.evaluate(() => window.__state.datasets.length), 1);
  await ui.getByTestId('crew-audio-discard').click();
  assert.equal(await ui.evaluate(() => window.__state.datasets.length), 1);
  pass('audio also requires review, discard causes no dataset write');
  await ui.evaluate(() => { window.__testDelay = true; });
  await ui.getByTestId('crew-video-input').setInputFiles(resolve(root, 'test/video/fixtures/right-channel.mp4'));
  await ui.getByTestId('crew-video-cancel').click();
  await ui.waitForFunction(() => document.querySelector('[data-testid="crew-video-status"]').textContent.startsWith('Cancelled'));
  assert.equal(await ui.evaluate(() => window.__state.datasets.length), 1);
  assert.equal(await ui.getByTestId('crew-video-confirm').count(), 0);
  pass('cancellation cannot publish a late result');

  // Check missing browser APIs independently of viewport emulation.
  const unsupported = await browser.newPage();
  await unsupported.goto(`${base}/test/video/harness.html`);
  await unsupported.evaluate(async () => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    const { mountMediaTranscriptionStation } = await import('/js/audio/media-transcription-station.js');
    mountMediaTranscriptionStation(document.querySelector('#cleaning-crew-body'), 'video', {});
  });
  assert.equal(await unsupported.getByTestId('crew-video-unavailable').count(), 1);
  assert.equal(await unsupported.getByTestId('btn-crew-video').count(), 0);
  pass('missing WebGPU produces unavailable state, not a dead button');
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, external, inference: 'UI tests used a deterministic model double, not real Whisper' }, null, 2));
  console.log(`${results.length} browser checks passed. Evidence: ${output}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

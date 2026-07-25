/**
 * Air-Gap Mode (pure posture + egress classifier) tests.
 *
 * No DOM, no storage, no network. What is pinned here is the contract the
 * canvas UI leans on: the mode is OFF until something turns it on, it fails
 * closed for anything that is not an explicit on-device feature, local engines
 * are never blocked, and no user-visible string carries an em dash.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_GAP_VERSION,
  isAirGapActive,
  activate,
  deactivate,
  shouldBlockNetwork,
  classifyFeature,
  classifyRequestUrl,
  listLocalFeatures,
  listEgressFeatures,
  getPosture,
  postureCopy,
  resetAirGapSession,
  DataGlowAirGap,
} from '../js/privacy/air-gap-mode.js';

const EM_DASH = '—';
const ORIGIN = 'https://dataglow.example';

beforeEach(() => { resetAirGapSession(); });

describe('air-gap: module shape', () => {
  it('exports a version and the full public API on the namespace object', () => {
    assert.equal(AIR_GAP_VERSION, 1);
    for (const fn of [
      'isAirGapActive', 'activate', 'deactivate', 'shouldBlockNetwork', 'classifyFeature',
      'classifyRequestUrl', 'listLocalFeatures', 'listEgressFeatures', 'getPosture', 'postureCopy',
    ]) {
      assert.equal(typeof DataGlowAirGap[fn], 'function', `missing ${fn}`);
    }
  });

  it('returns copies of the feature lists so callers cannot mutate the allowlist', () => {
    listLocalFeatures().push('ai');
    assert.ok(!listLocalFeatures().includes('ai'));
    listEgressFeatures().length = 0;
    assert.ok(listEgressFeatures().includes('ai'));
  });
});

describe('air-gap: session state', () => {
  it('is off until activated, and activation is session scoped with nothing persisted', () => {
    assert.equal(isAirGapActive(), false);
    const p = activate('user toggle');
    assert.equal(isAirGapActive(), true);
    assert.equal(p.active, true);
    assert.equal(p.reason, 'user toggle');
    assert.equal(p.sessionScoped, true);
    assert.equal(p.persisted, false);
    assert.equal(p.failClosed, true);
  });

  it('is idempotent in both directions', () => {
    activate();
    activate();
    assert.equal(getPosture().activatedCount, 1);
    deactivate();
    deactivate();
    assert.equal(isAirGapActive(), false);
  });

  it('restores every path on deactivate', () => {
    activate();
    assert.equal(shouldBlockNetwork('ai').blocked, true);
    deactivate();
    assert.equal(shouldBlockNetwork('ai').blocked, false);
    assert.deepEqual(getPosture().blockedFeatures, []);
  });

  it('reports a banner only while active', () => {
    assert.equal(getPosture().banner, false);
    activate();
    assert.equal(getPosture().banner, true);
  });
});

describe('air-gap: classifyFeature', () => {
  it('names local engines local and egress paths egress', () => {
    for (const id of ['duckdb', 'sql', 'python', 'r', 'charts', 'pivot', 'local-file']) {
      assert.equal(classifyFeature(id), 'local', id);
    }
    for (const id of ['ai', 'mcp', 'serverOffload', 'cdn', 'telemetry', 'rooms', 'federated']) {
      assert.equal(classifyFeature(id), 'egress', id);
    }
  });

  it('calls anything it does not recognise unknown rather than guessing', () => {
    for (const bad of ['whatever-2027', '', null, undefined, 42, {}]) {
      assert.equal(classifyFeature(bad), 'unknown');
    }
  });
});

describe('air-gap: shouldBlockNetwork', () => {
  it('blocks nothing while the mode is off', () => {
    for (const id of ['ai', 'mcp', 'serverOffload', 'sql', 'mystery']) {
      assert.equal(shouldBlockNetwork(id).blocked, false, id);
    }
  });

  it('hard-blocks AI, MCP, and server offload while on', () => {
    activate();
    for (const id of ['ai', 'mcp', 'serverOffload']) {
      const d = shouldBlockNetwork(id);
      assert.equal(d.blocked, true, id);
      assert.equal(d.reason, 'egress');
      assert.match(d.message, /Air-Gap Mode is on/);
    }
  });

  it('keeps every local engine running while on', () => {
    activate();
    for (const id of listLocalFeatures()) {
      const d = shouldBlockNetwork(id);
      assert.equal(d.blocked, false, id);
      assert.equal(d.reason, 'local');
    }
  });

  it('fails closed on an unclassified feature so a future path cannot leak by omission', () => {
    activate();
    const d = shouldBlockNetwork('some-future-uploader');
    assert.equal(d.blocked, true);
    assert.equal(d.reason, 'unknown-fail-closed');
  });

  it('never throws on junk input', () => {
    activate();
    for (const bad of [null, undefined, 0, {}, []]) {
      assert.equal(shouldBlockNetwork(bad).blocked, true);
    }
  });
});

describe('air-gap: classifyRequestUrl', () => {
  it('allows same-origin and inline resources so self-hosted assets keep loading', () => {
    for (const url of [
      'assets/duckdb/duckdb-eh.wasm',
      '/assets/plotly.min.js',
      `${ORIGIN}/assets/sheetjs.js`,
      'blob:https://dataglow.example/1234',
      'data:text/plain,hello',
    ]) {
      assert.equal(classifyRequestUrl(url, ORIGIN).blocked, false, url);
    }
  });

  it('blocks cross-origin requests and says where they were going', () => {
    for (const url of [
      'https://api.openai.com/v1/messages',
      'https://cdn.jsdelivr.net/pyodide/pyodide.js',
      '//evil.example/beacon',
    ]) {
      const v = classifyRequestUrl(url, ORIGIN);
      assert.equal(v.blocked, true, url);
      assert.equal(v.kind, 'cross-origin');
    }
  });

  it('blocks a URL it cannot read rather than letting it through', () => {
    for (const bad of ['', null, undefined, 'http://[bad', '   ']) {
      assert.equal(classifyRequestUrl(bad, ORIGIN).blocked, true, String(bad));
    }
  });

  it('blocks absolute URLs when the origin is unknown', () => {
    assert.equal(classifyRequestUrl('https://api.openai.com/v1', '').blocked, true);
    assert.equal(classifyRequestUrl('https://api.openai.com/v1', 'not a url').blocked, true);
  });
});

describe('air-gap: postureCopy', () => {
  it('never uses an em dash in user-visible copy', () => {
    for (const on of [false, true]) {
      if (on) activate(); else deactivate();
      const copy = postureCopy(getPosture());
      for (const [key, value] of Object.entries(copy)) {
        assert.equal(typeof value, 'string');
        assert.ok(value.length > 0, `empty ${key}`);
        assert.ok(!value.includes(EM_DASH), `em dash in ${key}`);
      }
    }
  });

  it('states the posture plainly in both directions', () => {
    assert.equal(postureCopy(getPosture()).title, 'Air-Gap Mode is off');
    activate();
    const copy = postureCopy(getPosture());
    assert.equal(copy.title, 'Air-Gap Mode is on');
    assert.match(copy.blocked, /AI providers/);
    assert.match(copy.body, /keep running locally/);
  });

  it('never claims to be a firewall or a certification', () => {
    const copy = postureCopy(activate());
    assert.match(copy.disclaimer, /not a firewall/);
    assert.ok(!/certified|guarantee/i.test(copy.disclaimer));
  });

  it('is safe with no argument at all', () => {
    assert.equal(typeof postureCopy().title, 'string');
    assert.equal(typeof postureCopy(null).body, 'string');
  });
});

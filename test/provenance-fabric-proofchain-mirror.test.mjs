// ============================================================
// DATAGLOW - ProvenanceFabric / ProofChain mirror re-entrancy proof
// ============================================================
// ProvenanceFabric wraps window.ProofChain.addStep so every ledger entry also
// gets a hash-linked fabric entry. The wrapper used to set a module-level
// suppression flag, call the async append(), and clear the flag on the very next
// synchronous line. append() awaits (crypto.subtle.digest) before it reaches its
// own ProofChain mirror, so by then the flag was already false: the mirrored
// entry called back into the wrapper, which appended again, forever. One
// ProofChain.addStep froze the page. Two shipped features (Shield Packs posture,
// Air-Gap Mode posture) route around this path because of it.
//
// This test runs the two real inlined sections of canvas/index.html
// (js/provenance/proof-chain.js and js/sentinel/provenance-fabric.js) inside a
// vm with a minimal DOM stub, then pushes one step through the wrapped
// addStep. Before the fix the ledger grows without bound inside the settle
// window; after it, one addStep produces exactly one ledger entry plus one
// mirrored fabric entry.
//
// RUN WITH:  node --test test/provenance-fabric-proofchain-mirror.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANVAS = readFileSync(join(REPO_ROOT, 'canvas', 'index.html'), 'utf8');

const SETTLE_MS = 400;
const RUNAWAY_LIMIT = 25;
const TEST_TIMEOUT_MS = 15000;

function section(path) {
  const from = `/* ---- from ${path} ---- */`;
  const end = `/* ---- end ${path} ---- */`;
  const a = CANVAS.indexOf(from);
  const b = CANVAS.indexOf(end);
  assert.ok(a !== -1 && b > a, `canvas/index.html is missing the inlined ${path} section`);
  return CANVAS.slice(a + from.length, b);
}

const PROOF_CHAIN = section('js/provenance/proof-chain.js');
const FABRIC = section('js/sentinel/provenance-fabric.js');

function fakeDocument() {
  const listeners = new Map();
  const node = {
    style: {}, textContent: '', appendChild() {}, removeChild() {},
    insertBefore() {}, querySelector: () => null, addEventListener() {},
  };
  return {
    readyState: 'complete',
    body: node,
    events: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(evt) {
      this.events.push(evt);
      for (const fn of listeners.get(evt.type) || []) fn(evt);
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => Object.assign({}, node),
  };
}

/** Boots both sections in a fresh vm and returns the sandbox once wired.
 *  A counting cap sits outside the wired addStep so runaway recursion breaks the
 *  loop with an assertion instead of starving the event loop forever: the throw
 *  rejects the mirroring append(), which the wrapper already swallows. */
async function boot() {
  const doc = fakeDocument();
  const sandbox = {
    document: doc,
    navigator: { userAgent: 'node-test' },
    crypto: globalThis.crypto,
    TextEncoder,
    console: { warn() {}, log() {}, error() {} },
    setTimeout,
    clearTimeout,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = (init && init.detail) || null;
      }
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PROOF_CHAIN, sandbox, { filename: 'proof-chain.js' });
  vm.runInContext(FABRIC, sandbox, { filename: 'provenance-fabric.js' });
  // _boot() (which wires the mirror) is deferred through setTimeout(0).
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sandbox.window.ProofChain.addStep._pfWrapped, true, 'mirror never wired');

  const wired = sandbox.window.ProofChain.addStep;
  const capped = function (step) {
    if (++capped.calls > RUNAWAY_LIMIT) {
      throw new Error(`runaway mirror recursion: ProofChain.addStep re-entered ${capped.calls} times`);
    }
    return wired(step);
  };
  capped.calls = 0;
  capped._pfWrapped = true;
  sandbox.window.ProofChain.addStep = capped;
  sandbox.capped = capped;
  return sandbox;
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

describe('ProvenanceFabric / ProofChain mirror: re-entrancy', () => {
  it('records exactly one ledger entry and one fabric entry per addStep', { timeout: TEST_TIMEOUT_MS }, async () => {
    const box = await boot();
    const win = box.window;
    win.ProofChain.clear();

    win.ProofChain.addStep({ type: 'find-replace', row: 1 });
    await settle();

    assert.equal(box.capped.calls, 1, 'addStep must not be re-entered by its own mirror');
    const steps = win.ProofChain.getSteps();
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'find-replace');

    const chain = win.ProvenanceFabric.getChain();
    assert.equal(chain.length, 1, 'the step should be mirrored into the fabric exactly once');
    assert.equal(chain[0].type, 'proofchain:find-replace');
    assert.equal(chain[0].payload.row, 1);
  });

  it('stays bounded across a burst of steps and keeps the chain verifiable', { timeout: TEST_TIMEOUT_MS }, async () => {
    const box = await boot();
    const win = box.window;
    win.ProofChain.clear();

    for (let i = 0; i < 5; i++) win.ProofChain.addStep({ type: 'burst', i });
    await settle();

    assert.equal(box.capped.calls, 5, 'addStep must not be re-entered by its own mirror');
    assert.equal(win.ProofChain.getSteps().length, 5);
    const chain = win.ProvenanceFabric.getChain();
    assert.equal(chain.length, 5);
    // Appends are serialized, so the burst keeps its order and its hash links.
    assert.equal(chain.map((e) => e.payload.i).join(','), '0,1,2,3,4');

    const result = await win.ProvenanceFabric.verify();
    assert.equal(result.ok, true);
    assert.equal(result.brokenAt, null);
  });

  it('still mirrors a direct ProvenanceFabric.append into the ProofChain ledger', { timeout: TEST_TIMEOUT_MS }, async () => {
    const box = await boot();
    const win = box.window;
    win.ProofChain.clear();

    await win.ProvenanceFabric.append('sql_query', { rows: 3 });
    await settle();

    assert.equal(box.capped.calls, 1, 'the mirrored step must not append a second fabric entry');
    const steps = win.ProofChain.getSteps();
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, 'sql_query');
    assert.equal(steps[0].payload.rows, 3);
    assert.equal(win.ProvenanceFabric.getChain().length, 1);
  });
});

describe('ProvenanceFabric / ProofChain mirror: shape of the guard', () => {
  it('does not carry a module-level suppression flag that a sync reset can clear', () => {
    assert.ok(!FABRIC.includes('_suppressProofChainMirror'),
      'suppression must travel as an append() argument, not a module-level flag ' +
      'that is cleared before append() resumes past its first await');
  });
});

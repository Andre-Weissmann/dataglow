// Bundle 12 - model/runtime supply-chain pinning, the derived CSP, the RECEIPT
// spine, the desktop llama.cpp path and the three polyglot power packs.
//
// Pure Node, no DOM. The rule here is the same one Bundle 11 set: anything this
// bundle restates about another module is read back out of that module, so a
// drift fails in CI rather than in front of someone. The two that matter most
// are the WebLLM URL (pinned in one place, asserted from the loader that
// actually fetches it) and the Python bridge row limit.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SUPPLY_CHAIN_DOCTRINE,
  PINNED_RUNTIMES,
  ALLOWED_MODEL_IDS,
  UNPINNED_WARNING,
  AIR_GAP_BLOCK_REASON,
  pinnedOrigins,
  unpinnedRuntimes,
  isModelIdAllowed,
  buildModelFetchPolicy,
  verifyPinnedRuntimeMeta,
  supplyChainChipLabel,
} from '../js/ai/model-supply-chain.js';

import {
  CSP_DOCTRINE,
  CSP_RESIDUALS,
  recommendedCspPolicy,
  checkPolicyCoversRuntimes,
} from '../js/security/csp-policy.js';

import {
  DESKTOP_LLM_STATES,
  SIDECAR_NAME,
  NOT_BUNDLED_NOTE,
  buildDesktopLlmStatus,
  describeSidecarScaffold,
  desktopLlmChipLabel,
} from '../js/ai/desktop-local-llm.js';

import {
  SPINE_STATES,
  RECEIPT_STEPS,
  buildReceiptSpine,
  nextStep,
  spineChipLabel,
} from '../js/spine/receipt-spine.js';

import {
  SQL_SNIPPETS,
  DUCKDB_DIVERGENCES,
  snippetTopics,
  listSnippets,
  listDivergences,
  buildSqlPowerPack,
} from '../js/polyglot/sql-power-pack.js';

import {
  DEFAULT_PY_ROW_LIMIT,
  PYTHON_RECIPES,
  BRIDGE_VARIABLE,
  bridgeTruncationNotice,
  buildPythonPowerPack,
} from '../js/polyglot/python-power-pack.js';

import {
  R_CAPABILITIES,
  R_RECIPES,
  buildRPowerPack,
} from '../js/polyglot/r-power-pack.js';

import { buildLocalAiStatus } from '../js/ai/local-ai-status.js';
import { MODEL_ID, isWebGPUAvailable, isModelLoaded, isModelLoading } from '../js/narrative/ondevice-llm.js';
import { PY_BRIDGE_ROW_LIMIT } from '../js/runtimes-viz/python-runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error('FAIL ' + name);
  console.log('  ✓ ' + name);
  passed++;
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const NEW_FILES = [
  'js/ai/model-supply-chain.js',
  'js/security/csp-policy.js',
  'js/ai/desktop-local-llm.js',
  'js/spine/receipt-spine.js',
  'js/spine/data-glow-receipt-spine-canvas.js',
  'js/polyglot/sql-power-pack.js',
  'js/polyglot/python-power-pack.js',
  'js/polyglot/r-power-pack.js',
  'js/polyglot/data-glow-power-packs-canvas.js',
];

// ---------------------------------------------------------------
console.log('\nSupply chain: the pin is recorded, and an unpinned runtime is a finding');
// ---------------------------------------------------------------

ok('every runtime entry says whether it is pinned, one way or the other',
  PINNED_RUNTIMES.every(r => typeof r.pinned === 'boolean'));

ok('the WebLLM entry is pinned to the exact URL the loader fetches',
  (() => {
    const entry = PINNED_RUNTIMES.filter(r => r.id === 'webllm')[0];
    const loader = read('js/narrative/ondevice-llm.js');
    return !!entry && entry.pinned === true && loader.indexOf(entry.url) > 0;
  })());

ok('the model-weights entry names the model id the loader actually asks for',
  (() => {
    const entry = PINNED_RUNTIMES.filter(r => r.id === 'model-weights')[0];
    return !!entry && MODEL_ID.indexOf(entry.version) >= 0;
  })());

ok('WebR is recorded as unpinned rather than quietly counted as pinned',
  unpinnedRuntimes().some(r => r.id === 'webr'));

ok('the unpinned list is exactly the entries whose pinned flag is false',
  unpinnedRuntimes().length === PINNED_RUNTIMES.filter(r => !r.pinned).length);

ok('every unpinned runtime carries the warning that says why it matters',
  unpinnedRuntimes().length === 0 || UNPINNED_WARNING.length > 40);

ok('pinnedOrigins returns distinct origins and nothing else',
  (() => {
    const o = pinnedOrigins();
    return o.length === new Set(o).size && o.every(x => /^https:\/\/[^/]+$/.test(x));
  })());

ok('only the shipped model id is allowed',
  isModelIdAllowed(MODEL_ID) === true && ALLOWED_MODEL_IDS.indexOf(MODEL_ID) >= 0);

ok('an unknown model id is refused, so free text cannot name a model to fetch',
  isModelIdAllowed('Llama-3-70B-Instruct-q4f16_1-MLC') === false);

ok('a prefix of an allowed id is not allowed, because prefix matching is how allowlists leak',
  isModelIdAllowed(MODEL_ID.slice(0, 8)) === false);

ok('a non-string model id is refused rather than coerced',
  isModelIdAllowed(null) === false && isModelIdAllowed(undefined) === false);

// ---------------------------------------------------------------
console.log('\nFetch policy: Air-Gap outranks everything, and unpinned is a finding on its face');
// ---------------------------------------------------------------

function decision(policy, id) {
  return policy.runtimes.filter(r => r.id === id)[0];
}

ok('with no Air-Gap and CDN allowed, a pinned runtime may be fetched',
  decision(buildModelFetchPolicy({ airGap: false, allowCdn: true }), 'webllm').allowed === true);

ok('an unpinned runtime carries the warning as its reason rather than a pin it does not have',
  (() => {
    const webr = decision(buildModelFetchPolicy({ airGap: false, allowCdn: true }), 'webr');
    return webr.pinned === false && webr.reason === UNPINNED_WARNING;
  })());

ok('Air-Gap blocks every runtime that is not already cached, pinned or not',
  buildModelFetchPolicy({ airGap: true, allowCdn: true }).runtimes.every(r => r.allowed === false));

ok('Air-Gap gives the Air-Gap reason, not a generic refusal',
  buildModelFetchPolicy({ airGap: true }).runtimes.every(r => r.reason === AIR_GAP_BLOCK_REASON));

ok('a runtime already cached is not blocked by Air-Gap, because using it fetches nothing',
  decision(buildModelFetchPolicy({ airGap: true, cachedRuntimeIds: ['webllm'] }), 'webllm').allowed === true);

ok('switching remote fetches off blocks everything, including the pinned runtimes',
  buildModelFetchPolicy({ airGap: false, allowCdn: false }).runtimes.every(r => r.allowed === false));

ok('the headline under Air-Gap says nothing is fetched rather than counting pins',
  /Air-Gap/.test(buildModelFetchPolicy({ airGap: true }).headline));

ok('the headline off Air-Gap names the floating path rather than claiming all pinned',
  /floating path/.test(buildModelFetchPolicy({}).headline));

ok('the policy reports whether anything at all may be fetched',
  buildModelFetchPolicy({ airGap: true }).anyAllowed === false
  && buildModelFetchPolicy({ airGap: false, allowCdn: true }).anyAllowed === true);

ok('the chip label never says pinned when Air-Gap has blocked everything',
  /air-gap/i.test(supplyChainChipLabel(buildModelFetchPolicy({ airGap: true }))));

ok('verifyPinnedRuntimeMeta accepts the URL it pinned',
  (() => {
    const entry = PINNED_RUNTIMES.filter(r => r.id === 'webllm')[0];
    return verifyPinnedRuntimeMeta({ id: 'webllm', url: entry.url }).ok === true;
  })());

ok('verifyPinnedRuntimeMeta refuses a different URL on the same origin',
  verifyPinnedRuntimeMeta({ id: 'webllm', url: 'https://esm.run/@mlc-ai/web-llm@latest' }).ok === false);

ok('verifyPinnedRuntimeMeta refuses an unknown runtime id',
  verifyPinnedRuntimeMeta({ id: 'not-a-runtime' }).ok === false);

ok('verifyPinnedRuntimeMeta refuses a model id outside the allowlist',
  verifyPinnedRuntimeMeta({ id: 'model-weights', modelId: 'something-else' }).ok === false);

ok('the doctrine states the reason rather than the rule',
  SUPPLY_CHAIN_DOCTRINE.length > 60);

// ---------------------------------------------------------------
console.log('\nCSP: derived from the pins, so the two cannot drift apart');
// ---------------------------------------------------------------

ok('the recommended policy covers every pinned origin',
  checkPolicyCoversRuntimes(recommendedCspPolicy({ platform: 'desktop' }).policy).ok === true);

ok('a policy missing an origin is reported as missing it, by name',
  (() => {
    const r = checkPolicyCoversRuntimes("default-src 'self'");
    return r.ok === false && r.missing.length === pinnedOrigins().length;
  })());

ok('object-src, frame-src and frame-ancestors are all none',
  (() => {
    const p = recommendedCspPolicy({ platform: 'desktop' }).policy;
    return /object-src 'none'/.test(p) && /frame-src 'none'/.test(p) && /frame-ancestors 'none'/.test(p);
  })());

ok('form-action is none, because nothing in this product posts a form anywhere',
  /form-action 'none'/.test(recommendedCspPolicy({ platform: 'desktop' }).policy));

ok('base-uri is pinned to self, so an injected base tag cannot redirect a script',
  /base-uri 'self'/.test(recommendedCspPolicy({ platform: 'desktop' }).policy));

ok('under Air-Gap the policy names no remote origin at all',
  (() => {
    const p = recommendedCspPolicy({ platform: 'desktop', airGap: true }).policy;
    return pinnedOrigins().every(o => p.indexOf(o) < 0);
  })());

ok('blob: is allowed for workers, because DuckDB-WASM builds its worker from a blob',
  /worker-src[^;]*blob:/.test(recommendedCspPolicy({ platform: 'desktop' }).policy));

ok('the residuals name what the policy still cannot do, with the cost of fixing it',
  CSP_RESIDUALS.length >= 3 && CSP_RESIDUALS.every(r => r.id && r.cost && r.why && r.fix));

ok('unsafe-eval is recorded as a residual rather than presented as fine',
  CSP_RESIDUALS.some(r => r.id === 'unsafe-eval'));

ok('the shipped Tauri CSP covers the runtimes this build actually fetches',
  (() => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const csp = conf.tauri && conf.tauri.security && conf.tauri.security.csp;
    return typeof csp === 'string' && checkPolicyCoversRuntimes(csp).ok === true;
  })());

ok('the CSP doctrine is stated in the module',
  CSP_DOCTRINE.length > 40);

// ---------------------------------------------------------------
console.log('\nChip readiness: the loader tells the truth about what is loaded');
// ---------------------------------------------------------------

ok('the loader exports the three things a status chip needs',
  typeof isWebGPUAvailable === 'function'
  && typeof isModelLoaded === 'function'
  && typeof isModelLoading === 'function');

ok('nothing is loaded and nothing is loading before anything is asked for',
  isModelLoaded() === false && isModelLoading() === false);

ok('isWebGPUAvailable returns false in Node instead of throwing',
  isWebGPUAvailable() === false);

ok('webgpu plus loaded reaches ready',
  buildLocalAiStatus({ webgpu: true, modelLoaded: true }).state === 'ready');

ok('air-gap without a cached model is blocked_airgap, not ready',
  buildLocalAiStatus({ webgpu: true, airGap: true }).state === 'blocked_airgap');

ok('loaded is no longer set by starting a download',
  (() => {
    const s = read('js/narrative/ondevice-llm.js');
    return /modelReady = false/.test(s) && !/return enginePromise != null/.test(s);
  })());

ok('a failed load resets both flags so a retry is honest',
  /enginePromise = null; \/\/ allow retry after a failed load/.test(read('js/narrative/ondevice-llm.js')));

ok('the canvas surface prefers the loader answer over reading navigator directly',
  /llm\.isWebGPUAvailable/.test(read('js/ai/data-glow-local-ai-canvas.js')));

// ---------------------------------------------------------------
console.log('\nDesktop llama.cpp: a state, never a pretence');
// ---------------------------------------------------------------

ok('the browser is unavailable_web, which is a state and not an error',
  (() => {
    const s = buildDesktopLlmStatus({ isTauri: false });
    return s.state === 'unavailable_web' && s.usable === false;
  })());

ok('the browser never reports a sidecar, even when told one is present',
  buildDesktopLlmStatus({ isTauri: false, sidecarPresent: true }).state === 'unavailable_web');

ok('desktop with no sidecar is sidecar_missing',
  buildDesktopLlmStatus({ isTauri: true, sidecarPresent: false }).state === 'sidecar_missing');

ok('desktop with a sidecar is ready',
  buildDesktopLlmStatus({ isTauri: true, sidecarPresent: true }).state === 'ready');

ok('an error outranks a present sidecar, because a broken server is not ready',
  buildDesktopLlmStatus({ isTauri: true, sidecarPresent: true, error: 'connection refused' }).state === 'error');

ok('every state is one of the declared four',
  [
    { isTauri: false },
    { isTauri: true },
    { isTauri: true, sidecarPresent: true },
    { isTauri: true, error: 'x' },
  ].every(i => DESKTOP_LLM_STATES.indexOf(buildDesktopLlmStatus(i).state) >= 0));

ok('no state ever claims the binary is bundled in this build',
  [
    { isTauri: false },
    { isTauri: true },
    { isTauri: true, sidecarPresent: true },
  ].every(i => buildDesktopLlmStatus(i).bundledInThisBuild === false));

ok('every state says what it falls back to, so nothing dead-ends',
  [
    { isTauri: false },
    { isTauri: true },
    { isTauri: true, error: 'x' },
  ].every(i => buildDesktopLlmStatus(i).fallsBackTo.length > 10));

ok('the scaffold names the exact config key and the value it needs',
  (() => {
    const d = describeSidecarScaffold();
    return d.configPath === 'tauri.bundle.externalBin'
      && d.valueWhenShipped.join(',').indexOf(SIDECAR_NAME) >= 0;
  })());

ok('the scaffold matches the shipped tauri config, which keeps externalBin empty',
  (() => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const cur = conf.tauri && conf.tauri.bundle && conf.tauri.bundle.externalBin;
    return Array.isArray(cur) && cur.length === 0
      && describeSidecarScaffold().currentValue.length === 0;
  })());

ok('the not-bundled note is stated rather than implied',
  NOT_BUNDLED_NOTE.length > 40);

ok('the chip label for the browser does not mention a sidecar being missing',
  !/missing/i.test(desktopLlmChipLabel(buildDesktopLlmStatus({ isTauri: false }))));

// ---------------------------------------------------------------
console.log('\nRECEIPT spine: five steps, none of them marked done by optimism');
// ---------------------------------------------------------------

ok('the five steps are Drop, Ask, Prove, Ship, Compound in that order',
  RECEIPT_STEPS.map(s => s.id).join(',') === 'drop,ask,prove,ship,compound');

ok('every step names the surface it opens and the condition that marks it done',
  RECEIPT_STEPS.every(s => s.opens && s.doneWhen && s.oneLine && s.body));

ok('a fresh session has Drop as the current step and nothing done',
  (() => {
    const s = buildReceiptSpine({});
    return s.currentId === 'drop' && s.doneCount === 0;
  })());

ok('loading a table advances the current step to Ask',
  buildReceiptSpine({ hasTable: true }).currentId === 'ask');

ok('exactly one step is current at any time',
  buildReceiptSpine({ hasTable: true, hasQueryResult: true })
    .steps.filter(s => s.state === 'current').length === 1);

ok('a finished path has no current step and all five done',
  (() => {
    const s = buildReceiptSpine({
      hasTable: true, hasQueryResult: true, proveRan: true, hasShipped: true, hasSavedMethod: true,
    });
    return s.doneCount === 5 && s.currentId === '';
  })());

ok('shipping without proving marks Prove skipped, not done',
  (() => {
    const s = buildReceiptSpine({ hasTable: true, hasQueryResult: true, hasShipped: true });
    const prove = s.steps.filter(x => x.id === 'prove')[0];
    return s.proveSkipped === true && prove.state === 'skipped';
  })());

ok('a skipped Prove does not count towards done',
  buildReceiptSpine({ hasTable: true, hasQueryResult: true, hasShipped: true }).doneCount < 5);

ok('every step state is one of the declared four',
  buildReceiptSpine({ hasTable: true, hasShipped: true })
    .steps.every(s => SPINE_STATES.indexOf(s.state) >= 0));

ok('nextStep returns the current step, and nothing once the path is finished',
  (() => {
    const mid = buildReceiptSpine({ hasTable: true });
    const done = buildReceiptSpine({
      hasTable: true, hasQueryResult: true, proveRan: true, hasShipped: true, hasSavedMethod: true,
    });
    return nextStep(mid).id === 'ask' && nextStep(done) === null;
  })());

ok('the chip label counts out of five',
  /of 5/.test(spineChipLabel(buildReceiptSpine({ hasTable: true }))));

ok('the rail resolves a target before it renders a button',
  /That surface is not mounted in this build/.test(read('js/spine/data-glow-receipt-spine-canvas.js')));

ok('the rail deletes no tab and hides no panel',
  (() => {
    const s = read('js/spine/data-glow-receipt-spine-canvas.js');
    return !/\.remove\(\)/.test(s) && !/data-panel/.test(s);
  })());

// ---------------------------------------------------------------
console.log('\nSQL pack: DuckDB, said out loud');
// ---------------------------------------------------------------

ok('the honesty note says DuckDB is not Postgres and not the warehouse',
  /not Postgres/.test(buildSqlPowerPack().honesty));

ok('every snippet names the placeholders it needs substituted',
  SQL_SNIPPETS.every(s => Array.isArray(s.substitute) && s.substitute.length > 0));

ok('every placeholder a snippet names actually appears in its SQL',
  SQL_SNIPPETS.every(s => s.substitute.every(p => s.sql.indexOf(p) >= 0)));

ok('every snippet says why it exists, not just what it does',
  SQL_SNIPPETS.every(s => typeof s.why === 'string' && s.why.length > 20));

ok('every divergence shows both dialects and says which one has the feature',
  DUCKDB_DIVERGENCES.every(d =>
    d.duckdb && d.postgres && ['duckdb_only', 'postgres_only', 'both_differ'].indexOf(d.direction) >= 0));

ok('filtering by topic returns a subset, and no topic returns all of them',
  (() => {
    const t = snippetTopics()[0];
    return listSnippets(t).length > 0
      && listSnippets(t).length < SQL_SNIPPETS.length
      && listSnippets().length === SQL_SNIPPETS.length;
  })());

ok('an unknown topic returns nothing rather than everything',
  listSnippets('not-a-topic').length === 0 && listDivergences('not-a-topic').length === 0);

ok('the not-supported list is stated before any snippet is offered',
  buildSqlPowerPack().notSupported.length >= 3);

// ---------------------------------------------------------------
console.log('\nPython pack: the bridge ceiling travels with the recipes');
// ---------------------------------------------------------------

ok('the default row limit is the real bridge limit, not a copy that can drift',
  DEFAULT_PY_ROW_LIMIT === PY_BRIDGE_ROW_LIMIT);

ok('a table under the limit reports that the whole thing arrived',
  bridgeTruncationNotice(1000, PY_BRIDGE_ROW_LIMIT).truncated === false);

ok('a table over the limit reports truncation and how much arrived',
  (() => {
    const n = bridgeTruncationNotice(PY_BRIDGE_ROW_LIMIT + 1, PY_BRIDGE_ROW_LIMIT);
    return n.truncated === true && n.delivered === PY_BRIDGE_ROW_LIMIT;
  })());

ok('the truncated detail says the aggregates below are now wrong',
  /not of the table/.test(bridgeTruncationNotice(PY_BRIDGE_ROW_LIMIT + 1, PY_BRIDGE_ROW_LIMIT).detail));

ok('exactly at the limit is not truncation',
  bridgeTruncationNotice(PY_BRIDGE_ROW_LIMIT, PY_BRIDGE_ROW_LIMIT).truncated === false);

ok('no table bridged yet says so rather than claiming all zero rows arrived',
  /No table is bridged yet/.test(bridgeTruncationNotice(0, PY_BRIDGE_ROW_LIMIT).headline));

ok('every recipe names the question it answers',
  PYTHON_RECIPES.every(r => typeof r.answers === 'string' && r.answers.length > 10));

ok('every recipe that touches the frame uses the bridged variable name',
  PYTHON_RECIPES.filter(r => r.code.indexOf('df') >= 0).length === PYTHON_RECIPES.length
  && BRIDGE_VARIABLE === 'df');

ok('polars is reported as absent rather than assumed present',
  /not importable/.test(buildPythonPowerPack({}).polars));

ok('polars reported present never claims anything routes through it',
  /Nothing routes through it automatically/.test(buildPythonPowerPack({ polarsAvailable: true }).polars));

// ---------------------------------------------------------------
console.log('\nR pack: a session that lost a package still runs R');
// ---------------------------------------------------------------

ok('every recipe declares the capability it needs',
  R_RECIPES.every(r => R_CAPABILITIES.indexOf(r.needs) >= 0));

ok('a session with both packages can run every recipe',
  buildRPowerPack({ hasJsonlite: true, hasGgplot2: true }).unavailable.length === 0);

ok('a session with neither package still has base R recipes to run',
  buildRPowerPack({}).recipes.length > 0);

ok('the recipes that cannot run are listed with a reason rather than hidden',
  (() => {
    const p = buildRPowerPack({});
    return p.unavailable.length > 0 && p.unavailable.every(u => u.reason.length > 20);
  })());

ok('available plus unavailable is always the whole pack',
  (() => {
    const p = buildRPowerPack({ hasJsonlite: true });
    return p.recipes.length + p.unavailable.length === R_RECIPES.length;
  })());

ok('losing ggplot2 points at the base R chart recipes instead of dead-ending',
  (() => {
    const p = buildRPowerPack({ hasJsonlite: true });
    return p.unavailable.some(u => /base R plotting still works/i.test(u.reason));
  })());

ok('the headline names what is missing rather than saying everything is fine',
  /did not install/.test(buildRPowerPack({}).headline));

// ---------------------------------------------------------------
console.log('\nHouse rules');
// ---------------------------------------------------------------

ok('no new file contains a U+2014 em dash',
  NEW_FILES.every(f => read(f).indexOf('—') < 0));

ok('no new file contains a control character that would break the canvas splice',
  NEW_FILES.every(f => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(read(f))));

ok('no new file closes the script tag it will be spliced into',
  NEW_FILES.every(f => read(f).indexOf('</scr' + 'ipt>') < 0));

ok('no pure engine touches the DOM',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0).every(f => !/document\./.test(read(f))));

ok('no new file reaches the network',
  NEW_FILES.every(f => !/\bfetch\(|XMLHttpRequest/.test(read(f))));

ok('every pure engine publishes itself onto window defensively',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0)
    .every(f => /typeof window !== 'undefined'/.test(read(f))));

ok('both canvas surfaces carry their own from and end markers',
  NEW_FILES.filter(f => f.indexOf('canvas') >= 0).every(f => {
    const s = read(f);
    return s.indexOf('/* ---- from ' + f + ' ---- */') === 0
      && s.indexOf('/* ---- end ' + f + ' ---- */') > 0;
  }));

ok('nothing in this bundle claims HIPAA compliance or beats a hosted model',
  NEW_FILES.every(f => !/HIPAA compliant|smarter than|beats Claude/i.test(read(f))));

console.log('\n' + passed + ' passed, 0 failed');

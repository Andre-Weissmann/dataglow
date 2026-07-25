// Bundle 11 - built-in AI status, ambient proof, capability ceiling,
// Polars path and the AI claim guard.
//
// Pure Node, no DOM. Every engine is imported for real, and the two constants
// this bundle restates (the shipped MODEL_ID and the Python bridge row limit)
// are read out of the modules that actually own them, so a drift between the
// product and its own honesty copy fails here rather than in front of a user.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LOCAL_AI_STATES,
  SHIPPED_MODEL_ID,
  SHIPPED_MODEL_LABEL,
  WHAT_BUILT_IN_AI_DOES,
  AI_DIVISION_OF_LABOUR,
  NOT_A_CERTIFICATION_NOTE,
  buildLocalAiStatus,
  statusChipLabel,
  listRecommendedLocalModels,
  shippedModel,
} from '../js/ai/local-ai-status.js';

import {
  DEFAULT_PY_BRIDGE_ROW_LIMIT,
  DEFAULT_R_BRIDGE_ROW_LIMIT,
  buildCapabilityCeiling,
  renderCeilingMarkdown,
} from '../js/ai/capability-ceiling.js';

import {
  AMBIENT_TONES,
  buildAmbientProofStrip,
  answerAmbientQuestion,
  ambientChipLabel,
} from '../js/ambient/ambient-proof-strip.js';

import {
  POLARS_STATES,
  describePolarsSecondaryPath,
  buildPolarsAvailability,
  polarsChipLabel,
} from '../js/polyglot/polars-path.js';

import {
  groundTruthValues,
  guardModelRephrase,
  guardLedgerEntry,
} from '../js/ai/ai-claim-guard.js';

import { MODEL_ID, MODEL_LABEL } from '../js/narrative/ondevice-llm.js';
import { PY_BRIDGE_ROW_LIMIT } from '../js/runtimes-viz/python-runtime.js';
import { refineWithOnDeviceModel } from '../js/agents/guarded-copilot.js';

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

// ---------------------------------------------------------------
console.log('\nBuilt-in AI status: the state is derived, never asserted');
// ---------------------------------------------------------------

ok('a machine with no WebGPU is rule-based, not broken',
  buildLocalAiStatus({ webgpu: false }).state === 'no_webgpu');

ok('no WebGPU still reports the rule tier as available',
  buildLocalAiStatus({ webgpu: false }).ruleTierAvailable === true);

ok('WebGPU with the model loaded is ready',
  buildLocalAiStatus({ webgpu: true, modelLoaded: true }).state === 'ready');

ok('WebGPU with nothing downloaded is available, not ready',
  buildLocalAiStatus({ webgpu: true }).state === 'available');

ok('Air-Gap with no cached model blocks the download',
  buildLocalAiStatus({ webgpu: true, airGap: true }).state === 'blocked_airgap');

ok('Air-Gap does not block a model that is already loaded, because running it sends nothing',
  buildLocalAiStatus({ webgpu: true, airGap: true, modelLoaded: true }).state === 'ready');

ok('Air-Gap with the model cached is not blocked',
  buildLocalAiStatus({ webgpu: true, airGap: true, modelCached: true }).state === 'available');

ok('a loaded flag on a machine with no WebGPU is not trusted',
  buildLocalAiStatus({ webgpu: false, modelLoaded: true }).state === 'no_webgpu');

ok('loading is reported while it happens',
  buildLocalAiStatus({ webgpu: true, loading: true }).state === 'loading');

ok('explicitly disabled falls to rule_only ahead of every other check',
  buildLocalAiStatus({ webgpu: true, modelLoaded: true, enabled: false }).state === 'rule_only');

ok('canUseBuiltInAi is true only in the ready state',
  LOCAL_AI_STATES.every(s => {
    const inputs = {
      ready: { webgpu: true, modelLoaded: true },
      available: { webgpu: true },
      loading: { webgpu: true, loading: true },
      blocked_airgap: { webgpu: true, airGap: true },
      no_webgpu: { webgpu: false },
      rule_only: { enabled: false },
    }[s];
    const st = buildLocalAiStatus(inputs);
    return st.canUseBuiltInAi === (st.state === 'ready');
  }));

ok('every state carries a headline, a detail and a reason to exist',
  LOCAL_AI_STATES.every(s => {
    const st = buildLocalAiStatus({ webgpu: false });
    return typeof st.headline === 'string' && st.headline.length > 0
      && typeof st.detail === 'string' && st.detail.length > 0;
  }));

ok('no state claims the model is always loaded',
  LOCAL_AI_STATES.every(s => !/always loaded/i.test(JSON.stringify(buildLocalAiStatus({})))));

ok('the status never mentions HIPAA as a property it has',
  !/HIPAA certif|is HIPAA/i.test(JSON.stringify(buildLocalAiStatus({ webgpu: true, modelLoaded: true }))));

ok('the non-certification note says a local model is a privacy property and not a compliance one',
  /privacy property/i.test(NOT_A_CERTIFICATION_NOTE) && /not a compliance one/i.test(NOT_A_CERTIFICATION_NOTE));

ok('nothing here sends anything', buildLocalAiStatus({}).sendsNothing === true);
ok('everything here is on-device', buildLocalAiStatus({}).onDevice === true);

ok('garbage input degrades to a state rather than throwing',
  LOCAL_AI_STATES.indexOf(buildLocalAiStatus(null).state) >= 0
  && LOCAL_AI_STATES.indexOf(buildLocalAiStatus('nope').state) >= 0);

ok('the chip label is derived from the state and falls back safely',
  statusChipLabel(buildLocalAiStatus({ webgpu: true, modelLoaded: true })).indexOf('ready') > 0
  && typeof statusChipLabel(null) === 'string');

ok('the three verbs are propose, explain and draft, in that order',
  WHAT_BUILT_IN_AI_DOES.map(x => x.id).join(',') === 'propose,explain,draft');

ok('the division of labour puts the human last and the engines in the middle',
  /AI proposes/.test(AI_DIVISION_OF_LABOUR)
  && /engines adjudicate/.test(AI_DIVISION_OF_LABOUR)
  && /human confirms/.test(AI_DIVISION_OF_LABOUR));

// ---------------------------------------------------------------
console.log('\nModel registry: honest about what is actually shipped');
// ---------------------------------------------------------------

const models = listRecommendedLocalModels();

ok('the registry pins the same MODEL_ID that ondevice-llm.js actually loads',
  SHIPPED_MODEL_ID === MODEL_ID);

ok('the registry pins the same MODEL_LABEL as ondevice-llm.js',
  SHIPPED_MODEL_LABEL === MODEL_LABEL);

ok('exactly one entry is marked shipped',
  models.filter(m => m.fit === 'shipped').length === 1);

ok('the shipped entry is the model the loader uses',
  shippedModel().id === MODEL_ID);

ok('a registry with one entry would not be a registry, so there is more than one',
  models.length >= 4);

ok('every fit is one of the four honest values',
  models.every(m => ['shipped', 'candidate', 'desktop_only', 'not_yet'].indexOf(m.fit) >= 0));

ok('every entry names its licence, its size and its runtime',
  models.every(m => m.license && m.sizeHint && m.runtime));

ok('every entry says what it does on web, desktop and mobile',
  models.every(m => m.platforms && m.platforms.web && m.platforms.desktop && m.platforms.mobile));

ok('every entry that is not shipped says what is in the way',
  models.filter(m => m.fit !== 'shipped').every(m => typeof m.why === 'string' && m.why.length > 40));

ok('the non-Apache licence is named as such rather than glossed',
  models.some(m => /not OSI-approved/i.test(m.license)));

ok('the scaffolded speech model is listed as not_yet, not as a feature',
  models.filter(m => /whisper/i.test(m.id)).every(m => m.fit === 'not_yet'));

// ---------------------------------------------------------------
console.log('\nCapability ceiling: the notThis line is the load-bearing one');
// ---------------------------------------------------------------

const ceiling = buildCapabilityCeiling();

ok('the default Python bridge limit is the real PY_BRIDGE_ROW_LIMIT',
  DEFAULT_PY_BRIDGE_ROW_LIMIT === PY_BRIDGE_ROW_LIMIT);

ok('the R bridge default is stated rather than inherited by accident',
  typeof DEFAULT_R_BRIDGE_ROW_LIMIT === 'number' && DEFAULT_R_BRIDGE_ROW_LIMIT > 0);

ok('every group states what it does and what it does not',
  ceiling.groups.every(g => g.does && g.notThis && g.does.length > 20 && g.notThis.length > 20));

ok('all six spec areas plus privacy are covered',
  ['sql', 'python', 'r', 'excel', 'size', 'messy', 'privacy']
    .every(id => ceiling.groups.some(g => g.id === id)));

ok('the SQL group refuses to claim every warehouse dialect',
  /not every warehouse dialect/i.test(ceiling.groups.find(g => g.id === 'sql').notThis));

ok('the SQL group names DuckDB rather than claiming any syntax',
  /DuckDB/.test(ceiling.groups.find(g => g.id === 'sql').does)
  && !/any syntax|any SQL dialect/i.test(JSON.stringify(ceiling)));

ok('the Python ceiling prints the real row limit',
  ceiling.groups.find(g => g.id === 'python').notThis.indexOf(PY_BRIDGE_ROW_LIMIT.toLocaleString('en-US')) > 0);

ok('a caller can override the limit and the copy follows it',
  buildCapabilityCeiling({ pyBridgeRowLimit: 12345 })
    .groups.find(g => g.id === 'python').notThis.indexOf('12,345') > 0);

ok('the R group says it is not CRAN',
  /not CRAN/i.test(ceiling.groups.find(g => g.id === 'r').notThis));

ok('the Excel group refuses VBA, macros and formulas explicitly',
  /VBA/.test(ceiling.groups.find(g => g.id === 'excel').notThis));

ok('the size group refuses the words any size',
  /no "any size"/i.test(ceiling.groups.find(g => g.id === 'size').notThis));

ok('the size group changes on desktop because the ceiling genuinely differs',
  buildCapabilityCeiling({ platform: 'desktop' }).groups.find(g => g.id === 'size').does
  !== ceiling.groups.find(g => g.id === 'size').does);

ok('a messy file and a messy data estate are kept apart',
  /messy data estate is not solved here/i.test(ceiling.groups.find(g => g.id === 'messy').notThis));

ok('the privacy group refuses to be read as a HIPAA certification',
  /not a HIPAA certification/i.test(ceiling.groups.find(g => g.id === 'privacy').notThis));

ok('no positive claim anywhere in the ceiling is a claim of certification',
  ceiling.groups.every(g => !/certified|audited|compliant/i.test(g.does))
  && !/HIPAA compliant/i.test(JSON.stringify(ceiling)));

ok('the markdown render carries every group and both ceiling lines',
  (() => {
    const md = renderCeilingMarkdown(ceiling);
    return ceiling.groups.every(g => md.indexOf(g.title) > 0)
      && md.indexOf('It does not:') > 0
      && md.indexOf(ceiling.closing) > 0;
  })());

ok('rendering with no argument still produces a ceiling rather than throwing',
  renderCeilingMarkdown(null).length > 200);

// ---------------------------------------------------------------
console.log('\nAmbient proof: continuous reporting, never continuous answering');
// ---------------------------------------------------------------

ok('with nothing checked the tone is idle and that is not a pass',
  (() => {
    const s = buildAmbientProofStrip({});
    return s.tone === 'idle' && /not a pass/i.test(s.facts.find(f => f.id === 'prove').detail);
  })());

ok('a passing gate against current data is clear',
  buildAmbientProofStrip({ prove: { allowed: true, unbound: [], cautions: [], refused: [] } }).tone === 'clear');

ok('a refused claim is blocked',
  buildAmbientProofStrip({ prove: { allowed: false, unbound: [{ text: '42' }], cautions: [], refused: [] } }).tone === 'blocked');

ok('cautions downgrade a pass to caution rather than hiding',
  buildAmbientProofStrip({ prove: { allowed: true, unbound: [], cautions: [{}], refused: [] } }).tone === 'caution');

ok('open caveats downgrade a pass to caution',
  buildAmbientProofStrip({ prove: { allowed: true, unbound: [], cautions: [], refused: [] }, openCaveats: 3 }).tone === 'caution');

ok('a pass against an older version of the data is stale, not green',
  buildAmbientProofStrip({
    prove: { allowed: true, unbound: [], cautions: [], refused: [], dataVersion: 'v1' },
    dataVersion: 'v2',
  }).tone === 'stale');

ok('the stale detail tells the user to run it again before quoting',
  /Run it again/i.test(buildAmbientProofStrip({
    prove: { allowed: true, unbound: [], cautions: [], refused: [], dataVersion: 'v1' },
    dataVersion: 'v2',
  }).facts.find(f => f.id === 'prove').detail));

ok('drift warnings surface as a fact when a severity is supplied',
  buildAmbientProofStrip({ driftSeverity: 'warn', driftHeadline: 'Column shifted' })
    .facts.some(f => f.id === 'drift'));

ok('no drift fact appears when nothing reported one',
  !buildAmbientProofStrip({}).facts.some(f => f.id === 'drift'));

ok('Air-Gap state is always on the strip in both directions',
  buildAmbientProofStrip({ airGap: true }).facts.some(f => f.id === 'airgap' && /On/.test(f.value))
  && buildAmbientProofStrip({ airGap: false }).facts.some(f => f.id === 'airgap' && /Off/.test(f.value)));

ok('Air-Gap off is not spun as a pass',
  /not on/i.test(buildAmbientProofStrip({ airGap: false }).facts.find(f => f.id === 'airgap').detail));

ok('zero caveats is not sold as proof there is nothing to say',
  /not proof/i.test(buildAmbientProofStrip({}).facts.find(f => f.id === 'caveats').detail));

ok('the outbound rule is on every strip',
  /must pass the prove gate/i.test(buildAmbientProofStrip({}).outboundRule));

ok('the strip declares that it answers nothing',
  buildAmbientProofStrip({}).answersQuestions === false);

ok('asking the strip a question is always declined, with a reason and a redirect',
  (() => {
    const a = answerAmbientQuestion('what is our revenue');
    return a.answered === false && a.reason.length > 20 && /SQL|notebook|Copilot/.test(a.redirect);
  })());

ok('the refusal holds for an empty question too',
  answerAmbientQuestion('').answered === false);

ok('every tone maps to a label',
  AMBIENT_TONES.every(t => typeof ambientChipLabel({ tone: t }) === 'string' && ambientChipLabel({ tone: t }).length > 5));

ok('a garbage strip still yields a label rather than throwing',
  typeof ambientChipLabel(null) === 'string');

ok('the doctrine names the difference from an ambient assistant',
  /guess/i.test(buildAmbientProofStrip({}).doctrine));

ok('the strip states it does not read the screen or listen',
  /does not read your screen/i.test(buildAmbientProofStrip({}).note));

// ---------------------------------------------------------------
console.log('\nPolars path: a status, not an engine');
// ---------------------------------------------------------------

ok('with no Python session the state is not_on_platform',
  buildPolarsAvailability({ pythonReady: false }).state === 'not_on_platform');

ok('a Python session without polars is not_installed',
  buildPolarsAvailability({ pythonReady: true, pyodideHasPolars: false }).state === 'not_installed');

ok('polars is only available when the session actually imports it',
  buildPolarsAvailability({ pythonReady: true, pyodideHasPolars: true }).state === 'available');

ok('no input never yields available, so the chip cannot fake ready',
  buildPolarsAvailability().state !== 'available'
  && buildPolarsAvailability(null).usable === false);

ok('every state is one of the three declared ones',
  [{}, { pythonReady: true }, { pythonReady: true, pyodideHasPolars: true }]
    .every(i => POLARS_STATES.indexOf(buildPolarsAvailability(i).state) >= 0));

ok('no state ever says Polars is ready',
  [{}, { pythonReady: true }, { pythonReady: true, pyodideHasPolars: true }]
    .every(i => !/Polars ready/i.test(JSON.stringify(buildPolarsAvailability(i)))));

ok('every availability restates that DuckDB is not being replaced',
  buildPolarsAvailability({}).replacesDuckDb === false
  && /not being replaced/i.test(buildPolarsAvailability({}).primaryEngine));

ok('the description is explicit that it would not replace DuckDB',
  describePolarsSecondaryPath().wouldNotDo.some(x => /Replace DuckDB/i.test(x)));

ok('the description is explicit that nothing would silently route to it',
  describePolarsSecondaryPath().wouldNotDo.some(x => /silently/i.test(x)));

ok('the description marks itself as a scaffold rather than a feature',
  describePolarsSecondaryPath().status === 'scaffold');

ok('the chip label never claims more than the state',
  polarsChipLabel(buildPolarsAvailability({})).indexOf('not') > 0
  && typeof polarsChipLabel(null) === 'string');

// ---------------------------------------------------------------
console.log('\nAI claim guard: the prompt is a request, this is the control');
// ---------------------------------------------------------------

const TIER1 = 'The customers table has 1204 rows and 3.5 percent of email values are null.';

ok('the ground truth is every number in the deterministic answer',
  groundTruthValues(TIER1).map(v => v.value).join(',') === '1204,3.5');

ok('a rephrase using the same numbers is kept',
  guardModelRephrase(TIER1, 'There are 1204 customers, and 3.5 percent are missing an email.').allowed === true);

ok('a kept rephrase is reported as having used the model',
  guardModelRephrase(TIER1, 'There are 1204 customers, and 3.5 percent are missing an email.').usedOnDeviceModel === true);

ok('a transposed digit is caught',
  guardModelRephrase(TIER1, 'There are 1240 customers.').allowed === false);

ok('a helpfully rounded number that is simply different is caught',
  guardModelRephrase(TIER1, 'About 5 percent are missing an email.').allowed === false);

ok('a correct rounding of a real number still binds',
  guardModelRephrase('The null rate is 3.47 percent.', 'The null rate is 3.5 percent.').allowed === true);

ok('a rejected rephrase falls back to the deterministic text verbatim, not to a stripped one',
  guardModelRephrase(TIER1, 'There are 1240 customers.').text === TIER1);

ok('a rejected rephrase reports that no model output was used',
  guardModelRephrase(TIER1, 'There are 1240 customers.').usedOnDeviceModel === false);

ok('the rejection names a reason rather than failing silently',
  /number the engine did not produce/i.test(guardModelRephrase(TIER1, 'There are 1240 customers.').reason));

ok('prose with no numbers at all passes, because there is nothing to invent',
  guardModelRephrase(TIER1, 'The table looks broadly healthy on this measure.').allowed === true);

ok('an empty rephrase is not treated as a model success',
  guardModelRephrase(TIER1, '').usedOnDeviceModel === false);

ok('a rephrase identical to the input is not counted as model work',
  guardModelRephrase(TIER1, TIER1).usedOnDeviceModel === false);

ok('the ledger entry records the outcome either way',
  guardLedgerEntry(guardModelRephrase(TIER1, 'There are 1240 customers.')).outcome === 'rephrase-discarded'
  && guardLedgerEntry(guardModelRephrase(TIER1, 'There are 1204 customers.')).outcome === 'rephrase-kept');

ok('the ledger entry names the unbound numbers it rejected',
  guardLedgerEntry(guardModelRephrase(TIER1, 'There are 1240 customers.')).unbound.indexOf('1240') >= 0);

// ---------------------------------------------------------------
console.log('\nTier 2 of the Guarded Copilot is guarded end to end');
// ---------------------------------------------------------------

function stubLlm(output) {
  return {
    isWebGPUAvailable: () => true,
    isModelLoaded: () => true,
    loadModel: async () => ({
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: output } }] };
            },
          }),
        },
      },
    }),
  };
}

const tier1 = { answered: true, text: TIER1, citedFrom: [] };

ok('a faithful rephrase reaches the user and is marked as model output',
  await (async () => {
    const r = await refineWithOnDeviceModel('how many rows', tier1, stubLlm('There are 1204 customers here.'));
    return r.usedOnDeviceModel === true && /1204/.test(r.text);
  })());

ok('a rephrase that invents a number is discarded and Tier 1 is returned instead',
  await (async () => {
    const r = await refineWithOnDeviceModel('how many rows', tier1, stubLlm('There are 9999 customers here.'));
    return r.usedOnDeviceModel === false && r.text === TIER1;
  })());

ok('the guard cannot be defeated by wrapping the invented number in confident prose',
  await (async () => {
    const r = await refineWithOnDeviceModel('how many rows', tier1,
      stubLlm('Analysis confirms the customers table holds exactly 1500 records.'));
    return r.text === TIER1;
  })());

ok('an empty generation still falls back to Tier 1',
  await (async () => {
    const r = await refineWithOnDeviceModel('how many rows', tier1, stubLlm(''));
    return r.usedOnDeviceModel === false && r.text === TIER1;
  })());

// ---------------------------------------------------------------
console.log('\nSource discipline');
// ---------------------------------------------------------------

const NEW_FILES = [
  'js/ai/local-ai-status.js',
  'js/ai/capability-ceiling.js',
  'js/ai/ai-claim-guard.js',
  'js/ambient/ambient-proof-strip.js',
  'js/polyglot/polars-path.js',
  'js/ai/data-glow-local-ai-canvas.js',
];

ok('no new file contains a U+2014 em dash',
  NEW_FILES.every(f => read(f).indexOf('—') < 0));

ok('no new file contains a network call',
  NEW_FILES.every(f => !/\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(read(f))));

ok('the pure engines touch no DOM at all',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0)
    .every(f => !/document\./.test(read(f))));

ok('the guarded copilot still declares exactly four public functions',
  /'classifyIntent',\s*\n\s*'answerDeterministic',\s*\n\s*'askGuardedCopilot',\s*\n\s*'refineWithOnDeviceModel',/
    .test(read('js/agents/guarded-copilot.js')));

ok('the copilot fails to the deterministic text when no guard is reachable',
  /if \(!guard\) return fallback;/.test(read('js/agents/guarded-copilot.js')));

ok('the canvas surface asks a human before the one outbound action it has',
  /askHuman\('Copy the capability ceiling/.test(read('js/ai/data-glow-local-ai-canvas.js')));

ok('the canvas surface carries its own from and end markers',
  (() => {
    const s = read('js/ai/data-glow-local-ai-canvas.js');
    return s.indexOf('/* ---- from js/ai/data-glow-local-ai-canvas.js ---- */') === 0
      && s.indexOf('/* ---- end js/ai/data-glow-local-ai-canvas.js ---- */') > 0;
  })());

ok('every new engine publishes itself onto window defensively',
  NEW_FILES.filter(f => f.indexOf('canvas') < 0)
    .every(f => /typeof window !== 'undefined'/.test(read(f))));

console.log('\n' + passed + ' passed, 0 failed');

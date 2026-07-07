// ============================================================
// DATAGLOW — On-Device Small Language Model Interpreter
// ============================================================
// An opt-in, in-browser LLM that turns DATAGLOW's structured validation output
// (the Assumption Ledger, the 20-layer results, and the Domain Physics Engine
// output when present) into a plain-English synthesis — WITHOUT any data ever
// leaving the browser.
//
// PRIVACY / LEGAL POSTURE (non-negotiable):
//   • The model runs 100% on-device via WebGPU (WebLLM / MLC). After the
//     one-time model-weight download (generic model files, never user data),
//     no network call is made — synthesis is fully offline. No row-level or
//     cell-level user data is ever transmitted anywhere.
//   • This is a *data-quality reasoning assistant*, not a medical or clinical
//     AI. It reasons about data validation findings only. Every prompt frames
//     it that way and it is instructed never to give clinical/diagnostic advice.
//
// The library (WebLLM) is loaded lazily from a CDN as an ES module the moment
// the user opts in — it is code, not user data, so fetching it is fine, and it
// keeps the ~MB library out of the initial page load.
//
// The prompt-construction functions are pure and browser-free so they can be
// unit-tested in Node. The model-loading / inference path requires WebGPU and
// is exercised via the graceful-degradation e2e path (and manual verification
// in a WebGPU-capable browser — see PR notes).

// A small, quantized instruct model from WebLLM's prebuilt registry. Qwen2.5's
// 1.5B-Instruct at 4-bit (~1.1GB) is a strong small model that runs on modest
// consumer GPUs; swap the id here to trade size for quality.
export const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
export const MODEL_LABEL = 'Qwen2.5 1.5B Instruct (4-bit, ~1.1 GB)';

// Pinned WebLLM ESM build. Loaded only on opt-in.
const WEBLLM_ESM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';

// WebGPU is required for on-device inference. Returns false (never throws) when
// the browser can't support it, so callers can degrade gracefully.
export function isWebGPUAvailable() {
  try {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  } catch {
    return false;
  }
}

// Collapse one layer result into a single readable line. Handles the two
// shapes runAllLayers produces: the generic { status, summary, detail } and the
// Confidence layer's { score, grade, verdict, ... }.
function summarizeOneLayer(id, r) {
  if (r == null) return null;
  const name = LAYER_NAME[id] || id;
  if (typeof r.score === 'number' && r.grade) {
    return `- ${name}: grade ${r.grade} (score ${r.score}/100) — ${r.verdict || r.status || ''}`.trim();
  }
  if (r.status || r.summary) {
    const status = (r.status || '').toUpperCase();
    let line = `- ${name}: ${status ? `[${status}] ` : ''}${r.summary || ''}`.trim();
    // Fold a short detail list in when present (cap length to keep the prompt tight).
    if (Array.isArray(r.detail) && r.detail.length) {
      const items = r.detail.slice(0, 3).map(d => String(d)).join('; ');
      line += ` (${items}${r.detail.length > 3 ? '; …' : ''})`;
    }
    return line;
  }
  return null;
}

// Human-readable names for layer ids (kept local so this module has no hard
// dependency on validation.js's export shape).
const LAYER_NAME = {
  sanity_anchor: 'Sanity Anchor',
  historical_drift: 'Historical Drift',
  unit_tests: 'Unit Tests',
  confidence: 'Confidence',
  denial_radar: 'Denial Radar',
  schema_fingerprint: 'Schema Fingerprint',
  semantic_drift: 'Semantic Drift',
  correlation_watchdog: 'Correlation Watchdog',
  narrative_consistency: 'Narrative Consistency',
  freshness: 'Freshness',
  blind_spot: 'Blind Spot Scanner',
  reproducibility: 'Reproducibility',
  outlier_detection: 'Outlier Detection',
  benford: "Benford's Law",
  categorical_consistency: 'Categorical Consistency',
  cross_column_logic: 'Cross-Column Logic',
  distribution_drift: 'Distribution Drift',
};

// Turn the full results object into a compact bullet summary string.
export function summarizeLayerResults(results) {
  if (!results || typeof results !== 'object') return '(no validation results available)';
  const lines = [];
  for (const [id, r] of Object.entries(results)) {
    const line = summarizeOneLayer(id, r);
    if (line) lines.push(line);
  }
  return lines.length ? lines.join('\n') : '(no validation results available)';
}

// Turn the Assumption Ledger entries into a compact bullet summary.
export function summarizeLedger(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '(no assumptions recorded)';
  return entries
    .map(e => `- (${e.source || 'unknown'}) ${e.action || ''}`.trim())
    .join('\n');
}

// Render the Domain Physics Engine output (shape unknown / optional) into text.
function summarizePhysics(physicsOutput) {
  if (physicsOutput == null) return null;
  if (typeof physicsOutput === 'string') return physicsOutput.trim() || null;
  if (Array.isArray(physicsOutput)) {
    const items = physicsOutput.map(x => (typeof x === 'string' ? x : (x && (x.message || x.summary)) || JSON.stringify(x))).filter(Boolean);
    return items.length ? items.map(i => `- ${i}`).join('\n') : null;
  }
  if (typeof physicsOutput === 'object') {
    if (physicsOutput.summary) return String(physicsOutput.summary);
    try { return JSON.stringify(physicsOutput); } catch { return null; }
  }
  return null;
}

const SYSTEM_PROMPT = [
  'You are DATAGLOW\'s on-device data-quality reasoning assistant.',
  'You run entirely on the user\'s own device and you help them understand DATA VALIDATION findings.',
  'You are NOT a medical, clinical, or diagnostic AI. Never give medical advice, diagnoses, or treatment guidance,',
  'and never claim clinical reasoning. If the data appears to be healthcare data, reason ONLY about its data quality',
  '(completeness, consistency, outliers, drift), never about patients or care.',
  'Write a concise, plain-English synthesis (a few short paragraphs) of the findings below for a non-technical analyst.',
  'Be honest about uncertainty, do not invent numbers that are not in the findings, and highlight the most material',
  'data-quality risks first. Do not output code.',
].join(' ');

// Build the full prompt (system + user) from the three structured inputs. Pure
// and deterministic so it can be unit-tested. Returns { system, user, messages }
// where `messages` is ready to hand to a chat-completions API.
export function buildSynthesisPrompt({ ledgerEntries = [], layerResults = {}, physicsOutput = null } = {}) {
  const sections = [];
  sections.push('## Assumption Ledger (judgment calls DATAGLOW made on the analyst\'s behalf)');
  sections.push(summarizeLedger(ledgerEntries));
  sections.push('');
  sections.push('## Validation Layer Results (20-layer suite)');
  sections.push(summarizeLayerResults(layerResults));

  const physics = summarizePhysics(physicsOutput);
  if (physics) {
    sections.push('');
    sections.push('## Domain Physics Engine Output');
    sections.push(physics);
  }

  sections.push('');
  sections.push('## Task');
  sections.push('Synthesize the above into a plain-English summary of the dataset\'s quality: what looks trustworthy, what the biggest risks are, and what a careful analyst should double-check before relying on this data. Remember: data quality only, no clinical interpretation.');

  const user = sections.join('\n');
  return {
    system: SYSTEM_PROMPT,
    user,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
}

// ============================================================
// Browser-only: model loading + inference (WebGPU / WebLLM)
// ============================================================
let enginePromise = null;

// Load (download + initialize) the on-device model. `onProgress` receives
// { progress: 0..1, text } during the one-time weight download, which WebLLM
// caches in the browser (Cache API / IndexedDB) for fully-offline reuse.
export async function loadModel(onProgress) {
  if (!isWebGPUAvailable()) {
    const err = new Error('WebGPU is not available in this browser. The on-device AI model needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on Android; Safari 18+).');
    err.code = 'NO_WEBGPU';
    throw err;
  }
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const webllm = await import(/* @vite-ignore */ WEBLLM_ESM_URL);
    const engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => {
        if (typeof onProgress === 'function') {
          onProgress({ progress: report.progress ?? 0, text: report.text || '' });
        }
      },
    });
    return engine;
  })().catch(err => {
    enginePromise = null; // allow retry after a failed load
    throw err;
  });
  return enginePromise;
}

export function isModelLoaded() {
  return enginePromise != null;
}

// Generate the plain-English synthesis. `context` is { ledgerEntries,
// layerResults, physicsOutput }. `onToken` (optional) streams partial text.
export async function synthesizeFindings(context, onToken) {
  const engine = await loadModel();
  const { messages } = buildSynthesisPrompt(context);
  const chunks = await engine.chat.completions.create({
    messages,
    temperature: 0.4,
    max_tokens: 700,
    stream: true,
  });
  let full = '';
  for await (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (delta) {
      full += delta;
      if (typeof onToken === 'function') onToken(full);
    }
  }
  return full.trim();
}

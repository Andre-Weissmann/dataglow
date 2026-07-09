// ============================================================
// DATAGLOW — Problem Framer
// ============================================================
// A pre-analysis wizard that turns a vague business question ("sales feel
// off this quarter") into a specific, measurable analytical question before
// any querying begins. Everything here is deterministic and offline: the
// reframing prompts are a fixed, hand-authored SMART-style set (no model
// call), the restatement is a plain template, and the column suggestions are
// simple keyword/substring matching against the loaded dataset's column
// names. No network, no data leaves the browser.
//
// This module is pure logic only (no DOM, no browser globals) so it runs
// identically in headless Node tests. main.js owns the panel wiring.

// The fixed reframing question set. Modeled on SMART framing — each question
// pins down one axis a vague ask usually leaves implicit: the decision at
// stake (Relevant), the time window (Time-bound), the audience, and the
// measurable definition of done (Specific + Measurable). Kept static on
// purpose: it must work with zero external calls.
export const REFRAMING_QUESTIONS = [
  {
    id: 'decision',
    label: 'What decision or action would the answer change?',
    hint: 'If nothing would change based on the answer, the question may not be worth analyzing yet.',
    placeholder: 'e.g. whether we shift ad budget away from the checkout funnel',
  },
  {
    id: 'timeWindow',
    label: 'What time window matters?',
    hint: 'Name the period you actually care about and anything to compare it against.',
    placeholder: 'e.g. this quarter (Q3) vs. the same quarter last year',
  },
  {
    id: 'audience',
    label: 'Who is the audience for the answer?',
    hint: 'Who will read or act on this? It sets the depth and framing of the result.',
    placeholder: 'e.g. the VP of Sales in the Monday leadership review',
  },
  {
    id: 'done',
    label: 'What does "done" look like — the specific, measurable result?',
    hint: 'Describe the concrete number, comparison, or chart that would let you stop.',
    placeholder: 'e.g. a signed-off figure for revenue change % by region',
  },
];

const QUESTION_IDS = REFRAMING_QUESTIONS.map((q) => q.id);

function clean(text) {
  return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
}

// Normalize a raw answers object into the fixed shape, trimming whitespace and
// dropping unknown keys. Always returns every question id (missing → '').
export function normalizeAnswers(answers = {}) {
  const out = {};
  for (const id of QUESTION_IDS) out[id] = clean(answers[id]);
  return out;
}

// Combine the intake text + the four answers into a single restated analytical
// question. Deterministic template — same inputs always yield the same output.
export function buildAnalyticalQuestion(intake, answers = {}) {
  const a = normalizeAnswers(answers);
  const topic = clean(intake) || 'the situation described';

  const parts = [];
  const measure = a.done || 'a specific, measurable result';
  parts.push(`For ${a.audience || 'the intended audience'},`);
  parts.push(`quantify ${measure.charAt(0).toLowerCase() + measure.slice(1)}`);
  parts.push(`over ${a.timeWindow || 'the relevant time window'},`);
  if (a.decision) {
    parts.push(`so we can decide ${a.decision.charAt(0).toLowerCase() + a.decision.slice(1)}.`);
  } else {
    parts.push('so we can act on a clear finding.');
  }

  const restated = parts.join(' ').replace(/\s+/g, ' ').trim();
  return `Originally asked as "${topic}", the analytical question is: ${restated}`;
}

// ---- Column suggestion (keyword / substring matching) --------------------

// Short, common words that carry no signal for matching column names.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
  'with', 'at', 'by', 'from', 'up', 'down', 'over', 'this', 'that', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'we', 'our', 'us', 'they', 'them', 'their', 'what', 'which', 'who', 'whom',
  'how', 'when', 'where', 'why', 'so', 'can', 'could', 'would', 'should',
  'will', 'do', 'does', 'did', 'has', 'have', 'had', 'as', 'about', 'into',
  'than', 'then', 'vs', 'per', 'any', 'all', 'each', 'some', 'more', 'most',
  'my', 'me', 'you', 'your', 'not', 'no', 'yes', 'change', 'answer', 'result',
  'data', 'dataset', 'look', 'like', 'matters', 'matter', 'window', 'time',
  'audience', 'decision', 'action', 'question', 'specific', 'measurable',
]);

function tokenize(text) {
  return clean(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// Break a column name into comparable lowercase tokens, splitting snake_case,
// kebab-case, spaces, and camelCase boundaries.
function columnTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function termMatchesColumn(term, colToks) {
  return colToks.some((ct) => ct === term || ct.includes(term) || term.includes(ct));
}

// Suggest which loaded columns might be relevant, by matching keywords the user
// typed (in the intake + answers) against the dataset's column names.
//
//   columns: array of column-name strings (e.g. ds.cols.map(c => c.name))
// Returns [{ term, columns: [names...] }] for each keyword with >=1 match,
// newest/most-specific ordering is not implied — order follows first appearance
// of the term. Pure, no side effects.
export function suggestColumns(intake, answers = {}, columns = []) {
  const cols = (columns || []).map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
  if (cols.length === 0) return [];

  const a = normalizeAnswers(answers);
  const haystack = [intake, a.decision, a.timeWindow, a.audience, a.done].join(' ');

  const seen = new Set();
  const terms = [];
  for (const t of tokenize(haystack)) {
    if (!seen.has(t)) { seen.add(t); terms.push(t); }
  }

  const colTokenMap = cols.map((name) => ({ name, toks: columnTokens(name) }));
  const suggestions = [];
  for (const term of terms) {
    const matched = colTokenMap.filter((c) => termMatchesColumn(term, c.toks)).map((c) => c.name);
    if (matched.length > 0) suggestions.push({ term, columns: matched });
  }
  return suggestions;
}

// ---- Context Card → validation-finding re-weighting -----------------------
//
// The optional Context Card ("What is this data for?") lets a user say, in
// their own words or by picking a domain, what the dataset is about before the
// 20 layers run. That free text feeds this pure re-weighting: each layer is
// scored for how well its focus matches the context, and the layers are
// reordered so the most relevant surface first. It only changes ORDER — every
// layer still runs and reports exactly what it always did. With no context the
// input order is returned unchanged, so the default experience is untouched.
//
// A small, hand-authored topic vocabulary maps each validation layer to the
// plain-language concerns it speaks to. Kept static and offline on purpose,
// exactly like the reframing question set above — no model call, nothing leaves
// the browser.
const LAYER_TOPICS = {
  unit_tests: ['integrity', 'accuracy', 'correct', 'error', 'defect', 'negative', 'duplicate', 'key', 'reference', 'billing', 'financial', 'amount', 'count'],
  outlier_detection: ['outlier', 'anomaly', 'extreme', 'spike', 'numeric', 'amount', 'price', 'value', 'revenue', 'sales', 'financial', 'billing', 'cost', 'money'],
  benford: ['fraud', 'manipulation', 'numeric', 'amount', 'financial', 'billing', 'accounting', 'ledger', 'transaction', 'invoice', 'money', 'accuracy'],
  upper_bound_sanity: ['bound', 'limit', 'percentage', 'proportion', 'probability', 'numeric', 'range', 'accuracy'],
  cross_column_logic: ['logic', 'consistency', 'impossible', 'combination', 'relationship', 'accuracy', 'integrity'],
  correlation_watchdog: ['correlation', 'metric', 'relationship', 'numeric', 'trend', 'financial'],
  sanity_anchor: ['aggregate', 'total', 'sum', 'accuracy', 'numeric', 'financial'],
  distribution_drift: ['drift', 'distribution', 'shift', 'trend', 'change', 'numeric', 'monitoring'],
  physiological_plausibility: ['physiological', 'vital', 'clinical', 'health', 'medical', 'patient', 'plausibility'],
  missingness_detective: ['missing', 'null', 'blank', 'incomplete', 'coverage', 'completeness'],
  categorical_consistency: ['category', 'categorical', 'label', 'spelling', 'text', 'naming', 'formatting', 'whitespace', 'merge', 'consistency'],
  semantic_drift: ['naming', 'label', 'text', 'meaning', 'semantic', 'column', 'formatting'],
  schema_fingerprint: ['schema', 'structure', 'column', 'type', 'formatting', 'naming'],
  freshness: ['fresh', 'stale', 'recent', 'timestamp', 'date', 'time', 'monitoring'],
  historical_drift: ['drift', 'change', 'history', 'reproducibility', 'monitoring'],
  reproducibility: ['reproducibility', 'deterministic', 'repeat', 'stable', 'consistency'],
  semantic: ['meaning', 'semantic'],
};

// Score one layer against the tokenized context terms. A term that hits the
// layer's curated topic vocabulary counts double; a term that only appears in
// the layer's own name/description counts single. Higher = more relevant.
function scoreLayerAgainstContext(def, terms) {
  if (!def || !def.id) return 0;
  const topics = LAYER_TOPICS[def.id] || [];
  const nameToks = tokenize(`${def.name || ''} ${def.desc || ''}`);
  let score = 0;
  for (const term of terms) {
    if (topics.some(t => t === term || t.includes(term) || term.includes(t))) score += 2;
    else if (nameToks.some(t => t === term || t.includes(term) || term.includes(t))) score += 1;
  }
  return score;
}

// Reorder `layerDefs` (each `{ id, name, desc, ... }`) so the layers most
// relevant to the Context Card text surface first. Ties keep the original
// registry order (stable), and an empty/whitespace/unmatched context returns a
// copy of the input in its original order — so skipping the Context Card leaves
// ordering exactly as it is today. Pure: never mutates its input.
export function orderLayersByContext(context, layerDefs = []) {
  const defs = Array.isArray(layerDefs) ? layerDefs.slice() : [];
  const ctx = clean(context);
  if (!ctx || defs.length === 0) return defs;
  const terms = tokenize(ctx);
  if (terms.length === 0) return defs;
  const scored = defs.map((def, i) => ({ def, i, score: scoreLayerAgainstContext(def, terms) }));
  if (scored.every(s => s.score === 0)) return defs;
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map(s => s.def);
}

// ---- Markdown export ------------------------------------------------------

// Produce a clean, one-page Markdown recap: the original vague question, the
// four reframing answers, the restated analytical question, and any suggested
// columns. Shareable/pasteable into a meeting recap. Deterministic aside from
// the timestamp, which the caller may override for tests.
export function buildExportMarkdown({ intake, answers = {}, columns = [], generatedAt } = {}) {
  const a = normalizeAnswers(answers);
  const topic = clean(intake) || '_(not provided)_';
  const analyticalQuestion = buildAnalyticalQuestion(intake, answers);
  const suggestions = suggestColumns(intake, answers, columns);
  const stamp = generatedAt || new Date().toISOString();

  const lines = [];
  lines.push('# DATAGLOW — Problem Framer Recap');
  lines.push('');
  lines.push(`_Generated ${stamp}_`);
  lines.push('');
  lines.push('## Original question');
  lines.push('');
  lines.push(`> ${topic}`);
  lines.push('');
  lines.push('## Reframing');
  lines.push('');
  for (const q of REFRAMING_QUESTIONS) {
    lines.push(`- **${q.label}**`);
    lines.push(`  ${a[q.id] || '_(not answered)_'}`);
  }
  lines.push('');
  lines.push('## Restated analytical question');
  lines.push('');
  lines.push(analyticalQuestion);
  lines.push('');
  lines.push('## Suggested columns');
  lines.push('');
  if (suggestions.length === 0) {
    lines.push('_No dataset loaded, or no column names matched the answers._');
  } else {
    for (const s of suggestions) {
      lines.push(`- You mentioned **${s.term}** — matching columns: ${s.columns.map((c) => `\`${c}\``).join(', ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

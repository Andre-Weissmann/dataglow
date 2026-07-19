// ============================================================
// DATAGLOW — Question Prompter (Feature 13: "Where to start" intelligence)
// ============================================================
// DataGlow does not wait for the analyst to know what to ask. This module
// reads a dataset's signals — its file name, its schema, its validation
// findings, its column statistics, and (as it streams in) its live batches —
// and turns them into a small, ranked set of concrete business questions the
// analyst can act on immediately.
//
// Three modes, three entry points:
//   1. Pre-upload   — generatePreUploadQuestions(fileName, columnNames)
//                      Nothing has loaded yet. Only the file name and the
//                      column names (from schema inference) are known. This
//                      mode asks the questions a sharp analyst would ask
//                      before opening the file: "what's the grain here?",
//                      "what time period does this cover?".
//   2. Post-validation — generateQuestions(findings, columnStats, options)
//                      Validation has run. This mode targets what was ACTUALLY
//                      found: nulls, skew, outliers, fanout, drift. Every
//                      question is traceable to a specific finding or stat
//                      (see `triggeredBy`).
//   3. Streaming    — updateStreamingQuestions(existing, newBatchFindings, n)
//                      NATS batches keep arriving. This mode diffs the new
//                      batch's findings against the existing question set:
//                      new patterns raise new questions, resolved patterns
//                      retire old ones.
//
// DESIGN PRINCIPLE: rule-based and template-driven, not LLM-dependent. Every
// function here is pure (no browser APIs, no network, no randomness beyond a
// deterministic hash) so the whole module runs identically in a browser tab,
// a Tauri desktop shell, or a bare Node test process — and so its output is
// reproducible: the same findings always produce the same questions in the
// same order. An LLM MAY be layered on top by a caller (e.g. to rephrase a
// question in a domain-specific voice) but is never required for the module
// to do its job.
//
// This module NEVER makes the call for the analyst. Questions are phrased as
// questions, `suggestedAction` is a starting point not an instruction, and
// `suggestedSQL` is a "run this to see for yourself", not a report. See
// docs/question-prompter.md §7 for the philosophy behind that choice.
// ============================================================

// ------------------------------------------------------------
// 1. Question template library
// ------------------------------------------------------------
// Every template is a `{{token}}`-interpolated string. Keys double as the
// `triggeredBy`-prefix / category discriminant used throughout this module.
export const QUESTION_TEMPLATES = {
  // Statistical patterns
  right_skew: '{{col}} has a right skew (skewness: {{skew}}). Should we investigate whether {{col}} follows a power-law distribution, and segment by {{groupCol}}?',
  high_nulls: '{{pct}}% of {{col}} values are missing. Is this missingness random (MCAR) or does it correlate with {{relatedCol}}?',
  outliers: '{{count}} outlier rows detected in {{col}} (beyond {{threshold}}). Are these data entry errors or genuine edge cases worth investigating?',
  low_cardinality: '{{col}} has only {{n}} unique values. Is this a category column being stored as text? Should we analyze distribution across these groups?',
  date_gap: '{{col}} has a {{gap}}-day gap between {{dateA}} and {{dateB}}. Was there a collection pause? Does this affect trend analysis?',
  // Join / schema issues
  fanout: 'The join between {{tableA}} and {{tableB}} has a {{ratio}}x fanout. Are there duplicate keys? Should we deduplicate before aggregating?',
  schema_drift: '{{col}} changed type from {{oldType}} to {{newType}} at row {{row}}. Was this intentional? Does it break downstream calculations?',
  // Business domain patterns
  revenue_skew: 'Revenue is concentrated in the top {{pct}}% of records. What drives this concentration — product type, region, or customer segment?',
  healthcare_los: 'Length of stay values range from {{min}} to {{max}} days. Are the extreme values readmissions, transfers, or data errors?',
  healthcare_readmission: '{{count}} patients appear within 30 days of discharge. Is this a readmission flag or a data join artifact?',
  // Exploratory
  correlation_hint: '{{colA}} and {{colB}} may be correlated (both numeric, similar null pattern). Should we run a correlation analysis?',
  time_trend: '{{col}} spans {{duration}}. Is there a seasonal pattern or trend worth investigating?',
  // Pre-upload (schema-only)
  schema_only_id: 'This looks like a transaction/event table. What is the grain — one row per {{entity}}?',
  schema_only_date: '{{col}} appears to be a date column. What time period does this data cover, and what is the reporting cadence?',
  schema_only_amount: '{{col}} looks like an amount/value column. What currency and what aggregation level (daily, monthly, per-transaction)?',
};

// Category + default priority for every template key. Used by generateQuestions
// / rankQuestions so callers don't need to hardcode this mapping themselves.
const TEMPLATE_META = {
  right_skew: { category: 'exploration', priority: 'medium' },
  high_nulls: { category: 'quality', priority: 'high' },
  outliers: { category: 'quality', priority: 'high' },
  low_cardinality: { category: 'exploration', priority: 'low' },
  date_gap: { category: 'quality', priority: 'medium' },
  fanout: { category: 'validation', priority: 'high' },
  schema_drift: { category: 'validation', priority: 'high' },
  revenue_skew: { category: 'business', priority: 'medium' },
  healthcare_los: { category: 'business', priority: 'medium' },
  healthcare_readmission: { category: 'business', priority: 'high' },
  correlation_hint: { category: 'exploration', priority: 'low' },
  time_trend: { category: 'exploration', priority: 'medium' },
  schema_only_id: { category: 'exploration', priority: 'medium' },
  schema_only_date: { category: 'exploration', priority: 'medium' },
  schema_only_amount: { category: 'exploration', priority: 'medium' },
};

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// ------------------------------------------------------------
// small internal helpers
// ------------------------------------------------------------

// Deterministic (non-cryptographic) string hash — stable across processes so
// question ids are reproducible for the same template + column + context.
// djb2 variant, rendered as an 8-char base36 string.
function hashString(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  // Force unsigned 32-bit, then base36 for compactness.
  return (h >>> 0).toString(36).padStart(7, '0');
}

// Deterministic id: same template + trigger context → same id, always.
function makeQuestionId(templateKey, contextKey) {
  return `q_${templateKey}_${hashString(contextKey)}`;
}

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });
}

function round(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function pct(n, digits = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const value = n <= 1 ? n * 100 : n; // accept either 0-1 fraction or already-percent
  return round(value, digits);
}

function clampMax(arr, max) {
  if (typeof max !== 'number' || max <= 0) return arr;
  return arr.slice(0, max);
}

// Build a Question object from a template key + vars + trigger metadata.
function buildQuestion(templateKey, vars, { triggeredBy, contextKey, columnStats = [], overridePriority, overrideCategory } = {}) {
  const template = QUESTION_TEMPLATES[templateKey];
  if (!template) return null;
  const meta = TEMPLATE_META[templateKey] || { category: 'exploration', priority: 'medium' };
  const text = interpolate(template, vars);
  const id = makeQuestionId(templateKey, contextKey || `${templateKey}:${JSON.stringify(vars)}`);
  return {
    id,
    text,
    priority: overridePriority || meta.priority,
    category: overrideCategory || meta.category,
    triggeredBy: triggeredBy || templateKey,
    suggestedSQL: null,
    suggestedAction: defaultActionFor(templateKey),
    _templateKey: templateKey,
    _vars: vars,
  };
}

function defaultActionFor(templateKey) {
  switch (templateKey) {
    case 'high_nulls': return 'Run a missingness breakdown grouped by a related column';
    case 'right_skew': return 'Run distribution analysis and segment by category';
    case 'outliers': return 'Inspect outlier rows individually for data entry errors';
    case 'low_cardinality': return 'Analyze distribution across the observed categories';
    case 'date_gap': return 'Check upstream collection logs for the gap window';
    case 'fanout': return 'Check join keys for duplicates before aggregating';
    case 'schema_drift': return 'Review the pipeline change log around the affected rows';
    case 'revenue_skew': return 'Run distribution analysis by category column';
    case 'healthcare_los': return 'Review extreme LOS rows for transfer/readmission flags';
    case 'healthcare_readmission': return 'Cross-check readmission flag against join provenance';
    case 'correlation_hint': return 'Run a correlation analysis between the two columns';
    case 'time_trend': return 'Plot the column over time to check for seasonality';
    case 'schema_only_id': return 'Confirm the table grain with the data owner';
    case 'schema_only_date': return 'Confirm the reporting period and cadence';
    case 'schema_only_amount': return 'Confirm currency and aggregation level';
    default: return 'Investigate further';
  }
}

// ------------------------------------------------------------
// 2. Domain inference
// ------------------------------------------------------------

const DOMAIN_SIGNALS = {
  healthcare: ['patient', 'claim', 'diagnosis', 'icd', 'drg', 'los', 'length_of_stay', 'discharge', 'admit', 'admission', 'npi', 'provider', 'readmission', 'insurance', 'encounter', 'procedure', 'cpt'],
  finance: ['revenue', 'amount', 'balance', 'account', 'transaction', 'invoice', 'payment', 'ledger', 'debit', 'credit', 'currency', 'gl_code', 'cost', 'price'],
  retail: ['product', 'sku', 'order', 'customer', 'cart', 'inventory', 'store', 'basket', 'checkout', 'shipment', 'warehouse', 'quantity'],
  hr: ['employee', 'salary', 'department', 'hire', 'termination', 'performance', 'headcount', 'compensation', 'manager_id', 'tenure'],
  operations: ['shift', 'downtime', 'throughput', 'utilization', 'maintenance', 'equipment', 'sensor', 'batch_id', 'yield'],
};

// Order matters as a tie-break when a name matches multiple domains equally —
// healthcare/finance/retail/hr are checked before the generic 'operations'
// bucket since they tend to be more specific signals.
const DOMAIN_ORDER = ['healthcare', 'finance', 'retail', 'hr', 'operations'];

function normalizeTokens(strs) {
  const text = strs.filter(Boolean).join(' ').toLowerCase();
  return text.replace(/[^a-z0-9]+/g, ' ');
}

export function inferDomain(fileName, columnNames = []) {
  const haystack = normalizeTokens([fileName || '', ...(columnNames || [])]);
  const scores = {};
  for (const domain of DOMAIN_ORDER) {
    let score = 0;
    for (const signal of DOMAIN_SIGNALS[domain]) {
      // Left word-boundary required (so "los" never matches inside "close"),
      // but the right side allows trailing letters so plurals and simple
      // suffixes match too ("claim" -> "claims", "payment" -> "payments").
      const re = new RegExp(`(^|[^a-z0-9])${signal}[a-z]{0,3}([^a-z0-9]|$)`, 'i');
      if (re.test(haystack)) score++;
    }
    scores[domain] = score;
  }
  let best = 'general';
  let bestScore = 0;
  for (const domain of DOMAIN_ORDER) {
    if (scores[domain] > bestScore) {
      best = domain;
      bestScore = scores[domain];
    }
  }
  return bestScore > 0 ? best : 'general';
}

// ------------------------------------------------------------
// 3. Column-name pattern helpers (used by pre-upload mode)
// ------------------------------------------------------------

const DATE_NAME_RE = /(date|_dt$|^dt_|time|timestamp|created|updated|admit|discharge|hire|period)/i;
const AMOUNT_NAME_RE = /(amount|amt|price|cost|revenue|balance|total|payment|fee|charge|value$)/i;
const ID_NAME_RE = /(_id$|^id$|identifier|key$|uuid|guid)/i;

function isDateLikeName(name) {
  return DATE_NAME_RE.test(name);
}
function isAmountLikeName(name) {
  return AMOUNT_NAME_RE.test(name);
}
function isIdLikeName(name) {
  return ID_NAME_RE.test(name);
}

// ------------------------------------------------------------
// 4. Post-validation mode: generateQuestions
// ------------------------------------------------------------

// findings: Finding[] — normalized to accept a range of shapes emitted by
// different validation layers across the codebase (type/kind, column/col,
// etc.) so this module can sit downstream of any of them without translation.
function findingType(f) {
  return (f && (f.type || f.kind || f.category || '')).toString().toLowerCase();
}
function findingColumn(f) {
  return f && (f.column || f.col || f.field || null);
}

export function generateQuestions(findings = [], columnStats = [], options = {}) {
  const { domain, maxQuestions = 7, includeSQL = false } = options;
  const questions = [];
  const safeFindings = Array.isArray(findings) ? findings : [];
  const safeStats = Array.isArray(columnStats) ? columnStats : [];

  if (safeFindings.length === 0 && safeStats.length === 0) {
    return [];
  }

  const inferredDomain = domain || 'general';

  // --- from column stats: high_nulls, right_skew, low_cardinality ---
  for (const stat of safeStats) {
    if (!stat || !stat.name) continue;
    const col = stat.name;

    if (typeof stat.nullPct === 'number' && stat.nullPct > 10) {
      const relatedCol = pickRelatedColumn(stat, safeStats);
      const q = buildQuestion('high_nulls', {
        pct: pct(stat.nullPct),
        col,
        relatedCol: relatedCol || 'another column',
      }, {
        triggeredBy: `high_nulls in ${col}`,
        contextKey: `high_nulls:${col}:${round(stat.nullPct, 1)}`,
      });
      if (q) questions.push(q);
    }

    if (typeof stat.skewness === 'number' && stat.skewness > 2) {
      const groupCol = pickGroupColumn(safeStats, col);
      const q = buildQuestion('right_skew', {
        col,
        skew: round(stat.skewness, 2),
        groupCol: groupCol || 'a category column',
      }, {
        triggeredBy: `right_skew in ${col}`,
        contextKey: `right_skew:${col}:${round(stat.skewness, 2)}`,
      });
      if (q) questions.push(q);

      // Business domain: revenue-flavored skew gets an extra business framing.
      if (/revenue|sales|amount|price/i.test(col)) {
        const topPct = 20;
        const rq = buildQuestion('revenue_skew', { pct: topPct }, {
          triggeredBy: `right_skew in ${col} (revenue-like column)`,
          contextKey: `revenue_skew:${col}`,
        });
        if (rq) questions.push(rq);
      }
    }

    if (typeof stat.uniqueCount === 'number' && stat.uniqueCount > 0 && stat.uniqueCount <= 12 && stat.type !== 'boolean') {
      const q = buildQuestion('low_cardinality', {
        col,
        n: stat.uniqueCount,
      }, {
        triggeredBy: `low_cardinality in ${col}`,
        contextKey: `low_cardinality:${col}:${stat.uniqueCount}`,
      });
      if (q) questions.push(q);
    }

    // Healthcare domain-specific: length-of-stay column by name pattern.
    if ((inferredDomain === 'healthcare' || /^los$|length_of_stay/i.test(col)) && /^los$|length_of_stay/i.test(col)) {
      if (typeof stat.min === 'number' && typeof stat.max === 'number') {
        const q = buildQuestion('healthcare_los', {
          min: stat.min,
          max: stat.max,
        }, {
          triggeredBy: `healthcare_los pattern in ${col}`,
          contextKey: `healthcare_los:${col}:${stat.min}:${stat.max}`,
        });
        if (q) questions.push(q);
      }
    }
  }

  // --- from findings: outliers, fanout, schema_drift, date_gap, readmission ---
  for (const f of safeFindings) {
    const type = findingType(f);
    const col = findingColumn(f) || 'the column';

    if (type.includes('outlier')) {
      const q = buildQuestion('outliers', {
        count: f.count ?? f.outlierCount ?? 'Several',
        col,
        threshold: f.threshold ?? '3 std dev',
      }, {
        triggeredBy: `outliers in ${col}`,
        contextKey: `outliers:${col}:${f.count ?? ''}`,
      });
      if (q) questions.push(q);
    }

    if (type.includes('fanout')) {
      const q = buildQuestion('fanout', {
        tableA: f.tableA || f.left || 'table A',
        tableB: f.tableB || f.right || 'table B',
        ratio: f.ratio ? round(f.ratio, 1) : '2+',
      }, {
        triggeredBy: `fanout between ${f.tableA || 'A'} and ${f.tableB || 'B'}`,
        contextKey: `fanout:${f.tableA}:${f.tableB}:${f.ratio}`,
      });
      if (q) questions.push(q);
    }

    if (type.includes('drift') && type.includes('schema')) {
      const q = buildQuestion('schema_drift', {
        col,
        oldType: f.oldType || 'unknown',
        newType: f.newType || 'unknown',
        row: f.row ?? f.rowIndex ?? 'unknown',
      }, {
        triggeredBy: `schema_drift in ${col}`,
        contextKey: `schema_drift:${col}:${f.oldType}:${f.newType}:${f.row}`,
      });
      if (q) questions.push(q);
    }

    if (type.includes('date_gap') || type.includes('gap')) {
      const q = buildQuestion('date_gap', {
        col,
        gap: f.gapDays ?? f.gap ?? 'a',
        dateA: f.dateA || f.from || 'the earlier date',
        dateB: f.dateB || f.to || 'the later date',
      }, {
        triggeredBy: `date_gap in ${col}`,
        contextKey: `date_gap:${col}:${f.gapDays}:${f.dateA}:${f.dateB}`,
      });
      if (q) questions.push(q);
    }

    if (type.includes('readmission') || (inferredDomain === 'healthcare' && type.includes('duplicate') && /patient/i.test(col))) {
      const q = buildQuestion('healthcare_readmission', {
        count: f.count ?? 'Several',
      }, {
        triggeredBy: `healthcare_readmission signal in ${col}`,
        contextKey: `healthcare_readmission:${col}:${f.count ?? ''}`,
      });
      if (q) questions.push(q);
    }

    if (type.includes('correlation')) {
      const q = buildQuestion('correlation_hint', {
        colA: f.colA || f.columnA || col,
        colB: f.colB || f.columnB || 'another column',
      }, {
        triggeredBy: `correlation_hint between ${f.colA || col} and ${f.colB || ''}`,
        contextKey: `correlation_hint:${f.colA}:${f.colB}`,
      });
      if (q) questions.push(q);
    }
  }

  // --- time trend from stats with min/max date-like values ---
  for (const stat of safeStats) {
    if (!stat || !stat.name) continue;
    if (isDateLikeName(stat.name) && stat.min && stat.max) {
      const q = buildQuestion('time_trend', {
        col: stat.name,
        duration: `${stat.min} to ${stat.max}`,
      }, {
        triggeredBy: `time_trend range in ${stat.name}`,
        contextKey: `time_trend:${stat.name}:${stat.min}:${stat.max}`,
      });
      if (q) questions.push(q);
    }
  }

  // Domain enrichment: healthcare domain always nudges toward LOS/readmission
  // framing when the domain is inferred even without an exact column hit, but
  // only if we have not already produced a domain-specific question and there
  // is at least one column that plausibly relates (avoids noise on unrelated
  // healthcare-adjacent files).
  if (inferredDomain === 'healthcare' && !questions.some(q => q._templateKey === 'healthcare_los')) {
    const losStat = safeStats.find(s => s && /^los$|length_of_stay|discharge/i.test(s.name || ''));
    if (losStat && typeof losStat.min === 'number' && typeof losStat.max === 'number') {
      const q = buildQuestion('healthcare_los', { min: losStat.min, max: losStat.max }, {
        triggeredBy: `healthcare_los inferred from domain + column ${losStat.name}`,
        contextKey: `healthcare_los_domain:${losStat.name}`,
      });
      if (q) questions.push(q);
    }
  }

  // De-duplicate by id, then sort by priority and truncate to maxQuestions.
  const seen = new Set();
  const deduped = [];
  for (const q of questions) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    deduped.push(q);
  }
  deduped.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  const limited = clampMax(deduped, maxQuestions);

  if (includeSQL) {
    for (const q of limited) {
      q.suggestedSQL = generateStarterSQL(q, options.tableName || 'dataset', safeStats);
    }
  }

  // Strip internal-only fields before returning.
  return limited.map(stripInternal);
}

function stripInternal(q) {
  const { _templateKey, _vars, ...rest } = q;
  return rest;
}

function pickRelatedColumn(stat, allStats) {
  const candidate = allStats.find(s => s && s.name !== stat.name && typeof s.nullPct === 'number');
  return candidate ? candidate.name : null;
}

function pickGroupColumn(allStats, excludeCol) {
  const candidate = allStats.find(s => s && s.name !== excludeCol && typeof s.uniqueCount === 'number' && s.uniqueCount > 1 && s.uniqueCount <= 20);
  return candidate ? candidate.name : null;
}

// ------------------------------------------------------------
// 5. Pre-upload mode: generatePreUploadQuestions
// ------------------------------------------------------------

export function generatePreUploadQuestions(fileName, columnNames = [], options = {}) {
  const domain = options.domain || inferDomain(fileName, columnNames);
  const names = Array.isArray(columnNames) ? columnNames : [];
  const questions = [];

  const dateCols = names.filter(isDateLikeName);
  const amountCols = names.filter(isAmountLikeName);
  const idCols = names.filter(isIdLikeName);

  if (idCols.length > 0) {
    const entity = guessEntityFromFileName(fileName, domain);
    const q = buildQuestion('schema_only_id', { entity }, {
      triggeredBy: `id-like column(s): ${idCols.join(', ')}`,
      contextKey: `schema_only_id:${fileName}:${idCols.join(',')}`,
    });
    if (q) questions.push(q);
  }

  for (const col of dateCols.slice(0, 2)) {
    const q = buildQuestion('schema_only_date', { col }, {
      triggeredBy: `date-like column name: ${col}`,
      contextKey: `schema_only_date:${fileName}:${col}`,
    });
    if (q) questions.push(q);
  }

  for (const col of amountCols.slice(0, 2)) {
    const q = buildQuestion('schema_only_amount', { col }, {
      triggeredBy: `amount-like column name: ${col}`,
      contextKey: `schema_only_amount:${fileName}:${col}`,
    });
    if (q) questions.push(q);
  }

  // Domain-specific pre-upload nudge even before any data has loaded.
  if (domain === 'healthcare') {
    const losCol = names.find(c => /^los$|length_of_stay/i.test(c));
    if (losCol) {
      const q = buildQuestion('healthcare_los', { min: 'the minimum observed', max: 'the maximum observed' }, {
        triggeredBy: `healthcare_los pre-upload signal: column name ${losCol}`,
        contextKey: `schema_only_healthcare_los:${fileName}:${losCol}`,
      });
      if (q) questions.push(q);
    }
  }

  // Fallback so we always return at least 3 questions even for a sparse schema.
  if (questions.length < 3) {
    const genericEntity = guessEntityFromFileName(fileName, domain);
    const fallbackTemplates = [
      buildQuestion('schema_only_id', { entity: genericEntity }, {
        triggeredBy: 'fallback: generic grain question',
        contextKey: `fallback_id:${fileName}`,
      }),
    ];
    for (const q of fallbackTemplates) {
      if (q && !questions.some(existing => existing.id === q.id)) questions.push(q);
    }
  }
  // Still short? Pad with a generic exploratory nudge per remaining column,
  // capped so we never exceed the 3-5 target range promised by the spec.
  let i = 0;
  while (questions.length < 3 && i < names.length) {
    const col = names[i++];
    if (dateCols.includes(col) || amountCols.includes(col) || idCols.includes(col)) continue;
    const q = buildQuestion('low_cardinality', { col, n: 'a handful of' }, {
      triggeredBy: `generic column present: ${col}`,
      contextKey: `preupload_generic:${fileName}:${col}`,
      overridePriority: 'low',
      overrideCategory: 'exploration',
    });
    if (q) questions.push(q);
  }

  const seen = new Set();
  const deduped = questions.filter(q => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  deduped.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  return clampMax(deduped, options.maxQuestions || 5).map(stripInternal);
}

function guessEntityFromFileName(fileName, domain) {
  if (domain === 'healthcare') return 'patient encounter';
  if (domain === 'finance') return 'transaction';
  if (domain === 'retail') return 'order';
  if (domain === 'hr') return 'employee record';
  if (domain === 'operations') return 'event';
  return 'record';
}

// ------------------------------------------------------------
// 6. Streaming mode: updateStreamingQuestions
// ------------------------------------------------------------

export function updateStreamingQuestions(existingQuestions = [], newBatchFindings = [], batchNumber = 0) {
  const existing = Array.isArray(existingQuestions) ? existingQuestions : [];
  const batchFindings = Array.isArray(newBatchFindings) ? newBatchFindings : [];

  // Generate candidate questions purely from this batch's findings (no
  // column stats available mid-stream — findings alone drive streaming mode).
  const fromBatch = generateQuestions(batchFindings, [], { maxQuestions: 20 });

  const existingIds = new Set(existing.map(q => q.id));
  const newQuestions = fromBatch.filter(q => !existingIds.has(q.id));

  // A question is "resolved" when its triggering finding type/column no
  // longer appears anywhere in this batch's findings — i.e. the condition
  // that raised it seems to have cleared in the latest data. Finding types are
  // stemmed (trailing 's' stripped) before comparison since `triggeredBy`
  // strings use the template-key plural ("outliers") while raw findings often
  // use the singular (`type: 'outlier'`).
  const activeTriggerKeys = new Set(
    batchFindings.map(f => `${stem(findingType(f))}:${findingColumn(f) || ''}`)
  );
  const resolvedQuestions = [];
  const stillActive = [];
  for (const q of existing) {
    const key = extractTriggerKey(q.triggeredBy);
    const stemmedKey = key ? stem(key) : null;
    const stillTriggered = stemmedKey ? [...activeTriggerKeys].some(k => k.includes(stemmedKey)) : true;
    if (!stillTriggered && batchFindings.length > 0) {
      resolvedQuestions.push({ ...q, resolvedAtBatch: batchNumber });
    } else {
      stillActive.push(q);
    }
  }

  const merged = [...stillActive, ...newQuestions];
  const seen = new Set();
  const deduped = merged.filter(q => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  deduped.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  return {
    questions: deduped,
    newQuestions,
    resolvedQuestions,
  };
}

// Best-effort extraction of a matchable fragment ("outliers", "col_name") from
// a triggeredBy string like "outliers in revenue" or "fanout between A and B".
function extractTriggerKey(triggeredBy) {
  if (!triggeredBy || typeof triggeredBy !== 'string') return null;
  const match = triggeredBy.match(/^(\w+)/);
  return match ? match[1] : null;
}

// Minimal English stemmer (strip a single trailing 's') so "outliers" and
// "outlier" compare equal. Deliberately not a full stemmer — this module only
// needs to bridge template-key plurals against raw finding-type singulars.
function stem(word) {
  if (!word) return word;
  return word.toLowerCase().endsWith('s') ? word.toLowerCase().slice(0, -1) : word.toLowerCase();
}

// ------------------------------------------------------------
// 7. Ranking
// ------------------------------------------------------------

export function rankQuestions(questions = [], previouslyShown = []) {
  const shownIds = new Set((previouslyShown || []).map(q => (typeof q === 'string' ? q : q.id)));
  const filtered = (questions || []).filter(q => q && !shownIds.has(q.id));
  return [...filtered].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 3;
    const pb = PRIORITY_RANK[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    // Stable secondary sort: category alphabetically, then text, for determinism.
    if (a.category !== b.category) return String(a.category).localeCompare(String(b.category));
    return String(a.text).localeCompare(String(b.text));
  });
}

// ------------------------------------------------------------
// 8. Starter SQL generation
// ------------------------------------------------------------

export function generateStarterSQL(question, tableName = 'dataset', columnStats = []) {
  if (!question) return null;
  const templateKey = question._templateKey || inferTemplateKeyFromTriggeredBy(question.triggeredBy);
  const col = extractColumnFromQuestion(question, columnStats);
  const table = tableName || 'dataset';

  switch (templateKey) {
    case 'high_nulls':
      return `SELECT COUNT(*) - COUNT(${col}) AS nulls, COUNT(*) AS total FROM ${table};`;
    case 'right_skew':
      return `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${col}) AS median, AVG(${col}) AS mean, MAX(${col}) AS max FROM ${table};`;
    case 'outliers':
      return `SELECT * FROM ${table} WHERE ${col} > (SELECT AVG(${col}) + 3 * STDDEV(${col}) FROM ${table}) OR ${col} < (SELECT AVG(${col}) - 3 * STDDEV(${col}) FROM ${table});`;
    case 'low_cardinality':
      return `SELECT ${col}, COUNT(*) AS cnt FROM ${table} GROUP BY ${col} ORDER BY cnt DESC;`;
    case 'date_gap':
      return `SELECT ${col}, LEAD(${col}) OVER (ORDER BY ${col}) - ${col} AS gap FROM ${table} ORDER BY gap DESC LIMIT 10;`;
    case 'fanout':
      return `SELECT ${col}, COUNT(*) AS cnt FROM ${table} GROUP BY ${col} HAVING cnt > 1 ORDER BY cnt DESC;`;
    case 'schema_drift':
      return `SELECT ${col}, typeof(${col}) AS observed_type FROM ${table} LIMIT 100;`;
    case 'revenue_skew':
      return `SELECT ${col}, PERCENT_RANK() OVER (ORDER BY ${col}) AS pct_rank FROM ${table} ORDER BY ${col} DESC;`;
    case 'healthcare_los':
      return `SELECT MIN(${col}) AS min_los, MAX(${col}) AS max_los, AVG(${col}) AS avg_los FROM ${table};`;
    case 'healthcare_readmission':
      return `SELECT patient_id, COUNT(*) AS visit_count FROM ${table} GROUP BY patient_id HAVING visit_count > 1;`;
    case 'correlation_hint':
      return `SELECT CORR(${col}, ${col}) AS correlation FROM ${table};`;
    case 'time_trend':
      return `SELECT DATE_TRUNC('month', ${col}) AS period, COUNT(*) AS n FROM ${table} GROUP BY period ORDER BY period;`;
    case 'schema_only_id':
      return `SELECT COUNT(*) AS total_rows, COUNT(DISTINCT ${col}) AS distinct_ids FROM ${table};`;
    case 'schema_only_date':
      return `SELECT MIN(${col}) AS earliest, MAX(${col}) AS latest FROM ${table};`;
    case 'schema_only_amount':
      return `SELECT SUM(${col}) AS total, AVG(${col}) AS avg, MIN(${col}) AS min, MAX(${col}) AS max FROM ${table};`;
    default:
      return `SELECT * FROM ${table} LIMIT 100;`;
  }
}

function inferTemplateKeyFromTriggeredBy(triggeredBy) {
  if (!triggeredBy) return null;
  for (const key of Object.keys(QUESTION_TEMPLATES)) {
    if (triggeredBy.includes(key)) return key;
  }
  return null;
}

function extractColumnFromQuestion(question, columnStats) {
  // Prefer an explicit column embedded in triggeredBy ("high_nulls in col_name").
  const inMatch = /in ([\w.]+)/.exec(question.triggeredBy || '');
  if (inMatch) return inMatch[1];
  const betweenMatch = /between (\S+)/.exec(question.triggeredBy || '');
  if (betweenMatch) return betweenMatch[1];
  if (columnStats && columnStats.length) return columnStats[0].name;
  return 'col';
}

// ------------------------------------------------------------
// 9. Canvas card formatting
// ------------------------------------------------------------

export function formatQuestionsCard(questions = []) {
  const lines = [];
  lines.push('WHERE TO START');
  lines.push('==============');
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) {
    lines.push('(No questions generated yet — load data or run validation to get started.)');
    return lines.join('\n');
  }
  for (const q of list) {
    const priorityTag = `[${(q.priority || 'medium').toUpperCase()}]`;
    const categoryLabel = capitalize(q.category || 'exploration');
    lines.push(`${priorityTag} ${categoryLabel}: ${q.text}`);
    if (q.suggestedSQL) {
      lines.push(`  \u2192 Starter SQL: ${q.suggestedSQL}`);
    } else if (q.suggestedAction) {
      lines.push(`  \u2192 Action: ${q.suggestedAction}`);
    }
  }
  return lines.join('\n');
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

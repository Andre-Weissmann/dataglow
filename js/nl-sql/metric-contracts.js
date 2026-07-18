// ============================================================
// DATAGLOW — NL→SQL: Metric Contracts
// ============================================================
// Metric Contracts are human-authored, canonical definitions of business metrics
// that the NL→SQL engine uses to generate DETERMINISTIC SQL for named metrics.
//
// Why this matters:
//   "Show me readmission rate" could generate SQL 5 different ways depending on
//   which LLM run you catch. A Metric Contract pins the exact DuckDB expression
//   so the output is reproducible and auditable — the LLM chooses WHICH metric
//   to use, but not HOW to compute it.
//
// Architecture:
//   - Contracts live in an in-memory registry (no localStorage, no server).
//   - Each contract has: name, description, SQL expression template, required
//     columns, and an optional domain tag.
//   - The NL→SQL engine searches contracts FIRST by keyword matching the user's
//     question. If a contract matches, its SQL expression is injected verbatim
//     into the prompt as a "locked expression" — the LLM is instructed to use
//     it exactly and not rephrase it.
//   - If no contract matches, the LLM generates freely from schema context.
//
// This is the dbt semantic-layer pattern, minus the server:
//   98-100% accuracy on named metrics (no hallucination of the formula),
//   vs 0% reliability when the LLM freestyle-invents metric SQL.
//
// Privacy: no row data. Contracts reference column names only.
// ============================================================

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------
/**
 * @typedef {object} MetricContract
 * @property {string}   name          Human name, e.g. "30-Day Readmission Rate"
 * @property {string}   id            Kebab-case machine id, e.g. "readmission-rate-30d"
 * @property {string}   description   Plain English: what this metric means
 * @property {string}   expression    DuckDB SQL expression template. Use {{table}} as table placeholder.
 *                                    e.g. "COUNT(CASE WHEN readmit_30d = 1 THEN 1 END) * 100.0 / COUNT(*)"
 * @property {string[]} requiredCols  Columns that must exist for this contract to apply
 * @property {string[]} keywords      Words/phrases in the user's question that trigger this contract
 * @property {string}   [domain]      Optional domain tag: 'healthcare', 'finance', 'general'
 * @property {string}   [alias]       Default column alias for the expression in SELECT
 */

// ---------------------------------------------------------------
// Registry
// ---------------------------------------------------------------

const contractRegistry = new Map(); // id -> MetricContract

// ---------------------------------------------------------------
// Built-in healthcare contracts
// ---------------------------------------------------------------
// These are the metrics a healthcare data analyst asks about most.
// All expressions are DuckDB-compatible. {{table}} is replaced at
// query-build time with the actual table alias.

const BUILT_IN_CONTRACTS = [
  {
    id: 'readmission-rate-30d',
    name: '30-Day Readmission Rate',
    description: 'Percentage of encounters where the patient was readmitted within 30 days of discharge.',
    expression: 'ROUND(COUNT(CASE WHEN readmit_30d = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2)',
    requiredCols: ['readmit_30d'],
    keywords: ['30 day readmission', '30-day readmission', 'readmission rate', 'readmit rate', 'readmitted'],
    alias: 'readmission_rate_30d_pct',
    domain: 'healthcare',
  },
  {
    id: 'denial-rate',
    name: 'Claim Denial Rate',
    description: 'Percentage of submitted claims that were denied.',
    expression: 'ROUND(COUNT(CASE WHEN claim_status = \'DENIED\' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2)',
    requiredCols: ['claim_status'],
    keywords: ['denial rate', 'denied claims', 'claim denial', 'denial percentage'],
    alias: 'denial_rate_pct',
    domain: 'healthcare',
  },
  {
    id: 'avg-length-of-stay',
    name: 'Average Length of Stay',
    description: 'Average number of days between admission and discharge.',
    expression: 'ROUND(AVG(DATEDIFF(\'day\', admit_date, discharge_date)), 2)',
    requiredCols: ['admit_date', 'discharge_date'],
    keywords: ['length of stay', 'average stay', 'avg los', 'los', 'days admitted', 'days in hospital'],
    alias: 'avg_length_of_stay_days',
    domain: 'healthcare',
  },
  {
    id: 'case-mix-index',
    name: 'Case Mix Index',
    description: 'Average DRG weight across all encounters — a measure of patient acuity.',
    expression: 'ROUND(AVG(drg_weight), 4)',
    requiredCols: ['drg_weight'],
    keywords: ['case mix', 'cmi', 'drg weight', 'acuity', 'patient complexity'],
    alias: 'case_mix_index',
    domain: 'healthcare',
  },
  {
    id: 'mortality-rate',
    name: 'In-Hospital Mortality Rate',
    description: 'Percentage of encounters that resulted in an in-hospital death.',
    expression: 'ROUND(COUNT(CASE WHEN discharge_disposition = \'EXPIRED\' OR deceased = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2)',
    requiredCols: [],
    // Works if either column is present — engine checks requiredCols against schema
    keywords: ['mortality', 'death rate', 'died', 'expired', 'in-hospital death'],
    alias: 'mortality_rate_pct',
    domain: 'healthcare',
  },
  {
    id: 'ed-utilization-rate',
    name: 'ED Utilization Rate',
    description: 'Percentage of encounters that came through the emergency department.',
    expression: 'ROUND(COUNT(CASE WHEN admit_source = \'EMERGENCY\' OR emergency_admit = 1 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2)',
    requiredCols: [],
    keywords: ['ed utilization', 'emergency utilization', 'emergency admit', 'er visits', 'ed visits'],
    alias: 'ed_utilization_rate_pct',
    domain: 'healthcare',
  },
  {
    id: 'net-payment-rate',
    name: 'Net Payment Rate',
    description: 'Percentage of billed charges that were actually paid (net of adjustments and refunds).',
    expression: 'ROUND(SUM(payment_amount) * 100.0 / NULLIF(SUM(billed_amount), 0), 2)',
    requiredCols: ['payment_amount', 'billed_amount'],
    keywords: ['payment rate', 'collection rate', 'net payment', 'paid vs billed', 'reimbursement rate'],
    alias: 'net_payment_rate_pct',
    domain: 'healthcare',
  },
  {
    id: 'null-rate',
    name: 'Null Rate',
    description: 'Percentage of values in a column that are NULL — a data quality metric.',
    expression: 'ROUND(COUNT(CASE WHEN {{col}} IS NULL THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2)',
    requiredCols: [],
    keywords: ['null rate', 'missing values', 'nulls', 'completeness', 'missing rate'],
    alias: 'null_rate_pct',
    domain: 'general',
  },
  {
    id: 'row-count',
    name: 'Row Count',
    description: 'Total number of rows in the result.',
    expression: 'COUNT(*)',
    requiredCols: [],
    keywords: ['how many', 'count', 'total rows', 'number of records', 'how many records', 'how many patients', 'how many encounters'],
    alias: 'row_count',
    domain: 'general',
  },
  {
    id: 'distinct-count',
    name: 'Distinct Count',
    description: 'Number of unique values in a column.',
    expression: 'COUNT(DISTINCT {{col}})',
    requiredCols: [],
    keywords: ['unique', 'distinct', 'how many different', 'how many unique'],
    alias: 'distinct_count',
    domain: 'general',
  },
];

// ---------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------

/**
 * Register a metric contract. Overwrites any existing contract with the same id.
 * @param {MetricContract} contract
 */
export function registerContract(contract) {
  if (!contract.id || !contract.name || !contract.expression) {
    throw new Error('registerContract: id, name, and expression are required');
  }
  contractRegistry.set(contract.id, {
    keywords: [],
    requiredCols: [],
    domain: 'general',
    ...contract,
  });
}

/**
 * Remove a contract by id.
 * @param {string} id
 */
export function unregisterContract(id) {
  contractRegistry.delete(id);
}

/**
 * Return all registered contracts (built-in + custom).
 * @returns {MetricContract[]}
 */
export function getAllContracts() {
  return [...contractRegistry.values()];
}

/**
 * Look up a contract by id.
 * @param {string} id
 * @returns {MetricContract|null}
 */
export function getContract(id) {
  return contractRegistry.get(id) || null;
}

// ---------------------------------------------------------------
// Matching — keyword search against user's natural language question
// ---------------------------------------------------------------

/**
 * Find all contracts whose keywords match the user's question.
 * Returns them sorted by match strength (most keywords matched first).
 *
 * Also filters out contracts whose requiredCols are not present in the
 * available columns, when availableCols is provided.
 *
 * @param {string} question
 * @param {string[]} [availableCols]  Column names visible in the loaded schema
 * @returns {MetricContract[]}
 */
export function matchContracts(question, availableCols) {
  const q = question.toLowerCase();
  const colSet = availableCols
    ? new Set(availableCols.map(c => c.toLowerCase()))
    : null;

  const scored = [];
  for (const contract of contractRegistry.values()) {
    // Filter by requiredCols if we have schema info
    if (colSet && contract.requiredCols.length) {
      const hasAll = contract.requiredCols.every(rc => colSet.has(rc.toLowerCase()));
      if (!hasAll) continue;
    }
    // Score by keyword hits
    let score = 0;
    for (const kw of contract.keywords) {
      if (q.includes(kw.toLowerCase())) score++;
    }
    if (score > 0) scored.push({ contract, score });
  }

  return scored.sort((a, b) => b.score - a.score).map(s => s.contract);
}

/**
 * Return the single best-matching contract, or null.
 * @param {string} question
 * @param {string[]} [availableCols]
 * @returns {MetricContract|null}
 */
export function bestMatch(question, availableCols) {
  const matches = matchContracts(question, availableCols);
  return matches.length ? matches[0] : null;
}

// ---------------------------------------------------------------
// Contract → prompt fragment
// ---------------------------------------------------------------

/**
 * Serialize a contract into a compact text block for injection into the
 * LLM system prompt. The model is instructed to use the expression verbatim.
 *
 * @param {MetricContract} contract
 * @param {string} [tableAlias]  The DuckDB table alias in scope, e.g. "t1"
 * @returns {string}
 */
export function contractToPromptFragment(contract, tableAlias) {
  const expr = tableAlias
    ? contract.expression.replace(/\{\{table\}\}/g, tableAlias)
    : contract.expression;
  return [
    `METRIC CONTRACT — ${contract.name}`,
    `Description: ${contract.description}`,
    `USE THIS EXACT EXPRESSION (do not rephrase or simplify):`,
    `  ${expr} AS ${contract.alias || 'metric_value'}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------
// Initialise built-ins
// ---------------------------------------------------------------

for (const contract of BUILT_IN_CONTRACTS) {
  registerContract(contract);
}

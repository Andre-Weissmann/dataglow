// ============================================================
// DATAGLOW — NL→SQL: Schema Context Extractor
// ============================================================
// Builds a compact, LLM-ready representation of the loaded dataset schema.
// PRIVACY GUARANTEE: this module only touches column names, types, and optional
// metadata (enum samples, cardinality hints). It NEVER reads row values or
// passes any user data to the prompt. That guarantee is enforced structurally —
// the functions here only accept ColDef[] / TableSchema objects, never raw rows.
//
// The output of buildSchemaContext() is what goes into the LLM prompt.
// It is plain text, token-efficient, and explicitly labelled so the model
// knows it is looking at a schema, not data.
// ============================================================

// ---------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------
/**
 * @typedef {{ name: string, type: string, nullable?: boolean, isPrimaryKey?: boolean, isForeignKey?: boolean, referencedTable?: string, referencedCol?: string, enumSamples?: string[], cardinalityHint?: 'low'|'medium'|'high'|'unique' }} ColDef
 * @typedef {{ tableName: string, cols: ColDef[], rowCountHint?: number, domainHint?: string }} TableSchema
 * @typedef {{ tables: TableSchema[], relationships: RelationshipHint[], domainContext?: string }} SchemaContext
 * @typedef {{ fromTable: string, fromCol: string, toTable: string, toCol: string, confidence: 'certain'|'inferred' }} RelationshipHint
 */

// ---------------------------------------------------------------
// Type normalisation helpers
// ---------------------------------------------------------------

const NUMERIC_TYPES = new Set([
  'INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT',
  'FLOAT', 'DOUBLE', 'REAL', 'DECIMAL', 'NUMERIC',
  'UBIGINT', 'UINTEGER', 'USMALLINT', 'UTINYINT',
]);
const DATE_TYPES   = new Set(['DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME', 'INTERVAL']);
const BOOLEAN_TYPES = new Set(['BOOLEAN', 'BOOL']);

/**
 * Return a simplified type group for prompt readability.
 * @param {string} rawType
 * @returns {'number'|'text'|'date'|'boolean'|'other'}
 */
export function typeGroup(rawType) {
  const upper = (rawType || '').toUpperCase().split('(')[0].trim();
  if (NUMERIC_TYPES.has(upper)) return 'number';
  if (DATE_TYPES.has(upper))    return 'date';
  if (BOOLEAN_TYPES.has(upper)) return 'boolean';
  if (upper === 'VARCHAR' || upper === 'TEXT' || upper === 'STRING' || upper === 'CHAR') return 'text';
  return 'other';
}

// ---------------------------------------------------------------
// Auto-infer relationships between tables from column names
// ---------------------------------------------------------------

const ID_SUFFIX_RE = /(_id|_key|_fk|id|key)$/i;

/**
 * Infer likely join relationships between tables purely from column naming.
 * Returns RelationshipHint[] sorted by confidence (certain first).
 *
 * Heuristics:
 *  1. Exact column name match across tables where both match ID_SUFFIX_RE.
 *  2. A column in table B named "<tableA>_id" or "<tableA>id" matching table A's PK.
 *
 * @param {TableSchema[]} tables
 * @returns {RelationshipHint[]}
 */
export function inferRelationships(tables) {
  const hints = [];
  const seen = new Set(); // deduplicate

  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const ta = tables[i];
      const tb = tables[j];

      for (const ca of ta.cols) {
        for (const cb of tb.cols) {
          const caLow = ca.name.toLowerCase();
          const cbLow = cb.name.toLowerCase();

          // 1. Exact match on an ID-like column
          if (caLow === cbLow && ID_SUFFIX_RE.test(caLow)) {
            const key = `${ta.tableName}.${ca.name}=${tb.tableName}.${cb.name}`;
            if (!seen.has(key)) {
              seen.add(key);
              hints.push({ fromTable: ta.tableName, fromCol: ca.name, toTable: tb.tableName, toCol: cb.name, confidence: 'certain' });
            }
          }

          // 2. Cross-table FK pattern: tb has "<ta.tableName>_id" column
          const expectedFk1 = ta.tableName.toLowerCase() + '_id';
          const expectedFk2 = ta.tableName.toLowerCase() + 'id';
          if ((cbLow === expectedFk1 || cbLow === expectedFk2)) {
            // Find the likely PK on ta (named "id", "<tableName>_id", or "encounter_id")
            const pkCandidate = ta.cols.find(c =>
              c.isPrimaryKey ||
              c.name.toLowerCase() === 'id' ||
              c.name.toLowerCase() === ta.tableName.toLowerCase() + '_id'
            );
            if (pkCandidate) {
              const key = `${ta.tableName}.${pkCandidate.name}=${tb.tableName}.${cb.name}`;
              if (!seen.has(key)) {
                seen.add(key);
                hints.push({ fromTable: ta.tableName, fromCol: pkCandidate.name, toTable: tb.tableName, toCol: cb.name, confidence: 'inferred' });
              }
            }
          }
        }
      }
    }
  }

  // Certain first, then inferred
  return hints.sort((a, b) => (a.confidence === 'certain' ? -1 : 1));
}

// ---------------------------------------------------------------
// Schema context builder
// ---------------------------------------------------------------

/**
 * Build a compact SchemaContext object from an array of TableSchema.
 * @param {TableSchema[]} tables
 * @param {object} [opts]
 * @param {string} [opts.domainContext]  Optional domain hint e.g. "healthcare claims"
 * @returns {SchemaContext}
 */
export function buildSchemaContext(tables, opts = {}) {
  const relationships = inferRelationships(tables);
  return {
    tables,
    relationships,
    domainContext: opts.domainContext || null,
  };
}

// ---------------------------------------------------------------
// Prompt serializer — converts SchemaContext to LLM-ready text
// ---------------------------------------------------------------

/**
 * Serialize a SchemaContext into a compact, token-efficient string suitable
 * for embedding in a system prompt. No row data is included — only schema.
 *
 * Format:
 *   DATABASE SCHEMA (schema only — no row data)
 *   Domain: <domainContext or "general">
 *
 *   TABLE encounters (<N> rows approx)
 *     encounter_id  INTEGER  [primary key]
 *     patient_id    INTEGER  [foreign key → patients.patient_id]
 *     admit_date    DATE
 *     ...
 *
 *   RELATIONSHIPS (inferred from column names):
 *     encounters.patient_id → patients.patient_id  [certain]
 *     ...
 *
 * @param {SchemaContext} ctx
 * @returns {string}
 */
export function serializeSchemaForPrompt(ctx) {
  const lines = [];
  lines.push('DATABASE SCHEMA (column names and types only — no row data, no patient records)');
  lines.push(`Domain: ${ctx.domainContext || 'general'}`);
  lines.push('');

  for (const table of ctx.tables) {
    const rowHint = table.rowCountHint != null ? ` (~${table.rowCountHint.toLocaleString()} rows)` : '';
    lines.push(`TABLE ${table.tableName}${rowHint}`);
    for (const col of table.cols) {
      const parts = [];
      // Name + type
      parts.push(`  ${col.name.padEnd(28)} ${(col.rawType || col.type || '').padEnd(20)}`);
      // Annotations
      const ann = [];
      if (col.isPrimaryKey) ann.push('PRIMARY KEY');
      if (col.isForeignKey && col.referencedTable) ann.push(`FK → ${col.referencedTable}.${col.referencedCol || '?'}`);
      if (col.nullable === false) ann.push('NOT NULL');
      if (col.cardinalityHint) ann.push(`cardinality:${col.cardinalityHint}`);
      if (col.enumSamples && col.enumSamples.length) {
        // Enum samples help the model know valid values without sending row data
        const samples = col.enumSamples.slice(0, 8).map(s => JSON.stringify(s)).join(', ');
        ann.push(`values: [${samples}]`);
      }
      if (ann.length) parts.push(`[${ann.join(', ')}]`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }

  if (ctx.relationships.length) {
    lines.push('INFERRED RELATIONSHIPS:');
    for (const r of ctx.relationships) {
      lines.push(`  ${r.fromTable}.${r.fromCol} → ${r.toTable}.${r.toCol}  [${r.confidence}]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------
// Dataset adapter — converts DataGlow's internal state.datasets
// format into TableSchema[] so buildSchemaContext can consume it.
// ---------------------------------------------------------------

/**
 * Convert a DataGlow dataset object (as stored in state.datasets) into
 * a TableSchema. Accepts several shapes that have occurred across phases.
 *
 * @param {object} dataset
 * @returns {TableSchema}
 */
export function datasetToTableSchema(dataset) {
  const tableName = dataset.name || dataset.tableName || 'unknown';
  const rawCols = dataset.columns || dataset.cols || dataset.schema || [];

  const cols = rawCols.map(c => {
    if (typeof c === 'string') return { name: c, type: 'VARCHAR', rawType: 'VARCHAR' };
    return {
      name:          c.name || c.col || c.column_name || '',
      type:          typeGroup(c.type || c.column_type || ''),
      rawType:       c.type || c.column_type || '',
      nullable:      c.nullable !== false,
      isPrimaryKey:  !!(c.isPrimaryKey || c.primary_key),
      isForeignKey:  !!(c.isForeignKey || c.foreign_key),
      referencedTable: c.referencedTable || c.referenced_table || null,
      referencedCol:   c.referencedCol   || c.referenced_col  || null,
      enumSamples:   Array.isArray(c.enumSamples) ? c.enumSamples : [],
      cardinalityHint: c.cardinalityHint || null,
    };
  });

  return {
    tableName,
    cols,
    rowCountHint: dataset.rowCount || dataset.row_count || null,
    domainHint: dataset.domainHint || null,
  };
}

/**
 * Build a SchemaContext from DataGlow's state.datasets array directly.
 * @param {object[]} datasets
 * @param {string} [domainContext]
 * @returns {SchemaContext}
 */
export function datasetsToSchemaContext(datasets, domainContext) {
  const tables = (datasets || []).map(datasetToTableSchema);
  return buildSchemaContext(tables, { domainContext });
}

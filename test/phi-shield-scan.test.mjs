/**
 * PHI Shield scan orchestration tests (pure, no DOM).
 * Mirrors DataGlowPhiShield.scanDataset logic against real modules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSafeHarbor,
  scoreReidentificationRisk,
  buildDeidReport,
} from '../js/provenance/deidentification-verifier.js';
import {
  classifySensitiveColumns,
  redactSensitiveText,
  guardPromptPayload,
} from '../js/agents/phi-prompt-guard.js';

function colNames(ds) {
  return (ds.columns || []).map((c, i) => (typeof c === 'string' ? c : c.name || `col${i}`));
}
function colTypes(ds) {
  return (ds.columns || []).map((c, i) =>
    typeof c === 'string' ? { name: c, type: 'STR' } : { name: c.name, type: c.type || 'STR' }
  );
}
function buildSamples(ds, cap = 400) {
  const names = colNames(ds);
  const rows = ds.rows || [];
  const n = Math.min(rows.length, cap);
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    for (let c = 0; c < names.length; c++) {
      const v = Array.isArray(row) ? row[c] : row?.[names[c]];
      if (v != null && v !== '') samples[names[c]].push(v);
    }
  }
  return samples;
}

function scanDataset(ds) {
  const columns = colTypes(ds);
  const names = colNames(ds);
  const samples = buildSamples(ds);
  const rowCount = ds.rows?.length || 0;
  const deid = buildDeidReport({ columns, samples, table: 't', rowCount });
  const sensitiveCols = classifySensitiveColumns(names);
  let patternHits = 0;
  for (const name of names) {
    for (const v of samples[name] || []) {
      if (typeof v !== 'string') continue;
      const rr = redactSensitiveText(v);
      patternHits += rr.findings.reduce((a, f) => a + (f.count || 1), 0);
    }
  }
  const objRows = (ds.rows || []).slice(0, 5).map((row) => {
    const o = {};
    names.forEach((n, i) => { o[n] = Array.isArray(row) ? row[i] : row?.[n]; });
    return o;
  });
  const guard = guardPromptPayload({ text: 'summary', rows: objRows, columns: names });
  let verdict = deid.verdict;
  if (patternHits > 0 && verdict === 'pass') verdict = 'review';
  if ((deid.safeHarbor?.flaggedCount || 0) > 0) verdict = 'fail';
  return { verdict, deid, sensitiveCols, patternHits, guard };
}

describe('PHI Shield scan', () => {
  it('flags PHI-heavy healthcare-shaped data as fail', () => {
    const ds = {
      columns: [
        { name: 'patient_name', type: 'STR' },
        { name: 'ssn', type: 'STR' },
        { name: 'mrn', type: 'STR' },
        { name: 'email', type: 'STR' },
        { name: 'zip', type: 'STR' },
        { name: 'encounters', type: 'INT' },
      ],
      rows: [
        ['Jane Doe', '123-45-6789', 'MRN: A123456', 'jane@example.com', '60601', 3],
        ['John Smith', '987-65-4321', 'MRN: B998877', 'john@example.org', '60614', 1],
      ],
    };
    const r = scanDataset(ds);
    assert.equal(r.verdict, 'fail');
    assert.ok(r.deid.safeHarbor.flaggedCount >= 1);
    assert.ok(r.patternHits >= 1);
    assert.equal(r.guard.sensitiveFound, true);
  });

  it('passes clean aggregate metrics with no identifiers', () => {
    const ds = {
      columns: [
        { name: 'segment', type: 'STR' },
        { name: 'fiscal_year', type: 'INT' },
        { name: 'revenue_usd', type: 'FLOAT' },
      ],
      rows: [
        ['Midwest', 2024, 120000.5],
        ['West', 2024, 98000.25],
      ],
    };
    const r = scanDataset(ds);
    assert.equal(r.verdict, 'pass', JSON.stringify(r.deid?.safeHarbor?.categories?.filter(c=>c.status==='flag'), null, 2));
    assert.equal(r.deid.safeHarbor.flaggedCount, 0);
    assert.equal(r.guard.sensitiveFound, false);
  });

  it('checkSafeHarbor matchedColumns use {column, reason} objects', () => {
    const sh = checkSafeHarbor({
      columns: [{ name: 'patient_name', type: 'STR' }],
      samples: { patient_name: ['A'] },
    });
    const names = sh.categories.find((c) => c.id === 'names');
    assert.equal(names.status, 'flag');
    assert.equal(typeof names.matchedColumns[0].column, 'string');
  });

  it('guardPromptPayload redacts SSN shapes in free text', () => {
    const g = guardPromptPayload({ text: 'Patient SSN 111-22-3333 needs review' });
    assert.equal(g.sensitiveFound, true);
    assert.match(g.text, /REDACTED:SSN/);
    assert.doesNotMatch(g.text, /111-22-3333/);
  });

  it('scoreReidentificationRisk marks classic trio high', () => {
    const r = scoreReidentificationRisk({
      columns: [
        { name: 'dob' },
        { name: 'sex' },
        { name: 'zip' },
      ],
      samples: {},
      rowCount: 20,
    });
    assert.equal(r.level, 'high');
  });
});

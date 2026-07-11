// ============================================================
// DATAGLOW — Open Floor Kernel test suite (Batch A)
// ============================================================
// Unit tests for the two pure Batch-A modules:
//   - js/agents/open-floor-room.js   (read-only room kernel)
//   - js/agents/phi-prompt-guard.js  (pre-submit PHI/sensitive prompt filter)
// No DuckDB, no DOM, no network — the room takes an INJECTED fake reader.
//
// RUN WITH:  node test/open-floor-kernel.test.mjs

import {
  createReadOnlyRoom,
  classifyReadOnlySql,
  ReadOnlyViolation,
} from '../js/agents/open-floor-room.js';
import {
  guardPromptPayload,
  redactSensitiveText,
  redactSampleRows,
  classifySensitiveColumns,
  DEFAULT_SENSITIVE_PATTERNS,
} from '../js/agents/phi-prompt-guard.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}
async function assertThrows(msg, ctor, promise) {
  let threw = null;
  try { await promise; } catch (e) { threw = e; }
  ok(threw instanceof ctor, `${msg}: throws ${ctor.name}`);
}

async function main() {
  // ================================================================
  // 1. classifyReadOnlySql — reads pass, everything mutating/ambiguous
  //    is rejected (fail closed).
  // ================================================================
  ok(classifyReadOnlySql('SELECT * FROM t').ok, 'classify: SELECT is read-only');
  ok(classifyReadOnlySql('  with x as (select 1) select * from x ').ok, 'classify: WITH...SELECT is read-only');
  ok(classifyReadOnlySql('DESCRIBE t').ok, 'classify: DESCRIBE is read-only');
  ok(classifyReadOnlySql('SUMMARIZE t').ok, 'classify: SUMMARIZE is read-only');
  ok(classifyReadOnlySql('SELECT created_at, count(*) FROM t GROUP BY 1').ok,
    'classify: "created_at" does not trip the CREATE keyword (word boundary)');
  ok(classifyReadOnlySql('SELECT * FROM t; -- trailing').ok, 'classify: single trailing semicolon + comment ok');

  ok(!classifyReadOnlySql('DROP TABLE t').ok, 'classify: DROP is rejected');
  ok(!classifyReadOnlySql('DELETE FROM t').ok, 'classify: DELETE is rejected');
  ok(!classifyReadOnlySql('UPDATE t SET x=1').ok, 'classify: UPDATE is rejected');
  ok(!classifyReadOnlySql('INSERT INTO t VALUES (1)').ok, 'classify: INSERT is rejected');
  ok(!classifyReadOnlySql('TRUNCATE t').ok, 'classify: TRUNCATE is rejected');
  ok(!classifyReadOnlySql('SELECT 1; DROP TABLE t').ok, 'classify: chained SELECT;DROP is rejected (no smuggling)');
  ok(!classifyReadOnlySql('').ok, 'classify: empty is rejected');
  ok(!classifyReadOnlySql('   ').ok, 'classify: blank is rejected');
  ok(!classifyReadOnlySql('COPY t TO \'f.csv\'').ok, 'classify: COPY (exfil) is rejected');
  ok(!classifyReadOnlySql('ATTACH \'x.db\'').ok, 'classify: ATTACH is rejected');
  ok(!classifyReadOnlySql('PRAGMA database_list').ok, 'classify: unknown-leader PRAGMA is rejected (fail closed)');

  // ================================================================
  // 2. createReadOnlyRoom — read-only BY CONSTRUCTION: no mutating
  //    method exists, the surface is frozen, reads delegate to the
  //    injected reader, and non-reads never reach it.
  // ================================================================
  const dataset = { name: 'patients', table: 'patients', rowCount: 3,
    cols: [{ name: 'id' }, { name: 'age' }, { name: 'race' }] };
  const readCalls = [];
  const fakeRead = async (sql) => { readCalls.push(sql); return { columns: ['n'], rows: [{ n: 3 }] }; };
  const room = createReadOnlyRoom({
    dataset, read: fakeRead,
    validation: { confidence: { grade: 'B' } },
    metrics: { rowCount: 3 },
  });

  ok(room.isReadOnlyRoom === true, 'room: marked isReadOnlyRoom');
  ok(room.describe().columns.join(',') === 'id,age,race', 'room: describe() lists columns');
  ok(room.getRowCount() === 3, 'room: getRowCount()');

  // The whole point: mutating methods DO NOT EXIST on the surface.
  for (const m of ['update', 'delete', 'insert', 'applyFix', 'mutate', 'drop', 'write', 'set']) {
    ok(room[m] === undefined, `room: no .${m}() method exists (read-only by construction)`);
  }
  // ...and the surface is frozen, so a caller cannot attach one.
  let attachThrew = false;
  try {
    'use strict';
    Object.defineProperty(room, 'applyFix', { value: () => 'boom' });
  } catch { attachThrew = true; }
  ok(attachThrew || room.applyFix === undefined, 'room: cannot bolt on a mutating method (frozen)');

  // Read delegates to the injected reader.
  const res = await room.query('SELECT count(*) AS n FROM patients');
  ok(res.rows[0].n === 3 && readCalls.length === 1, 'room: query() delegates a read to the injected reader');

  // A non-read is refused and NEVER reaches the reader.
  await assertThrows('room: DROP via query()', ReadOnlyViolation, room.query('DROP TABLE patients'));
  ok(readCalls.length === 1, 'room: refused statement never reached the reader');

  // Governed-state snapshots are frozen copies (mutating them is inert).
  const v = room.getValidationState();
  try { v.confidence.grade = 'F'; } catch { /* frozen */ }
  ok(room.getValidationState().confidence.grade === 'B', 'room: validation snapshot is a frozen copy');

  // Missing reader / dataset fail fast.
  ok((() => { try { createReadOnlyRoom({ dataset }); return false; } catch { return true; } })(),
    'room: refuses to build without an injected reader');

  // ================================================================
  // 3. PHI guard — column classification reuses the shared predicate.
  // ================================================================
  const cols = ['patient_id', 'age', 'race', 'insurance', 'sex', 'zip'];
  const sens = classifySensitiveColumns(cols);
  ok(sens.includes('race') && sens.includes('insurance') && sens.includes('sex'),
    'phi: classifies race/insurance/sex as sensitive (shared classifier)');
  ok(!sens.includes('age') && !sens.includes('zip'),
    'phi: does not over-flag age/zip (matches domain-physics behavior)');

  // ================================================================
  // 4. PHI guard — always-on value patterns fire WITHOUT any pack.
  // ================================================================
  const ssnScan = redactSensitiveText('Patient SSN is 123-45-6789 today.');
  ok(ssnScan.text.includes('[REDACTED:SSN]') && !ssnScan.text.includes('123-45-6789'),
    'phi: SSN-shaped string is redacted (no pack needed)');
  const mrnScan = redactSensitiveText('See MRN: 00456789 for details.');
  ok(mrnScan.text.includes('[REDACTED:MRN]'), 'phi: MRN-shaped string is redacted');
  const emailScan = redactSensitiveText('contact jane.doe@example.com');
  ok(emailScan.text.includes('[REDACTED:EMAIL]'), 'phi: email is redacted');
  const clean = redactSensitiveText('The query returned 1250 rows across 8 columns.');
  ok(clean.text === 'The query returned 1250 rows across 8 columns.' && clean.findings.length === 0,
    'phi: ordinary counts are NOT redacted (no false positive)');

  // ================================================================
  // 5. PHI guard — structured rows drop sensitive columns + scan values.
  // ================================================================
  const rows = [
    { patient_id: 1, race: 'Asian', note: 'ssn 222-33-4444', age: 40 },
    { patient_id: 2, race: 'White', note: 'fine', age: 55 },
  ];
  const sr = redactSampleRows(rows, ['patient_id', 'race', 'note', 'age']);
  ok(sr.droppedColumns.includes('race'), 'phi: sensitive column "race" dropped from sample');
  ok(sr.rows.every(r => !('race' in r)), 'phi: no sensitive column value survives in sample rows');
  ok(sr.rows[0].note.includes('[REDACTED:SSN]'), 'phi: value-pattern scan runs on surviving columns');
  ok(rows[0].race === 'Asian', 'phi: input rows never mutated');

  // ================================================================
  // 6. PHI guard — the combined pre-submit entry point.
  // ================================================================
  const guarded = guardPromptPayload({
    text: 'Summarize patient 123-45-6789 by race.',
    rows,
    columns: ['patient_id', 'race', 'note', 'age'],
  });
  ok(!guarded.text.includes('123-45-6789'), 'guard: SSN redacted from free-text prompt');
  ok(guarded.rows.every(r => !('race' in r)), 'guard: sensitive column stripped from embedded rows');
  ok(guarded.sensitiveFound === true, 'guard: sensitiveFound flag set when anything was redacted');
  const cleanGuard = guardPromptPayload({ text: 'How many rows are there?' });
  ok(cleanGuard.sensitiveFound === false && cleanGuard.text === 'How many rows are there?',
    'guard: a clean, non-sensitive prompt passes through untouched');

  ok(DEFAULT_SENSITIVE_PATTERNS.length >= 3, 'phi: a minimal default pattern set ships');

  // ---------- summary ----------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

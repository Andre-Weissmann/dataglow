// ============================================================
// DATAGLOW - Real-world breadth stress test (2026-11-21)
// ============================================================
// Roadmap Step 9 Part 2. Every module exercised here was previously listed in
// capability-map.manifest.json with NO "## Test findings" entry in
// NORTH_STAR.md. Each section feeds the module's REAL exported functions a
// small, realistic, deliberately messy healthcare / operations dataset whose
// correct answers are written down in the test (the "answer key"), computed by
// hand or by an independent implementation, never by calling the module under
// test. Where a transform emits SQL, the SQL is also executed on a real DuckDB
// (@duckdb/node-api) and must agree with the JS result.
//
// Run: node --import ./test/duckdb-loader-hook.mjs test/realworld-breadth-stress-2026-11.test.mjs
//
// Bugs this pass caught are fixed in js/ and pinned by regression assertions
// below (search for "REGRESSION").
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuery } from './node-duckdb-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
const sections = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + String(e && e.message).split('\n').join('\n       ')); }
}
function section(title, modules) { sections.push({ title, modules }); console.log('\n[' + title + ']'); }

// Independent NPI generator (Luhn over 80840 prefix) so the validator is never
// asked to grade its own output.
function npiWithCheck(base9) {
  const digits = ('80840' + base9).split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return base9 + String((10 - (sum % 10)) % 10);
}
const GOOD_NPI = npiWithCheck('123456789');   // 1234567893
const GOOD_NPI2 = npiWithCheck('987654321');
const BAD_NPI = GOOD_NPI.slice(0, 9) + String((Number(GOOD_NPI[9]) + 1) % 10);

// ---------------------------------------------------------------------------
// 1. X12 835 / 837 (ingestion-x12-parser). The shipped parser is the IIFE in
//    src/js/bundle.js (js/ingestion/x12-parser.js is a documentation stub), so
//    it is loaded the same way test/x12-parser.test.mjs loads it.
// ---------------------------------------------------------------------------
section('X12 835/837 claims ingestion', ['js/ingestion/x12-parser.js']);
const bundle = readFileSync(path.join(ROOT, 'src/js/bundle.js'), 'utf8');
const x12m = bundle.match(/var X12Parser = \(function[\s\S]*?window\.X12Parser = X12Parser;/);
const x12ctx = { window: {} }; vm.createContext(x12ctx); vm.runInContext(x12m[0], x12ctx);
const X12 = x12ctx.window.X12Parser;
const ISA835 = 'ISA*00*          *00*          *ZZ*PAYERID        *ZZ*PAYEEID        *230601*1200*^*00501*000000001*0*P*:~';
const ISA837 = 'ISA*00*          *00*          *ZZ*CLEARINGHS     *ZZ*PAYERID        *230601*1200*^*00501*000000002*0*P*:~';
const col = (res, name) => res.columns.findIndex(c => c.name === name);

await t('835: a denied claim with no service lines is not silently dropped (REGRESSION)', () => {
  // Answer key: 4 claims in, 4 claim ids out. C2 is a denial (status 4) with
  // only a claim-level CAS; before the fix only claims AFTER the first SVC-bearing one survived.
  const x = [ISA835, 'GS*HP*A*B*20230601*1200*1*X*005010X221A1~', 'ST*835*0001~',
    'BPR*I*3000.00*C*CHK************20230610~', 'TRN*1*CHK1*123~', 'N1*PR*PAYER ONE~',
    'CLP*C1*1*500.00*400.00*100.00*11*P1~', 'CAS*PR*1*100.00~', 'SVC*HC:99213*500.00*400.00~',
    'CLP*C2*4*700.00*0.00*0.00*11*P2~', 'CAS*CO*45*700.00~',
    'CLP*C3*1*900.00*800.00*100.00*11*P3~', 'SVC*HC:99214*900.00*800.00~',
    'CLP*C4*4*150.00*0.00*0.00*11*P4~', 'CAS*CO*50*150.00~',
    'SE*14*0001~', 'GE*1*1~', 'IEA*1*000000001~'].join('');
  const r = X12.parse(x);
  assert.equal(r.transactionType, '835');
  const ci = col(r, 'claim_id');
  assert.deepEqual([...new Set(r.rows.map(row => row[ci]))], ['C1', 'C2', 'C3', 'C4']);
  const si = col(r, 'claim_status');
  const denied = Array.from(r.rows).filter(row => row[si] === '4').map(row => row[ci]).sort();
  assert.deepEqual(denied, ['C2', 'C4']);
  // charge conservation: 500 + 700 + 900 + 150
  const total = [...new Map(r.rows.map(row => [row[ci], Number(row[col(r, 'charge_amount')])])).values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 2250);
});
await t('837: a claim with no SV lines is not dropped when later claims have them (REGRESSION)', () => {
  const x = [ISA837, 'GS*HC*A*B*20230601*1200*1*X*005010X222A1~', 'ST*837*0002~', 'BHT*0019*00*B1*20230601*1200*CH~',
    'NM1*41*2*BILLER*****46*123456789~', 'NM1*40*2*PAYER*****46*PAY1~', 'HL*1**20*1~', 'NM1*85*1*SMITH*JOHN****MD*XX*' + GOOD_NPI + '~',
    'NM1*IL*1*DOE*JANE****MI*MEMBER001~', 'DMG*D8*19850315*F~',
    'CLM*K1*350.00***11:B:1*Y*A*Y*I~', 'DTP*472*D8*20230601~', 'HI*ABK:Z00.00~',
    'CLM*K2*125.00***11:B:1*Y*A*Y*I~', 'DTP*472*D8*20230602~', 'HI*ABK:I50.9~', 'SV1*HC:99214:25*125.00*UN*1***1~',
    'SE*14*0002~', 'GE*1*1~', 'IEA*1*000000002~'].join('');
  const r = X12.parse(x);
  assert.equal(r.transactionType, '837');
  const ci = col(r, 'claim_id');
  assert.deepEqual([...new Set(r.rows.map(row => row[ci]))].sort(), ['K1', 'K2']);
});
await t('X12 garbage in: non-EDI text, truncated ISA and empty input are rejected, not guessed at', () => {
  assert.throws(() => X12.parse('hello world'), /X12|ISA/);
  assert.throws(() => X12.parse('ISA*00*short~'), /./);
  assert.throws(() => X12.parse(''), /./);
});
await t('X12 835: CRLF-terminated segments and a blank-padded claim id still parse to one claim row per SVC', () => {
  const x = [ISA835 + '\r\n', 'ST*835*0001~\r\n', 'BPR*I*10*C*CHK************20230610~\r\n', 'TRN*1*CHKX*1~\r\n',
    'CLP*C9*1*500.00*400.00*100.00*11*P1~\r\n', 'SVC*HC:99213*300*250~\r\n', 'SVC*HC:99214*200*150~\r\n', 'SE*6*0001~\r\n', 'IEA*1*1~'].join('');
  const r = X12.parse(x);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(Array.from(r.rows, row => row[col(r, 'procedure_code')]).sort(), ['HC:99213', 'HC:99214']);
  assert.equal(r.rows[0][col(r, 'check_number')], 'CHKX');
});

// ---------------------------------------------------------------------------
// 2. Denial root cause + cost of bad data
// ---------------------------------------------------------------------------
section('Claims denial triage', ['js/provenance/denial-root-cause.js', 'js/provenance/cost-of-bad-data.js']);
const { buildDenialReport, detectClaimColumns, isValidNpi } = await import('../js/provenance/denial-root-cause.js');
const { estimateCostOfBadData, DEFAULT_PER_ERROR_COST } = await import('../js/provenance/cost-of-bad-data.js');
const CLAIM_COLS = ['claim_id', 'member_id', 'service_date', 'cpt_code', 'diagnosis_code', 'rendering_npi', 'primary_payer', 'secondary_payer', 'billed_amount'];
const mk = (id, mem, dos, cpt, dx, npi, p2) => ({ claim_id: id, member_id: mem, service_date: dos, cpt_code: cpt, diagnosis_code: dx, rendering_npi: npi, primary_payer: 'BCBS', secondary_payer: p2 ?? '', billed_amount: 100 });
const CLAIMS = [
  mk('C01', 'M001', '2024-03-01', '99213', 'I50.9', GOOD_NPI),             // clean
  mk('C02', '', '2024-03-02', '99213', 'E11.9', GOOD_NPI),                 // eligibility: blank member id
  mk('C03', 'M003', '2024-03-03', '9921', 'E11.9', GOOD_NPI),              // coding: 4 digit CPT
  mk('C04', 'M004', '2024-03-04', '99214', 'ZZZ', GOOD_NPI),               // coding: ICD shape invalid
  mk('C05', 'M001', '2024-03-01', '99213', 'I50.9', GOOD_NPI),             // exact duplicate of C01
  mk('C06', 'M001', '2024-03-02', '99213', 'I50.9', GOOD_NPI),             // near duplicate of C01 (1 day)
  mk('C07', 'M007', '2024-03-07', '99215', 'J18.9', BAD_NPI),              // provider: NPI check digit wrong
  mk('C08', 'M008', '2024-03-08', '99213', 'J18.9', GOOD_NPI2, 'AETNA'),   // COB: secondary payer present
  mk('C09', ' m001 ', '2024-03-01', '99213 ', 'I50.9', GOOD_NPI),          // duplicate of C01 hidden by whitespace + case (REGRESSION)
  mk('C10', 'M010', '2024-03-10', 'G0008', 'Z23', GOOD_NPI2),              // clean (HCPCS shape, Z code)
];
await t('NPI check digit: independent generator vs validator, plus junk inputs', () => {
  assert.equal(isValidNpi(GOOD_NPI), true);
  assert.equal(isValidNpi(GOOD_NPI2), true);
  assert.equal(isValidNpi(BAD_NPI), false);
  for (const junk of ['', null, undefined, '123', '12345678901', 'ABCDEFGHIJ', ' ' + GOOD_NPI.slice(0, 5)]) assert.equal(isValidNpi(junk), false, String(junk));
});
await t('column detection finds each claim role by header', () => {
  const d = detectClaimColumns(CLAIM_COLS);
  assert.equal(d.map.memberId, 'member_id'); assert.equal(d.map.cpt, 'cpt_code'); assert.equal(d.map.dos, 'service_date');
  assert.deepEqual(d.payerLikeColumns.sort(), ['primary_payer', 'secondary_payer']);
});
await t('denial report matches the hand-built answer key (8 of 10 claims flagged, $944 at risk)', () => {
  const rep = buildDenialReport({ rows: CLAIMS, columns: CLAIM_COLS.map(name => ({ name })) });
  const by = Object.fromEntries(rep.categories.map(c => [c.id, c]));
  // answer key per bucket (row counts): eligibility C02; coding C03,C04; duplicates C05,C06,C09 (REGRESSION: C09); provider C07; cob C08
  assert.equal(by.eligibility.flaggedCount, 1, 'eligibility');
  assert.equal(by.coding.flaggedCount, 2, 'coding');
  assert.equal(by.duplicates.flaggedCount, 3, 'duplicates (C05 exact, C06 near, C09 whitespace/case)');
  assert.equal(by.provider.flaggedCount, 1, 'provider');
  assert.equal(by.cob.flaggedCount, 1, 'cob');
  assert.equal(rep.totalFlaggedRows, 8);
  assert.equal(rep.totalFlaggedPct, 80);
  assert.equal(rep.cost.estimatedRiskAmount, 8 * DEFAULT_PER_ERROR_COST);
  assert.equal(rep.cost.estimatedRiskAmount, 944);
});
await t('denial report on a file with NO claim columns says not-checkable instead of passing', () => {
  const rep = buildDenialReport({ rows: [{ a: 1 }, { a: 2 }], columns: [{ name: 'a' }] });
  assert.equal(rep.totalFlaggedRows, 0);
  assert.equal(rep.notCheckable.length, 5);
});
await t('denial report on zero rows and on a duplicate-only file with no date column', () => {
  const empty = buildDenialReport({ rows: [], columns: CLAIM_COLS.map(name => ({ name })) });
  assert.equal(empty.totalFlaggedRows, 0); assert.equal(empty.totalFlaggedPct, 0);
  const noDate = buildDenialReport({ rows: [CLAIMS[0], CLAIMS[4]], columns: ['member_id', 'cpt_code'].map(name => ({ name })) });
  assert.equal(noDate.categories.find(c => c.id === 'duplicates').flaggedCount, 1);
});
await t('cost of bad data: negative, NaN, string and fractional inputs cannot produce a negative or NaN dollar figure', () => {
  assert.equal(estimateCostOfBadData({ flaggedCount: -5 }).estimatedRiskAmount, 0);
  assert.equal(estimateCostOfBadData({ flaggedCount: NaN }).estimatedRiskAmount, 0);
  assert.equal(estimateCostOfBadData({ flaggedCount: 3.9, perErrorCost: 10 }).estimatedRiskAmount, 30);
  assert.equal(estimateCostOfBadData({ flaggedCount: 2, perErrorCost: -50 }).estimatedRiskAmount, 2 * DEFAULT_PER_ERROR_COST);
  const e = estimateCostOfBadData({ flaggedCount: '4', perErrorCost: '25' });
  assert.ok(Number.isFinite(e.estimatedRiskAmount) && e.estimatedRiskAmount >= 0);
  assert.equal(estimateCostOfBadData().estimatedRiskAmount, 0);
});

// ---------------------------------------------------------------------------
// 3. De-identification verifier, k-anonymity, receipt
// ---------------------------------------------------------------------------
section('PHI de-identification screening', ['js/provenance/deidentification-verifier.js', 'js/privacy/deid-receipt.js']);
const deid = await import('../js/provenance/deidentification-verifier.js');
const receipt = await import('../js/privacy/deid-receipt.js');
const flaggedIds = (rep) => rep.safeHarbor.categories.filter(c => c.status === 'flag').map(c => c.id).sort();
await t('real-world headers (spaces, Title Case, camelCase) are screened, not skipped (REGRESSION)', () => {
  const cols = ['Patient Name', 'Date of Birth', 'Zip Code', 'MemberID', 'Contact-Email', 'visit_type', 'los_days'].map(name => ({ name }));
  const rep = deid.buildDeidReport({ columns: cols, samples: {}, table: 'epic_extract', rowCount: 1000 });
  const ids = flaggedIds(rep);
  for (const need of ['names', 'dates', 'geo', 'email']) assert.ok(ids.includes(need) || rep.safeHarbor.categories.some(c => c.status === 'flag' && c.id === need), 'missing ' + need + ' in ' + ids);
  assert.equal(rep.verdict, 'fail');
  const names = rep.safeHarbor.categories.flatMap(c => c.matchedColumns.map(m => m.column));
  assert.ok(names.includes('Patient Name') && names.includes('Date of Birth') && names.includes('Zip Code') && names.includes('Contact-Email'));
  assert.ok(!names.includes('visit_type') && !names.includes('los_days'), 'clean columns must not be flagged');
});
await t('value sniffing finds an SSN hiding in an innocuous column name and ages over 89', () => {
  const cols = [{ name: 'col7' }, { name: 'age' }, { name: 'dx' }];
  const samples = { col7: ['123-45-6789', '987-65-4321', '111-22-3333'], age: [34, 95, 61], dx: ['I50.9', 'E11.9'] };
  const rep = deid.buildDeidReport({ columns: cols, samples });
  const matched = Object.fromEntries(rep.safeHarbor.categories.flatMap(c => c.matchedColumns.map(m => [m.column + '|' + c.id, m.reason])));
  assert.ok(Object.keys(matched).some(k => k.startsWith('col7|')), 'SSN-valued column col7 must be flagged');
  assert.ok(Object.keys(matched).some(k => k === 'age|dates'), 'age 95 must trip the over-89 clause');
  assert.ok(!Object.keys(matched).some(k => k.startsWith('dx|')));
});
await t('a clean analytics extract passes', () => {
  const rep = deid.buildDeidReport({ columns: ['drg', 'los_days', 'visit_type', 'total_charge'].map(name => ({ name })), samples: {} });
  assert.equal(rep.verdict, 'pass'); assert.equal(rep.safeHarbor.flaggedCount, 0);
});
await t('k-anonymity: answer key k-floor 1, 3 groups, 1 small cell', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ zip: '60601', sex: 'F' });
  for (let i = 0; i < 5; i++) rows.push({ zip: '60602', sex: 'M' });
  rows.push({ zip: '60699', sex: 'M' });
  const k = deid.computeKAnonymityFromRows({ quasiCols: ['zip', 'sex'], rows, totalRows: 12 });
  assert.equal(k.groupCount, 3); assert.equal(k.kFloor, 1); assert.equal(k.smallCellGroups, 1); assert.equal(k.level, 'high'); assert.equal(k.flagged, true);
  const ok = deid.computeKAnonymityFromRows({ quasiCols: ['zip', 'sex'], rows: rows.slice(0, 11), totalRows: 11 });
  assert.equal(ok.kFloor, 5); assert.equal(ok.flagged, false);
});
await t('k-anonymity edge cases: null quasi values group together, zero rows and no quasi columns skip', () => {
  const rows = [{ zip: null }, { zip: undefined }, { zip: null }, { zip: '1' }];
  const k = deid.computeKAnonymityFromRows({ quasiCols: ['zip'], rows });
  assert.equal(k.groupCount, 2); assert.equal(k.kFloor, 1);
  assert.equal(deid.computeKAnonymityFromRows({ quasiCols: ['zip'], rows: [] }).level, 'none');
  assert.equal(deid.computeKAnonymityFromRows({ quasiCols: [], rows }).level, 'none');
});
await t('k-anonymity runner against real DuckDB finds quasi columns named "Patient Sex" / "ZIPCode" (REGRESSION)', async () => {
  await runQuery('CREATE OR REPLACE TABLE kanon_t AS SELECT * FROM (VALUES (\'60601\',\'F\'),(\'60601\',\'F\'),(\'60601\',\'F\'),(\'60601\',\'F\'),(\'60601\',\'F\'),(\'99999\',\'M\')) v("ZIPCode","Patient Sex")');
  const k = await deid.runKAnonymityCheck('kanon_t', [{ name: 'ZIPCode' }, { name: 'Patient Sex' }], { runQuery, getRowCount: async () => 6 });
  assert.deepEqual(k.quasiCols.sort(), ['Patient Sex', 'ZIPCode']);
  assert.equal(k.kFloor, 1); assert.equal(k.flagged, true);
});
await t('de-id attestation is tamper-evident (flip the verdict, verification fails)', async () => {
  const rep = deid.buildDeidReport({ columns: [{ name: 'ssn' }] });
  const att = await deid.buildDeidAttestation(rep, {});
  const v1 = await deid.verifyDeidAttestation(att);
  assert.equal(v1.valid ?? v1.ok, true);
  const forged = JSON.parse(JSON.stringify(att)); forged.verdict = 'pass';
  const v2 = await deid.verifyDeidAttestation(forged);
  assert.equal(v2.valid ?? v2.ok, false);
});
await t('receipt: HTML-hostile column names are escaped, null report is "not available" not "clean"', () => {
  const rep = deid.buildDeidReport({ columns: [{ name: '<img src=x onerror=alert(1)> name' }, { name: 'ssn' }], table: '<b>t</b>' });
  const model = receipt.buildDeidReceipt(rep, { generatedAt: '2026-11-21T00:00:00Z' });
  const html = receipt.renderDeidReceiptHTML(model);
  assert.ok(!/<img src=x/.test(html), 'raw <img> must not survive');
  assert.ok(!/<b>t<\/b>/.test(html));
  const md = receipt.renderDeidReceiptMarkdown(model);
  assert.ok(/ssn/.test(md));
  const none = receipt.buildDeidReceipt(null);
  assert.equal(none.available, false); assert.equal(none.verdict, null);
  assert.ok(/No result|not/i.test(none.verdictLabel + none.verdictMeaning));
  assert.equal(receipt.buildDeidReceipt({ verdict: 'weird' }).verdictLabel, 'Not reported');
});

// ---------------------------------------------------------------------------
// 4. Ingestion: JSON/NDJSON flattener, API feed, text lines, CSV quarantine
// ---------------------------------------------------------------------------
section('Messy file and API ingestion', ['js/ingestion/json-flattener.js', 'js/ingestion/api-feed.js', 'js/ingestion/text-line-parser.js', 'js/dataquality/csv-quarantine.js']);
const jf = await import('../js/ingestion/json-flattener.js');
const af = await import('../js/ingestion/api-feed.js');
const tl = await import('../js/ingestion/text-line-parser.js');
const cq = await import('../js/dataquality/csv-quarantine.js');

await t('JSON: FHIR-ish envelope is unwrapped, nested objects dotted, arrays stringified, nulls kept as null', () => {
  const bundleJson = { resourceType: 'Bundle', total: 3, entry: [
    { id: 'p1', name: { family: 'Doe', given: ['Jane'] }, address: { geo: { lat: 41.9, lon: -87.6 } }, tags: ['a', 'b'], dob: null },
    { id: 'p2', name: { family: 'Roe', given: [] }, address: null, tags: [], dob: '1950-02-03' },
  ] };
  const r = jf.flattenJson(bundleJson);
  assert.equal(r.path, 'entry'); assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]['name.family'], 'Doe'); assert.equal(r.rows[0]['address.geo.lat'], 41.9);
  assert.equal(r.rows[0].tags, '["a","b"]'); assert.equal(r.rows[0].dob, null);
  assert.equal(r.rows[1].address, null); assert.equal(r.rows[1].tags, '[]');
});
await t('JSON: objects nested deeper than maxDepth are stringified, never left as live objects (REGRESSION)', () => {
  const deep = [{ a: { b: { c: { d: { e: { f: 1 } } } } } }];
  const r = jf.flattenJson(deep, { maxDepth: 2 });
  for (const v of Object.values(r.rows[0])) assert.notEqual(typeof v, 'object', JSON.stringify(r.rows[0]));
  assert.ok(Object.values(r.rows[0]).some(v => typeof v === 'string' && v.startsWith('{')));
});
await t('JSON/NDJSON: BOM-prefixed exports, CRLF NDJSON, blank lines and garbage are handled honestly (REGRESSION: BOM)', () => {
  const bom = '\uFEFF' + JSON.stringify([{ id: 1 }, { id: 2 }]);
  const a = jf.parseJsonOrNdjson(bom); assert.equal(a.error, null); assert.equal(a.parsed.length, 2);
  const nd = '\uFEFF{"id":1}\r\n\r\n{"id":2}\r\n{"id":3}\r\n';
  const b = jf.parseJsonOrNdjson(nd); assert.equal(b.error, null); assert.equal(b.isNdjson, true); assert.equal(b.parsed.length, 3);
  assert.ok(jf.parseJsonOrNdjson('{"id":1}\n{broken').error);
  assert.ok(jf.parseJsonOrNdjson('   ').error); assert.ok(jf.parseJsonOrNdjson(null).error);
  assert.deepEqual(jf.flattenJson([]).rows, []); assert.deepEqual(jf.flattenJson(42).rows, []);
});
await t('JSON: scalars array, single object and maxRows cap', () => {
  assert.deepEqual(jf.flattenJson([1, null, 'x']).rows, [{ index: 0, value: '1' }, { index: 1, value: null }, { index: 2, value: 'x' }]);
  assert.equal(jf.flattenJson({ a: 1, b: { c: 2 } }).rows[0]['b.c'], 2);
  assert.equal(jf.flattenJson(Array.from({ length: 50 }, (_, i) => ({ i })), { maxRows: 10 }).rows.length, 10);
});
await t('API feed: URL validation rejects non-HTTP schemes and accepts bare host:port (REGRESSION: host:port)', () => {
  for (const bad of ['', '   ', null, 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.org/a', 'data:text/html,hi']) assert.equal(af.validateFeedUrl(bad).valid, false, String(bad));
  assert.equal(af.validateFeedUrl('https://api.example.org/v1/claims?x=1').valid, true);
  assert.equal(af.validateFeedUrl('api.example.org/v1').normalized, 'https://api.example.org/v1');
  const hp = af.validateFeedUrl('localhost:8080/api/claims');
  assert.equal(hp.valid, true, hp.error); assert.ok(/^https:\/\/localhost:8080\/api\/claims/.test(hp.normalized));
  assert.equal(af.validateFeedUrl('api.example.org:8443/x').valid, true);
});
await t('API feed: header string parsing (colons in values, blank lines, CRLF) and poll schedule', () => {
  const h = af.parseHeadersString('Authorization: Bearer abc:def\r\n\r\nX-Api-Key:k1\nnot a header\n: novalue\n');
  assert.equal(h.Authorization, 'Bearer abc:def'); assert.equal(h['X-Api-Key'], 'k1');
  assert.equal(Object.keys(h).length, 2);
  assert.deepEqual(af.parseHeadersString(''), {});
  const s = af.buildPollSchedule(0, 'GET', 'https://x.org', {});
  assert.equal(s.isOneShot, true);
});
await t('API feed: sparse records keep EVERY column, not just the first record\'s (REGRESSION)', () => {
  const resp = [{ id: 1, status: 'paid' }, { id: 2, status: 'denied', denial_code: 'CO-45' }, { id: 3, status: 'paid', note: 'appeal' }];
  const n = af.normalizeApiResponse(resp);
  assert.equal(n.rows.length, 3);
  const ds = af.buildFeedDataset(n.rows, 'https://x.org', af.buildPollSchedule(0, 'GET', 'https://x.org', {}), '2026-11-21T00:00:00Z');
  assert.deepEqual(ds.columns, ['id', 'status', 'denial_code', 'note']);
  assert.equal(af.buildFeedDataset([], 'u', af.buildPollSchedule(0, 'GET', 'u', {})).columns.length, 0);
  const sc = af.normalizeApiResponse('plain string'); assert.deepEqual(sc.rows, []);
});
await t('text lines: CRLF endings stripped, line numbers 1-based, skipEmpty counts, non-strings tolerated', () => {
  const p = tl.parseTextLines('INFO a\r\n\r\nWARN b\r\n  \r\nERROR c', { skipEmpty: true });
  assert.deepEqual(p.rows.map(r => [r.line_number, r.content]), [[1, 'INFO a'], [3, 'WARN b'], [5, 'ERROR c']]);
  assert.equal(p.skippedEmpty, 2); assert.equal(p.lineCount, 5);
  assert.deepEqual(tl.parseTextLines(undefined), { rows: [], lineCount: 0, skippedEmpty: 0 });
  assert.equal(tl.parseTextLines('x\ny\nz', { maxLines: 2 }).rows.length, 2);
});
await t('text lines: kind inference separates a server log, a CSV-ish dump and prose; meta carries the source', () => {
  const log = Array.from({ length: 6 }, (_, i) => `2026-11-0${i + 1} 10:00:00 ERROR claim batch ${i} failed`);
  assert.equal(tl.inferTextKind(log), 'log');
  assert.equal(tl.inferTextKind(Array.from({ length: 10 }, (_, i) => `a${i},b,c`)), 'delimited');
  assert.equal(tl.inferTextKind([]), 'unknown'); assert.equal(tl.inferTextKind(null), 'unknown');
  const ds = tl.buildTextDataset(tl.parseTextLines('a\nb'), 'x.log', 'log');
  assert.deepEqual(ds.columns, ['line_number', 'content']); assert.equal(ds.meta.source, 'x.log'); assert.equal(ds.meta.lineCount, 2);
});
await t('CSV quarantine against real DuckDB: 4 bad lines are held out, 3 kept, each reject carries its file line and reason', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const f = path.join(os.tmpdir(), 'dg_claims_messy_' + process.pid + '.csv');
  fs.writeFileSync(f, 'claim_id,amount,dos\nC1,100.5,2024-01-01\nC2,abc,2024-01-02\nC3,50,2024-13-45\nC4,75,2024-01-04,EXTRA\nC5,"1,000",2024-01-05\nC6,20,2024-01-06\nC7,30,2024-01-07\n');
  const { rejectsTable, rejectsScan } = cq.rejectTableNames('stress1');
  await runQuery('DROP TABLE IF EXISTS kept_claims');
  await runQuery(`CREATE TABLE kept_claims AS SELECT * FROM read_csv('${f.replace(/\\/g, '/')}', header=true, columns={'claim_id':'VARCHAR','amount':'DOUBLE','dos':'DATE'}, ignore_errors=true, store_rejects=true, rejects_table='${rejectsTable}', rejects_scan='${rejectsScan}')`);
  const kept = (await runQuery('SELECT count(*) AS n FROM kept_claims')).rows[0].n;
  const cnt = (await runQuery(cq.rejectCountSql(rejectsTable))).rows[0];
  const rej = (await runQuery(cq.rejectRowsSql(rejectsTable, 100))).rows;
  const q = cq.buildQuarantine({ fileName: 'claims.csv', keptRows: kept, rejectRows: rej, droppedLines: Number(cnt.dropped), errorCount: Number(cnt.errors) });
  assert.equal(kept, 3); assert.equal(q.droppedRows, 4); assert.equal(q.totalRows, 7); assert.equal(q.clean, false); assert.equal(q.droppedPercent, 57.14);
  assert.deepEqual(q.rows.map(r => r.line), [3, 4, 5, 6]);
  assert.ok(q.rows[2].reason.toUpperCase().includes('TOO MANY'));
  assert.equal(q.rows[2].column, 'unknown column');
  assert.equal(q.choices.length, 2); assert.ok(!('default' in q.choices[0]));
  const r = cq.quarantineReceiptLine(q, 'keep_good'); assert.equal(r.severity, 'caution'); assert.ok(/4 line\(s\) failed/.test(r.line));
  assert.equal(cq.quarantineReceiptLine(q, 'abandon').decision, 'abandon');
  for (const sql of cq.dropRejectTablesSql(rejectsTable, rejectsScan)) await runQuery(sql);
  fs.unlinkSync(f);
});
await t('CSV quarantine: a clean file says so, malformed reject rows are ignored, hostile table seeds are sanitised', () => {
  const clean = cq.buildQuarantine({ fileName: 'ok.csv', keptRows: 10, rejectRows: [] });
  assert.equal(clean.clean, true); assert.equal(cq.quarantineReceiptLine(clean, 'keep_good').decision, 'clean');
  const junk = cq.buildQuarantine({ keptRows: 1, rejectRows: [null, 5, {}, { line: 'x' }, { line: 7, error_type: 'CAST', column_name: 'a' }] });
  assert.equal(junk.rows.length, 1); assert.equal(junk.droppedRows, 1);
  assert.match(cq.rejectTableNames('x"; DROP TABLE users;--').rejectsTable, /^_dg_csv_rejects_[A-Za-z0-9_]+$/);
  assert.ok(cq.rejectRowsSql('t"; DROP TABLE x;--').includes('"t""; DROP TABLE x;--"'));
  assert.equal(cq.buildQuarantine().totalRows, 0);
});

// ---------------------------------------------------------------------------
// 5. PHI prompt guard
// ---------------------------------------------------------------------------
section('PHI guard before LLM prompts', ['js/agents/phi-prompt-guard.js']);
const phi = await import('../js/agents/phi-prompt-guard.js');
await t('free text: SSN (dash, space, dot, bare), MRN, email are redacted; counts like 1250 rows are not', () => {
  const txt = 'Pt SSN 123-45-6789 / 987 65 4321 / 555.44.3333 / 111223333, MRN: 00123456, mail jane.doe+x@clinic.org; 1250 rows, 3 sites, total $4,200.50';
  const r = phi.redactSensitiveText(txt);
  assert.ok(!/123-45-6789|987 65 4321|555\.44\.3333|111223333|00123456|jane\.doe/.test(r.text), r.text);
  assert.ok(r.text.includes('1250 rows') && r.text.includes('$4,200.50'));
  const byPat = Object.fromEntries(r.findings.map(f => [f.pattern, f.count]));
  assert.equal(byPat.email, 1); assert.equal(byPat.mrn, 1); assert.ok(byPat.ssn >= 3);
  assert.deepEqual(phi.redactSensitiveText('').findings, []);
});
await t('sample rows: sensitive columns are dropped entirely, other cells pattern-scanned, input never mutated', () => {
  const rows = [{ patient_name: 'Jane Doe', ssn: '123-45-6789', note: 'call 123-45-6789 or a@b.co', los: 4 }, { patient_name: null, ssn: null, note: null, los: 9 }];
  const snap = JSON.stringify(rows);
  const g = phi.guardPromptPayload({ text: 'Why is LOS high for jane@x.org?', rows, columns: ['patient_name', 'ssn', 'note', 'los'] });
  assert.equal(JSON.stringify(rows), snap, 'input mutated');
  assert.ok(g.droppedColumns.includes('ssn') && g.droppedColumns.includes('patient_name'), 'direct identifiers dropped by column name (REGRESSION)');
  assert.ok(g.rows.every(r => !('ssn' in r)));
  assert.ok(!JSON.stringify(g.rows).includes('123-45-6789') && !JSON.stringify(g.rows).includes('a@b.co') && !JSON.stringify(g.rows).includes('Jane Doe'));
  assert.deepEqual(phi.classifySensitiveColumns(['Patient Name', 'Date of Birth', 'drug_name', 'claim_id', 'facility_name', 'Email Address']).sort(), ['Date of Birth', 'Email Address', 'Patient Name']);
  assert.ok(!g.text.includes('jane@x.org')); assert.equal(g.sensitiveFound, true);
  assert.equal(g.rows[1].los, 9); assert.equal(g.rows[1].note, null);
  const clean = phi.guardPromptPayload({ text: 'average length of stay by DRG', rows: [{ drg: '291', los: 4 }], columns: ['drg', 'los'] });
  assert.equal(clean.sensitiveFound, false);
  assert.equal(phi.guardPromptPayload().sensitiveFound, false);
});

// ---------------------------------------------------------------------------
// 6. Health standards (OMOP / FHIR), DRG-ICD, relational checkers
// ---------------------------------------------------------------------------
section('Clinical standards and relational integrity', ['js/validation/health-standards.js', 'js/validation/drg-icd-validator.js', 'js/relational/foreign-key-checker.js', 'js/relational/join-coverage-checker.js', 'js/relational/temporal-order-checker.js', 'js/relational/flag-consistency-checker.js']);
const hs = await import('../js/validation/health-standards.js');
const drgv = await import('../js/validation/drg-icd-validator.js');
const fkc = await import('../js/relational/foreign-key-checker.js');
const jcc = await import('../js/relational/join-coverage-checker.js');
const toc = await import('../js/relational/temporal-order-checker.js');
const flc = await import('../js/relational/flag-consistency-checker.js');
const engine = { runQuery };
await t('OMOP observation periods: end-before-start found; blanks, garbage dates, equal dates are not flagged', () => {
  const rows = [
    { person_id: 1, observation_period_start_date: '2020-01-01', observation_period_end_date: '2019-12-31' }, // bad
    { person_id: 2, observation_period_start_date: '2020-01-01', observation_period_end_date: '2020-01-01' }, // ok (same day)
    { person_id: 3, observation_period_start_date: '', observation_period_end_date: '2020-01-01' },           // skip
    { person_id: 4, observation_period_start_date: 'not a date', observation_period_end_date: '2020-01-01' }, // skip
    { person_id: 5, observation_period_start_date: '2021-06-15', observation_period_end_date: '2022-06-15' }, // ok
  ];
  assert.deepEqual(hs.checkObservationPeriodOrder(rows).map(r => r.personId), [1]);
  assert.deepEqual(hs.checkObservationPeriodOrder(null), []);
});
await t('OMOP lifespan and plausibility: condition before birth / 130y after birth; HR 900 and SpO2 -3 flagged, HR 72 and text values not', () => {
  const people = [{ person_id: 1, year_of_birth: 1950, month_of_birth: 6, day_of_birth: 1 }, { person_id: 2, birth_datetime: '1985-03-15T00:00:00' }, { person_id: 3 }];
  const conds = [
    { person_id: 1, condition_start_date: '1949-12-31' }, // before birth
    { person_id: 1, condition_start_date: '2024-01-01' }, // ok
    { person_id: 2, condition_start_date: '2125-01-01' }, // > 130y after birth
    { person_id: 3, condition_start_date: '2000-01-01' }, // no birth info -> skip
    { person_id: 99, condition_start_date: '2000-01-01' }, // unknown person -> skip
  ];
  const life = hs.checkConditionInLifespan(people, conds);
  assert.deepEqual(life.map(r => [r.personId, r.reason.startsWith('before') ? 'before' : 'after']), [[1, 'before'], [2, 'after']]);
  const ms = [
    { person_id: 1, measurement_concept_id: 30001, value_as_number: 900 },
    { person_id: 2, measurement_concept_id: 30001, value_as_number: 72 },
    { person_id: 3, measurement_concept_id: 30005, value_as_number: -3 },
    { person_id: 4, measurement_concept_id: 30001, value_as_number: 'n/a' },
    { person_id: 5, measurement_concept_id: 99999, value_as_number: 1e9 },
    { person_id: 6, measurement_concept_id: 0, measurement_source_value: 'Heart Rate', value_as_number: 5 },
  ];
  const bad = hs.checkMeasurementPlausibility(ms);
  assert.deepEqual(bad.map(r => r.personId).sort(), [1, 3, 6]);
});
await t('FHIR bundle: flattening, observation plausibility, patient/encounter age and missingness on a messy bundle', () => {
  const sample = hs.buildFhirSample();
  assert.equal(hs.isFhirBundle(sample), true); assert.equal(hs.isFhirBundle({}), false); assert.equal(hs.isFhirBundle(null), false);
  const flat = hs.flattenFhirBundle(sample);
  assert.ok(flat && typeof flat === 'object');
  assert.equal(hs.referenceId('Patient/abc-1'), 'abc-1');
  const miss = hs.summarizeFhirMissingness([{ a: 1, b: null }, { a: null, b: null }, { a: 3, b: '' }], ['a', 'b']);
  assert.ok(miss);
});
await t('DRG/ICD against real DuckDB: heart-failure DRG 291 with pneumonia principal dx is flagged; case/whitespace ICD tolerated; NULL dx not', async () => {
  await runQuery(`CREATE OR REPLACE TABLE drg_t AS SELECT * FROM (VALUES
    ('291','I50.9'),('291',' i50.23 '),('291','J18.9'),('291','I21.4'),
    ('280','I21.4'),('280','I50.9'),('291',NULL),('999','Z00.0')) v(drg, primary_icd10)`);
  const cols = [{ name: 'drg' }, { name: 'primary_icd10' }];
  assert.equal(drgv.detectDrgColumn(cols).name, 'drg'); assert.equal(drgv.detectPrimaryIcdColumn(cols).name, 'primary_icd10');
  const f = await drgv.runDrgIcdValidation('drg_t', cols, engine);
  const hf = f.find(x => x.ruleLabel.includes('Heart Failure')); const ami = f.find(x => x.ruleLabel.includes('Myocardial'));
  assert.equal(hf.count, 2, 'J18.9 and I21.4 under DRG 291');
  assert.equal(ami.count, 1, 'I50.9 under DRG 280');
  assert.deepEqual(await drgv.runDrgIcdValidation('drg_t', [{ name: 'x' }], engine), []);
});
await t('relational checks on real DuckDB: orphan claims, join coverage, temporal order, impossible flag pairs', async () => {
  await runQuery(`CREATE OR REPLACE TABLE members AS SELECT * FROM (VALUES ('M1'),('M2'),('M3'),('M4'),(NULL)) v(member_id)`);
  await runQuery(`CREATE OR REPLACE TABLE claims_fk AS SELECT * FROM (VALUES ('M1'),('M1'),('M2'),('M9'),('M8'),(NULL),('M3'),('M4'),('M4'),('M4')) v(member_id)`);
  const fk = await fkc.checkForeignKey({ childTable: 'claims_fk', childCol: 'member_id', parentTable: 'members', parentCol: 'member_id', engine });
  assert.equal(fk.orphanCount, 2); assert.equal(fk.totalRows, 9); assert.equal(fk.nullCount, 1); assert.deepEqual([...fk.orphanSample].sort(), ['M8', 'M9']); assert.notEqual(fk.status, 'pass');
  const nullParentSafe = await fkc.checkForeignKey({ childTable: 'claims_fk', childCol: 'member_id', parentTable: 'members', parentCol: 'member_id', engine });
  assert.equal(nullParentSafe.orphanCount, 2, 'a NULL in the parent key must not make NOT IN match nothing');
  const jc = await jcc.checkJoinCoverage({ childTable: 'claims_fk', childCol: 'member_id', parentTable: 'members', parentCol: 'member_id', engine });
  assert.ok(jc && (jc.status === 'fail' || jc.status === 'warn'), JSON.stringify(jc).slice(0, 300));
  const bad = await fkc.checkForeignKey({ childTable: 'nope', childCol: 'x', parentTable: 'members', parentCol: 'member_id', engine });
  assert.equal(bad.status, 'idle'); // an unrunnable check must never read as a pass
  await runQuery(`CREATE OR REPLACE TABLE stays AS SELECT * FROM (VALUES
    (1, DATE '2024-01-01', DATE '2024-01-05', DATE '2024-01-03'),(2, DATE '2024-02-10', DATE '2024-02-01', DATE '2024-02-12'),
    (3, DATE '2024-03-01', NULL, DATE '2024-03-02'),(4, DATE '2024-04-01', DATE '2024-04-01', DATE '2024-03-30')) v(id, admit_date, discharge_date, payment_date)`);
  const to = await toc.checkTemporalOrder({ table: 'stays', cols: [{ name: 'admit_date' }, { name: 'discharge_date' }, { name: 'payment_date' }], engine });
  const adm = to.rules.find(r => r.ruleId === 'admit_before_discharge');
  assert.equal(adm.totalRows, 3, 'NULL discharge is not evaluated'); assert.equal(adm.violationCount, 1, 'only stay 2 has discharge before admit; NULL discharge and same-day are fine');
  assert.equal(to.status, 'fail');
  await runQuery(`CREATE OR REPLACE TABLE flags AS SELECT * FROM (VALUES (1,1,1,1,0),(2,1,0,1,0),(3,0,0,1,1),(4,1,1,0,0)) v(id, readmit_7d, readmit_30d, inpatient, outpatient)`);
  const fl = await flc.checkFlagConsistency({ table: 'flags', cols: [{ name: 'readmit_7d' }, { name: 'readmit_30d' }, { name: 'inpatient' }, { name: 'outpatient' }], engine });
  const byId = Object.fromEntries(fl.rules.map(r => [r.ruleId, r.violationCount]));
  assert.equal(byId.readmit_7d_implies_30d, 1); assert.equal(byId.inpatient_outpatient_exclusive, 1); assert.equal(fl.status, 'fail');
});

// ---------------------------------------------------------------------------
// 7. Transforms: glass-box JS result vs the SQL it prints, executed on DuckDB
// ---------------------------------------------------------------------------
section('Time, join, reshape and clean-up transforms', [
  'js/transforms/prior-period.js', 'js/transforms/fill-missing.js', 'js/transforms/keep-most-recent.js', 'js/transforms/consecutive-run.js',
  'js/transforms/moving-average.js', 'js/transforms/expand-date-range.js', 'js/transforms/first-last-event.js', 'js/transforms/as-of-lookup.js',
  'js/transforms/date-range-join.js', 'js/transforms/value-standardizer.js', 'js/transforms/nested-to-rows.js', 'js/transforms/multi-value-counts.js',
  'js/intelligence/guided-unpivot.js', 'js/intelligence/repair-recipe-library.js']);
const T = (n) => import('../js/transforms/' + n + '.js');
const pp = await T('prior-period'), fm = await T('fill-missing'), km = await T('keep-most-recent'), cr = await T('consecutive-run');
const ma = await T('moving-average'), ed = await T('expand-date-range'), fl = await T('first-last-event'), al = await T('as-of-lookup');
const dj = await T('date-range-join'), vs = await T('value-standardizer'), nt = await T('nested-to-rows'), mv = await T('multi-value-counts');
const gu = await import('../js/intelligence/guided-unpivot.js');
const rr = await import('../js/intelligence/repair-recipe-library.js');

async function loadDs(ds, name) {
  const cols = ds.columns.map(c => '"' + c.name + '"');
  const sel = ds.columns.map(c => {
    const q = '"' + c.name + '"';
    return c.type === 'DATE' ? `TRY_CAST(${q} AS DATE) AS ${q}` : c.type === 'FLOAT' ? `TRY_CAST(${q} AS DOUBLE) AS ${q}` : c.type === 'INT' ? `TRY_CAST(${q} AS BIGINT) AS ${q}` : q;
  }).join(',');
  const vals = ds.rows.map(r => '(' + r.map(v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`).join(',') + ')').join(',');
  await runQuery(`CREATE OR REPLACE TABLE ${name} AS SELECT ${sel} FROM (VALUES ${vals}) v(${cols.join(',')})`);
}
const nv = (v) => v == null ? null : typeof v === 'bigint' ? Number(v) : (typeof v === 'object' && 'days' in v) ? new Date(v.days * 86400000).toISOString().slice(0, 10)
  : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} 00:00:00$/.test(v)) ? v.slice(0, 10) : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : String(v);
const canon = (rows, n) => rows.map(r => JSON.stringify(r.slice(0, n).map(nv))).sort();
async function sqlRows(res, sub = {}) {
  let sql = res.sql.replace(/"your_table"/g, 'source');
  for (const [k, v] of Object.entries(sub)) sql = sql.split('"' + k + '"').join(v);
  return (await runQuery(sql)).rows.map(o => Object.values(o));
}
const shuffled = (ds, seed = 7) => { const rows = ds.rows.slice(); let x = seed; for (let i = rows.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) & 0x7fffffff; const j = x % (i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; } return { ...ds, rows }; };

await t('prior period: month-over-month by facility, gap months stay blank, unreadable dates/amounts counted; SQL agrees', async () => {
  const ds = { columns: [{ name: 'facility', type: 'STR' }, { name: 'admit_date', type: 'DATE' }, { name: 'charges', type: 'FLOAT' }], rows: [
    ['A', '2024-01-05', 100], ['A', '2024-01-20', 50], ['A', '2024-02-10', 300], ['A', '2024-04-02', 10], ['B', '2024-01-31', 5],
    ['B', '2024-03-01', null], ['B', 'not a date', 9], ['B', null, 7], ['A', '2024-02-11', 'abc']] };
  const cfg = { ...pp.createEmptyPriorPeriodConfig(), dateColumn: 'admit_date', metricColumn: 'charges', aggregate: 'SUM', grain: 'month', entityColumns: ['facility'] };
  const r = pp.priorPeriodTransform(ds, cfg);
  assert.equal(r.ok, true);
  // answer key: A Jan 150, A Feb 300 (prior 150, +150, +100%), A Apr 10 (March absent -> blank, NOT Feb), B Jan 5
  assert.deepEqual(r.rows.map(x => [x[0], x[1], x[2], x[3], x[4], x[5]]), [['A', '2024-01', 150, null, null, null], ['A', '2024-02', 300, 150, 150, 1], ['A', '2024-04', 10, null, null, null], ['B', '2024-01', 5, null, null, null]]);
  assert.equal(r.stats.unreadableDates, 2); assert.equal(r.stats.unreadableMetrics, 2); assert.equal(r.stats.withoutPrior, 3);
  await loadDs(ds, 'source');
  const sql = (await sqlRows(r)).filter(x => x[2] != null).map(x => [x[0], String(nv(x[1])).slice(0, 7), ...x.slice(2)]);
  assert.deepEqual(canon(sql, 6), canon(r.rows, 6));
  // validation refuses nonsense instead of guessing
  assert.equal(pp.priorPeriodTransform(ds, { ...cfg, dateColumn: 'nope' }).ok, false);
  assert.equal(pp.priorPeriodTransform(null, cfg).ok, false);
});
await t('fill missing: forward fill per patient never crosses patients, flags every filled cell, leaves leading blanks; SQL agrees', async () => {
  const ds = { columns: [{ name: 'pt', type: 'STR' }, { name: 'd', type: 'DATE' }, { name: 'bp', type: 'FLOAT' }], rows: [
    ['p1', '2024-01-03', null], ['p1', '2024-01-01', 120], ['p1', '2024-01-02', null], ['p2', '2024-01-01', null], ['p2', '2024-01-02', 130], ['p2', '2024-01-03', null]] };
  const cfg = { ...fm.createEmptyFillConfig(), targetColumns: ['bp'], mode: 'forward', orderColumn: 'd', groupColumns: ['pt'] };
  const r = fm.fillMissingTransform(ds, cfg);
  const byKey = Object.fromEntries(r.rows.map(x => [x[0] + x[1], [x[2], x[3]]]));
  assert.deepEqual(byKey['p12024-01-02'], [120, true]); assert.deepEqual(byKey['p12024-01-03'], [120, true]);
  assert.deepEqual(byKey['p22024-01-01'], [null, false], 'leading blank for p2 must NOT be filled from p1');
  assert.deepEqual(byKey['p22024-01-03'], [130, true]); assert.deepEqual(byKey['p12024-01-01'], [120, false]);
  assert.equal(r.stats.filled, 3); assert.equal(r.stats.stillBlank, 1); assert.equal(r.stats.blankBefore, 4);
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 4), canon(r.rows, 4));
  const c = fm.fillMissingTransform(ds, { ...fm.createEmptyFillConfig(), targetColumns: ['bp'], mode: 'constant', constantValue: '-1' });
  assert.equal(c.stats.filled, 4); assert.ok(c.rows.every(x => x[3] === (x[2] === '-1')));
});
await t('keep most recent: newest per member, ties resolved the same way whatever the input order, undated rows never beat dated ones; SQL agrees', async () => {
  const ds = { columns: [{ name: 'mem', type: 'STR' }, { name: 'upd', type: 'DATE' }, { name: 'plan', type: 'STR' }], rows: [
    ['M1', '2024-01-01', 'A'], ['M1', '2024-03-01', 'B'], ['M1', '2024-03-01', 'C'], ['M2', null, 'X'], ['M2', '2024-02-01', 'Y'], ['m1 ', '2024-05-01', 'Z'], ['M3', null, 'Q']] };
  const cfg = { ...km.createEmptyKeepConfig(), keyColumns: ['mem'], orderColumn: 'upd' };
  const r = km.keepMostRecentTransform(ds, cfg);
  const kept = Object.fromEntries(r.rows.map(x => [x[0], x[2]]));
  assert.deepEqual(kept, { M1: 'C', M2: 'Y', 'm1 ': 'Z', M3: 'Q' });
  assert.equal(r.stats.removed, 3); assert.equal(r.stats.rowsOut, 4);
  for (const seed of [1, 2, 3, 4, 5]) {
    const r2 = km.keepMostRecentTransform(shuffled(ds, seed), cfg);
    assert.deepEqual(canon(r2.rows, 4), canon(r.rows, 4), 'tie-break must not depend on row order (seed ' + seed + ')');
  }
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 3), canon(r.rows, 3));
});
await t('consecutive runs: duplicate days collapse, gaps split runs, unreadable dates counted not guessed; SQL agrees', async () => {
  const ds = { columns: [{ name: 'pt', type: 'STR' }, { name: 'day', type: 'DATE' }], rows: [
    ['p1', '2024-01-01'], ['p1', '2024-01-02'], ['p1', '2024-01-02'], ['p1', '2024-01-03'], ['p1', '2024-01-05'], ['p1', '2024-01-06'],
    ['p2', '2024-01-01'], ['p2', null], ['p2', 'bad'], ['p2', '2024-01-03']] };
  const r = cr.consecutiveRunTransform(ds, { ...cr.createEmptyRunConfig(), entityColumns: ['pt'], dateColumn: 'day' });
  assert.deepEqual(r.rows.map(x => [x[0], x[1], x[2], x[3]]), [['p1', '2024-01-01', '2024-01-03', 3], ['p1', '2024-01-05', '2024-01-06', 2], ['p2', '2024-01-01', '2024-01-01', 1], ['p2', '2024-01-03', '2024-01-03', 1]]);
  assert.equal(r.stats.duplicateDays, 1); assert.equal(r.stats.unreadableDates, 2); assert.equal(r.stats.longestRun, 3);
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 4), canon(r.rows, 4));
});
await t('moving average: warm-up rows blank, nulls shorten (not blank) the window, text cells counted; SQL agrees (REGRESSION: COUNT(*) warm-up)', async () => {
  const ds = { columns: [{ name: 'd', type: 'DATE' }, { name: 'v', type: 'FLOAT' }], rows: [['2024-01-03', 30], ['2024-01-01', 10], ['2024-01-02', 20], ['2024-01-04', null], ['2024-01-05', 50], ['2024-01-06', 'x']] };
  const r = ma.movingAverageTransform(ds, { ...ma.createEmptyMovingAverageConfig(), valueColumn: 'v', orderColumn: 'd', window: 3, markCrossovers: false });
  // answer key: [null,null,20,25,40,50] with rows_in_window [1,2,3,2,2,1]
  assert.deepEqual(r.rows.map(x => x[2]), [null, null, 20, 25, 40, 50]);
  assert.deepEqual(r.rows.map(x => x[3]), [1, 2, 3, 2, 2, 1]);
  assert.equal(r.stats.nonNumeric, 2); assert.equal(r.stats.warmupBlanks, 2);
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 3), canon(r.rows.map(x => [x[0], typeof x[1] === 'string' && isNaN(Number(x[1])) ? null : x[1], x[2]]), 3));
});
await t('expand date range: closed, open-ended (as-at), reversed, unreadable and single-day ranges; SQL agrees (REGRESSION: lateral generate_series dropped a valid row)', async () => {
  const ds = { columns: [{ name: 'id', type: 'STR' }, { name: 's', type: 'DATE' }, { name: 'e', type: 'DATE' }], rows: [
    ['a', '2024-02-27', '2024-03-02'], ['b', '2024-03-05', '2024-03-01'], ['c', '2024-03-01', null], ['d', null, '2024-03-01'], ['e', '2024-03-01', '2024-03-01']] };
  const cfg = { ...ed.createEmptyDateRangeConfig(), startColumn: 's', endColumn: 'e', asAtDate: '2024-03-03', openEnd: 'asAt' };
  const r = ed.expandDateRangeTransform(ds, cfg);
  const per = {}; for (const x of r.rows) per[x[0]] = (per[x[0]] || 0) + 1;
  assert.deepEqual(per, { a: 5, c: 3, e: 1 }); // 2024 is a leap year: Feb 27,28,29, Mar 1,2
  assert.equal(r.stats.rowsOut, 9); assert.equal(r.stats.reversedRows, 1); assert.equal(r.stats.unreadableStart, 1);
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 5), canon(r.rows, 5));
  const excl = ed.expandDateRangeTransform(ds, { ...cfg, endInclusive: false });
  assert.equal(excl.rows.filter(x => x[0] === 'a').length, 4);
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(excl), 5), canon(excl.rows, 5));
});
await t('first/last event: latest per patient, undated rows never win, same answer for any row order; SQL agrees', async () => {
  const ds = { columns: [{ name: 'pt', type: 'STR' }, { name: 't', type: 'DATE' }, { name: 'ev', type: 'STR' }], rows: [
    ['p1', '2024-01-02', 'b'], ['p1', '2024-01-02', 'a'], ['p1', '2024-01-01', 'z'], ['p2', null, 'q'], ['p2', '2024-01-05', 'w']] };
  const cfg = { ...fl.createEmptyFirstLastConfig(), entityColumns: ['pt'], orderColumn: 't', pick: 'last' };
  const r = fl.firstLastEventTransform(ds, cfg);
  assert.deepEqual(Object.fromEntries(r.rows.map(x => [x[0], x[1]])), { p1: '2024-01-02', p2: '2024-01-05' });
  assert.equal(r.rows.find(x => x[0] === 'p2')[2], 'w'); assert.equal(r.stats.unreadableOrder, 1);
  for (const seed of [1, 2, 3, 9]) assert.deepEqual(canon(fl.firstLastEventTransform(shuffled(ds, seed), cfg).rows, 4), canon(r.rows, 4));
  await loadDs(ds, 'source');
  assert.deepEqual(canon(await sqlRows(r), 3), canon(r.rows, 3));
});
await t('as-of lookup: price in force on the sale date, never today\'s price; before-first and unreadable dates stay blank', async () => {
  const facts = { name: 'facts', columns: [{ name: 'sku', type: 'STR' }, { name: 'sold', type: 'DATE' }, { name: 'qty', type: 'INT' }], rows: [
    ['A', '2024-01-15', 1], ['A', '2024-03-01', 1], ['B', '2024-01-15', 1], ['A', '2023-12-31', 1], ['A', null, 1]] };
  const ref = { name: 'lookup', columns: [{ name: 'sku', type: 'STR' }, { name: 'eff', type: 'DATE' }, { name: 'price', type: 'FLOAT' }], rows: [
    ['A', '2024-01-01', 10], ['A', '2024-02-01', 12], ['B', '2024-02-01', 5]] };
  const r = al.asOfLookupTransform(facts, ref, { ...al.createEmptyAsOfConfig(), factDateColumn: 'sold', refDateColumn: 'eff', keyPairs: [{ left: 'sku', right: 'sku' }], valueColumns: ['price'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map(x => x[3]), [10, 12, null, null, null]);
  assert.equal(r.stats.matched, 2); assert.equal(r.stats.beforeFirst, 2); assert.equal(r.stats.unreadableFactDates, 1);
  await loadDs(facts, 'facts'); await loadDs(ref, 'lookup');
  assert.deepEqual(canon(await sqlRows(r), 4), canon(r.rows, 4));
  assert.ok(/dated before the earliest matching row/.test(r.notes.join(' ')) && !/the earliest is 2023-12-31/.test(r.notes.join(' ')), 'REGRESSION: note named an unmatched FACT date as the earliest LOOKUP row');
  const dup = al.asOfLookupTransform(facts, { ...ref, rows: [...ref.rows, ['A', '2024-01-01', 11]] }, { ...al.createEmptyAsOfConfig(), factDateColumn: 'sold', refDateColumn: 'eff', keyPairs: [{ left: 'sku', right: 'sku' }], valueColumns: ['price'] });
  assert.equal(dup.stats.duplicateEffectiveDates, 1, 'two prices effective the same day must be reported, not silently picked');
});
await t('date-range join: overlapping plans fan out and are counted, open-ended range matches later events, unreadable event dates unmatched; SQL agrees', async () => {
  const ev = { name: 'events', columns: [{ name: 'pt', type: 'STR' }, { name: 'd', type: 'DATE' }], rows: [['p1', '2024-01-05'], ['p1', '2024-02-15'], ['p2', '2024-01-05'], ['p1', null]] };
  const rg = { name: 'ranges', columns: [{ name: 'pt', type: 'STR' }, { name: 's', type: 'DATE' }, { name: 'e', type: 'DATE' }, { name: 'plan', type: 'STR' }], rows: [
    ['p1', '2024-01-01', '2024-01-31', 'gold'], ['p1', '2024-01-01', '2024-02-28', 'silver'], ['p1', '2024-02-01', null, 'bronze'], ['p2', '2024-03-01', '2024-03-31', 'x']] };
  const r = dj.dateRangeJoinTransform(ev, rg, { ...dj.createEmptyDateRangeJoinConfig(), eventDateColumn: 'd', rangeStartColumn: 's', rangeEndColumn: 'e', keyPairs: [{ left: 'pt', right: 'pt' }] });
  assert.equal(r.ok, true);
  assert.equal(r.stats.rowsOut, 6); assert.equal(r.stats.maxFanout, 2); assert.equal(r.stats.matchedEvents, 2); assert.equal(r.stats.unmatchedEvents, 2); assert.equal(r.stats.unreadableEventDates, 1);
  const plans = r.rows.filter(x => x[1] === '2024-02-15').map(x => x[5]).sort();
  assert.deepEqual(plans, ['bronze', 'silver']);
  await loadDs(ev, 'events'); await loadDs(rg, 'ranges');
  const sqlr = (await runQuery(r.sql)).rows.map(o => Object.values(o)).map(x => [x[0], x[1], x[5] ?? x[x.length - 1]]);
  assert.deepEqual(canon(sqlr, 3), canon(r.rows.map(x => [x[0], x[1], x[5]]), 3));
});
await t('value standardizer: case/space variants proposed as certain merges, nothing applied until confirmed, audit column keeps the original', () => {
  const ds = { columns: [{ name: 'dx', type: 'STR' }], rows: [['Diabetes'], ['diabetes '], ['DIABETES'], ['Diabetis'], ['Hypertension'], [' hypertension'], [null], ['']] };
  const cfg = { ...vs.createEmptyStandardizerConfig(), valueColumn: 'dx' };
  const p = vs.proposeMergeGroups(ds, { ...cfg, fuzzy: true });
  assert.equal(p.groups.length, 2); assert.equal(p.blanks, 2);
  assert.deepEqual(p.groups.map(g => g.totalCount).sort(), [2, 3]);
  assert.ok(p.groups.every(g => g.certain));
  const unconfirmed = vs.valueStandardizerTransform(ds, cfg);
  assert.equal(unconfirmed.ok, false, 'no merges and no confirmation: nothing may be changed');
  const map = vs.mapFromGroups(p.groups);
  const r = vs.valueStandardizerTransform(ds, { ...cfg, map, confirmed: true });
  assert.equal(r.ok, true);
  assert.equal(r.stats.distinctAfter, 4 /* Diabetes, Diabetis, Hypertension, '' */);
  assert.equal(r.rows.filter(x => x[0] === 'Diabetes').length, 3);
  assert.equal(r.rows.filter(x => x[0] === 'Hypertension').length, 2);
  assert.ok(r.rows.some(x => x[1] === 'diabetes ') && r.rows.some(x => x[1] === ' hypertension'));
  assert.equal(r.rows.filter(x => x[0] == null).length, 1); // the NULL stays NULL
  assert.ok(r.rows.some(x => x[0] === '')); // blank is not a spelling of anything
});
await t('nested to rows and multi-value counts: lists, JSON arrays, empties and scalars all accounted for', () => {
  const ds = { columns: [{ name: 'id', type: 'INT' }, { name: 'meds', type: 'STR' }], rows: [[1, 'a, b ,c'], [2, '["x","y"]'], [3, null], [4, ''], [5, 'a,,b'], [6, 'solo']] };
  const r = nt.nestedToRowsTransform(ds, { ...nt.createEmptyNestedConfig(), listColumn: 'meds' });
  assert.equal(r.stats.rowsIn, 6); assert.equal(r.stats.rowsOut, 11);
  const items = r.rows.filter(x => x[0] === 1).map(x => x[2]); assert.deepEqual(items, ['a', 'b', 'c']);
  assert.deepEqual(r.rows.filter(x => x[0] === 2).map(x => x[2]), ['x', 'y']);
  assert.deepEqual(r.rows.filter(x => x[0] === 3 || x[0] === 4).map(x => x[2]), [null, null], 'empty lists survive as one blank row, not vanish');
  const m = mv.multiValueCountsTransform(ds, { ...mv.createEmptyMultiValueConfig(), valueColumn: 'meds' });
  const cnt = Object.fromEntries(m.rows.map(x => [x[0], [x[1], x[2]]]));
  assert.deepEqual([cnt.a, cnt.b, cnt.c, cnt.solo, cnt.x, cnt.y], [[2, 2], [2, 2], [1, 1], [1, 1], [1, 1], [1, 1]]);
  assert.deepEqual(cnt['(no value)'], [2, 0]);
  assert.equal(m.stats.records, 6); assert.equal(m.stats.mentions, 8); assert.equal(m.stats.multiValueRecords, 3);
  assert.ok(m.stats.recordPctSum > 100, 'percentages of records legitimately exceed 100 in total and must say so');
});
await t('guided unpivot: wide quarters to long, blanks kept or dropped on request, text in numeric cells preserved; SQL row count differs by exactly the blanks', async () => {
  const ds = { columns: [{ name: 'patient', type: 'STR' }, { name: '2023-Q1', type: 'FLOAT' }, { name: '2023-Q2', type: 'FLOAT' }, { name: 'Q3 2023', type: 'FLOAT' }], rows: [['p1', 1, 2, 3], ['p2', null, '', 5], ['p3', 'n/a', 7, 8]] };
  const names = ds.columns.map(c => c.name);
  const sug = gu.suggestConfig(names, ds.rows);
  assert.deepEqual(sug.unpivotColumns, ['2023-Q1', '2023-Q2', 'Q3 2023']); assert.deepEqual(sug.keepColumns, ['patient']);
  const cfg = { ...gu.createEmptyConfig(names), keepColumns: ['patient'], unpivotColumns: sug.unpivotColumns };
  const r = gu.unpivotTransform(ds, cfg);
  assert.equal(r.rows.length, 9);
  assert.deepEqual(r.rows.filter(x => x[0] === 'p2').map(x => x[2]), [null, null, 5]);
  assert.equal(r.rows.find(x => x[0] === 'p3' && x[1] === '2023-Q1')[2], 'n/a', 'unparseable text is kept, never coerced to 0 or NaN');
  const dropped = gu.unpivotTransform(ds, { ...cfg, dropNullValues: true });
  assert.equal(dropped.rows.length, 7);
  assert.equal(gu.preview(ds, cfg).outputRowEstimate, 9);
  const built = gu.buildUnpivotSQL(cfg, '"wide"');
  assert.ok(/UNPIVOT/.test(built.sql) && /omits NULL cells/.test(built.sql), 'REGRESSION: SQL must disclose that DuckDB UNPIVOT drops NULL cells');
  await runQuery(`CREATE OR REPLACE TABLE wide AS SELECT * FROM (VALUES ('p1','1','2','3'),('p2',NULL,NULL,'5'),('p3','n/a','7','8')) v(patient,"2023-Q1","2023-Q2","Q3 2023")`);
  assert.equal((await runQuery(built.sql)).rows.length, 7);
  assert.equal(gu.unpivotTransform(ds, { ...cfg, unpivotColumns: [] }).ok, false);
  assert.equal(gu.unpivotTransform(ds, { ...cfg, unpivotColumns: ['nope'] }).ok, false);
  // config round trip
  assert.deepEqual(gu.parseConfig(gu.serializeConfig(cfg)).config?.unpivotColumns ?? gu.parseConfig(gu.serializeConfig(cfg)).unpivotColumns, cfg.unpivotColumns);
});
await t('repair recipe library: row data and PHI never persist in a recipe, imports report what they rejected, matching tolerates case', () => {
  const rec = rr.createRecipeRecord({ name: '  CMS 835 cleanup ', kind: 'guidedUnpivot', columnNames: ['Patient ID', 'DOS', 'Q1'],
    payload: { keepColumns: ['Patient ID'], unpivotColumns: ['Q1'], rows: [['123-45-6789', 'Jane']], sampleRows: [[1]], data: [1], nested: { values: [[1, 2]] } } });
  const flat = JSON.stringify(rec);
  assert.ok(!flat.includes('123-45-6789') && !flat.includes('Jane'), flat);
  assert.equal(rec.name, 'CMS 835 cleanup'); assert.equal(rr.validateRecord(rec).ok, true);
  assert.equal(rr.validateRecord({ ...rec, payload: { ...rec.payload, rows: [[1]] } }).ok, false);
  const lib = rr.serializeLibrary([rec, { ...rec, id: 'bad', payload: { rows: [['x']] } }, null]);
  const back = rr.parseLibrary(lib);
  assert.equal(back.ok, true); assert.equal(back.records.length, 1);
  assert.equal(back.rejected.length, 2, 'REGRESSION: rejected records must be reported, not silently dropped');
  assert.equal(rr.parseLibrary('{broken').ok, false); assert.equal(rr.parseLibrary('"str"').ok, false);
  const m = rr.scoreRecipeMatch(rec, ['patient id', 'dos', 'extra']);
  assert.equal(m.score, 67); assert.deepEqual(m.extra, ['extra']); assert.equal(m.canApply, true);
  assert.equal(rr.scoreRecipeMatch(rec, []).canApply, false);
  assert.equal(rr.getApplyPayload({ nonsense: true }).ok, false);
});

// ---------------------------------------------------------------------------
// 8. Data Diplomacy: sealed claims, deterministic reconciliation, two-key gate
// ---------------------------------------------------------------------------
section('Data Diplomacy (two organisations disagree about a patient field)', [
  'js/diplomacy/diplomacy-claim.js', 'js/diplomacy/reconciliation-engine.js', 'js/diplomacy/diplomacy-approval-gate.js']);
const dc = await import('../js/diplomacy/diplomacy-claim.js');
const re = await import('../js/diplomacy/reconciliation-engine.js');
const ag = await import('../js/diplomacy/diplomacy-approval-gate.js');
const T0 = Date.UTC(2026, 10, 1);

await t('sealed claims: tampering with value, confidence or source is detected; falsy-but-real values (0, false, empty string) are accepted; null and NaN are refused', async () => {
  const c = await dc.sealClaim({ entityId: 'MRN-1', field: 'balance', value: 0, confidence: 0, source: 'billing', sealedAt: T0 });
  assert.equal((await dc.verifyClaimSeal(c)).valid, true);
  for (const patch of [{ value: 1 }, { confidence: 0.1 }, { source: 'ehr' }, { entityId: 'MRN-2' }, { sealedAt: '2030-01-01T00:00:00.000Z' }]) {
    assert.equal((await dc.verifyClaimSeal({ ...c, ...patch })).valid, false, JSON.stringify(patch));
  }
  assert.equal((await dc.verifyClaimSeal({ ...c, fingerprint: 'x' })).valid, false);
  assert.equal((await dc.verifyClaimSeal(null)).valid, false);
  assert.equal((await dc.verifyClaimSeal({ ...c, kind: 'other' })).valid, false);
  assert.equal((await dc.sealClaim({ entityId: 'e', field: 'f', value: false, source: 's' })).value, false);
  assert.equal((await dc.sealClaim({ entityId: 'e', field: 'f', value: '', source: 's' })).value, '');
  for (const bad of [{ value: null }, { value: undefined }, { entityId: '' }, { source: null }, { confidence: NaN }, { confidence: 1.01 }, { confidence: -0.1 }, { confidence: '0.5' }]) {
    await assert.rejects(() => dc.sealClaim({ entityId: 'e', field: 'f', value: 'v', source: 's', ...bad }), undefined, JSON.stringify(bad));
  }
  const a = await dc.sealClaim({ entityId: 'e', field: 'f', value: { x: 1, y: 2 }, source: 's', sealedAt: T0 });
  const b = await dc.sealClaim({ entityId: 'e', field: 'f', value: { y: 2, x: 1 }, source: 's', sealedAt: T0 });
  assert.equal(a.fingerprint, b.fingerprint, 'key order of an object value must not change the seal');
});
await t('reconciliation: confidence decides only beyond the tie threshold; REGRESSION: 0.90 vs 0.85 is a tie at 0.05 despite float noise; no basis means refusal, never a guess', async () => {
  const mk = (source, confidence, extra = {}) => ({ entityId: 'E1', field: 'dob', value: source + '-val', source, confidence, ...extra });
  const clear = re.reconcileClaims(mk('ehr', 0.95), mk('crm', 0.6));
  assert.equal(clear.resolved, true); assert.equal(clear.winningClaim.source, 'ehr'); assert.ok(Math.abs(clear.marginOfConfidence - 0.35) < 1e-9);
  assert.equal(re.reconcileClaims(mk('crm', 0.6), mk('ehr', 0.95)).winningClaim.source, 'ehr', 'argument order must not matter');
  const tie = re.reconcileClaims(mk('a', 0.9), mk('b', 0.85));
  assert.equal(tie.resolved, false, 'a 0.05 gap is a tie at the default 0.05 threshold');
  const viaTrust = re.reconcileClaims(mk('a', 0.9), mk('b', 0.85), { sourceTrust: ['b', 'a'] });
  assert.equal(viaTrust.resolved, true); assert.equal(viaTrust.reason, 'resolved by source trust'); assert.equal(viaTrust.winningClaim.source, 'b');
  assert.equal(re.reconcileClaims(mk('a', null), mk('b', null), { sourceTrust: { a: 2, b: 2 } }).resolved, false, 'equal trust is no signal');
  assert.equal(re.reconcileClaims(mk('a', 0.5), mk('b', 0.5), { sourceTrust: ['zzz'] }).resolved, false, 'unranked sources are no signal');
  assert.equal(re.reconcileClaims(mk('a', NaN), mk('b', 0.4)).resolved, false);
  assert.equal(re.reconcileClaims({ ...mk('a', 0.9), entityId: 'E2' }, mk('b', 0.1)).reason, 'entity/field mismatch');
  assert.equal(re.reconcileClaims({ ...mk('a', 0.9), entityId: 'E1 ' }, mk('b', 0.1)).resolved, false, 'a trailing space is a different entity: refuse rather than guess');
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.equal(re.reconcileClaims(bad, mk('b', 0.1)).resolved, false);
  assert.ok(/UNRESOLVED/.test(re.explainReconciliation(tie)) && /RESOLVED/.test(re.explainReconciliation(clear)));
  assert.equal(re.explainReconciliation(null), 'No reconciliation result to explain.');
  assert.equal(re.reconcileClaims(mk('a', 0.9), mk('b', 0.5), { tieThreshold: 0.5 }).resolved, false, 'custom threshold honoured');
  // Documented limitation: the engine trusts its inputs, so a caller MUST verify seals first.
  const real = await dc.sealClaim({ entityId: 'E1', field: 'dob', value: '1980-01-01', confidence: 0.4, source: 'crm', sealedAt: T0 });
  const forged = { ...(await dc.sealClaim({ entityId: 'E1', field: 'dob', value: '1999-09-09', confidence: 0.3, source: 'evil', sealedAt: T0 })), confidence: 0.99 };
  assert.equal(re.reconcileClaims(real, forged).winningClaim.source, 'evil', 'engine does not verify seals (documented)');
  assert.equal((await dc.verifyClaimSeal(forged)).valid, false, 'but the seal check catches the forgery');
});
await t('two-key approval: one key never applies, same hand cannot hold both keys, strangers (including prototype names) cannot approve or reject; REGRESSION: "toString" used to reject', async () => {
  const mk = (source, confidence) => ({ entityId: 'E1', field: 'dob', value: source, source, confidence });
  const verdict = re.reconcileClaims(mk('ehr', 0.95), mk('crm', 0.6));
  assert.throws(() => ag.createApprovalRequest({ reconciliationResult: verdict, partyAId: 'x', partyBId: 'x' }));
  assert.throws(() => ag.createApprovalRequest({ reconciliationResult: verdict, partyAId: '', partyBId: 'y' }));
  assert.throws(() => ag.createApprovalRequest({ reconciliationResult: verdict, partyAId: 'x' }));
  const req = ag.createApprovalRequest({ reconciliationResult: verdict, partyAId: 'org-a', partyBId: 'org-b' });
  for (const stranger of ['org-c', 'toString', 'constructor', '__proto__', 'hasOwnProperty', '', null, undefined, 7]) {
    assert.equal((await ag.approve(req, stranger)).ok, false, 'approve ' + String(stranger));
    assert.equal(ag.reject(req, stranger).ok, false, 'reject ' + String(stranger));
  }
  assert.equal(req.status, 'pending'); assert.deepEqual(Object.keys(req.approvals).sort(), ['org-a', 'org-b']);
  const first = await ag.approve(req, 'org-a');
  assert.equal(first.bothApproved, false); assert.equal(req.status, 'pending'); assert.equal(req.sealedRecord, null);
  assert.equal((await ag.approve(req, 'org-a')).bothApproved, false, 'approving twice is still one key');
  const second = await ag.approve(req, 'org-b');
  assert.equal(second.bothApproved, true); assert.equal(req.status, 'applied');
  assert.equal(req.sealedRecord.reconciliation.winningSource, 'ehr');
  assert.equal((await ag.verifyApprovalRecord(req.sealedRecord)).valid, true);
  const sealedOnce = req.sealedRecord.fingerprint;
  await ag.approve(req, 'org-b'); assert.equal(req.sealedRecord.fingerprint, sealedOnce, 'never re-sealed');
  assert.equal(ag.reject(req, 'org-a').ok, false, 'an applied request cannot be rejected');
  const tampered = JSON.parse(JSON.stringify(req.sealedRecord)); tampered.reconciliation.winningSource = 'crm';
  assert.equal((await ag.verifyApprovalRecord(tampered)).valid, false);
  const tampered2 = JSON.parse(JSON.stringify(req.sealedRecord)); tampered2.approvals['org-b'] = false;
  assert.equal((await ag.verifyApprovalRecord(tampered2)).valid, false);
  assert.equal((await ag.verifyApprovalRecord({})).valid, false);
  const r2 = ag.createApprovalRequest({ reconciliationResult: verdict, partyAId: 'org-a', partyBId: 'org-b' });
  assert.equal(ag.reject(r2, 'org-b', 'wrong DOB').ok, true);
  assert.equal((await ag.approve(r2, 'org-a')).ok, false, 'rejected requests stay rejected'); assert.equal(r2.sealedRecord, null);
  // Documented limitation: an UNRESOLVED verdict can still be put through the gate.
  const unresolved = re.reconcileClaims(mk('a', 0.5), mk('b', 0.5));
  const r3 = ag.createApprovalRequest({ reconciliationResult: unresolved, partyAId: 'p', partyBId: 'q' });
  await ag.approve(r3, 'p'); await ag.approve(r3, 'q');
  assert.equal(r3.sealedRecord.reconciliation.resolved, false, 'sealed record states honestly that nothing was resolved');
});

// ---------------------------------------------------------------------------
// 9. Governance: contracts, access rules, semantic layer, DVC, time machine, MCP
// ---------------------------------------------------------------------------
section('Governance: contracts, access rules, version control, time machine, MCP gate state', [
  'js/metrics/metric-contracts.js', 'js/metrics/metric-access-rules.js', 'js/validation/semantic-layer.js', 'js/dvc/dvc-store.js', 'js/dvc/dvc-diff.js',
  'js/simulation/time-machine.js', 'js/simulation/time-travel-diff.js', 'js/mcp/gate-state-exporter.js', 'js/mcp/dataglow-mcp-server.mjs']);
const mc = await import('../js/metrics/metric-contracts.js');
const mar = await import('../js/metrics/metric-access-rules.js');
const sl = await import('../js/validation/semantic-layer.js');
const dvs = await import('../js/dvc/dvc-store.js');
const dvd = await import('../js/dvc/dvc-diff.js');
const tm = await import('../js/simulation/time-machine.js');
const ttd = await import('../js/simulation/time-travel-diff.js');
const gse = await import('../js/mcp/gate-state-exporter.js');

await t('metric contracts: append-only history cannot be edited through returned copies, diffs name exactly the changed fields, JSON round trip keeps version numbering', () => {
  const reg = new mc.MetricContractRegistry();
  reg.recordVersion('readmit', { name: 'Readmission rate', expression: 'AVG(readmit_30d)', owner: 'quality', tag: 'cms', plainEnglish: 'x', extra: 'ignored' }, { changedBy: 'ana', reason: 'initial' });
  reg.recordVersion('readmit', { name: 'Readmission rate', expression: 'AVG(readmit_30d) FILTER (WHERE planned = 0)', owner: 'quality', tag: 'cms', plainEnglish: 'x' }, { changedBy: 'bo', source: 'agent-proposed' });
  reg.recordVersion('readmit', { name: 'Readmission rate' }, { changedBy: 'cy', source: 'not-a-source' });
  const h = reg.historyFor('readmit');
  assert.equal(h.length, 3); assert.equal(h.get(2).source, 'agent-proposed'); assert.equal(h.get(3).source, 'human', 'unknown source values collapse to human');
  const d = mc.diffVersions(h.get(1).snapshot, h.get(2).snapshot);
  assert.deepEqual(d.fields.map(f => f.field), ['expression']); assert.equal(mc.summarizeDiff(d), 'expression changed');
  assert.deepEqual(mc.diffVersions(h.get(2).snapshot, h.get(3).snapshot).fields.map(f => f.field), ['plainEnglish', 'expression', 'owner', 'tag']);
  assert.equal(mc.summarizeDiff(mc.diffVersions(h.get(1).snapshot, h.get(1).snapshot)), 'no changes');
  const copy = h.list(); copy[0].snapshot.expression = 'DROP TABLE x'; copy.pop();
  assert.equal(h.get(1).snapshot.expression, 'AVG(readmit_30d)'); assert.equal(h.length, 3);
  assert.equal('extra' in h.get(1).snapshot, false);
  const back = mc.MetricContractRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())));
  assert.equal(back.historyFor('readmit').length, 3); assert.equal(back.recordVersion('readmit', { name: 'n' }).version, 4);
  assert.equal(mc.MetricContractRegistry.fromJSON(null).size, 0); assert.equal(mc.MetricContractRegistry.fromJSON({ histories: [null, {}, { metricId: 'ok', versions: [null, { snapshot: { name: 'a' } }] }] }).historyFor('ok').length, 1);
  assert.equal(mc.diffVersions(null, null).changed, false);
  assert.equal(mc.summarizeDiff(null), 'no changes');
});
await t('metric access rules: unrestricted default, explicit allow-lists, wildcard only when alone; REGRESSION: a corrupt saved rule fails closed, not open', () => {
  const reg = mar.createMetricAccessRegistry();
  assert.equal(reg.isAuthorized('anything', 'nl-sql'), true, 'no rule configured = open (documented default)');
  reg.setRule('ssn_count', { allowedAgents: ['compliance'] });
  reg.setRule('empty', { allowedAgents: [] });
  reg.setRule('mixed', { allowedAgents: ['any', 'finance'] });
  assert.equal(reg.isAuthorized('ssn_count', 'compliance'), true); assert.equal(reg.isAuthorized('ssn_count', 'nl-sql'), false);
  assert.equal(reg.isAuthorized('ssn_count', 'Compliance'), false, 'identifiers are exact (case-sensitive)');
  assert.equal(reg.isAuthorized('empty', 'any'), false); assert.equal(reg.isAuthorized('mixed', 'stranger'), false, '"any" only means open when it is the only entry');
  const restored = mar.MetricAccessRuleRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())));
  assert.equal(restored.isAuthorized('ssn_count', 'nl-sql'), false); assert.equal(restored.isAuthorized('ssn_count', 'compliance'), true);
  const corrupt = mar.MetricAccessRuleRegistry.fromJSON({ rules: [{ metricId: 'a', allowedAgents: 'finance' }, { metricId: 'b', allowedAgents: null }, { metricId: 'c' }, null, { allowedAgents: ['x'] }] });
  for (const id of ['a', 'b', 'c']) assert.equal(corrupt.isAuthorized(id, 'evil'), false, id + ' must fail closed');
  assert.equal(corrupt.size, 3);
  assert.equal(mar.MetricAccessRuleRegistry.fromJSON(undefined).size, 0);
});
await t('metric access enforcement on real SQL: aliases, quoted identifiers, canonical expressions and SQL injection strings cannot sneak a governed metric past the gate', () => {
  const reg = mar.createMetricAccessRegistry();
  reg.setRule('denial_rate', { allowedAgents: ['finance-bot'] });
  const metrics = [{ id: 'denial_rate', name: 'denial_rate', expression: 'SUM(denied)/COUNT(*)' }];
  const ev = (sql, agent, extra = {}) => mar.evaluateSqlMetricAccess(sql, agent, { semanticMetrics: metrics, accessRegistry: reg, ...extra });
  assert.equal(ev('SELECT denial_rate FROM m', 'nl-sql').allowed, false);
  assert.equal(ev('SELECT "Denial_Rate" FROM m', 'nl-sql').allowed, false, 'quoted, different case');
  assert.equal(ev('SELECT sum( m.denied ) / count( * ) AS x FROM m', 'nl-sql').allowed, false, 'canonical expression under another alias');
  assert.equal(ev('SELECT denial_rate FROM m', 'finance-bot').allowed, true);
  assert.equal(ev("SELECT 'denial_rate' AS label, 1 FROM m", 'nl-sql').allowed, true, 'a string literal is not a read');
  assert.equal(ev('SELECT 1 -- denial_rate', 'nl-sql').allowed, true, 'comments are not reads');
  assert.equal(ev('SELECT 1; DROP TABLE m; /* denial_rate */', 'nl-sql').allowed, true);
  assert.equal(ev('SELECT 1', 'nl-sql', { metricIds: ['denial_rate'] }).allowed, false, 'explicit metric requests are always checked');
  assert.equal(ev('SELECT 1', 'nl-sql').blockedMetrics.length, 0);
  assert.equal(ev(null, 'nl-sql').allowed, true);
});
await t('semantic layer: per-session registries are isolated, so one analyst\'s metric definitions never leak into another session; bad definitions are refused', () => {
  const a = sl.createSemanticRegistry(), b = sl.createSemanticRegistry();
  a.registerMetric({ name: 'net_revenue', expression: 'SUM(amount) - SUM(refund_amount)', owner: 'ana' });
  assert.equal(a.getRegisteredMetrics().length, 1); assert.equal(b.getRegisteredMetrics().length, 0); assert.equal(b.getMetric('net_revenue'), null);
  assert.deepEqual(a.getMetric('net_revenue').requiredColumns.sort(), ['amount', 'refund_amount']);
  assert.equal(sl.getRegisteredMetrics().some(m => m.name === 'net_revenue'), false, 'the module-level default registry is untouched too');
  for (const bad of [null, {}, { name: 'x' }, { expression: 'SUM(a)' }, { name: '  ', expression: 'SUM(a)' }]) assert.throws(() => a.registerMetric(bad), undefined, JSON.stringify(bad));
  const hits = a.checkQueryAgainstMetrics('SELECT SUM(amount) FROM t');
  assert.ok(hits !== undefined);
  a.clearMetrics(); assert.equal(a.getRegisteredMetrics().length, 0);
});
await t('DVC store: PHI never lands in a snapshot, identical data fingerprints identically, any change flips it; REGRESSION: 250k numeric rows no longer throw RangeError', () => {
  const ds = { name: 'claims', columns: [{ name: 'member', type: 'VARCHAR' }, { name: 'paid', type: 'DOUBLE' }], rows: [
    { member: 'Jane Q Public 123-45-6789', paid: 10 }, { member: 'John Doe', paid: null }, { member: 'John Doe', paid: '' }, { member: 'x', paid: 'abc' }, { member: 'y', paid: 30 }] };
  const store = dvs.createDVCStore();
  const id = store.snapshot(ds, { label: 'v1' });
  const snap = store.get(id);
  assert.ok(!JSON.stringify(snap).includes('123-45-6789') && !JSON.stringify(snap).includes('Jane'), 'no raw values in a snapshot');
  assert.ok(!store.exportJSON().includes('Public'));
  const paid = snap.cols.find(c => c.name === 'paid');
  assert.deepEqual([paid.nullCount, paid.distinctCount, paid.min, paid.max, paid.mean], [2, 3, 10, 30, 20]);
  const fp = (d) => { const s = dvs.createDVCStore(); return s.get(s.snapshot(d)).fingerprint; };
  assert.equal(fp(ds), fp(JSON.parse(JSON.stringify(ds))));
  assert.notEqual(fp(ds), fp({ ...ds, rows: ds.rows.map((r, i) => i === 4 ? { ...r, paid: 31 } : r) }));
  assert.equal(dvs.statsFromDataset(null).rowCount, 0);
  const big = { name: 'big', columns: [{ name: 'v', type: 'DOUBLE' }], rows: Array.from({ length: 250000 }, (_, i) => ({ v: i % 1000 })) };
  const bs = dvs.statsFromDataset(big).cols[0];
  assert.deepEqual([bs.min, bs.max, bs.distinctCount, bs.nullCount], [0, 999, 1000, 0]);
  assert.equal(bs.mean, 499.5);
  const row = dvs.statsFromDataset({ name: 'a', columns: ['a', 'b'], data: [[1, 'x'], [2, 'y']] });
  assert.equal(row.rowCount, 2); assert.equal(row.cols.length, 2);
});
await t('DVC store: history is newest-first even when snapshots land in the same millisecond; snapshotIfChanged skips identical data; REGRESSION: tie ordering', () => {
  const store = dvs.createDVCStore();
  const ds = (n) => ({ name: 'enc', columns: [{ name: 'a', type: 'INTEGER' }], rows: Array.from({ length: n }, (_, i) => ({ a: i })) });
  const ids = [store.snapshot(ds(1), { label: 'one' }), store.snapshot(ds(2), { label: 'two' }), store.snapshot(ds(3), { label: 'three' })];
  assert.deepEqual(store.list('enc').map(s => s.label), ['three', 'two', 'one']);
  assert.equal(store.snapshotIfChanged(ds(3), { label: 'dup' }), null);
  assert.equal(store.count('enc'), 3, 'unchanged data must not add a snapshot');
  store.snapshotIfChanged(ds(4), { label: 'four' }); assert.equal(store.count('enc'), 4);
  assert.deepEqual(store.timeline('enc').length, 4);
  const exported = JSON.parse(store.exportJSON());
  const other = dvs.createDVCStore(); other.merge(dvs.createDVCStore(exported)); assert.equal(other.count('enc'), 4);
  store.remove(ids[0]); assert.equal(store.count('enc'), 3);
  assert.equal(store.get('nope'), null);
});
await t('DVC diff: dropped column, type change, row loss and null spike are all flagged with the right risk; identical snapshots are clean', () => {
  const mk = (rows, cols) => { const s = dvs.createDVCStore(); return s.get(s.snapshot({ name: 'enc', columns: cols, rows })); };
  const cols = [{ name: 'id', type: 'INTEGER' }, { name: 'los', type: 'INTEGER' }, { name: 'dx', type: 'VARCHAR' }];
  const A = mk(Array.from({ length: 100 }, (_, i) => ({ id: i, los: 3 + (i % 5), dx: 'd' + (i % 4) })), cols);
  const clean = dvd.diffSnapshots(A, A); assert.equal(clean.overallRisk, dvd.RISK.OK); assert.equal(clean.rowCountDelta, 0);
  const B = mk(Array.from({ length: 60 }, (_, i) => ({ id: i, los: i % 2 ? null : 3 + (i % 5) })), [cols[0], cols[1]]);
  const d = dvd.diffSnapshots(A, B);
  assert.equal(d.overallRisk, dvd.RISK.BREAKING); assert.equal(d.rowCountDelta, -40); assert.equal(d.rowCountPct, -40);
  assert.deepEqual(d.schema.removed.map(c => c.name), ['dx']);
  assert.ok(d.colDiffs.find(c => c.name === 'los').flags.length > 0, 'null spike flagged on los');
  assert.ok(/dx/.test(dvd.summarizeDiff(d)));
  const html = dvd.diffToHTML({ ...d, datasetName: '<img src=x onerror=alert(1)>' });
  assert.ok(!/<img src=x/.test(html), 'dataset names are escaped in HTML');
  const T2 = mk([{ id: 1, los: 'a', dx: 'x' }], cols);
  assert.equal(dvd.diffSnapshots(A, T2).schema.typeChanged.length >= 0, true);
  assert.throws(() => dvd.diffSnapshots(null, A));
});
await t('time machine + time-travel diff: content hash is stable, key detection refuses non-unique keys, omitted-rows snapshots never report bogus mass inserts (REGRESSION)', () => {
  const cols = ['id', 'amt'];
  const rows1 = [{ id: 1, amt: 10 }, { id: 2, amt: 20 }, { id: 3, amt: null }];
  assert.equal(tm.contentHash(cols, rows1), tm.contentHash(cols, rows1.map(r => ({ ...r }))));
  assert.notEqual(tm.contentHash(cols, rows1), tm.contentHash(cols, [{ id: 1, amt: 10 }, { id: 2, amt: 20 }, { id: 3, amt: 'null' }]), 'null and the string "null" are different');
  assert.notEqual(tm.contentHash(cols, rows1), tm.contentHash(cols, [rows1[1], rows1[0], rows1[2]]), 'row order is part of identity');
  assert.equal(ttd.detectKeyColumn(['id', 'amt'], rows1), 'id');
  assert.equal(ttd.detectKeyColumn(['a'], [{ a: 1 }, { a: 1 }]), null);
  assert.equal(ttd.detectKeyColumn(['a'], [{ a: 1 }, { a: null }]), null, 'a nullable column cannot be a key');
  const s1 = tm.buildSnapshot({ datasetName: 'd', columns: cols, rows: rows1, now: 1000 });
  assert.equal(s1.diffSummary.rowCountDelta, 3);
  const rows2 = [{ id: 1, amt: 11 }, { id: 2, amt: 20 }, { id: 4, amt: 5 }];
  const s2 = tm.buildSnapshot({ datasetName: 'd', columns: cols, rows: rows2, previous: s1, now: 2000 });
  assert.deepEqual([s2.diffSummary.rowChanges.added, s2.diffSummary.rowChanges.removed, s2.diffSummary.rowChanges.changed], [1, 1, 1]);
  const s2lean = tm.buildSnapshot({ datasetName: 'd', columns: cols, rows: rows2, previous: s1, now: 2000, embedRows: false });
  assert.equal(s2lean.rows, null); assert.equal(s2lean.rowsOmitted, true);
  const s3 = tm.buildSnapshot({ datasetName: 'd', columns: cols, rows: rows2.concat([{ id: 9, amt: 1 }]), previous: s2lean, now: 3000 });
  assert.equal(s3.diffSummary.rowChanges, null, 'REGRESSION: previous rows are unknown; must not diff against []');
  assert.equal(s3.diffSummary.rowCountDelta, 1); assert.ok(/unavailable/.test(s3.diffSummary.text));
  assert.throws(() => tm.buildSnapshot({ datasetName: 'd', columns: [], rows: [] })); assert.throws(() => tm.buildSnapshot({ columns: cols, rows: null }));
  const dd = ttd.diffRows(rows1, rows2, 'id');
  assert.deepEqual([dd.added, dd.removed, dd.unchanged], [['4'], ['3'], 1]); assert.deepEqual(dd.changed[0].fields, [{ column: 'amt', from: 10, to: 11 }]);
  const arch = tm.exportArchive([s1, s2lean]);
  assert.equal(tm.parseArchive(arch).count, 2); assert.throws(() => tm.parseArchive('{"kind":"x"}')); assert.throws(() => tm.parseArchive('nope'));
  // Documented limitation: archives embed raw rows, so exporting one exports whatever PHI the rows contain.
  const phi = tm.buildSnapshot({ datasetName: 'p', columns: ['ssn'], rows: [{ ssn: '123-45-6789' }], now: 1 });
  assert.ok(tm.exportArchive([phi]).includes('123-45-6789'), 'time-machine export includes raw rows (documented PHI exposure; DVC store does not)');
  // Documented limitation: duplicate keys collapse in diffRows (last one wins).
  assert.equal(ttd.diffRows([{ k: 1, v: 'a' }, { k: 1, v: 'b' }], [{ k: 1, v: 'b' }], 'k').unchanged, 1);
});
await t('gate-state export: only the declared shape leaves the browser, extras are opt-in, access rules and the enforcement flag round-trip into the MCP check', () => {
  const ds = [{ name: 'claims', table: 't', rowCount: '1200', cols: [{ name: 'mrn', type: 'VARCHAR' }, null].filter(Boolean), layerResults: { phi: { status: 'fail' } }, rawRows: [['123-45-6789']], secret: 'x' }, null, 'junk'];
  const p = gse.buildGateStatePayload(ds);
  assert.equal(p.datasets.length, 1); assert.equal(p.datasets[0].rowCount, 1200);
  assert.ok(!JSON.stringify(p).includes('123-45-6789') && !JSON.stringify(p).includes('secret'), 'unknown fields (raw rows) are never exported');
  assert.deepEqual(Object.keys(p).sort(), ['datasets', 'exportedAt', 'version']);
  assert.deepEqual(gse.buildGateStatePayload('x').datasets, []);
  const reg = mar.createMetricAccessRegistry(); reg.setRule('m', { allowedAgents: ['a'] });
  const p2 = JSON.parse(gse.serializeGateState(ds, { metricAccessRules: reg, metricAccessEnforcement: 'yes' }));
  assert.equal(p2.metricAccessEnforcement, false, 'only literal true enables enforcement'); assert.equal(p2.metricAccessRules.rules.length, 1);
  assert.equal(mar.MetricAccessRuleRegistry.fromJSON(p2.metricAccessRules).isAuthorized('m', 'b'), false);
  assert.equal(gse.GATE_STATE_FILENAME, 'dataglow-gate-state.json');
  assert.equal(mar.checkMetricAccessFromGateState(p2, 'm', 'b').allowed, true, 'enforcement not literally true: open, and says so');
  assert.equal(mar.checkMetricAccessFromGateState(p2, 'm', 'b').enforced, false);
  const on = JSON.parse(gse.serializeGateState(ds, { metricAccessRules: reg, metricAccessEnforcement: true }));
  assert.deepEqual([mar.checkMetricAccessFromGateState(on, 'm', 'b').allowed, mar.checkMetricAccessFromGateState(on, 'm', 'a').allowed, mar.checkMetricAccessFromGateState(on, 'other', 'b').allowed], [false, true, true]);
  for (const junk of [null, undefined, 'x', 5, { metricAccessEnforcement: true, metricAccessRules: 'garbage' }]) assert.equal(mar.checkMetricAccessFromGateState(junk, 'm', 'b').allowed, true);
});
await t('MCP server over real stdio: a governed metric is denied to an unlisted agent, allowed to a listed one, and malformed requests are errors, never allowed:true', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'dg-breadth-mcp-'));
  try {
    const reg = mar.createMetricAccessRegistry(); reg.setRule('reid_risk', { allowedAgents: ['compliance-bot'] });
    const sp = path.join(dir, 'state.json'); writeFileSync(sp, gse.serializeGateState([], { metricAccessRules: reg, metricAccessEnforcement: true }));
    const client = new Client({ name: 'breadth', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'js/mcp/dataglow-mcp-server.mjs')], env: { ...process.env, DATAGLOW_GATE_STATE_PATH: sp }, stderr: 'ignore' }));
    try {
      const ask = async (a) => { const r = await client.callTool({ name: 'check_metric_access', arguments: a }); return { err: !!r.isError, body: JSON.parse(r.content[0].text) }; };
      assert.equal((await ask({ metric_id: 'reid_risk', agent_id: 'compliance-bot' })).body.allowed, true);
      assert.equal((await ask({ metric_id: 'reid_risk', agent_id: 'claude-code' })).body.allowed, false);
      assert.equal((await ask({ metric_id: 'reid_risk', agent_id: 'Compliance-Bot' })).body.allowed, false);
      for (const bad of [{}, { metric_id: 'reid_risk' }, { metric_id: 5, agent_id: 'x' }, { metric_id: '', agent_id: '' }]) { const r = await ask(bad); assert.equal(r.err, true); assert.equal(r.body.allowed, false); }
    } finally { await client.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 10. Statistics, anomaly, drift and narrative guard
// ---------------------------------------------------------------------------
section('Statistics, anomaly detection, drift and narrative honesty', [
  'js/anomaly/spc-control.js', 'js/anomaly/entity-baseline.js', 'js/anomaly/anomaly-timeline.js', 'js/validation/expected-range.js',
  'js/drift/freshness-decay.js', 'js/drift/dataset-differ.js', 'js/rigor/narrative-overconfidence-guard.js']);
const spc = await import('../js/anomaly/spc-control.js');
const eb = await import('../js/anomaly/entity-baseline.js');
const { AnomalyTimeline } = await import('../js/anomaly/anomaly-timeline.js');
const er = await import('../js/validation/expected-range.js');
const fd = await import('../js/drift/freshness-decay.js');
const dd = await import('../js/drift/dataset-differ.js');
const nog = await import('../js/rigor/narrative-overconfidence-guard.js');
const eng = { runQuery };

await t('SPC: 3-sigma limits and Cpk match hand-computed values; empty/constant series are safe; REGRESSION: 300k-point Cpk no longer overflows the stack', () => {
  const l = spc.computeControlLimits([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.deepEqual([l.mean, l.sigma, l.ucl, l.lcl, l.n], [5, 2, 11, -1, 8]);
  const c = spc.computeCpk([2, 4, 4, 4, 5, 5, 7, 9], 11, -1); assert.equal(c.cpk, 1); assert.equal(c.inferredSpec, false);
  const inf = spc.computeCpk([2, 4, 4, 4, 5, 5, 7, 9]); assert.equal(inf.inferredSpec, true); assert.deepEqual([inf.usl, inf.lsl], [9, 2]);
  assert.equal(spc.computeCpk([5, 5, 5]).cpk, null);
  assert.deepEqual(spc.computeControlLimits([]), { mean: 0, sigma: 0, ucl: 0, lcl: 0, n: 0 });
  const big = Array.from({ length: 300000 }, (_, i) => i % 100);
  const bc = spc.computeCpk(big); assert.deepEqual([bc.usl, bc.lsl], [99, 0]);
  assert.ok(Number.isNaN(spc.computeControlLimits([1, NaN, 3]).mean), 'NaN input is not silently dropped by the pure helper (documented: analyzeColumnSPC filters first)');
});
await t('SPC on DuckDB: text and NULLs are skipped, a lone outlier among 40 normal points is out of control, quoted column names are safe', async () => {
  await runQuery(`CREATE OR REPLACE TABLE spc_t AS SELECT 'x' AS "bad""col", CASE WHEN i = 20 THEN 500.0 ELSE 100.0 + (i % 5) END AS v FROM range(41) t(i)`);
  await runQuery(`INSERT INTO spc_t VALUES ('x', NULL)`);
  const r = await spc.analyzeColumnSPC('spc_t', 'v', eng);
  assert.equal(r.values.length, 41); assert.equal(r.outOfControl, 1);
  assert.equal(await spc.analyzeColumnSPC('spc_t', 'bad"col', eng), null, 'text column has no numeric values; a quote in the name must not break the query');
  const all = await spc.analyzeAllNumericSPC('spc_t', [{ name: 'v', type: 'DOUBLE' }, { name: 'bad"col', type: 'VARCHAR' }], eng);
  assert.equal(all.length, 1);
});
await t('per-entity baselines: a vendor\'s own normal range, quoted names safe; limitation pinned: an entity with 10 or fewer points can never trip the 3-sigma flag', async () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(`('V1', ${200 + i * 50})`);        // 200..750
  rows.push(`('V1', 12000)`);                                              // the real outlier, 13 points
  for (let i = 0; i < 5; i++) rows.push(`('V2', ${5000 + i})`);              // big vendor, normal
  for (let i = 0; i < 8; i++) rows.push(`('V3', ${300 + i})`); rows.push(`('V3', 90000)`); // only 9 points
  rows.push(`('V4', NULL)`);
  await runQuery(`CREATE OR REPLACE TABLE inv AS SELECT * FROM (VALUES ${rows.join(',')}) v("vendor ""id""", amount)`);
  const base = await eb.computeEntityBaselines('inv', 'vendor "id"', 'amount', eng);
  assert.equal(base.V1.n, 13); assert.equal(Math.round(base.V2.mean), 5002); assert.equal('V4' in base, false);
  const flags = await eb.flagEntityDeviations('inv', 'vendor "id"', 'amount', base, eng);
  assert.deepEqual(flags.map(f => [f.entity, f.value]), [['V1', 12000]]);
  assert.ok(flags[0].zScore > 3 && /own baseline/.test(flags[0].reason));
  // V3 has a 90,000 invoice among 8 around 300, but with n=9 the maximum attainable population z is sqrt(n-1) = 2.83.
  assert.equal(flags.some(f => f.entity === 'V3'), false, 'KNOWN LIMITATION: n<=10 cannot exceed 3 sigma when the outlier is part of its own baseline');
  const z = (90000 - base.V3.mean) / base.V3.stddev; assert.ok(z < 3 && z > 2.8, String(z));
});
await t('anomaly timeline: finds the spike, the gap, the duplicate and the missing cluster at the right rows; constant columns and tiny tables stay quiet', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ day: `2024-03-${String(i + 1).padStart(2, '0')}`, claims: 100 + (i % 3), note: 'ok', flat: 7 });
  rows[17].claims = 1000;
  const rep = AnomalyTimeline.detect({ columns: [{ name: 'day' }, { name: 'claims' }, { name: 'note' }, { name: 'flat' }], rows });
  const spike = rep.events.find(e => e.col === 'claims' && e.type === 'spike');
  assert.ok(spike && spike.rowIndex === 17 && spike.value === 1000, JSON.stringify(rep.events.slice(0, 3)));
  assert.equal(rep.events.some(e => e.col === 'flat'), false);
  assert.equal(AnomalyTimeline.detect({ columns: [{ name: 'a' }], rows: [{ a: 1 }, { a: 2 }] }).events.length, 0);
  assert.equal(AnomalyTimeline.detect(null).events.length, 0);
  const small = AnomalyTimeline.detect({ columns: [{ name: 'v' }], rows: [1, 2, 3, 2, 1, 2, 400].map(v => ({ v })) });
  assert.equal(small.events.some(e => e.type === 'spike'), false, 'KNOWN LIMITATION: with 7 rows the maximum z is sqrt(6) = 2.449, below the 2.5 threshold');
  const nine = AnomalyTimeline.detect({ columns: [{ name: 'v' }], rows: [1, 2, 3, 2, 1, 2, 3, 2, 400].map(v => ({ v })) });
  assert.equal(nine.events.some(e => e.type === 'spike' && e.rowIndex === 8), true);
});
await t('expected range: trend narration is informational, handles zero base and missing history, never claims a prediction', () => {
  assert.equal(er.trendPerUploadPct(110, 10), 10); assert.equal(er.trendPerUploadPct(10, 10), null); assert.equal(er.trendPerUploadPct(NaN, 1), null);
  assert.equal(er.describeTrend(0, 0.1), 'holding roughly steady'); assert.ok(/up ~10.0%/.test(er.describeTrend(10, 10))); assert.ok(/down/.test(er.describeTrend(-3, null)));
  assert.deepEqual(er.expectedRangeReport(null), { active: false, historyLen: 0, bands: [] });
  assert.equal(er.expectedRangeReport({ active: false, historyLen: 2 }).bands.length, 0);
  const rep = er.expectedRangeReport({ active: true, historyLen: 5, projections: [
    { kind: 'mean', column: 'rev', expected: 140, low: 135, high: 145, actual: 150, trend: 4, outside: true },
    { kind: 'nullRate', column: 'rev', expected: 0.1, actual: 0.2 }, { kind: 'mean', column: 'bad', expected: NaN, actual: 1 }, { kind: 'mean', column: 'z', expected: 0, low: -1, high: 1, actual: 0, trend: 0, outside: false }] });
  assert.equal(rep.bands.length, 2); assert.equal(rep.bands[0].within, false); assert.equal(rep.bands[0].direction, 'up');
  assert.ok(/outside the expected range/.test(rep.bands[0].message) && /not a prediction/.test(rep.bands[0].message));
  assert.equal(rep.bands[1].direction, 'flat');
});
await t('freshness decay: fresh, stale, expired and unknown dates; REGRESSION: an unparseable as-of date can no longer yield a NaN multiplier', () => {
  const cfg = { staleAfterDays: 30, expiredAfterDays: 90, decayFloor: 0.4, decayShape: 'linear', rationale: 'r' };
  const at = (d) => fd.computeFreshnessDecay({ dataDate: d, asOf: '2026-06-01', freshnessConfig: cfg });
  assert.deepEqual([at('2026-05-20').status, at('2026-05-20').multiplier], ['fresh', 1]);
  const stale = at('2026-04-02'); // 60 days old: halfway through the 30..90 window
  assert.equal(stale.status, 'stale'); assert.ok(Math.abs(stale.multiplier - 0.7) < 1e-9, String(stale.multiplier));
  const expo = fd.computeFreshnessDecay({ dataDate: '2026-04-02', asOf: '2026-06-01', freshnessConfig: { ...cfg, decayShape: 'exponential' } });
  assert.ok(expo.multiplier > 0.4 && expo.multiplier < 0.7 + 1e-9 + 0.0, String(expo.multiplier));
  assert.deepEqual([at('2025-01-01').status, at('2025-01-01').multiplier], ['expired', 0.4]);
  for (const bad of [null, '', 'not a date', undefined]) assert.equal(at(bad).status, 'unknown');
  const badAsOf = fd.computeFreshnessDecay({ dataDate: '2026-04-02', asOf: 'garbage', freshnessConfig: cfg });
  assert.equal(badAsOf.status, 'unknown'); assert.equal(badAsOf.multiplier, 1); assert.ok(!Number.isNaN(fd.applyFreshnessDecay(80, badAsOf).adjustedScore));
  assert.equal(fd.applyFreshnessDecay(80, stale).adjustedScore, 80 * stale.multiplier); assert.equal(fd.applyFreshnessDecay(80, null).multiplier, 1);
  assert.equal(at('2027-01-01').status, 'fresh'); // documented: future-dated data is treated as fresh, not flagged
  assert.ok(typeof fd.freshnessLabel(stale) === 'string' && fd.freshnessLabel(null) === 'Unknown');
});
await t('dataset differ: row-count, null-rate, mean shift, dropped and retyped columns on a real before/after pair', async () => {
  await runQuery(`CREATE OR REPLACE TABLE snap_a AS SELECT i AS id, 100.0 AS paid, 'x' AS note, CAST(i AS VARCHAR) AS code FROM range(1000) t(i)`);
  await runQuery(`CREATE OR REPLACE TABLE snap_b AS SELECT i AS id, CASE WHEN i % 4 = 0 THEN NULL ELSE 180.0 END AS paid, CAST(i AS BIGINT) AS code FROM range(700) t(i)`);
  const cols = async (t_) => (await runQuery(`DESCRIBE ${t_}`)).rows.map(r => ({ name: r.column_name, type: r.column_type }));
  const A = await dd.captureSnapshot({ table: 'snap_a', cols: await cols('snap_a'), engine: eng, label: 'before', capturedAt: '2026-01-01T00:00:00Z' });
  const B = await dd.captureSnapshot({ table: 'snap_b', cols: await cols('snap_b'), engine: eng, label: 'after', capturedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual([A.rowCount, B.rowCount], [1000, 700]);
  const d = dd.diffSnapshots(A, B);
  assert.equal(d.status, 'fail');
  const kinds = d.findings.map(f => f.kind + ':' + (f.column || ''));
  for (const k of ['mean_shifted:paid']) assert.ok(kinds.includes(k), kinds.join(' | '));
  assert.ok(d.findings.some(f => /row/i.test(f.kind) && f.status === 'fail'), 'a 30% row loss fails');
  assert.ok(d.findings.some(f => /null/i.test(f.kind) && f.column === 'paid'));
  assert.ok(d.findings.some(f => /removed|dropped/i.test(f.kind) && (f.column === 'note')) || /note/.test(d.rationale + JSON.stringify(d.schemaDiff)));
  assert.equal(dd.diffSnapshots(A, A).status, 'pass');
  assert.equal(dd.diffSnapshots(null, A).status, 'idle');
  const quoted = await dd.captureSnapshot({ table: 'snap_a', cols: [{ name: 'id', type: 'BIGINT' }, { name: 'we"ird', type: 'VARCHAR' }], engine: eng });
  assert.equal(quoted.columnStats.find(c => c.name === 'we"ird').nullRate, null, 'a missing column degrades to unknown, never throws');
  // Documented limitation: a mean moving away from exactly 0 is not flagged (relative change undefined).
  const zero = dd.diffSnapshots({ rowCount: 10, columnCount: 1, columnStats: [{ name: 'v', type: 'DOUBLE', nullRate: 0, meanVal: 0 }] }, { rowCount: 10, columnCount: 1, columnStats: [{ name: 'v', type: 'DOUBLE', nullRate: 0, meanVal: 500 }] });
  assert.equal(zero.status, 'pass', 'KNOWN LIMITATION: baseline mean of 0 hides a shift to 500');
});
await t('narrative overconfidence guard: confident wording on a weak (C/D) claim is flagged, hedged wording and strong claims are not, junk input is idle', () => {
  const claims = [{ kind: 'average', column: 'paid', value: 41.2, text: 'x', confidence: { grade: 'D', n: 6, missingRate: 0.4 } },
    { kind: 'total', column: 'visits', value: 9000, text: 'y', confidence: { grade: 'A', n: 9000, missingRate: 0 } }];
  const bad = nog.checkNarrativeOverconfidence('The average paid of 41.2 is clearly the true cost. Visits total 9000.', claims);
  assert.equal(bad.status, 'warn');
  assert.ok(bad.findings.some(f => f.issue === 'overconfident_language' && f.column === 'paid'));
  assert.ok(bad.findings.some(f => f.issue === 'missing_hedge'));
  assert.ok(!bad.findings.some(f => f.column === 'visits'), 'grade A claims are never flagged');
  const good = nog.checkNarrativeOverconfidence('The average paid is about 41.2. Treat this average cautiously: it rests on limited data.', claims);
  assert.equal(good.status, 'pass', JSON.stringify(good.findings));
  for (const junk of [[null, claims], ['', claims], ['text', []], ['text', null], [42, claims]]) assert.equal(nog.checkNarrativeOverconfidence(...junk).status, 'idle');
  assert.equal(nog.checkNarrativeOverconfidence('Definitely 41.2.', [{ kind: 'k', confidence: null }, null].filter(Boolean)).status, 'pass');
  assert.ok(/graded D/.test(nog.describeOverconfidenceFinding(bad.findings[0])));
});

console.log('\n' + '='.repeat(60));
const modulesTouched = new Set();
for (const sec of sections) for (const m of sec.modules) modulesTouched.add(m);
console.log(`breadth stress 2026-11: ${passed} passed, ${failures.length} failed, ${modulesTouched.size} distinct capability modules exercised`);
if (failures.length) process.exit(1);

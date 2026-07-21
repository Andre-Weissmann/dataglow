/**
 * DataGlow X12 Parser -- unit tests (835 + 837)
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bundle = readFileSync(path.join(__dirname, '../src/js/bundle.js'), 'utf8');
const iifePat = /var X12Parser = \(function[\s\S]*?window\.X12Parser = X12Parser;/;
const match = bundle.match(iifePat);
if (!match) throw new Error('X12Parser IIFE not found in bundle.js');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(match[0], ctx);
const X12Parser = ctx.window.X12Parser;
if (!X12Parser) throw new Error('X12Parser not assigned after evaluation.');

/* ISA header is exactly 106 chars: position 104 = component sep, 105 = seg terminator */
const ISA835 = 'ISA*00*          *00*          *ZZ*PAYERID        *ZZ*PAYEEID        *230601*1200*^*00501*000000001*0*P*:~';
const ISA837 = 'ISA*00*          *00*          *ZZ*CLEARINGHS     *ZZ*PAYERID        *230601*1200*^*00501*000000002*0*P*:~';

const SAMPLE_835 = [
  ISA835,
  'GS*HP*PAYERID*PAYEEID*20230601*1200*1*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*1500.00*C*CHK************20230610~',
  'TRN*1*CHK123456789*1234567890~',
  'N1*PR*ANTHEM BLUE CROSS~',
  'N1*PE*CLINIC A*XX*9876543210~',
  'CLP*CLAIM001*1*2000.00*1500.00*100.00*11*PAYERCLAIM001~',
  'CAS*CO*45*400.00~',
  'SVC*HC:99213*2000.00*1500.00~',
  'SE*10*0001~',
  'GE*1*1~',
  'IEA*1*000000001~',
].join('');

const SAMPLE_837 = [
  ISA837,
  'GS*HC*CLEARINGHS*PAYERID*20230601*1200*1*X*005010X222A1~',
  'ST*837*0002~',
  'BHT*0019*00*BATCH001*20230601*1200*CH~',
  'NM1*41*2*PROVIDER BILLING CO*****46*123456789~',
  'NM1*40*2*ANTHEM BLUE CROSS*****46*PAYID999~',
  'HL*1**20*1~',
  'NM1*85*1*SMITH*JOHN****MD*XX*1234567890~',
  'NM1*IL*1*DOE*JANE****MI*MEMBER001~',
  'DMG*D8*19850315*F~',
  'CLM*CLM9999*350.00***11:B:1*Y*A*Y*I~',
  'DTP*472*D8*20230601~',
  'HI*ABK:Z00.00~',
  'SV1*HC:99214:25*350.00*UN*2***1~',
  'SE*14*0002~',
  'GE*1*1~',
  'IEA*1*000000002~',
].join('');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('\u2713', name); passed++; }
  catch (err) { console.error('\u2717', name, '->', err.message); failed++; }
}

test('ISA835 is 106 chars', () => assert.strictEqual(ISA835.length, 106));
test('ISA837 is 106 chars', () => assert.strictEqual(ISA837.length, 106));

test('parseEnvelope: 835 segments non-empty', () => {
  const env = X12Parser.parseEnvelope(SAMPLE_835);
  assert.ok(env && env.segments.length > 0);
});
test('detectType: 835', () => {
  assert.strictEqual(X12Parser.detectType(X12Parser.parseEnvelope(SAMPLE_835).segments), '835');
});
test('detectType: 837', () => {
  assert.strictEqual(X12Parser.detectType(X12Parser.parseEnvelope(SAMPLE_837).segments), '837');
});

const r835 = X12Parser.parse(SAMPLE_835);
test('835: transactionType', () => assert.strictEqual(r835.transactionType, '835'));
test('835: has rows', () => assert.ok(r835.rows.length > 0));
test('835: payer_name', () => {
  const col = r835.columns.findIndex(c => c.name === 'payer_name');
  assert.ok(r835.rows.some(row => row[col].includes('ANTHEM')));
});
test('835: check_number', () => {
  const col = r835.columns.findIndex(c => c.name === 'check_number');
  assert.ok(r835.rows[0][col].includes('CHK123456789'));
});
test('835: paid_amount non-empty', () => {
  const col = r835.columns.findIndex(c => c.name === 'paid_amount');
  assert.ok(r835.rows[0][col].length > 0);
});
test('835: procedure_code non-empty', () => {
  const col = r835.columns.findIndex(c => c.name === 'procedure_code');
  assert.ok(r835.rows.some(row => row[col].length > 0));
});
test('835: FLOAT columns >= 4', () => assert.ok(r835.columns.filter(c => c.type === 'FLOAT').length >= 4));

const r837 = X12Parser.parse(SAMPLE_837);
test('837: transactionType', () => assert.strictEqual(r837.transactionType, '837'));
test('837: has rows', () => assert.ok(r837.rows.length > 0));
test('837: patient_name contains DOE', () => {
  const col = r837.columns.findIndex(c => c.name === 'patient_name');
  assert.ok(r837.rows.some(row => row[col].includes('DOE')));
});
test('837: member_id', () => {
  const col = r837.columns.findIndex(c => c.name === 'member_id');
  assert.strictEqual(r837.rows[0][col], 'MEMBER001');
});
test('837: provider_npi', () => {
  const col = r837.columns.findIndex(c => c.name === 'provider_npi');
  assert.strictEqual(r837.rows[0][col], '1234567890');
});
test('837: diagnosis_code contains Z00', () => {
  const col = r837.columns.findIndex(c => c.name === 'diagnosis_code');
  assert.ok(r837.rows[0][col].includes('Z00'));
});
test('837: procedure_code is 99214', () => {
  const col = r837.columns.findIndex(c => c.name === 'procedure_code');
  assert.strictEqual(r837.rows[0][col], '99214');
});
test('837: payer_name', () => {
  const col = r837.columns.findIndex(c => c.name === 'payer_name');
  assert.ok(r837.rows[0][col].includes('ANTHEM'));
});
test('837: service_date', () => {
  const col = r837.columns.findIndex(c => c.name === 'service_date');
  assert.strictEqual(r837.rows[0][col], '20230601');
});
test('837: total_charge', () => {
  const col = r837.columns.findIndex(c => c.name === 'total_charge');
  assert.strictEqual(r837.rows[0][col], '350.00');
});
test('837: DATE columns >= 2', () => assert.ok(r837.columns.filter(c => c.type === 'DATE').length >= 2));

test('parse: throws on non-X12', () => assert.throws(() => X12Parser.parse('not EDI'), /valid X12/i));
test('parse: throws on short content', () => assert.throws(() => X12Parser.parse('ISA*short'), /valid X12/i));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

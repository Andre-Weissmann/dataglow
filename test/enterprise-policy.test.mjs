/**
 * Enterprise Policy Engine — unit tests
 * Tests the EnterprisePolicy IIFE logic extracted as pure functions.
 * No DOM, no fetch. Simulates what EnterprisePolicy does in the browser.
 */

/* ---- Inline the parse/apply logic from the IIFE for testing ---- */
function parsePolicy(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    return { ok: false, error: 'Not valid JSON: ' + e.message };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Must be a JSON object.' };
  if (obj.version !== 1) return { ok: false, error: 'Unsupported version ' + obj.version };
  return { ok: true, policy: obj };
}

function applyPolicy(policy) {
  const disabled = {};
  const required = {};
  const org = typeof policy.organization === 'string' ? policy.organization : null;
  const contact = typeof policy.adminContact === 'string' ? policy.adminContact : null;
  const exportFormats = Array.isArray(policy.allowedExportFormats) ? policy.allowedExportFormats : null;
  if (Array.isArray(policy.disable)) policy.disable.forEach(k => { if (typeof k === 'string') disabled[k] = true; });
  if (Array.isArray(policy.require)) policy.require.forEach(k => { if (typeof k === 'string') required[k] = true; });
  return {
    isDisabled: k => !!disabled[k],
    isRequired: k => !!required[k],
    getOrganization: () => org,
    getAdminContact: () => contact,
    getAllowedExportFormats: () => exportFormats,
    getSnapshot: () => ({ applied: true, organization: org, disabled: Object.keys(disabled), required: Object.keys(required), exportFormats, contact })
  };
}

/* ---- Test harness ---- */
let passed = 0, failed = 0;
function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + desc);
  if (!ok) { console.error('  Expected:', expected, '  Got:', actual); failed++; }
  else passed++;
}
function assertOk(desc, val) { assert(desc, !!val, true); }
function assertFalse(desc, val) { assert(desc, !!val, false); }

/* ================================================================
   Parse tests
   ================================================================ */
const valid = JSON.stringify({ version: 1, organization: 'Acme', disable: ['byokStory'], require: ['auditLog'] });
const r1 = parsePolicy(valid);
assertOk('parse: valid policy returns ok=true', r1.ok);

const r2 = parsePolicy('not json{{{');
assertFalse('parse: malformed JSON returns ok=false', r2.ok);
assertOk('parse: malformed JSON includes error', r2.error);

const r3 = parsePolicy(JSON.stringify({ version: 2 }));
assertFalse('parse: wrong version returns ok=false', r3.ok);

const r4 = parsePolicy('null');
assertFalse('parse: null body returns ok=false', r4.ok);

const r5 = parsePolicy('[]');
assertFalse('parse: array body returns ok=false', r5.ok);

/* ================================================================
   Apply tests
   ================================================================ */
const policy = applyPolicy(r1.policy);

assertOk('apply: byokStory is disabled', policy.isDisabled('byokStory'));
assertFalse('apply: webrtcRooms is NOT disabled (not listed)', policy.isDisabled('webrtcRooms'));
assertOk('apply: auditLog is required', policy.isRequired('auditLog'));
assertFalse('apply: enterpriseBuild NOT required (not listed)', policy.isRequired('enterpriseBuild'));
assert('apply: organization is correct', policy.getOrganization(), 'Acme');

/* ================================================================
   Full policy file (sample) tests
   ================================================================ */
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const __dir = dirname(fileURLToPath(import.meta.url));
const sampleRaw = readFileSync(join(__dir, '../dataglow-policy.sample.json'), 'utf8');

// Remove _comment field to simulate real usage
const sampleObj = JSON.parse(sampleRaw);
delete sampleObj._comment;
const sampleText = JSON.stringify(sampleObj);
const sampleParsed = parsePolicy(sampleText);
assertOk('sample: parses successfully', sampleParsed.ok);

const samplePolicy = applyPolicy(sampleParsed.policy);
assertOk('sample: byokStory disabled', samplePolicy.isDisabled('byokStory'));
assertOk('sample: webrtcRooms disabled', samplePolicy.isDisabled('webrtcRooms'));
assertFalse('sample: cdnFetches NOT disabled by default sample', samplePolicy.isDisabled('cdnFetches'));
assertOk('sample: auditLog required', samplePolicy.isRequired('auditLog'));
assertOk('sample: enterpriseBuild required', samplePolicy.isRequired('enterpriseBuild'));
assert('sample: organization', samplePolicy.getOrganization(), 'Acme Health System');
assert('sample: adminContact', samplePolicy.getAdminContact(), 'dataops@acmehealth.org');
assert('sample: allowedExportFormats', samplePolicy.getAllowedExportFormats(), ['pdf', 'xlsx', 'csv']);

/* ================================================================
   Snapshot test
   ================================================================ */
const snap = samplePolicy.getSnapshot();
assertOk('snapshot: applied=true', snap.applied);
assertOk('snapshot: disabled array has items', snap.disabled.length > 0);
assertOk('snapshot: required array has items', snap.required.length > 0);
assert('snapshot: organization in snapshot', snap.organization, 'Acme Health System');

/* ================================================================
   Edge cases
   ================================================================ */
const emptyPolicy = applyPolicy({ version: 1 });
assertFalse('edge: empty disable array -- byokStory not disabled', emptyPolicy.isDisabled('byokStory'));
assertFalse('edge: empty require array -- auditLog not required', emptyPolicy.isRequired('auditLog'));
assert('edge: no organization returns null', emptyPolicy.getOrganization(), null);
assert('edge: no export formats returns null', emptyPolicy.getAllowedExportFormats(), null);

const nonStringKeys = applyPolicy({ version: 1, disable: [42, null, true, 'byokStory'], require: ['auditLog', 99] });
assertOk('edge: non-string disable keys are ignored, valid ones applied', nonStringKeys.isDisabled('byokStory'));
assertOk('edge: non-string require keys are ignored, valid ones applied', nonStringKeys.isRequired('auditLog'));
assertFalse('edge: numeric key 42 not treated as disabled', nonStringKeys.isDisabled('42'));

/* ================================================================
   Results
   ================================================================ */
console.log('\n' + passed + '/' + (passed + failed) + ' tests passed.');
if (failed > 0) process.exit(1);

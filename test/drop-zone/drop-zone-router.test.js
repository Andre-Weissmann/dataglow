// ============================================================
// DataGlow — Universal Drop Zone: Router Tests
// ============================================================
// Tests for js/drop-zone/drop-zone-router.js — pure logic, no DOM, no
// DuckDB, no File API. Fully runnable in plain Node.
//
// Run: node test/drop-zone/drop-zone-router.test.js
// ============================================================

import {
  detectFileFormat,
  buildDropManifest,
  routeDropManifest,
  buildJoinPanelDescriptor,
  buildTabDescriptor,
  _resetDropZoneCounters,
} from '../../js/drop-zone/drop-zone-router.js';

// ---- Minimal test harness (matches repo convention) ----
let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---- Byte helpers ----
function bytesFromAscii(str, totalLen = 16) {
  const out = new Uint8Array(totalLen);
  for (let i = 0; i < str.length && i < totalLen; i++) out[i] = str.charCodeAt(i);
  return out;
}

function emptyBytes() {
  return new Uint8Array(16);
}

// ============================================================
// 1. detectFileFormat
// ============================================================
section('1. detectFileFormat');

{
  const bytes = bytesFromAscii('PAR1abcdefghijkl');
  const r = detectFileFormat('claims_Q2.parquet', '', bytes);
  ok(r.format === 'parquet', 'parquet magic bytes -> format parquet');
  ok(r.handler === 'duckdb', 'parquet magic bytes -> handler duckdb');
  ok(r.confidence === 'high', 'parquet magic bytes -> high confidence');
}

{
  // Zip local file header signature 'PK\x03\x04' + .xlsx extension
  const bytes = new Uint8Array(16);
  bytes[0] = 0x50; // P
  bytes[1] = 0x4b; // K
  bytes[2] = 0x03;
  bytes[3] = 0x04;
  const r = detectFileFormat('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
  ok(r.format === 'xlsx', 'xlsx magic bytes + extension -> format xlsx');
  ok(r.handler === 'univer', 'xlsx magic bytes -> handler univer');
  ok(r.confidence === 'high', 'xlsx magic bytes -> high confidence');
}

{
  const bytes = bytesFromAscii('%PDF-1.7 blah blah');
  const r = detectFileFormat('report.pdf', 'application/pdf', bytes);
  ok(r.format === 'pdf', 'pdf magic bytes -> format pdf');
  ok(r.handler === 'rag', 'pdf magic bytes -> handler rag');
  ok(r.confidence === 'high', 'pdf magic bytes -> high confidence');
}

{
  const r = detectFileFormat('voicememo.unknownext', 'audio/mp4', emptyBytes());
  ok(r.format === 'audio', 'audio MIME -> format audio');
  ok(r.handler === 'whisper', 'audio MIME -> handler whisper');
}

{
  const r = detectFileFormat('site_visit.webm', '', emptyBytes());
  ok(r.format === 'video', 'video extension -> format video');
  ok(r.handler === 'webcodecs', 'video extension -> handler webcodecs');
}

{
  const r = detectFileFormat('mystery.xyz', '', emptyBytes());
  ok(r.format === 'unknown', 'unrecognized file -> format unknown');
  ok(r.handler === 'unknown', 'unrecognized file -> handler unknown');
}

// Additional coverage: MIME fallbacks + extension fallbacks
{
  const r = detectFileFormat('data', 'text/csv', emptyBytes());
  ok(r.format === 'csv', 'text/csv MIME -> format csv');
  ok(r.handler === 'duckdb', 'text/csv MIME -> handler duckdb');
}

{
  const r = detectFileFormat('data.tsv', '', emptyBytes());
  ok(r.format === 'tsv', '.tsv extension -> format tsv');
  ok(r.handler === 'duckdb', '.tsv extension -> handler duckdb');
}

{
  const r = detectFileFormat('events.ndjson', '', emptyBytes());
  ok(r.format === 'json', '.ndjson extension -> format json (parse-time distinction deferred to DuckDB layer)');
  ok(r.handler === 'duckdb', '.ndjson extension -> handler duckdb');
}

{
  const r = detectFileFormat('payload.json', 'application/json', emptyBytes());
  ok(r.format === 'json', 'application/json MIME -> format json');
}

// ============================================================
// 2. buildDropManifest
// ============================================================
section('2. buildDropManifest');

{
  _resetDropZoneCounters();
  const files = [
    { name: 'claims_Q2.csv', mimeType: 'text/csv', size: 1024, firstBytes: emptyBytes() },
    { name: 'contract_terms.pdf', mimeType: 'application/pdf', size: 20480, firstBytes: bytesFromAscii('%PDF-1.4') },
    { name: 'call_recording.mp3', mimeType: 'audio/mpeg', size: 512000, firstBytes: emptyBytes() },
  ];
  const manifest = buildDropManifest(files);

  ok(manifest.totalFiles === 3, 'manifest has 3 items');
  ok(manifest.items.length === 3, 'items array length matches totalFiles');

  const csvItem = manifest.items.find((i) => i.name === 'claims_Q2.csv');
  const pdfItem = manifest.items.find((i) => i.name === 'contract_terms.pdf');
  const mp3Item = manifest.items.find((i) => i.name === 'call_recording.mp3');

  ok(csvItem.format === 'csv' && csvItem.handler === 'duckdb', 'csv item has correct format/handler');
  ok(pdfItem.format === 'pdf' && pdfItem.handler === 'rag', 'pdf item has correct format/handler');
  ok(mp3Item.format === 'audio' && mp3Item.handler === 'whisper', 'mp3 item has correct format/handler');

  ok(csvItem.displayName === 'claims Q2', 'csv display name strips extension and replaces underscores');
  ok(pdfItem.displayName === 'contract terms', 'pdf display name strips extension and replaces underscores');

  ok(manifest.requiresTranscription === true, 'requiresTranscription is true when audio present');
  ok(manifest.requiresRAG === true, 'requiresRAG is true when pdf present');
  ok(manifest.hasMixedFormats === true, 'hasMixedFormats is true across csv+pdf+mp3');

  ok(typeof manifest.manifestId === 'string' && manifest.manifestId.length > 0, 'manifestId is a non-empty string');
  ok(new Set(manifest.items.map((i) => i.fileId)).size === 3, 'each item has a unique fileId');
  ok(
    manifest.items.every((i, idx) => i.tabOrder === idx),
    'tabOrder matches input order'
  );
}

{
  // Single-format drop should not be flagged as mixed
  const files = [
    { name: 'a.csv', mimeType: 'text/csv', size: 10, firstBytes: emptyBytes() },
    { name: 'b.csv', mimeType: 'text/csv', size: 10, firstBytes: emptyBytes() },
  ];
  const manifest = buildDropManifest(files);
  ok(manifest.hasMixedFormats === false, 'single-handler drop is not flagged as mixed');
  ok(manifest.requiresTranscription === false, 'no transcription needed for csv-only drop');
  ok(manifest.requiresRAG === false, 'no RAG needed for csv-only drop');
}

// ============================================================
// 3. routeDropManifest
// ============================================================
section('3. routeDropManifest');

{
  const files = [
    { name: 'claims_Q2.csv', mimeType: 'text/csv', size: 1024, firstBytes: emptyBytes() },
    { name: 'budget.xlsx', mimeType: '', size: 2048, firstBytes: (() => { const b = new Uint8Array(16); b[0]=0x50; b[1]=0x4b; return b; })() },
    { name: 'contract_terms.pdf', mimeType: 'application/pdf', size: 20480, firstBytes: bytesFromAscii('%PDF-1.4') },
    { name: 'call_recording.mp3', mimeType: 'audio/mpeg', size: 512000, firstBytes: emptyBytes() },
    { name: 'site_visit.mp4', mimeType: 'video/mp4', size: 999, firstBytes: emptyBytes() },
    { name: 'unknown_thing.xyz', mimeType: '', size: 1, firstBytes: emptyBytes() },
  ];
  const manifest = buildDropManifest(files);
  const plan = routeDropManifest(manifest);

  ok(plan.duckdbFiles.length === 1 && plan.duckdbFiles[0].name === 'claims_Q2.csv', 'csv routed to duckdbFiles');
  ok(plan.univerFiles.length === 1 && plan.univerFiles[0].name === 'budget.xlsx', 'xlsx routed to univerFiles');
  ok(plan.ragFiles.length === 1 && plan.ragFiles[0].name === 'contract_terms.pdf', 'pdf routed to ragFiles');
  ok(plan.transcriptionFiles.length === 1 && plan.transcriptionFiles[0].name === 'call_recording.mp3', 'mp3 routed to transcriptionFiles');
  ok(plan.webCodecsFiles.length === 1 && plan.webCodecsFiles[0].name === 'site_visit.mp4', 'mp4 routed to webCodecsFiles');
  ok(plan.unknownFiles.length === 1 && plan.unknownFiles[0].name === 'unknown_thing.xyz', 'unknown file routed to unknownFiles');

  const totalRouted =
    plan.duckdbFiles.length + plan.univerFiles.length + plan.ragFiles.length +
    plan.transcriptionFiles.length + plan.webCodecsFiles.length + plan.unknownFiles.length;
  ok(totalRouted === manifest.items.length, 'every manifest item lands in exactly one bucket');
}

// ============================================================
// 4. buildJoinPanelDescriptor
// ============================================================
section('4. buildJoinPanelDescriptor');

{
  const datasets = [
    {
      tabId: 'tab_claims',
      displayName: 'claims Q2',
      columns: [
        { name: 'claim_id', type: 'VARCHAR' },
        { name: 'amount', type: 'DECIMAL(18,2)' },
      ],
    },
    {
      tabId: 'tab_payments',
      displayName: 'payments Q2',
      columns: [
        { name: 'claim_id', type: 'VARCHAR' },
        { name: 'paid_date', type: 'DATE' },
      ],
    },
  ];
  const descriptor = buildJoinPanelDescriptor(datasets);

  ok(descriptor.availableDatasets.length === 2, 'availableDatasets echoes input datasets');
  const claimJoins = descriptor.suggestedJoins.filter((j) => j.leftColumn === 'claim_id' && j.rightColumn === 'claim_id');
  ok(claimJoins.length === 1, 'exactly one suggested join for shared claim_id column');
  ok(claimJoins[0].confidence === 'high', 'exact name+type match suggested with high confidence');
  ok(claimJoins[0].leftDataset === 'tab_claims' && claimJoins[0].rightDataset === 'tab_payments', 'join references correct tabIds');
  ok(/claim_id/.test(claimJoins[0].reason), 'reason string mentions the shared column');
}

{
  // Fuzzy match: 'patient_id' vs 'id', compatible types -> medium confidence
  const datasets = [
    { tabId: 'tab_a', displayName: 'A', columns: [{ name: 'patient_id', type: 'INTEGER' }] },
    { tabId: 'tab_b', displayName: 'B', columns: [{ name: 'id', type: 'INTEGER' }] },
  ];
  const descriptor = buildJoinPanelDescriptor(datasets);
  ok(descriptor.suggestedJoins.length === 1, 'fuzzy name match produces one suggestion');
  ok(descriptor.suggestedJoins[0].confidence === 'medium', 'fuzzy match has medium confidence');
}

{
  // Incompatible types should not be suggested even with identical names
  const datasets = [
    { tabId: 'tab_a', displayName: 'A', columns: [{ name: 'code', type: 'VARCHAR' }] },
    { tabId: 'tab_b', displayName: 'B', columns: [{ name: 'code', type: 'INTEGER' }] },
  ];
  const descriptor = buildJoinPanelDescriptor(datasets);
  ok(descriptor.suggestedJoins.length === 0, 'no suggestion when types are incompatible despite name match');
}

{
  // No overlap at all
  const datasets = [
    { tabId: 'tab_a', displayName: 'A', columns: [{ name: 'alpha', type: 'INTEGER' }] },
    { tabId: 'tab_b', displayName: 'B', columns: [{ name: 'beta', type: 'VARCHAR' }] },
  ];
  const descriptor = buildJoinPanelDescriptor(datasets);
  ok(descriptor.suggestedJoins.length === 0, 'no suggestion when there is no name or type overlap');
}

{
  // Single dataset — no pairs, no joins
  const datasets = [{ tabId: 'tab_a', displayName: 'A', columns: [{ name: 'x', type: 'INTEGER' }] }];
  const descriptor = buildJoinPanelDescriptor(datasets);
  ok(descriptor.suggestedJoins.length === 0, 'single dataset produces no join suggestions');
}

// ============================================================
// 5. buildTabDescriptor
// ============================================================
section('5. buildTabDescriptor');

{
  const cases = [
    ['csv', 'table'],
    ['tsv', 'table'],
    ['json', 'table'],
    ['ndjson', 'table'],
    ['parquet', 'table'],
    ['xlsx', 'grid'],
    ['pdf', 'document'],
    ['audio', 'audio'],
    ['video', 'video'],
    ['unknown', 'unknown'],
  ];
  for (const [format, expectedIcon] of cases) {
    const tab = buildTabDescriptor('file_1', 'My File', format, 'ready');
    ok(tab.icon === expectedIcon, `format '${format}' maps to icon '${expectedIcon}'`);
    ok(tab.fileId === 'file_1', `tab descriptor for '${format}' preserves fileId`);
    ok(tab.status === 'ready', `tab descriptor for '${format}' preserves status`);
    ok(tab.format === format, `tab descriptor for '${format}' preserves format`);
  }
}

{
  const tab = buildTabDescriptor('file_2', 'Recording', 'audio', 'transcribing');
  ok(tab.status === 'transcribing', 'transcribing status is preserved on tab descriptor');
}

{
  const tab = buildTabDescriptor('file_3', 'Contract', 'pdf', 'indexing');
  ok(tab.status === 'indexing', 'indexing status is preserved on tab descriptor');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

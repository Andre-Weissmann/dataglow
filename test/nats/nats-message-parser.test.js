// ============================================================
// DATAGLOW — NATS WebSocket Bridge: nats-message-parser test suite
// ============================================================
// Pure Node tests, no DuckDB/browser needed.
//
// RUN WITH:  node test/nats/nats-message-parser.test.js

import {
  NATS_FORMATS,
  detectNATSFormat,
  parseNATSMessage,
  parseNATSBatch,
  inferNATSSchema,
  buildSubjectFilter,
  validateNATSConfig,
} from '../../js/nats/nats-message-parser.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ---------- detectNATSFormat ----------
  {
    const r = detectNATSFormat('{"col1": 1, "col2": "x"}');
    ok(r.format === NATS_FORMATS.JSON, 'detectNATSFormat: JSON object detected');
    ok(r.confidence === 'high', 'detectNATSFormat: JSON object has high confidence');
  }
  {
    const r = detectNATSFormat('[{"a":1},{"a":2}]');
    ok(r.format === NATS_FORMATS.JSON, 'detectNATSFormat: JSON array detected');
    ok(r.confidence === 'high', 'detectNATSFormat: JSON array has high confidence');
  }
  {
    const r = detectNATSFormat('{"a":1}\n{"a":2}\n{"a":3}');
    ok(r.format === NATS_FORMATS.NDJSON, 'detectNATSFormat: NDJSON detected');
    ok(r.confidence === 'high', 'detectNATSFormat: NDJSON has high confidence');
  }
  {
    const r = detectNATSFormat('1,foo,3.5');
    ok(r.format === NATS_FORMATS.CSV_LINE, 'detectNATSFormat: CSV line detected');
  }
  {
    const r = detectNATSFormat('just some ambiguous plain text');
    ok(r.confidence === 'low', 'detectNATSFormat: ambiguous payload has low confidence');
  }
  {
    const r = detectNATSFormat('');
    ok(r.confidence === 'low', 'detectNATSFormat: empty payload has low confidence');
  }

  // ---------- parseNATSMessage: JSON object ----------
  {
    const r = parseNATSMessage('{"col1": 1, "col2": "test"}');
    ok(r.rows.length === 1, 'parseNATSMessage: JSON object yields one row');
    ok(r.rows[0].col1 === 1 && r.rows[0].col2 === 'test', 'parseNATSMessage: JSON object row values correct');
    ok(r.format === NATS_FORMATS.JSON, 'parseNATSMessage: JSON object format tagged correctly');
    ok(r.parseErrors.length === 0, 'parseNATSMessage: JSON object has no parse errors');
  }

  // ---------- parseNATSMessage: JSON array ----------
  {
    const r = parseNATSMessage('[{"a":1},{"a":2},{"a":3}]');
    ok(r.rows.length === 3, 'parseNATSMessage: JSON array yields multiple rows');
    ok(r.rows[1].a === 2, 'parseNATSMessage: JSON array row values correct');
  }
  {
    const r = parseNATSMessage('[{"a":1}, "not an object", {"a":2}]');
    ok(r.rows.length === 2, 'parseNATSMessage: JSON array skips non-object entries');
    ok(r.parseErrors.length === 1, 'parseNATSMessage: JSON array logs error for skipped entry');
  }

  // ---------- parseNATSMessage: NDJSON ----------
  {
    const r = parseNATSMessage('{"a":1}\n{"a":2}\n{"a":3}');
    ok(r.rows.length === 3, 'parseNATSMessage: NDJSON yields multiple rows');
    ok(r.format === NATS_FORMATS.NDJSON, 'parseNATSMessage: NDJSON format tagged correctly');
  }

  // ---------- parseNATSMessage: parse errors handled gracefully ----------
  {
    const r = parseNATSMessage('{"a":1}\nnot valid json\n{"a":3}');
    ok(r.rows.length === 2, 'parseNATSMessage: NDJSON skips bad line, keeps good ones');
    ok(r.parseErrors.length === 1, 'parseNATSMessage: NDJSON logs the bad line as a parse error, non-fatal');
  }
  {
    let threw = false;
    try {
      parseNATSMessage('{invalid json here');
    } catch {
      threw = true;
    }
    ok(threw === false, 'parseNATSMessage: malformed JSON never throws');
  }

  // ---------- parseNATSMessage: CSV line ----------
  {
    const r = parseNATSMessage('1,foo,3.5', { format: NATS_FORMATS.CSV_LINE });
    ok(r.rows.length === 1, 'parseNATSMessage: CSV line yields one row');
    ok(r.rows[0].col1 === 1 && r.rows[0].col2 === 'foo' && r.rows[0].col3 === 3.5, 'parseNATSMessage: CSV line values coerced correctly');
  }
  {
    const r = parseNATSMessage('1,foo,3.5', { format: NATS_FORMATS.CSV_LINE, headers: ['id', 'name', 'amount'] });
    ok(r.rows[0].id === 1 && r.rows[0].name === 'foo' && r.rows[0].amount === 3.5, 'parseNATSMessage: CSV line respects supplied headers');
  }

  // ---------- parseNATSMessage: Protobuf stub ----------
  {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const r = parseNATSMessage(bytes);
    ok(r.format === NATS_FORMATS.PROTOBUF_STUB, 'parseNATSMessage: binary bytes classified as protobuf stub');
    ok(typeof r.rows[0].raw_base64 === 'string' && r.rows[0].raw_base64.length > 0, 'parseNATSMessage: protobuf stub returns base64 column');
  }

  // ---------- parseNATSBatch ----------
  {
    const messages = [
      { payload: '{"a":1}', subject: 'metrics.cpu' },
      { payload: '{"a":2}', subject: 'metrics.mem' },
      { payload: '{"a":3}', subject: 'metrics.cpu' },
    ];
    const r = parseNATSBatch(messages);
    ok(r.rows.length === 3, 'parseNATSBatch: accumulates rows from multiple messages');
    ok(r.messageCount === 3, 'parseNATSBatch: reports correct messageCount');
    ok(r.subjects.length === 2, 'parseNATSBatch: dedupes subjects');
    ok(r.subjects.includes('metrics.cpu') && r.subjects.includes('metrics.mem'), 'parseNATSBatch: subject list contains expected subjects');
  }
  {
    const r = parseNATSBatch([{ subject: 'x' }, { payload: '{"a":1}' }]);
    ok(r.parseErrors.length === 1, 'parseNATSBatch: missing payload logged as non-fatal error');
    ok(r.rows.length === 1, 'parseNATSBatch: continues processing after a missing-payload message');
  }

  // ---------- inferNATSSchema ----------
  {
    const rows = [
      { id: 1, amount: 3.5, name: 'a', active: true },
      { id: 2, amount: 4.25, name: 'b', active: false },
      { id: 3, amount: 5.0, name: null, active: true },
    ];
    const schema = inferNATSSchema(rows);
    const byName = Object.fromEntries(schema.map((c) => [c.name, c]));
    ok(byName.id.type === 'INTEGER', 'inferNATSSchema: detects INTEGER type');
    ok(byName.amount.type === 'DOUBLE', 'inferNATSSchema: detects DOUBLE type');
    ok(byName.name.type === 'VARCHAR', 'inferNATSSchema: detects VARCHAR type');
    ok(byName.active.type === 'BOOLEAN', 'inferNATSSchema: detects BOOLEAN type');
    ok(byName.name.nullCount === 1, 'inferNATSSchema: counts nulls correctly');
    ok(byName.id.nullCount === 0, 'inferNATSSchema: zero nulls reported when none present');
  }

  // ---------- buildSubjectFilter ----------
  {
    const filter = buildSubjectFilter('metrics.cpu');
    ok(filter('metrics.cpu') === true, 'buildSubjectFilter: matches exact subject');
    ok(filter('metrics.mem') === false, 'buildSubjectFilter: rejects non-matching exact subject');
  }
  {
    const filter = buildSubjectFilter('events.*.raw');
    ok(filter('events.orders.raw') === true, 'buildSubjectFilter: * wildcard matches single token');
    ok(filter('events.orders.users.raw') === false, 'buildSubjectFilter: * wildcard does not match multiple tokens');
    ok(filter('events.raw') === false, 'buildSubjectFilter: * wildcard requires a token to be present');
  }
  {
    const filter = buildSubjectFilter('metrics.>');
    ok(filter('metrics.cpu') === true, 'buildSubjectFilter: > wildcard matches one trailing token');
    ok(filter('metrics.cpu.usage.pct') === true, 'buildSubjectFilter: > wildcard matches multiple trailing tokens');
    ok(filter('metrics') === false, 'buildSubjectFilter: > wildcard requires at least one trailing token');
    ok(filter('other.cpu') === false, 'buildSubjectFilter: > wildcard still requires prefix match');
  }

  // ---------- validateNATSConfig ----------
  {
    const r = validateNATSConfig({ url: 'ws://localhost:4221', subject: 'metrics.>', batchSize: 100, batchIntervalMs: 1000 });
    ok(r.valid === true, 'validateNATSConfig: valid config passes');
    ok(r.errors.length === 0, 'validateNATSConfig: valid config has no errors');
  }
  {
    const r = validateNATSConfig({ url: 'http://localhost:4221', subject: 'metrics.>' });
    ok(r.valid === false, 'validateNATSConfig: rejects non-ws URL');
    ok(r.errors.some((e) => /ws:\/\/|wss:\/\//.test(e)), 'validateNATSConfig: error message mentions ws:// requirement');
  }
  {
    const r = validateNATSConfig({ url: 'ws://localhost:4221', subject: '' });
    ok(r.valid === false, 'validateNATSConfig: rejects empty subject');
  }
  {
    const r = validateNATSConfig({ url: 'wss://localhost:4221', subject: 'x', batchSize: 20000 });
    ok(r.valid === false, 'validateNATSConfig: rejects batchSize out of range');
  }
  {
    const r = validateNATSConfig({ url: 'ws://localhost:4221', subject: 'x', batchIntervalMs: 50 });
    ok(r.valid === false, 'validateNATSConfig: rejects batchIntervalMs below minimum');
  }
  {
    const r = validateNATSConfig({});
    ok(r.valid === false, 'validateNATSConfig: rejects empty config');
    ok(r.errors.length >= 2, 'validateNATSConfig: empty config reports multiple errors');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

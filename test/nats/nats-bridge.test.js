// ============================================================
// DATAGLOW — NATS WebSocket Bridge: nats-bridge test suite
// ============================================================
// Pure Node tests, no DuckDB/browser needed. The streaming validator is a
// dependency injected by the caller (deps.runStreamingValidation) — these
// tests use the real js/streaming/streaming-validator.js implementation
// (imported here, not by nats-bridge.js itself) so the integration is
// exercised end to end, plus a couple of fake-dep cases for isolation.
//
// RUN WITH:  node test/nats/nats-bridge.test.js

import {
  createNATSSession,
  processBatch,
  buildRailUpdate,
  summarizeNATSSession,
  computeBatchDrift,
  resetBaseline,
  generateConnectionGuide,
} from '../../js/nats/nats-bridge.js';
import { runStreamingValidation } from '../../js/streaming/streaming-validator.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ FAILED: ${msg}`); }
}

function main() {
  // ---------- createNATSSession ----------
  {
    const session = createNATSSession({ subject: 'metrics.>', datasetName: 'live_metrics' });
    ok(typeof session.sessionId === 'string' && session.sessionId.length > 0, 'createNATSSession: sessionId present');
    ok(session.config.subject === 'metrics.>', 'createNATSSession: config.subject set');
    ok(session.config.batchSize === 100, 'createNATSSession: default batchSize is 100');
    ok(session.config.batchIntervalMs === 1000, 'createNATSSession: default batchIntervalMs is 1000');
    ok(session.baseline === null, 'createNATSSession: baseline starts null');
    ok(session.batchCount === 0, 'createNATSSession: batchCount starts at 0');
    ok(session.totalRows === 0, 'createNATSSession: totalRows starts at 0');
    ok(Array.isArray(session.findings) && session.findings.length === 0, 'createNATSSession: findings starts empty');
  }

  // ---------- processBatch: basic accounting ----------
  {
    let session = createNATSSession({ subject: 'metrics.cpu', datasetName: 'cpu_stream' });
    const rows = [{ pct: 10 }, { pct: 20 }, { pct: 30 }];
    const result = processBatch(session, rows, { runStreamingValidation });
    ok(result.session.batchCount === 1, 'processBatch: increments batchCount');
    ok(result.session.totalRows === 3, 'processBatch: accumulates totalRows');
    ok(result.session.baseline !== null, 'processBatch: sets a baseline after first batch');
    session = result.session;

    const result2 = processBatch(session, [{ pct: 15 }, { pct: 25 }], { runStreamingValidation });
    ok(result2.session.batchCount === 2, 'processBatch: increments batchCount across batches');
    ok(result2.session.totalRows === 5, 'processBatch: totalRows accumulates across batches');
  }

  // ---------- processBatch: RailUpdate shape ----------
  {
    const session = createNATSSession({ subject: 'metrics.cpu' });
    const result = processBatch(session, [{ pct: 10 }], { runStreamingValidation });
    ok(result.railUpdate.type === 'new_batch', 'processBatch: RailUpdate has type "new_batch"');
    ok(result.railUpdate.batchNumber === 1, 'processBatch: RailUpdate reports correct batchNumber');
    ok(Array.isArray(result.railUpdate.newFindings), 'processBatch: RailUpdate.newFindings is an array');
    ok(typeof result.railUpdate.totalFindings === 'number', 'processBatch: RailUpdate.totalFindings is a number');
  }

  // ---------- processBatch: toastMessage clean ----------
  {
    const session = createNATSSession({ subject: 'metrics.cpu' });
    const result = processBatch(session, [{ pct: 10 }, { pct: 12 }], { runStreamingValidation });
    ok(result.railUpdate.toastMessage === 'New batch validated.', 'processBatch: toastMessage is clean-batch message with no prior baseline');
  }

  // ---------- processBatch: toastMessage with findings ----------
  {
    let session = createNATSSession({ subject: 'metrics.cpu' });
    // Establish a stable baseline over several consistent batches.
    for (let i = 0; i < 3; i++) {
      const r = processBatch(session, [{ pct: 10 }, { pct: 11 }, { pct: 9 }, { pct: 10 }], {
        runStreamingValidation,
        columnsToWatch: ['pct'],
      });
      session = r.session;
    }
    // Now send a batch with a wild mean shift to trigger a finding.
    const spike = processBatch(session, [{ pct: 9000 }, { pct: 9100 }, { pct: 8800 }, { pct: 9050 }], {
      runStreamingValidation,
      columnsToWatch: ['pct'],
    });
    ok(spike.findings.length > 0, 'processBatch: mean-shift batch produces findings');
    ok(/^New batch: \d+ issues? found\.$/.test(spike.railUpdate.toastMessage), 'processBatch: toastMessage includes finding count when findings exist');
  }

  // ---------- buildRailUpdate ----------
  {
    const update = buildRailUpdate(3, [], 0);
    ok(update.type === 'new_batch', 'buildRailUpdate: type is new_batch');
    ok(update.batchNumber === 3, 'buildRailUpdate: batchNumber passed through');
    ok(update.toastMessage === 'New batch validated.', 'buildRailUpdate: clean toast message when no findings');
  }
  {
    const update = buildRailUpdate(4, [{ id: 'a' }, { id: 'b' }], 5);
    ok(update.toastMessage === 'New batch: 2 issues found.', 'buildRailUpdate: pluralized toast message for multiple findings');
    ok(update.totalFindings === 5, 'buildRailUpdate: totalFindings passed through');
  }
  {
    const update = buildRailUpdate(5, [{ id: 'a' }], 1);
    ok(update.toastMessage === 'New batch: 1 issue found.', 'buildRailUpdate: singular toast message for one finding');
  }

  // ---------- summarizeNATSSession ----------
  {
    let session = createNATSSession({ subject: 'metrics.cpu', datasetName: 'cpu_stream' });
    const r = processBatch(session, [{ pct: 10 }, { pct: 20 }], { runStreamingValidation });
    session = r.session;
    const summary = summarizeNATSSession(session);
    ok(summary.datasetName === 'cpu_stream', 'summarizeNATSSession: datasetName correct');
    ok(summary.batchCount === 1, 'summarizeNATSSession: batchCount correct');
    ok(summary.totalRows === 2, 'summarizeNATSSession: totalRows correct');
    ok(summary.status === 'receiving', 'summarizeNATSSession: status is receiving after a batch');
    ok(typeof summary.errorCount === 'number' && typeof summary.warningCount === 'number', 'summarizeNATSSession: error/warning counts are numbers');
  }
  {
    const fresh = createNATSSession({ subject: 'x' });
    const summary = summarizeNATSSession(fresh);
    ok(summary.status === 'idle', 'summarizeNATSSession: fresh session status is idle');
    ok(summary.lastBatchAt === null, 'summarizeNATSSession: fresh session lastBatchAt is null');
  }

  // ---------- computeBatchDrift ----------
  {
    const prev = { newBaseline: { schemaFingerprint: 'a:INTEGER|b:VARCHAR', expectedRowsPerBatch: 100 } };
    const curr = { newBaseline: { schemaFingerprint: 'a:INTEGER|b:VARCHAR|c:DOUBLE', expectedRowsPerBatch: 100 } };
    const drift = computeBatchDrift(prev, curr);
    ok(drift.schemaChanged === true, 'computeBatchDrift: detects schema change (new column)');
    ok(drift.newColumns.includes('c'), 'computeBatchDrift: reports new column name');
    ok(drift.significantDrift === true, 'computeBatchDrift: schema change counts as significant drift');
  }
  {
    const prev = { newBaseline: { schemaFingerprint: 'a:INTEGER|b:VARCHAR', expectedRowsPerBatch: 100 } };
    const curr = { newBaseline: { schemaFingerprint: 'a:INTEGER', expectedRowsPerBatch: 100 } };
    const drift = computeBatchDrift(prev, curr);
    ok(drift.droppedColumns.includes('b'), 'computeBatchDrift: detects dropped column');
  }
  {
    const snap = { newBaseline: { schemaFingerprint: 'a:INTEGER|b:VARCHAR', expectedRowsPerBatch: 100 } };
    const drift = computeBatchDrift(snap, snap);
    ok(drift.schemaChanged === false, 'computeBatchDrift: no schema drift for identical snapshots');
    ok(drift.significantDrift === false, 'computeBatchDrift: no significant drift for identical snapshots');
    ok(drift.newColumns.length === 0 && drift.droppedColumns.length === 0, 'computeBatchDrift: no column diffs for identical snapshots');
  }
  {
    const drift = computeBatchDrift(null, null);
    ok(drift.significantDrift === false, 'computeBatchDrift: handles null snapshots gracefully');
  }

  // ---------- resetBaseline ----------
  {
    let session = createNATSSession({ subject: 'metrics.cpu' });
    const r = processBatch(session, [{ pct: 10 }], { runStreamingValidation });
    session = r.session;
    ok(session.batchCount === 1, 'resetBaseline setup: batchCount is 1 before reset');

    const resetSession = resetBaseline(session);
    ok(resetSession.batchCount === 0, 'resetBaseline: clears batchCount');
    ok(resetSession.baseline === null, 'resetBaseline: clears baseline');
    ok(resetSession.findings.length === 0, 'resetBaseline: clears findings');
    ok(resetSession.sessionId === session.sessionId, 'resetBaseline: preserves sessionId');
  }

  // ---------- generateConnectionGuide ----------
  {
    const guide = generateConnectionGuide({ url: 'ws://localhost:4221', subject: 'metrics.>' });
    ok(typeof guide === 'string' && guide.length > 0, 'generateConnectionGuide: returns a non-empty string');
    ok(guide.includes('nats-server'), 'generateConnectionGuide: mentions nats-server');
    ok(guide.includes('ws://localhost:4221'), 'generateConnectionGuide: includes the configured URL');
    ok(guide.includes('--websocket'), 'generateConnectionGuide: mentions websocket flag');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

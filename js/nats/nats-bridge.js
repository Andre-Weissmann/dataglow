// ============================================================
// DATAGLOW — NATS WebSocket Bridge: bridge layer
// ============================================================
// This module is PURE LOGIC. It never opens a WebSocket, never touches
// localStorage/IndexedDB/OPFS, and never imports the streaming validator
// directly — `processBatch` takes `runStreamingValidation` as an injected
// dependency (deps.runStreamingValidation), the same pattern used by
// js/webhook/webhook-handler.js... except that module imports the
// validator directly; this bridge goes one step further and injects it, so
// it has ZERO import coupling to js/streaming/streaming-validator.js. That
// keeps this module trivially testable in plain Node with a fake validator,
// and keeps the browser bundle free to wire the real one in.
//
// Architecture (see docs/nats-bridge.md for the full picture):
//
//   [NATS Server (local)] --ws://--> [NATS WS Client (browser)]
//     --raw bytes--> [nats-message-parser.js] --parsed rows-->
//     [streaming-validator.js] --snapshot--> [nats-bridge.js]
//     --findings + RailUpdate--> [Ambient Validation Rail in Canvas]
//
// The browser wiring calls, in order, per batch window:
//   1. parseNATSBatch(messages)              (nats-message-parser.js)
//   2. processBatch(session, rows, { runStreamingValidation })  (this file)
//   3. hands the returned `railUpdate` + `session` to the Canvas, which
//      renders the toast and appends to the Ambient Validation Rail.
// ============================================================

function makeSessionId() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `nats-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Creates a NATS bridge session.
 *
 * @param {{ subject: string, batchSize?: number, batchIntervalMs?: number, datasetName?: string }} config
 * @returns {{ sessionId: string, config: object, baseline: null, batchCount: number, totalRows: number, findings: Array }}
 */
function createNATSSession(config) {
  const cfg = config || {};
  return {
    sessionId: makeSessionId(),
    config: {
      subject: cfg.subject,
      batchSize: cfg.batchSize ?? 100,
      batchIntervalMs: cfg.batchIntervalMs ?? 1000,
      datasetName: cfg.datasetName,
    },
    baseline: null,
    batchCount: 0,
    totalRows: 0,
    findings: [],
    lastSnapshot: null,
    lastBatchAt: null,
  };
}

/**
 * Converts a raw streaming-validator result into a flat list of
 * Finding-shaped objects the Ambient Validation Rail can render.
 *
 * @param {object} snapshot - result of runStreamingValidation
 * @returns {Array<{ id: string, severity: 'error'|'warning', kind: string, message: string }>}
 */
function extractFindings(snapshot) {
  const findings = [];
  if (!snapshot) return findings;

  if (snapshot.schemaDrift && snapshot.schemaDrift.drifted) {
    findings.push({
      id: `${snapshot.batchId}-schema`,
      severity: 'error',
      kind: 'schema_drift',
      message: `Schema changed: expected "${snapshot.schemaDrift.baseline}", got "${snapshot.schemaDrift.current}".`,
    });
  }

  if (snapshot.arrivalAnomaly && snapshot.arrivalAnomaly.anomaly) {
    findings.push({
      id: `${snapshot.batchId}-arrival`,
      severity: 'warning',
      kind: 'arrival_anomaly',
      message: `Row count ${snapshot.arrivalAnomaly.actual} is outside the expected band around ${snapshot.arrivalAnomaly.expected}.`,
    });
  }

  const valueDrift = snapshot.valueDrift || {};
  for (const [colName, drift] of Object.entries(valueDrift)) {
    if (drift.meanShift) {
      findings.push({
        id: `${snapshot.batchId}-${colName}-meanshift`,
        severity: 'error',
        kind: 'value_drift',
        message: `Column "${colName}" mean shifted beyond threshold (baseline ${drift.details.baselineMean}, current ${drift.details.currentMean}).`,
      });
    }
    if (drift.nullSpike) {
      findings.push({
        id: `${snapshot.batchId}-${colName}-nullspike`,
        severity: 'warning',
        kind: 'null_spike',
        message: `Column "${colName}" null ratio spiked (baseline ${drift.details.baselineNullRatio}, current ${drift.details.currentNullRatio}).`,
      });
    }
  }

  return findings;
}

/**
 * Builds the rail update descriptor consumed by the Canvas.
 *
 * @param {number} batchNumber
 * @param {Array} newFindings
 * @param {number} totalFindings
 * @returns {{ type: 'new_batch', batchNumber: number, newFindings: Array, totalFindings: number, toastMessage: string }}
 */
function buildRailUpdate(batchNumber, newFindings, totalFindings) {
  const findings = newFindings || [];
  const toastMessage = findings.length === 0
    ? 'New batch validated.'
    : `New batch: ${findings.length} issue${findings.length === 1 ? '' : 's'} found.`;

  return {
    type: 'new_batch',
    batchNumber,
    newFindings: findings,
    totalFindings,
    toastMessage,
  };
}

/**
 * Processes a batch of parsed rows through the (injected) streaming
 * validator and produces an updated session plus a Canvas-ready rail
 * update descriptor.
 *
 * @param {object} session - a session from createNATSSession (or a
 *   previously-returned updated session)
 * @param {object[]} rows - parsed rows for this batch (from
 *   parseNATSBatch / parseNATSMessage)
 * @param {{ runStreamingValidation: Function, columns?: Array, columnsToWatch?: string[], now?: string }} deps
 * @returns {{ session: object, snapshot: object, findings: Array, railUpdate: object }}
 */
function processBatch(session, rows, deps = {}) {
  const runStreamingValidation = deps.runStreamingValidation;
  if (typeof runStreamingValidation !== 'function') {
    throw new TypeError('processBatch requires deps.runStreamingValidation to be injected.');
  }

  const safeRows = Array.isArray(rows) ? rows : [];
  const arrivedAt = deps.now || new Date().toISOString();

  // Infer columns from the rows themselves if the caller didn't supply an
  // explicit schema — keeps this bridge usable without a prior schema step.
  const columns = deps.columns || inferColumnsFromRows(safeRows);
  const columnsToWatch = deps.columnsToWatch || columns
    .filter((c) => c.type === 'INTEGER' || c.type === 'DOUBLE')
    .map((c) => c.name);

  const batch = { columns, rows: safeRows, arrivedAt };

  const snapshot = runStreamingValidation(batch, session.baseline, { columnsToWatch });

  const newFindings = extractFindings(snapshot);
  const batchNumber = session.batchCount + 1;
  const allFindings = [...session.findings, ...newFindings];

  const updatedSession = {
    ...session,
    baseline: snapshot.newBaseline,
    batchCount: batchNumber,
    totalRows: session.totalRows + safeRows.length,
    findings: allFindings,
    lastSnapshot: snapshot,
    lastBatchAt: arrivedAt,
  };

  const railUpdate = buildRailUpdate(batchNumber, newFindings, allFindings.length);

  return { session: updatedSession, snapshot, findings: newFindings, railUpdate };
}

function inferColumnsFromRows(rows) {
  const names = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names.map((name) => {
    let type = 'VARCHAR';
    for (const row of rows) {
      const value = row[name];
      if (value === null || value === undefined) continue;
      if (typeof value === 'number') {
        type = Number.isInteger(value) ? 'INTEGER' : 'DOUBLE';
      } else if (typeof value === 'boolean') {
        type = 'BOOLEAN';
      } else {
        type = 'VARCHAR';
      }
      break;
    }
    return { name, type };
  });
}

/**
 * Summarizes a NATS session for the status bar / agent presence line.
 *
 * @param {object} session
 * @returns {{ datasetName: string|undefined, batchCount: number, totalRows: number,
 *   totalFindings: number, errorCount: number, warningCount: number,
 *   lastBatchAt: string|null, status: 'idle'|'receiving'|'paused' }}
 */
function summarizeNATSSession(session) {
  const s = session || {};
  const findings = Array.isArray(s.findings) ? s.findings : [];
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  let status = 'idle';
  if (s.batchCount > 0) {
    status = 'receiving';
  }

  return {
    datasetName: s.config ? s.config.datasetName : undefined,
    batchCount: s.batchCount || 0,
    totalRows: s.totalRows || 0,
    totalFindings: findings.length,
    errorCount,
    warningCount,
    lastBatchAt: s.lastBatchAt || null,
    status,
  };
}

/**
 * Computes drift between two consecutive batch snapshots (from
 * runStreamingValidation), independent of the intra-batch drift pillars —
 * this looks at schema/row-rate changes across NATS batches specifically.
 *
 * @param {object|null} previousSnapshot
 * @param {object|null} currentSnapshot
 * @returns {{ schemaChanged: boolean, newColumns: string[], droppedColumns: string[],
 *   rowRateDelta: number, significantDrift: boolean }}
 */
function computeBatchDrift(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot || !currentSnapshot) {
    return {
      schemaChanged: false,
      newColumns: [],
      droppedColumns: [],
      rowRateDelta: 0,
      significantDrift: false,
    };
  }

  const prevFingerprint = previousSnapshot.newBaseline ? previousSnapshot.newBaseline.schemaFingerprint : '';
  const currFingerprint = currentSnapshot.newBaseline ? currentSnapshot.newBaseline.schemaFingerprint : '';

  const prevCols = new Set(
    (prevFingerprint || '').split('|').filter(Boolean).map((entry) => entry.split(':')[0])
  );
  const currCols = new Set(
    (currFingerprint || '').split('|').filter(Boolean).map((entry) => entry.split(':')[0])
  );

  const newColumns = [...currCols].filter((c) => !prevCols.has(c));
  const droppedColumns = [...prevCols].filter((c) => !currCols.has(c));
  const schemaChanged = prevFingerprint !== currFingerprint;

  const prevRows = previousSnapshot.newBaseline ? previousSnapshot.newBaseline.expectedRowsPerBatch : 0;
  const currRows = currentSnapshot.newBaseline ? currentSnapshot.newBaseline.expectedRowsPerBatch : 0;
  const rowRateDelta = currRows - prevRows;

  const significantDrift =
    schemaChanged ||
    (prevRows > 0 && Math.abs(rowRateDelta) > prevRows * 0.3);

  return { schemaChanged, newColumns, droppedColumns, rowRateDelta, significantDrift };
}

/**
 * Resets a session's drift anchor: clears the baseline, batch count, and
 * accumulated findings, but keeps the session identity/config so the
 * connection doesn't need to be re-established.
 *
 * @param {object} session
 * @returns {object} a new session object with baseline/batchCount/findings reset
 */
function resetBaseline(session) {
  const s = session || {};
  return {
    ...s,
    baseline: null,
    batchCount: 0,
    totalRows: 0,
    findings: [],
    lastSnapshot: null,
    lastBatchAt: null,
  };
}

/**
 * Generates a plain-text connection guide, shown in the Canvas NATS setup
 * UI, walking the user through installing and starting a local NATS
 * server with WebSocket enabled, publishing a test message, and pointing
 * DataGlow at it.
 *
 * @param {{ url: string, subject?: string }} config
 * @returns {string}
 */
function generateConnectionGuide(config) {
  const cfg = config || {};
  const url = cfg.url || 'ws://localhost:4221';
  const subject = cfg.subject || 'metrics.>';

  return [
    '1. Install NATS Server: brew install nats-server (macOS) / see nats.io',
    '2. Start with WebSocket: nats-server -p 4222 -m 8222 --websocket --websocket-port 4221',
    `3. Publish test message: nats pub ${subject} '{"col1": 1, "col2": "test"}'`,
    `4. DataGlow connects to: ${url}`,
  ].join('\n');
}

export {
  createNATSSession,
  processBatch,
  buildRailUpdate,
  summarizeNATSSession,
  computeBatchDrift,
  resetBaseline,
  generateConnectionGuide,
};

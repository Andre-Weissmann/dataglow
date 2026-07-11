// ============================================================
// DATAGLOW — Portable `.dataglow` Provenance Packet (format + sign/verify)
// ============================================================
// A single-file, portable, SIGNED "passport for a dataset". It bundles the
// provenance artifacts other modules already produce — the cell-level transform
// history (data-blame), the HIPAA Safe Harbor de-identification attestation, and
// the claims denial-risk profile + cost-of-bad-data estimate — into ONE JSON
// document that can be shared and re-checked on a machine that never loaded the
// original data. The point is "prove properties without sharing the data": the
// packet is self-contained, so an importer sees the results and can confirm the
// document has not been altered since export, without the source rows.
//
// This module is PURE and dependency-light: it does NOT import the four section
// producers (js/provenance/data-blame.js, deidentification-verifier.js,
// denial-root-cause.js, cost-of-bad-data.js). It receives their OUTPUT SHAPES as
// plain data and embeds them verbatim, so the format stays stable no matter how
// those producers evolve, and this file builds/tests fine even before those
// sibling modules are merged. The only shared primitive is `sha256Hex` — the
// SAME Web-Crypto hash the provenance chain of custody and every attestation in
// the repo already use; no new crypto is introduced.
//
// TAMPER MODEL: the top-level signature is a SHA-256 digest over the packet's
// entire canonical core (format version + timestamp + producer + dataset +
// every section, including each embedded attestation's own digest). Because the
// core covers everything but the signature itself, ANY post-export edit — to a
// blame entry, a verdict, a cost number, or a nested attestation — changes the
// recomputed digest and is caught on import. Sections are OPTIONAL: whatever has
// not been run is omitted, never faked, and the signature commits to exactly the
// sections that are present.

import { sha256Hex } from './provenance.js';

export const PACKET_KIND = 'dataglow-provenance-packet';
export const PACKET_FORMAT_VERSION = 1;
export const PACKET_FILE_EXTENSION = '.dataglow.json';

// The four section slots, in a fixed display order. Keys are stable — other
// work depends on this format, so treat them as part of the contract.
export const PACKET_SECTIONS = ['dataBlame', 'deidentification', 'denialRisk', 'costOfBadData'];

// ---- helpers ---------------------------------------------------------------

function isoNow() {
  return new Date().toISOString();
}

// Pull a plausible ISO timestamp out of an embedded producer output, falling
// back to the packet's own generatedAt so every section carries a timestamp.
function sectionTimestamp(data, fallback) {
  if (data && typeof data === 'object' && typeof data.generatedAt === 'string') return data.generatedAt;
  return fallback;
}

// Wrap one producer output in the standard section envelope. `data == null`
// means "not run" → the section is omitted entirely (present:false, no data),
// so an importer can distinguish "ran and found nothing" from "never ran".
function makeSection(data, generatedAt) {
  if (data == null) return { present: false };
  return { present: true, sectionVersion: 1, generatedAt: sectionTimestamp(data, generatedAt), data };
}

// Normalize a data-blame input into the section payload. Accepts either the
// `buildBlameIndex(trail)` shape `{ entries, byColumn }` or a flat `replayLog`
// array; stores both a flat log and the per-column index so an importer needs
// neither the original trail nor the data-blame module to render the history.
function normalizeBlame(blame) {
  if (blame == null) return null;
  if (Array.isArray(blame)) {
    return { log: blame, byColumn: indexByColumn(blame) };
  }
  if (typeof blame === 'object') {
    const entries = Array.isArray(blame.entries) ? blame.entries
      : (Array.isArray(blame.log) ? blame.log : []);
    const byColumn = blame.byColumn && typeof blame.byColumn === 'object'
      ? blame.byColumn : indexByColumn(entries);
    return { log: entries, byColumn };
  }
  return null;
}

function indexByColumn(entries) {
  const byColumn = {};
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const cols = Array.isArray(e && e.columns) ? e.columns : [];
    for (const c of cols) (byColumn[c] || (byColumn[c] = [])).push(e);
  }
  return byColumn;
}

// ---- packet assembly -------------------------------------------------------

// The canonical core the signature commits to: the whole packet minus the
// signature block. Serialized deterministically (stable key order via the fixed
// object literal) so the digest is a pure function of the content.
export function packetCore(packet) {
  return {
    kind: packet.kind,
    formatVersion: packet.formatVersion,
    generatedAt: packet.generatedAt,
    producer: packet.producer,
    dataset: packet.dataset,
    sections: packet.sections,
  };
}

export async function computePacketSignature(packet) {
  return sha256Hex(JSON.stringify(packetCore(packet)));
}

// Build a signed packet from whatever sections are available. Every section is
// optional; pass `null`/omit to leave one out. `dataset` describes the dataset
// the packet is about (table, rowCount, columns) so the packet is meaningful
// without the rows themselves.
//
//   buildPacket({
//     dataset:          { table, rowCount, columns, sourceHash },
//     blame:            buildBlameIndex(trail) | replayLog(trail) | null,
//     deidentification: buildDeidAttestation(report) | null,
//     denial:           buildDenialAttestation(report) | buildDenialReport(...) | null,
//     cost:             estimateCostOfBadData({...}) | null,
//     generatedAt, producer,
//   })
export async function buildPacket({
  dataset = null, blame = null, deidentification = null, denial = null, cost = null,
  generatedAt = null, producer = null,
} = {}) {
  const ts = generatedAt || isoNow();
  const ds = dataset && typeof dataset === 'object' ? {
    table: dataset.table ?? null,
    rowCount: dataset.rowCount ?? null,
    columns: Array.isArray(dataset.columns)
      ? dataset.columns.map(c => (typeof c === 'string' ? { name: c, type: null } : { name: c.name, type: c.type ?? null }))
      : [],
    sourceHash: dataset.sourceHash ?? null,
  } : { table: null, rowCount: null, columns: [], sourceHash: null };

  // If a full denial report (not the attestation) was passed and no explicit
  // cost was, lift its embedded cost estimate so the section is populated.
  const costData = cost != null ? cost
    : (denial && typeof denial === 'object' && denial.cost ? denial.cost : null);

  const packet = {
    kind: PACKET_KIND,
    formatVersion: PACKET_FORMAT_VERSION,
    generatedAt: ts,
    producer: producer && typeof producer === 'object'
      ? { app: producer.app ?? 'DATAGLOW', version: producer.version ?? null, build: producer.build ?? null }
      : { app: 'DATAGLOW', version: '1.0.0', build: null },
    dataset: ds,
    sections: {
      dataBlame: makeSection(normalizeBlame(blame), ts),
      deidentification: makeSection(deidentification, ts),
      denialRisk: makeSection(denial, ts),
      costOfBadData: makeSection(costData, ts),
    },
  };

  const value = await computePacketSignature(packet);
  packet.signature = {
    algorithm: 'SHA-256',
    value,
    covers: 'kind, formatVersion, generatedAt, producer, dataset, sections',
  };
  packet.disclaimer =
    'A DATAGLOW Provenance Packet is a cryptographic integrity record that bundles the provenance artifacts '
    + 'produced for a dataset. Each embedded section carries its own producer disclaimer and remains a heuristic '
    + 'screening aid, not a certification, determination, or guarantee. The top-level signature proves only that '
    + 'this document has not been altered since it was exported — it does not attest to the correctness of the '
    + 'underlying data or of any section.';
  return packet;
}

// ---- verification (tamper detection) ---------------------------------------

// Re-verify a packet from scratch: confirm it is a DATAGLOW packet of a known
// format version and that its stored signature matches a freshly recomputed
// digest over its canonical core. Because the core covers every section, this
// one check detects tampering anywhere in the document.
export async function verifyPacket(packet) {
  if (!packet || typeof packet !== 'object' || packet.kind !== PACKET_KIND) {
    return { valid: false, reason: 'Not a DATAGLOW Provenance Packet (missing or incorrect "kind").', signature: null };
  }
  if (packet.formatVersion !== PACKET_FORMAT_VERSION) {
    return {
      valid: false,
      reason: `Unsupported packet format version ${packet.formatVersion}; this build understands version ${PACKET_FORMAT_VERSION}.`,
      signature: null,
    };
  }
  const stored = packet.signature && packet.signature.value;
  if (!stored) {
    return { valid: false, reason: 'Packet is unsigned — no signature to verify against.', signature: { stored: null, recomputed: null } };
  }
  const recomputed = await computePacketSignature(packet);
  const valid = recomputed === stored;
  return {
    valid,
    reason: valid
      ? 'Packet verified: the signature matches its contents — the document has not been altered since export.'
      : 'SIGNATURE MISMATCH — this packet was modified after it was signed. Do not trust its contents.',
    signature: { stored, recomputed },
  };
}

// ---- serialize / parse -----------------------------------------------------

export function serializePacket(packet) {
  return JSON.stringify(packet, null, 2);
}

// Parse packet text. Throws a clear error on invalid JSON or a document that is
// not a DATAGLOW packet, so a caller can show an unambiguous import error rather
// than silently treating garbage as a packet. Signature validity is a SEPARATE
// step (verifyPacket) — parsing succeeds for a tampered-but-well-formed packet
// so the importer can still surface the tamper warning.
export function parsePacket(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON — this does not look like a DATAGLOW packet (${e.message}).`);
  }
  if (!obj || typeof obj !== 'object' || obj.kind !== PACKET_KIND) {
    throw new Error('Not a DATAGLOW Provenance Packet (missing or incorrect "kind").');
  }
  return obj;
}

// A stable download filename for a packet, e.g. "dataglow-packet-claims.dataglow.json".
export function packetFilename(packet) {
  const table = packet && packet.dataset && packet.dataset.table;
  const safe = (table ? String(table) : 'dataset').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `dataglow-packet-${safe}${PACKET_FILE_EXTENSION}`;
}

// ---- read-only summary (self-contained, no source data needed) -------------

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Project a packet into a flat, presentational summary an importer can render
// without the original dataset and without any of the producer modules. Every
// field is read defensively from the embedded section data.
export function summarizePacket(packet) {
  const sections = (packet && packet.sections) || {};
  const out = {
    kind: packet ? packet.kind : null,
    formatVersion: packet ? packet.formatVersion : null,
    generatedAt: packet ? packet.generatedAt : null,
    producer: packet ? packet.producer : null,
    dataset: packet ? packet.dataset : null,
    sections: {},
  };

  const blame = sections.dataBlame;
  if (blame && blame.present && blame.data) {
    const log = Array.isArray(blame.data.log) ? blame.data.log : [];
    const byColumn = blame.data.byColumn && typeof blame.data.byColumn === 'object' ? blame.data.byColumn : {};
    out.sections.dataBlame = {
      present: true,
      generatedAt: blame.generatedAt,
      changeCount: log.length,
      columnsTouched: Object.keys(byColumn),
      log,
    };
  } else {
    out.sections.dataBlame = { present: false };
  }

  const deid = sections.deidentification;
  if (deid && deid.present && deid.data) {
    const d = deid.data;
    out.sections.deidentification = {
      present: true,
      generatedAt: deid.generatedAt,
      verdict: d.verdict ?? null,
      flaggedCategories: d.safeHarbor ? num(d.safeHarbor.flaggedCount) : null,
      reidentificationLevel: d.reidentification ? (d.reidentification.level ?? null) : null,
      reidentificationScore: d.reidentification ? num(d.reidentification.score) : null,
      hasDigest: !!(d.digest && d.digest.value),
    };
  } else {
    out.sections.deidentification = { present: false };
  }

  const denial = sections.denialRisk;
  if (denial && denial.present && denial.data) {
    const d = denial.data;
    const cats = Array.isArray(d.categories) ? d.categories : [];
    out.sections.denialRisk = {
      present: true,
      generatedAt: denial.generatedAt,
      totalFlaggedRows: num(d.totalFlaggedRows),
      totalFlaggedPct: num(d.totalFlaggedPct),
      categories: cats.map(c => ({ id: c.id ?? null, label: c.label ?? null, flaggedRows: num(c.flaggedRows) ?? num(c.flagged) })),
      hasDigest: !!(d.digest && d.digest.value),
    };
  } else {
    out.sections.denialRisk = { present: false };
  }

  const cost = sections.costOfBadData;
  if (cost && cost.present && cost.data) {
    const c = cost.data;
    out.sections.costOfBadData = {
      present: true,
      generatedAt: cost.generatedAt,
      flaggedCount: num(c.flaggedCount),
      perErrorCost: num(c.perErrorCost),
      currency: c.currency ?? null,
      estimatedRiskAmount: num(c.estimatedRiskAmount),
      formatted: c.formatted ?? null,
      label: c.label ?? null,
      isDefaultCost: !!c.isDefaultCost,
    };
  } else {
    out.sections.costOfBadData = { present: false };
  }

  out.presentSections = PACKET_SECTIONS.filter(k => out.sections[k] && out.sections[k].present);
  return out;
}

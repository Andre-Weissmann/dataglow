// ============================================================
// DATAGLOW — Federated coordination-branch pruner
// ============================================================
// Run by the scheduled `federated-coordination` GitHub Action every few minutes.
// It rewrites coordination.json on the coordination branch, DROPPING every
// peer-presence entry and relay update older than the TTL, so the "phone book"
// rotates itself and never accumulates history.
//
// The pruning LOGIC lives in js/federated-learning.js (pruneCoordinationEntries),
// so it is unit-tested in CI; this wrapper only does file I/O. GitHub only ever
// stores ephemeral signaling metadata + already-masked/DP-noised weight deltas —
// never any raw data.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pruneCoordinationEntries, COORDINATION_TTL_MS } from '../../js/federated/federated-learning.js';

const FILE = process.env.COORDINATION_FILE || 'coordination.json';
const now = Date.now();

function load() {
  if (!existsSync(FILE)) return { kind: 'dataglow-federated-coordination', version: 1, peers: [], relay: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { return { kind: 'dataglow-federated-coordination', version: 1, peers: [], relay: [] }; }
}

const file = load();
const beforePeers = Array.isArray(file.peers) ? file.peers.length : 0;
const beforeRelay = Array.isArray(file.relay) ? file.relay.length : 0;

const pruned = {
  kind: 'dataglow-federated-coordination',
  version: 1,
  rotatedAt: now,
  ttlMs: COORDINATION_TTL_MS,
  peers: pruneCoordinationEntries(file.peers, now, COORDINATION_TTL_MS),
  relay: (Array.isArray(file.relay) ? file.relay : []).filter(
    e => e && typeof e.ts === 'number' && (now - e.ts) <= COORDINATION_TTL_MS,
  ),
};

writeFileSync(FILE, JSON.stringify(pruned, null, 2) + '\n');
console.log(
  `pruned coordination.json: peers ${beforePeers} -> ${pruned.peers.length}, relay ${beforeRelay} -> ${pruned.relay.length}`,
);

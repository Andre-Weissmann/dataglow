// ============================================================
// DATAGLOW — Open Floor Sandbox Twin (Gen 45, Batch B)
// ============================================================
// A forkable, disposable, in-memory COPY of an already-loaded dataset that an
// autonomous agent (or a curious stakeholder on the Open Floor) can beat on
// freely — propose deletes, drops, perturbations, whatever — WITHOUT any risk to
// the real data, because two structural guarantees hold at once:
//
//   1. FORK ISOLATION. The twin is a deep copy taken at fork time. Nothing the
//      twin does can reach the real dataset by reference: mutating the twin only
//      ever rewrites the twin's own row array, and `reset()` restores the exact
//      fork baseline, so every twin op is reversible/disposable by construction.
//
//   2. NOTHING APPLIES WITHOUT THE FIREWALL. EVERY mutation — against the twin
//      AND, especially, PROMOTING a twin result back into the real dataset —
//      routes through the Agent Action Firewall (js/agents/agent-action-firewall.js)
//      and its mandatory, per-action, human-confirmed, single-use-nonce handshake.
//      There is no trusted/auto/force path here just as there is none in the
//      firewall. An agent may PROPOSE anything (proposeAction never executes);
//      it can APPLY nothing without an explicit human confirmation.
//
// This is the Open Floor's answer to the April 2026 "agent deleted prod + all
// backups in nine seconds" incident: give the agent a sandbox it can wreck, and
// make the door back to reality a firewall-gated, human-confirmed promote.
//
// GRACEFUL DEGRADATION: if the firewall module cannot be loaded (e.g. a build
// that ships this piece without Batch-1 of the Passport), the twin does NOT
// throw at construction — it comes up in a DISABLED state that FAILS CLOSED:
// every propose/apply/promote call console.warns and refuses. A dataset is never
// mutated as a side effect of the firewall being absent.
//
// PURITY: no DOM, no network, no storage. Diffing REUSES time-travel-diff.js and
// perturbation REUSES digital-twin.js — this module owns neither. The firewall is
// resolved via an INJECTED dependency (tests) or a dynamic import (browser), the
// same injected-dependency pattern used across the codebase.

import { perturbRows } from './digital-twin.js';
import { diffRows, detectKeyColumn } from './time-travel-diff.js';

const FIREWALL_MODULE = '../agents/agent-action-firewall.js';

function isUsableFirewall(mod) {
  return !!mod && typeof mod.confirmAndApply === 'function' && typeof mod.proposeAction === 'function';
}

// Resolve the firewall:
//   * a valid injected module (tests / explicit wiring) wins;
//   * `firewall === false` forces the DISABLED/unavailable state (no import attempt) —
//     this lets a caller, and the red-team test, exercise the real fail-closed branch;
//   * an injected-but-invalid object is treated as unavailable (warn, disable) rather
//     than silently importing something else;
//   * otherwise (nothing injected) dynamic-import the sibling.
// A failed import is NOT fatal — we return null and the twin comes up disabled.
async function resolveFirewall(injected) {
  if (injected === false) {
    console.warn('[sandbox-twin] Agent Action Firewall explicitly unavailable — twin disabled (fail closed).');
    return null;
  }
  if (injected != null) {
    if (isUsableFirewall(injected)) return injected;
    console.warn('[sandbox-twin] Injected Agent Action Firewall is missing proposeAction/confirmAndApply — twin disabled (fail closed).');
    return null;
  }
  try {
    const mod = await import(FIREWALL_MODULE);
    if (isUsableFirewall(mod)) return mod;
    console.warn('[sandbox-twin] Agent Action Firewall module loaded but is missing proposeAction/confirmAndApply — twin disabled (fail closed).');
    return null;
  } catch (err) {
    console.warn(
      '[sandbox-twin] Agent Action Firewall module unavailable — the sandbox twin is disabled and will apply NO mutation (fail closed). ' +
      'Ship Batch-1 of the DataGlow Passport (js/agents/agent-action-firewall.js) to enable it.',
      err && err.message ? err.message : err,
    );
    return null;
  }
}

// Normalize a schema to the two shapes the reused modules expect:
//   colObjects : [{name,type}]  (digital-twin's perturbRows)
//   colNames   : ['name', ...]  (time-travel-diff's detectKeyColumn/diffRows)
function normalizeColumns(columns) {
  const colObjects = (columns || []).map(c =>
    typeof c === 'string' ? { name: c, type: '' } : { name: c.name, type: c.type || '' });
  return { colObjects, colNames: colObjects.map(c => c.name) };
}

function deepCopyRows(rows) {
  return rows.map(r => ({ ...r }));
}

/**
 * Fork a disposable sandbox twin from an already-loaded dataset.
 *
 * Async because it may need to dynamic-import the firewall; pass `firewall` to
 * inject it (tests / explicit wiring) and the call resolves synchronously-ish.
 *
 * @param {object} args
 * @param {Array<object>} args.realRows   rows the caller ALREADY read from the live table (never mutated here)
 * @param {Array<{name:string,type?:string}>|string[]} args.columns  the live schema
 * @param {string} [args.keyColumn]       primary key for diffing; auto-detected when omitted
 * @param {object} [args.firewall]        injected firewall module (else dynamic import)
 * @returns {Promise<object>}             the twin handle (see methods below)
 */
export async function createSandboxTwin({ realRows, columns, keyColumn = null, firewall = null } = {}) {
  if (!Array.isArray(realRows)) throw new Error('createSandboxTwin needs a realRows array.');
  const { colObjects, colNames } = normalizeColumns(columns);
  if (!colNames.length) throw new Error('createSandboxTwin needs a non-empty column schema.');

  const fw = await resolveFirewall(firewall);
  const enabled = !!fw;

  // The immutable fork point: the twin can always be reset to exactly this, which
  // is also what the real dataset looked like at fork time (so diff() is twin-vs-real).
  const forkBaseline = Object.freeze(deepCopyRows(realRows));
  let twinRows = deepCopyRows(realRows);
  let disposed = false;

  const key = keyColumn || detectKeyColumn(colNames, forkBaseline);

  function ensureLive() {
    if (disposed) throw new Error('sandbox twin has been disposed.');
  }

  // Shared refusal used whenever the firewall is absent: warn + fail closed.
  function refuseNoFirewall(op) {
    console.warn(`[sandbox-twin] ${op} refused: Agent Action Firewall unavailable, so no mutation can be human-confirmed (fail closed).`);
    return { ok: false, applied: false, blocked: true, reason: 'firewall-unavailable' };
  }

  return Object.freeze({
    isSandboxTwin: true,
    enabled,
    keyColumn: key,

    /** A COPY of the twin's current rows — callers never get the live array. */
    getRows() { ensureLive(); return deepCopyRows(twinRows); },
    getColumns() { return colObjects.map(c => ({ ...c })); },
    getRowCount() { ensureLive(); return twinRows.length; },

    /**
     * PROPOSE a mutation. Pure classification + a single-use nonce; executes
     * NOTHING. Safe to call as often as an agent likes. Returns null (and warns)
     * when the firewall is unavailable.
     */
    propose(action) {
      ensureLive();
      if (!enabled) { refuseNoFirewall('propose'); return null; }
      return fw.proposeAction(action);
    },

    /**
     * Apply a mutation TO THE TWIN — still firewall-gated. `mutate(rows, columns)`
     * returns the next rows[] (or {rows}); it runs ONLY after the firewall's
     * per-action human confirmation passes. Reversible: `reset()` undoes it.
     * Throws AgentActionBlocked (from the firewall) when confirmation is
     * missing/invalid — the twin is left untouched (inert).
     */
    async applyToTwin({ proposal, confirmation, mutate }) {
      ensureLive();
      if (!enabled) return refuseNoFirewall('applyToTwin');
      if (typeof mutate !== 'function') throw new Error('applyToTwin needs a mutate(rows, columns) function.');
      const apply = () => {
        const next = mutate(deepCopyRows(twinRows), colObjects);
        const nextRows = Array.isArray(next) ? next : (next && Array.isArray(next.rows) ? next.rows : null);
        if (!nextRows) throw new Error('twin mutate must return an array of rows or { rows }.');
        twinRows = deepCopyRows(nextRows);
        return { rowCount: twinRows.length };
      };
      const res = await fw.confirmAndApply({ proposal, confirmation, apply });
      return { ok: true, applied: true, ...res };
    },

    /**
     * Convenience: propose + apply a REUSED digital-twin perturbation against the
     * twin in one firewall-gated step. `confirmation` supplies { confirmed, identity };
     * the nonce is threaded internally. Never touches real data.
     */
    async perturbTwin({ knobs = {}, seed = undefined, confirmation } = {}) {
      ensureLive();
      if (!enabled) return refuseNoFirewall('perturbTwin');
      const proposal = fw.proposeAction({
        kind: 'transform-column',
        description: 'Sandbox perturbation (digital-twin what-if) applied to the disposable twin only.',
      });
      const conf = { ...(confirmation || {}), nonce: proposal.nonce };
      return this.applyToTwin({
        proposal,
        confirmation: conf,
        mutate: (rows) => perturbRows(rows, colObjects, knobs, seed === undefined ? undefined : { seed }).rows,
      });
    },

    /**
     * PROMOTE the twin's current state back into the REAL dataset. This is the
     * ONLY method that can touch real data, and it does so exclusively through
     * the firewall: `applyToReal(twinRows)` — the caller's real-table writer — is
     * invoked ONLY after the per-action human confirmation passes. Missing/invalid
     * confirmation throws AgentActionBlocked and applyToReal is NEVER called.
     * The authorization is written to the chain of custody via recordAudit.
     */
    async promoteToReal({ proposal, confirmation, applyToReal, recordAudit }) {
      ensureLive();
      if (!enabled) return refuseNoFirewall('promoteToReal');
      if (typeof applyToReal !== 'function') throw new Error('promoteToReal needs an applyToReal(rows) executor.');
      const snapshot = deepCopyRows(twinRows);
      const apply = () => applyToReal(snapshot);
      const res = await fw.confirmAndApply({ proposal, confirmation, apply, recordAudit });
      return { ok: true, promoted: true, ...res };
    },

    /**
     * Diff the twin against the real dataset at fork time. REUSES
     * time-travel-diff's diffRows — this module owns no diffing logic.
     */
    diff() {
      ensureLive();
      if (!key) return { keyColumn: null, added: [], removed: [], changed: [], unchanged: 0, countA: forkBaseline.length, countB: twinRows.length, note: 'no unique key column; row-level diff unavailable.' };
      return diffRows(forkBaseline, twinRows, key);
    },

    /** Restore the twin to the fork baseline. Local, safe, no confirmation needed. */
    reset() { ensureLive(); twinRows = deepCopyRows(forkBaseline); return { ok: true, rowCount: twinRows.length }; },

    /** Discard the twin. Frees the working copy; further calls throw. */
    dispose() { twinRows = []; disposed = true; return { ok: true }; },
  });
}

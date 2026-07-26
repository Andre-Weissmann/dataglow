// ============================================================
// DATAGLOW - Proof Harness v1: Regression Vault
// ============================================================
// WHY THIS EXISTS
// PROOF_HARNESS_V1_SPEC.md, pillar 2: every RED verdict and every human
// rejection (a refused confirm, or an explicit Reject action) appends a
// durable local vault test -- a seeded repeat of a prior RED must fail again
// (caught), the same "does this regression stay caught" discipline a unit
// test suite gives a codebase, applied to claims instead of code.
//
// A vault test is plain data: { id, claimText, statement, expected,
// createdAt, source }. `runVault({ runQuery })` re-runs every test through
// the SAME injected runner discipline every other proof-harness module uses
// (never talks to DuckDB directly) and reports pass/fail per test -- "pass"
// here means the vault test's ORIGINAL bad outcome is still reproduced (the
// regression is still caught), not that the claim is now true. A vault test
// that suddenly comes back GREEN is the vault's alarm bell: something that
// used to be wrong is no longer being caught as wrong, which is exactly the
// silent-regression case this module exists to surface.
//
// STORAGE: in-memory always; `localStorage` under key
// `dataglow.proofHarness.vault.v1` when available (browser only). Never
// uploads -- this module makes no network call anywhere. A caller (tests, a
// non-browser host) may inject its own storage object shaped like
// `localStorage` ({getItem, setItem, removeItem}) via createVault({storage}),
// so this module needs no `typeof window` branch to stay Node-testable.
//
// PURITY: no DOM, no network. `runQuery` is the only injected side effect,
// exactly like runProofCycle's own injected runner.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const VAULT_STORAGE_KEY = 'dataglow.proofHarness.vault.v1';

/** SHA-256 of a string, lowercase hex. Same algorithm as proposal.js/receipt.js. */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function resolveStorage(injected) {
  if (injected && typeof injected.getItem === 'function' && typeof injected.setItem === 'function') return injected;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (_e) { /* localStorage can throw in a locked-down context; fall back to memory-only */ }
  return null;
}

function readStored(storage) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return []; // malformed/corrupt storage never throws out; starts clean
  }
}

function writeStored(storage, tests) {
  if (!storage) return;
  try {
    storage.setItem(VAULT_STORAGE_KEY, JSON.stringify(tests));
  } catch (_e) { /* storage full/unavailable mid-session: vault stays in-memory-only for this session */ }
}

/**
 * Build one vault test record from a prove cycle's inputs. Never throws;
 * a malformed input still produces a usable record with safe defaults.
 * @param {{claimText?:string, statement:string, expected?:object,
 *          source:'red'|'reject'}} input
 */
export async function buildVaultTest(input) {
  const inp = isPlainObject(input) ? input : {};
  const statement = typeof inp.statement === 'string' ? inp.statement : '';
  const expected = isPlainObject(inp.expected) ? { ...inp.expected } : {};
  const source = inp.source === 'reject' ? 'reject' : 'red';
  const createdAt = Number.isFinite(inp.createdAt) ? inp.createdAt : Date.now();
  const idSeed = JSON.stringify({ statement, expected, source, createdAt, salt: Math.random() });
  const id = 'vault-' + (await sha256Hex(idSeed)).slice(0, 16);
  return {
    id,
    claimText: typeof inp.claimText === 'string' && inp.claimText.trim() ? inp.claimText.trim() : null,
    statement,
    expected,
    createdAt,
    source,
  };
}

/**
 * A durable local Regression Vault. In-memory always; persists to the
 * injected/global localStorage when available. NEVER uploads -- there is no
 * network call anywhere in this module.
 * @param {{storage?: {getItem:Function, setItem:Function}}} [opts]
 */
export function createVault(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const storage = resolveStorage(o.storage);
  let tests = readStored(storage);

  /**
   * Append a new vault test from a RED verdict or a human rejection. Never
   * throws. Returns the stored test record.
   * @param {{claimText?:string, statement:string, expected?:object, source:'red'|'reject'}} input
   */
  async function add(input) {
    const test = await buildVaultTest(input);
    tests = tests.concat([test]);
    writeStored(storage, tests);
    return test;
  }

  /** Read-only snapshot of every stored vault test, oldest first. */
  function list() {
    return tests.slice();
  }

  /** Number of stored vault tests. */
  function size() {
    return tests.length;
  }

  /** Remove every vault test (explicit reset only; tests / user-initiated clear). */
  function clear() {
    tests = [];
    writeStored(storage, tests);
  }

  return { add, list, size, clear };
}

/**
 * Re-run every vault test through the injected runner and report pass/fail
 * per test. "Pass" means the regression is STILL caught -- i.e. the run does
 * NOT now match `expected` (mirrors the original RED/reject), using the same
 * compareClaimToRun discipline as score-claim.js. A test whose run now
 * matches `expected` FAILS the vault check: the regression escaped, and that
 * is reported plainly rather than folded into a generic error.
 *
 * A run that throws is treated as still-caught (pass): the original claim is
 * still not provable/reproducible, consistent with decideVerdict's RED-on-
 * run-error rule. Never throws itself.
 *
 * @param {{runQuery: (sql:string) => Promise<*>, tests?: Array<object>, compareClaimToRun: Function}} args
 * @returns {Promise<{total:number, caught:number, escaped:number, results: Array<object>}>}
 */
export async function runVault(args) {
  const a = isPlainObject(args) ? args : {};
  const tests = Array.isArray(a.tests) ? a.tests : [];
  const compare = typeof a.compareClaimToRun === 'function' ? a.compareClaimToRun : null;
  const results = [];

  for (const test of tests) {
    if (typeof a.runQuery !== 'function' || typeof test.statement !== 'string' || !test.statement.trim()) {
      results.push({ id: test.id, caught: true, reason: 'No runner or no statement; treated as still not provable (caught).', run: null });
      continue;
    }
    let run;
    try {
      const result = await a.runQuery(test.statement);
      const rowCount = Array.isArray(result && result.rows) ? result.rows.length
        : (typeof (result && result.rowCount) === 'number' ? result.rowCount : null);
      run = { status: 'ok', rowCount, scalars: {}, result, error: null };
    } catch (err) {
      results.push({ id: test.id, caught: true, reason: 'The run errored again, same as originally recorded.', run: null });
      continue;
    }

    const comparison = compare ? compare(test.expected, run) : { pass: false, mismatches: [] };
    if (comparison.pass) {
      // The original problem no longer reproduces: the regression escaped.
      results.push({ id: test.id, caught: false, reason: 'This vault test now matches the expectation; the regression it caught is no longer being caught.', run });
    } else {
      results.push({ id: test.id, caught: true, reason: 'The mismatch that put this in the vault is still present.', run, mismatches: comparison.mismatches });
    }
  }

  const caught = results.filter((r) => r.caught).length;
  return {
    total: results.length,
    caught,
    escaped: results.length - caught,
    results,
  };
}

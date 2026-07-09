// ============================================================
// DATAGLOW — Pack no-network guard (Gen 40)
// ============================================================
// Domain packs preserve DATAGLOW's zero-upload guarantee: pack code may only
// transform / validate / annotate data ALREADY loaded into the app, and must
// never reach the network. Before Gen 40 that was a convention; this module
// makes it an enforced guarantee with two complementary mechanisms:
//
//   1. A STATIC SOURCE SCAN (`scanSourceForNetwork` / `assertNoNetwork`). It is
//      the primary, most reliable mechanism for this zero-build codebase: it
//      reads a pack file's own source text and flags any reference to a network
//      primitive. The loader runs it on any pack that supplies source, and the
//      CI test (test/pack-architecture.test.mjs) runs it over every shipped pack
//      file — so a pack that so much as names `fetch` fails the build.
//
//   2. A RUNTIME TRAP (`runWithNetworkDenied`). Defence in depth: it executes a
//      pack callback with the network globals shadowed by throwing stubs, so
//      even a primitive reached indirectly at runtime is blocked rather than
//      silently succeeding. Synchronous and self-restoring.
//
// Descriptor-based packs (retail, finance, imported community packs) carry NO
// executable network code by construction — they are pure data compiled through
// the annotate-only factory sandbox — so for them the static scan is total. The
// hand-written healthcare pack is plain JS whose source the CI scan covers.

// The network primitives a pack must never reference. Each entry is a token we
// scan the (comment-stripped) source for. Kept deliberately broad — the whole
// point is that a pack has NO legitimate reason to name any of them.
export const NETWORK_PRIMITIVES = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'importScripts',
  'navigator',
]);

// Strip line (`// …`) and block (`/* … */`) comments and string literals so a
// primitive merely NAMED in a comment or a message string does not trip the
// scan — only real code references count. Intentionally simple (not a full JS
// parser): it errs toward stripping, which can only reduce false positives, and
// the runtime trap backs it up.
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") state = 'code'; i++; continue; }
    if (state === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') state = 'code'; i++; continue; }
    if (state === 'tpl') { if (c === '\\') { i += 2; continue; } if (c === '`') state = 'code'; i++; continue; }
  }
  return out;
}

/**
 * Statically scan pack source for references to any network primitive.
 * @param {string} source raw JS source text of a pack file
 * @returns {Array<{primitive:string, line:number}>} one entry per reference
 *   found (empty array = clean). Line numbers are 1-based, into the ORIGINAL
 *   source, for a useful error message.
 */
export function scanSourceForNetwork(source) {
  if (typeof source !== 'string' || source === '') return [];
  const code = stripCommentsAndStrings(source);
  const violations = [];
  // Precompute line-start offsets of the (comment/string-stripped) code so a
  // match offset maps to a 1-based line number.
  const lineStarts = [0];
  for (let k = 0; k < code.length; k++) if (code[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  for (const prim of NETWORK_PRIMITIVES) {
    const re = new RegExp(`\\b${prim}\\b`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      violations.push({ primitive: prim, line: lineOf(m.index) });
    }
  }
  return violations;
}

/**
 * Throw if pack source references any network primitive.
 * @param {string} source pack file source text
 * @param {string} label identifier used in the error message (e.g. pack id)
 */
export function assertNoNetwork(source, label = 'pack') {
  const violations = scanSourceForNetwork(source);
  if (violations.length) {
    const detail = violations.map(v => `${v.primitive} (line ${v.line})`).join(', ');
    throw new Error(`no-network guard: "${label}" references network primitive(s): ${detail}. Packs may only transform data already loaded locally; they must never reach the network.`);
  }
}

// The names shadowed inside the runtime trap. `navigator` is trapped as a whole
// because navigator.sendBeacon is a network primitive; a pack has no reason to
// touch navigator at all.
const TRAPPED_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'navigator'];

/**
 * Run `fn` with the network globals replaced by throwing stubs, restoring the
 * originals afterward (even if `fn` throws). Synchronous — the pack transforms
 * this backs are synchronous — so there is no window in which another task sees
 * the shadowed globals. Returns whatever `fn` returns.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithNetworkDenied(fn) {
  const g = globalThis;
  const saved = [];
  const trap = (name) => () => {
    throw new Error(`no-network guard: pack code attempted to use "${name}" at runtime — network access is not permitted from a domain pack.`);
  };
  for (const name of TRAPPED_GLOBALS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(g, name); } catch { descriptor = undefined; }
    saved.push({ name, descriptor, existed: name in g });
    try {
      Object.defineProperty(g, name, { value: trap(name), configurable: true, writable: true });
    } catch {
      // A non-configurable global can't be shadowed; the static scan is the
      // backstop for those environments.
    }
  }
  try {
    return fn();
  } finally {
    for (const { name, descriptor, existed } of saved) {
      try {
        if (descriptor) Object.defineProperty(g, name, descriptor);
        else if (!existed) delete g[name];
      } catch { /* best-effort restore */ }
    }
  }
}

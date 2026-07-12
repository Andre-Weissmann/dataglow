// ============================================================
// DATAGLOW — Trust Beam (shareable, self-contained seal link)
// (Trust Passport — makes an existing Verifiable Check Seal portable)
// ============================================================
// Turns an EXISTING Verifiable Check Seal (js/provenance/verifiable-check-seal.js's
// sealCheckResult output — itself a Merkle-tree/SHA-256 commitment composed from
// js/provenance/selective-disclosure-proof.js) into a compact, URL-safe string
// that lives entirely in a URL FRAGMENT (after `#`). A fragment is never sent to
// a server by the browser, so a "Trust Beam" link carries the whole seal to a
// recipient who has never installed DataGlow: they open the link, the standalone
// verify-beam.html page reads the fragment, decodes the seal, and re-runs the
// EXISTING verifySeal() client-side. Nothing is uploaded, nothing is stored on a
// server, and no new crypto is introduced — this module only serializes.
//
// WHAT THIS IS: a lossless, dependency-free serializer. encodeBeam(seal) packs the
// seal verbatim (no field dropped) into a versioned envelope and base64url-encodes
// its UTF-8 JSON; decodeBeam reverses it exactly, so the seal that comes out is the
// same object verifySeal already knows how to check. The beam adds NO trust of its
// own: it is a transport wrapper. All of the seal's guarantees — and all of its
// honest limits — carry through unchanged (it is a hash commitment with a
// re-checkable data fingerprint; NOT a zero-knowledge proof, NOT a certification,
// NOT "blockchain"; it proves the check ran against data matching a fingerprint and
// produced a result, not that the data is accurate).
//
// WHAT THIS IS NOT: it does not re-verify, re-sign, compress, or encrypt anything.
// It pulls in no compression library and no crypto library — just TextEncoder/
// TextDecoder and a tiny hand-rolled base64url codec, so it behaves identically in
// the browser, the Tauri desktop webview, and headless Node tests. QR-image
// generation is deliberately out of scope for this batch (no QR library is
// vendored); a copyable link is the artifact. QR is a documented follow-up: once a
// permissively-licensed QR encoder is vendored, buildBeamUrl's output is exactly
// what would be drawn into a QR code — no change to this module needed.
//
// PURITY: pure logic — no DOM, no network primitive, no engine. Given a seal object
// it returns strings; given a string it returns a seal object.

import { CHECK_SEAL_KIND } from './verifiable-check-seal.js';

export const BEAM_KIND = 'dataglow-trust-beam';
export const BEAM_VERSION = 1;

// The fragment key the payload lives under, e.g. `…/verify-beam.html#beam=<payload>`.
// Named (rather than the bare fragment) so the verify page can tell a beam apart
// from any other fragment a host URL might carry.
export const BEAM_FRAGMENT_KEY = 'beam';

export const BEAM_DISCLAIMER =
  'A Trust Beam is a transport wrapper only: it carries an existing DATAGLOW '
  + 'Verifiable Check Seal inside a URL fragment so it can be re-verified in any '
  + 'browser with no DataGlow install, no server, and no upload — the fragment is '
  + 'never sent anywhere. The beam adds no guarantee of its own; every property of '
  + 'the seal carries through unchanged. It is NOT a zero-knowledge proof, NOT a '
  + 'certification, and NOT "blockchain". It proves only that the sealed check ran '
  + 'against data matching the committed SHA-256 fingerprint and produced the '
  + 'committed result — NOT that the underlying data is accurate, truthful, or '
  + 'complete. Not a legal, clinical, or regulatory determination.';

// ------------------------------------------------------------
// base64url codec (bytes <-> compact URL-safe string), dependency-free
// ------------------------------------------------------------
// URL fragments tolerate a wide charset, but base64url (RFC 4648 §5, no padding)
// keeps the payload free of characters that browsers/QR encoders reorder or
// percent-encode, and is trivial for a third-party verifier to re-implement.
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = (() => {
  const m = new Map();
  for (let i = 0; i < B64URL_ALPHABET.length; i++) m.set(B64URL_ALPHABET[i], i);
  return m;
})();

function bytesToBase64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET[(triple >> 18) & 0x3f];
    out += B64URL_ALPHABET[(triple >> 12) & 0x3f];
    if (i + 1 < bytes.length) out += B64URL_ALPHABET[(triple >> 6) & 0x3f];
    if (i + 2 < bytes.length) out += B64URL_ALPHABET[triple & 0x3f];
  }
  return out;
}

function base64urlToBytes(str) {
  const clean = String(str).trim();
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64URL_LOOKUP.get(clean[i]);
    const c1 = B64URL_LOOKUP.get(clean[i + 1]);
    if (c0 === undefined || c1 === undefined) {
      throw new Error('decodeBeam: payload is not valid base64url.');
    }
    const c2 = i + 2 < clean.length ? B64URL_LOOKUP.get(clean[i + 2]) : undefined;
    const c3 = i + 3 < clean.length ? B64URL_LOOKUP.get(clean[i + 3]) : undefined;
    if ((clean[i + 2] !== undefined && c2 === undefined) || (clean[i + 3] !== undefined && c3 === undefined)) {
      throw new Error('decodeBeam: payload is not valid base64url.');
    }
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 !== undefined) out.push(((c2 & 0x03) << 6) | c3);
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------
// encode / decode
// ------------------------------------------------------------
/**
 * Serialize an existing Verifiable Check Seal into a compact, URL-safe payload
 * string that fits in a URL fragment. Lossless: the seal is embedded verbatim so
 * a round-trip reproduces it byte-for-byte and verifySeal treats it identically.
 *
 * @param {object} seal  A seal from sealCheckResult (kind === CHECK_SEAL_KIND).
 * @returns {string} A base64url payload (no server round-trip, no upload).
 */
export function encodeBeam(seal) {
  if (!seal || typeof seal !== 'object' || seal.kind !== CHECK_SEAL_KIND) {
    throw new Error(
      'encodeBeam: expected a DATAGLOW Verifiable Check Seal (from sealCheckResult). '
      + 'The beam is a transport wrapper — it does not create or verify seals.');
  }
  const envelope = { beam: BEAM_KIND, v: BEAM_VERSION, seal };
  const json = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64url(bytes);
}

/**
 * Reverse encodeBeam: decode a payload string back into the original seal object.
 * Validates the envelope shape and version but performs NO cryptographic check —
 * pass the returned seal to verifySeal() for that (unchanged, existing logic).
 *
 * @param {string} payloadString  The base64url payload from a beam URL fragment.
 * @returns {object} The original seal object.
 */
export function decodeBeam(payloadString) {
  if (typeof payloadString !== 'string' || !payloadString.trim()) {
    throw new Error('decodeBeam: expected a non-empty payload string.');
  }
  const bytes = base64urlToBytes(payloadString);
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error('decodeBeam: payload did not contain valid JSON: ' + e.message);
  }
  if (!envelope || typeof envelope !== 'object' || envelope.beam !== BEAM_KIND) {
    throw new Error('decodeBeam: not a DATAGLOW Trust Beam payload (missing/incorrect "beam" marker).');
  }
  if (envelope.v !== BEAM_VERSION) {
    throw new Error(`decodeBeam: unsupported Trust Beam version ${envelope.v} (expected ${BEAM_VERSION}).`);
  }
  if (!envelope.seal || typeof envelope.seal !== 'object' || envelope.seal.kind !== CHECK_SEAL_KIND) {
    throw new Error('decodeBeam: payload does not carry a Verifiable Check Seal.');
  }
  return envelope.seal;
}

// ------------------------------------------------------------
// URL composition
// ------------------------------------------------------------
/**
 * Compose the full shareable Trust Beam URL: the seal payload lives in the URL
 * FRAGMENT (after `#`), which the browser never transmits to a server, so the
 * seal is carried peer-to-peer with nothing uploaded or stored server-side.
 *
 * Any existing fragment on baseUrl is replaced; an existing query string is kept
 * untouched. baseUrl typically points at the standalone verify-beam.html page.
 *
 * @param {object} seal  A seal from sealCheckResult.
 * @param {string} baseUrl  Where the verify page lives, e.g. 'https://host/verify-beam.html'.
 * @returns {string} The full URL, e.g. 'https://host/verify-beam.html#beam=<payload>'.
 */
export function buildBeamUrl(seal, baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('buildBeamUrl: baseUrl must be a non-empty string.');
  }
  const payload = encodeBeam(seal);
  const hashIndex = baseUrl.indexOf('#');
  const base = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  return `${base}#${BEAM_FRAGMENT_KEY}=${payload}`;
}

/**
 * Extract a beam payload from a URL fragment string. Accepts a raw fragment with
 * or without a leading '#', reads the `beam=` key (falling back to treating the
 * whole fragment as the payload for forward-compatibility), and returns the
 * payload string, or null if none is present. Pure and DOM-free so both the
 * verify page and the tests share one parser.
 *
 * @param {string} fragment  e.g. location.hash ('#beam=<payload>') or '<payload>'.
 * @returns {string|null}
 */
export function readBeamPayloadFromFragment(fragment) {
  if (typeof fragment !== 'string') return null;
  let frag = fragment;
  if (frag.startsWith('#')) frag = frag.slice(1);
  if (!frag) return null;
  for (const part of frag.split('&')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq) === BEAM_FRAGMENT_KEY) {
      return part.slice(eq + 1) || null;
    }
  }
  // No key=value form — treat the entire fragment as the raw payload.
  return frag.includes('=') ? null : frag;
}

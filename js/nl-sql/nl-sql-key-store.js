// ============================================================
// DATAGLOW -- NL->SQL: In-memory API key store
// ============================================================
// Holds AI provider API keys in plain JS module memory ONLY.
// NOT localStorage, NOT sessionStorage (both blocked in the iframe sandbox).
// Keys live for the lifetime of the page and are gone the moment DataGlow is
// closed or reloaded. This module is imported by both the Settings UI (to save
// keys) and nl-sql-engine.js (to read them at query time).
//
// Coding constraints (iOS WKWebView): no backticks, no apostrophes in
// single-quoted strings.
// ============================================================

// provider id -> key string. Held in RAM only.
var KEYS = {
  openai: '',
  anthropic: '',
  google: '',
  perplexity: '',
};

// Save a single provider key.
export function setProviderKey(providerId, key) {
  if (!providerId) return;
  KEYS[providerId] = key ? String(key).trim() : '';
}

// Save several keys at once from a { providerId: key } object.
export function setProviderKeys(obj) {
  if (!obj || typeof obj !== 'object') return;
  var ids = Object.keys(obj);
  for (var i = 0; i < ids.length; i++) {
    setProviderKey(ids[i], obj[ids[i]]);
  }
}

// Read a single provider key (empty string if unset).
export function getProviderKey(providerId) {
  return (providerId && KEYS[providerId]) ? KEYS[providerId] : '';
}

// Read a shallow copy of all keys.
export function getAllProviderKeys() {
  return {
    openai: KEYS.openai,
    anthropic: KEYS.anthropic,
    google: KEYS.google,
    perplexity: KEYS.perplexity,
  };
}

// True if at least one provider key is present.
export function hasAnyKey() {
  var ids = Object.keys(KEYS);
  for (var i = 0; i < ids.length; i++) {
    if (KEYS[ids[i]]) return true;
  }
  return false;
}

// Wipe every key (used on explicit clear or teardown).
export function clearProviderKeys() {
  KEYS.openai = '';
  KEYS.anthropic = '';
  KEYS.google = '';
  KEYS.perplexity = '';
}

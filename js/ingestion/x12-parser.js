/**
 * X12 EDI Parser -- 835 (ERA/Remittance) and 837 (Claims)
 *
 * Pure browser-side, zero-upload, zero-dependency.
 * Parses X12 EDI envelopes into flat tabular datasets for
 * DataGlow validation and analytics.
 *
 * This module is inlined into canvas/index.html via build.sh.
 * See the X12 PARSER ENGINE block in src/js/bundle.js for the
 * full implementation (canonically defined there as an IIFE,
 * exposed as window.X12Parser).
 *
 * Supported transaction sets:
 *   835 -- Electronic Remittance Advice (ERA)
 *   837 -- Healthcare Claims (Professional, Institutional)
 *   Unknown -- generic segment-level fallback table
 *
 * Public API:
 *   X12Parser.parse(text)            -- main entry point
 *   X12Parser.parseEnvelope(text)    -- split ISA envelope into segments
 *   X12Parser.detectType(segments)   -- read ST01 to identify 835 vs 837
 */
export function parse(text) { /* inlined in bundle */ }
export function parseEnvelope(text) { /* inlined in bundle */ }
export function detectType(segments) { /* inlined in bundle */ }

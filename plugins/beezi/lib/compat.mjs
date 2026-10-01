import fs from 'fs';

// Helpers that stand in for syntax and APIs newer than Node 13.2, the plugin's runtime floor
// (first Node with unflagged ESM). Everything in lib/ and scripts/ must stay parseable and
// runnable there; test/ is exempt and runs on modern Node. The floor is enforced by
// test/compat-syntax.test.mjs.
//
// It also holds the handful of tiny value-coercion helpers that several unrelated modules each had
// their own copy of (readString, boundedLabel, parseTimestampMs). They are not runtime-floor shims;
// they live here because this is the one module with no dependencies of its own, so every caller
// can import it without creating a cycle.

// `a ?? b` for the plain-defaulting case. The fallback is evaluated eagerly — where the
// right-hand side is expensive or has side effects, write the ternary out at the call site.
export function orDefault(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

// Buffer's 'base64url' encoding is Node 15.7+. PKCE (RFC 7636) requires the unpadded alphabet,
// so the trailing '=' strip is load-bearing, not cosmetic.
export function base64urlEncode(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Node's base64 decoder ignores missing padding, matching the tolerance of the native
// 'base64url' decoding this replaces.
export function base64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// fs.rmSync is Node 14.14+. These two cover every deletion the plugin performs: a single file
// that may already be gone, and a directory tree that may already be gone.
export function removeFileSync(p) {
  try {
    fs.unlinkSync(p);
  } catch { /* already gone */ }
}

export function removeDirSync(p) {
  try {
    if (fs.rmSync) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      // Node < 14.14: recursive rmdirSync exists since 12.10 and is not yet deprecated there.
      fs.rmdirSync(p, { recursive: true });
    }
  } catch { /* already gone */ }
}

// A non-empty trimmed string, or null. STRICT about the input type: a non-string (a number, an
// object) is null, not its String() form. That is what keeps a JSON field that arrived with the
// wrong type out of an identity label.
export function readString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// A non-empty trimmed label of at most `max` characters, or null. COERCES its input, unlike
// readString: callers hand it values straight off a parsed JSON payload.
//
// An oversized value is DROPPED, never truncated — a truncated uuid names a DIFFERENT account, and
// an over-long one fails the API's validation, which under forbidNonWhitelisted refuses the WHOLE
// payload rather than the one field. The per-DTO bounds stay at the call sites; only the rule is
// shared.
export function boundedLabel(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '' || s.length > max) return null;
  return s;
}

// An ISO timestamp as epoch milliseconds, or null when it is absent or unparseable. Folds the
// explicit null/undefined ternary + `Date.parse` + `Number.isNaN` trio that 9 call sites each
// spelled out.
//
// Null and undefined parse to null rather than throwing, but note this COERCES like Date.parse: a
// bare number is read as a year. A caller that must reject non-strings guards the type first
// (recordTimestampToIso in lib/rate-limits-codex.mjs does exactly that).
export function parseTimestampMs(value) {
  const ms = Date.parse(value === null || value === undefined ? '' : value);
  return Number.isNaN(ms) ? null : ms;
}

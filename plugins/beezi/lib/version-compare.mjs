// Semver ordering, split out of update-check.mjs so the comparison can be read, tested and reused
// without dragging the fetch/cache machinery along. These are the rules the stale-version check
// (G-8-4) applies.
//
// Node 13.2 floor: no optional chaining, no nullish coalescing.

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  };
}

function comparePre(a, b) {
  // Semver's own rule, and the one that matters for this plugin's variants: a build stamped
  // `0.7.0-staging.4821` is BEHIND the plain `0.7.0`, and ahead of `0.7.0-staging.4102`. Numeric
  // identifiers compare numerically so `.10` beats `.9`, which a string compare gets backwards on
  // every tenth internal publish.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank lower than alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 when a < b, 0 when equal, 1 when a > b. null when either side is not a version. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

/**
 * Is `candidate` a later version than `current`?
 *
 * Fails CLOSED: an uncomparable pair is not "newer", so a malformed manifest or a hand-edited
 * plugin.json can never produce a nag.
 */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

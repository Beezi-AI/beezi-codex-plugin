// The two output helpers every CLI entry point in scripts/ had its own copy of.
//
// They live in lib/ rather than in one script importing another because scripts/ entry points are
// siblings: each is spawned directly by name (`node scripts/sync.mjs`), and none of them is the
// natural parent of the others.
//
// Kept apart from lib/friendly-error.mjs deliberately: that module CLASSIFIES an error into a
// sentence and is imported by lib/diagnostics.mjs, which must never print or exit. These two do
// exactly the printing and exiting a library must not.

// Print the ✗ line and stop. Never returns.
export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// "1 session" / "2 sessions". Naive -s pluralisation, which is all the counted nouns here need.
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

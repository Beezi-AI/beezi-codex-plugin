import path from 'path';
import { orDefault } from './compat.mjs';

// Derive code-change stats from a delta segment's rollout lines.
//
// Codex has recorded code changes three different ways, selected by CLI version. Measured across
// 201 local rollouts (CLI 0.77.0 -> 0.153.4, 2025-12 -> 2026-09):
//
//   A  0.77 -> 0.107   `response_item` / `custom_tool_call` named `apply_patch`, whose `input` is
//                      an apply_patch envelope. There is NO event of any kind on these builds --
//                      the envelope is the only record. Still live: 72 of 201 rollouts, so this is
//                      a real fallback and not legacy trivia.
//   B  0.122 -> 0.146  `event_msg` / `patch_apply_end`, carrying a `changes` map.
//   C  0.153+          `event_msg` / `item_completed` whose `payload.item.type === 'FileChange'`,
//                      carrying the SAME `changes` map. `patch_apply_end` was itself removed in
//                      0.153: all 11 September rollouts with edits use `FileChange` and none has a
//                      `patch_apply_end`, so reading only era B reports zero on current builds.
//
// The apply_patch envelope (era A only):
//
//   *** Begin Patch
//   *** Update File: <path>
//   @@ <optional context header>
//    unchanged context line (leading space)
//   -removed line
//   +added line
//   *** Add File: <path>
//   +new content line
//   *** Delete File: <path>
//   *** End Patch
//
// The `changes` map (eras B and C -- identical shape in both), keyed by absolute path:
//
//   changes["<abs path>"] = { type: "update", unified_diff: "<@@ hunks>", move_path: <string|null> }
//   changes["<abs path>"] = { type: "add",    content: "<full new file text>" }
//   changes["<abs path>"] = { type: "delete", content: "<full prior file text>" }
//
// Measured over 411 real entries: `update` is 288 of them (70%) and carries `unified_diff` and NO
// `content`; only `add` (100) and `delete` (23) carry `content`. Coding to `{type, content}` alone
// would count zero lines for seven of every ten changes.
//
// What is deliberately NOT a source: `tools.apply_patch(...)` inside a unified-exec program. It
// looks like the symmetric fix to the operations bucketing, and it would double-count every modern
// edit -- every rollout whose exec programs contain one already carries an event describing the
// result (233 such programs vs 371 event-recorded changes). Code changes come from the events and
// the legacy envelope. Nothing else.
//
// files_changed counts distinct files touched; lines_added/removed count '+'/'-' body lines
// (envelope, hunk and preamble headers excluded); by_extension tallies distinct files per
// extension, so its values sum to files_changed.

function extOf(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext || '(none)';
}

// Codex writes absolute OS paths, and the same file shows up as "C:\Users\..." in one record and
// "c:\Users\..." in another within a single corpus. Raw strings would count one file twice, so the
// set is keyed on a normalized form while `files` keeps the first-seen spelling for display.
function fileKey(filePath) {
  return String(filePath).split('\\').join('/').toLowerCase();
}

// Claude's rule (lib/code-changes.mjs in the beezi-claude-plugins repo), copied so whole-file adds
// and deletes are counted identically on both platforms: strip exactly one trailing newline, split.
function lineCount(s) {
  if (typeof s !== 'string' || s === '') return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

const FILE_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

// Parse one apply_patch envelope, accumulating into the shared collectors.
function parsePatch(patch, files, counts) {
  if (typeof patch !== 'string') return;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = FILE_HEADER_RE.exec(line);
    if (header) {
      touch(header[2].trim(), files);
      continue;
    }
    const move = MOVE_RE.exec(line);
    if (move) {
      touch(move[1].trim(), files);
      continue;
    }
    if (line.startsWith('*** ') || line.startsWith('@@')) continue; // envelope / hunk headers
    // Body lines. In apply_patch, '+'/'-' mark added/removed; a leading space is context.
    if (line.startsWith('+')) counts.added += 1;
    else if (line.startsWith('-')) counts.removed += 1;
  }
}

// `unified_diff` is a plain unified-diff BODY: "@@ -a,b +c,d @@" hunk headers followed by
// ' '/'+'/'-' prefixed lines. No "*** Begin Patch" envelope and no ---/+++ preamble appears in any
// observed sample, which is why parsePatch cannot be reused here -- it derives the filename from
// "*** Update File:" headers that are not present.
function countUnifiedDiff(diff, counts) {
  if (typeof diff !== 'string' || diff === '') return;
  let inHunk = false;
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('@@')) { inHunk = true; continue; }
    // Anything before the first hunk header is preamble and never counts. No further guard inside
    // a hunk: testing for '+++'/'---' there would silently drop a genuine added line whose content
    // begins with them (a Markdown rule, a C++ decrement).
    if (!inHunk) continue;
    if (line.startsWith('+')) counts.added += 1;
    else if (line.startsWith('-')) counts.removed += 1;
  }
}

function touch(filePath, files) {
  if (!filePath) return;
  const key = fileKey(filePath);
  if (!files.has(key)) files.set(key, filePath);
}

// The `changes` map carried identically by patch_apply_end and item_completed/FileChange.
function applyChangeMap(changes, files, counts) {
  if (!changes || typeof changes !== 'object') return;
  for (const rawPath of Object.keys(changes)) {
    const change = changes[rawPath];
    if (!change || typeof change !== 'object') continue;
    // A rename keys the OLD path and names the NEW one in move_path (8 of 288 observed updates).
    // The file that exists afterwards is the destination; counting both keys would report one
    // rename as two changed files.
    const moved = change.move_path;
    const target = typeof moved === 'string' && moved !== '' ? moved : rawPath;
    touch(target, files);
    if (change.type === 'update') countUnifiedDiff(change.unified_diff, counts);
    else if (change.type === 'add') counts.added += lineCount(change.content);
    else if (change.type === 'delete') counts.removed += lineCount(change.content);
  }
}

// The two event shapes Codex has used to report a completed edit, or null. They are alternatives
// chosen by CLI version (0 co-occurrences across the 95 local rollouts carrying any code-change
// record) but they share ONE id namespace -- `exec-<uuid>` under unified exec, `call_<base62>` on
// legacy -- so a single consumed-id Set covers a future build that emitted both.
function changeEvent(record) {
  const p = record && record.payload;
  if (!p || record.type !== 'event_msg') return null;
  if (p.type === 'patch_apply_end') {
    // A failed patch still names the file it TRIED to write (1 of 251 local records). Nothing
    // reached disk, so counting it inflates the stats with an edit that never happened.
    if (p.success === false || p.status === 'failed') return null;
    return { id: orDefault(p.call_id, null), changes: p.changes };
  }
  if (p.type === 'item_completed') {
    const item = orDefault(p.item, null);
    if (!item || item.type !== 'FileChange') return null;
    // All 133 observed FileChange items are `completed`; gate defensively anyway.
    if (item.status && item.status !== 'completed') return null;
    return { id: orDefault(item.id, null), changes: item.changes };
  }
  return null;
}

// The era-A envelope call, or null.
function legacyApplyPatch(record) {
  const p = record && record.payload;
  if (!p || p.type !== 'custom_tool_call' || p.name !== 'apply_patch') return null;
  if (typeof p.input !== 'string') return null;
  return { callId: orDefault(p.call_id, null), input: p.input };
}

// Paths a single record wrote, for the timeline's plan-document detection. Reuses changeEvent and
// legacyApplyPatch so "what counts as a landed edit" (failed patches excluded, move_path preferred)
// cannot drift from computeCodeChanges. The legacy envelope contributes Add/Update headers only:
// it is the proposal, not the result, and a delete is never a plan being written.
export function editedPathsOf(record) {
  const out = [];
  const ev = changeEvent(record);
  if (ev) {
    const changes = ev.changes;
    if (changes && typeof changes === 'object') {
      for (const rawPath of Object.keys(changes)) {
        const change = changes[rawPath];
        if (!change || typeof change !== 'object') continue;
        const moved = change.move_path;
        out.push(typeof moved === 'string' && moved !== '' ? moved : rawPath);
      }
    }
    return out;
  }
  const call = legacyApplyPatch(record);
  if (call) {
    for (const rawLine of call.input.split('\n')) {
      const header = FILE_HEADER_RE.exec(rawLine.replace(/\r$/, ''));
      if (header && header[1] !== 'Delete') out.push(header[2].trim());
    }
  }
  return out;
}

export function computeCodeChanges(lines) {
  const files = new Map();    // normalized key -> first-seen spelling
  const counts = { added: 0, removed: 0 };
  const consumed = new Set(); // event ids already counted == calls already covered

  // Pass 1 -- events. Authoritative on both tool surfaces: they describe what actually landed on
  // disk, with a real diff, rather than the patch text the model proposed.
  for (const record of lines) {
    const ev = changeEvent(record);
    if (!ev) continue;
    // A null id can neither suppress nor be suppressed; count it and move on.
    if (ev.id !== null) {
      if (consumed.has(ev.id)) continue;
      consumed.add(ev.id);
    }
    applyChangeMap(ev.changes, files, counts);
  }

  // Pass 2 -- the legacy envelope, and only for calls that no event covered. This is a SECOND loop
  // on purpose: an event follows its call by one or two lines (measured over all 169 real joins),
  // so a single fused pass would reach the envelope before its id was consumed and double era B.
  //
  // Suppression is by matching call_id, never by position: on 0.122-0.146 legacy builds the
  // `apply_patch` call and its `patch_apply_end` DO co-occur and share the id, and parsing both
  // would double every line count for that whole installed base. Under unified exec the event id
  // is `exec-<uuid>` while the exec call id is `call_<base62>`, so they never collide and no
  // suppression happens -- correct, because exec input is never parsed for changes anyway.
  for (const record of lines) {
    const call = legacyApplyPatch(record);
    if (!call) continue;
    if (call.callId !== null && consumed.has(call.callId)) continue;
    parsePatch(call.input, files, counts);
  }

  const byExtension = {};
  for (const displayPath of files.values()) {
    const ext = extOf(displayPath);
    byExtension[ext] = orDefault(byExtension[ext], 0) + 1;
  }

  return {
    files_changed: files.size,
    lines_added: counts.added,
    lines_removed: counts.removed,
    by_extension: byExtension,
  };
}

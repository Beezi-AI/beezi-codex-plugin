import path from 'node:path';

// Derive code-change stats from Codex `apply_patch` tool calls in a segment's rollout lines.
//
// Codex edits files through a single `apply_patch` custom_tool_call whose `input` is a patch in
// the apply_patch envelope:
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
// files_changed counts distinct files touched; lines_added/removed count '+'/'-' body lines
// (headers and context excluded); by_extension tallies distinct files per extension.

function extOf(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext || '(none)';
}

const FILE_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

// Parse one apply_patch envelope, accumulating into the shared collectors.
function parsePatch(patch, files, filesByExt, counts) {
  if (typeof patch !== 'string') return;
  let current = null;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const header = FILE_HEADER_RE.exec(line);
    if (header) {
      current = header[2].trim();
      touch(current, files, filesByExt);
      continue;
    }
    const move = MOVE_RE.exec(line);
    if (move) {
      current = move[1].trim();
      touch(current, files, filesByExt);
      continue;
    }
    if (line.startsWith('*** ') || line.startsWith('@@')) continue; // envelope / hunk headers
    // Body lines. In apply_patch, '+'/'-' mark added/removed; a leading space is context.
    if (line.startsWith('+')) counts.added += 1;
    else if (line.startsWith('-')) counts.removed += 1;
  }
}

function touch(filePath, files, filesByExt) {
  if (!filePath) return;
  files.add(filePath);
  const ext = extOf(filePath);
  let set = filesByExt.get(ext);
  if (!set) { set = new Set(); filesByExt.set(ext, set); }
  set.add(filePath);
}

// Pull the apply_patch input out of a rollout record, or null.
function applyPatchInput(record) {
  const p = record?.payload;
  if (!p || p.type !== 'custom_tool_call' || p.name !== 'apply_patch') return null;
  return typeof p.input === 'string' ? p.input : null;
}

export function computeCodeChanges(lines) {
  const files = new Set();
  const filesByExt = new Map();
  const counts = { added: 0, removed: 0 };

  for (const record of lines) {
    const patch = applyPatchInput(record);
    if (patch) parsePatch(patch, files, filesByExt, counts);
  }

  const byExtension = {};
  for (const [ext, set] of filesByExt) byExtension[ext] = set.size;

  return {
    files_changed: files.size,
    lines_added: counts.added,
    lines_removed: counts.removed,
    by_extension: byExtension,
  };
}

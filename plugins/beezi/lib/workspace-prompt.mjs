import path from 'path';
import url from 'url';
import {
  describeTenant,
  isMultiTenant,
  joinTenantNames,
  newTenantsOf,
  readSessionWorkspace,
  resolveTargets,
  roleLabel,
  tenantById,
} from './workspace.mjs';
import { bindSessionRoutes, createRouteContext, routeKeyForDir, shortLabel, usesRules } from './workspace-rules.mjs';
import { resultLine } from './pending-history.mjs';

// Only a new session or a clear asks; resume and compact never do.
const ASK_SOURCES = ['startup', 'clear'];
// request_user_input is single-choice with a forced "Other", 2-3 options and at most 3 questions; past these caps the ask is a plain sentence.
const TOOL_MAX_WORKSPACES = 2;
const TOOL_MAX_QUESTIONS = 3;
// request_user_input headers are at most 12 characters.
const TOOL_HEADER = 'Beezi';

// Resolved from this module, not cwd: hooks run with the user's repository as their working directory.
export function pluginRoot(deps = {}) {
  const root = deps.pluginRoot != null
    ? deps.pluginRoot
    : path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  return root.replace(/\\/g, '/');
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// Only rows linkedSessions can produce a token for (runSessionStart's "linked" test): one whose credentials are gone is neither asked nor told.
async function withUsableLogin(rows, deps) {
  // No credential read when there is nothing to ask or tell.
  if (rows.length === 0) return rows;
  const accounts = await import('./accounts.mjs');
  const linkedSessions = deps.linkedSessions == null ? accounts.linkedSessions : deps.linkedSessions;
  let live;
  try { live = await linkedSessions(deps); } catch { live = []; }
  const keys = (Array.isArray(live) ? live : []).map((s) => s.key);
  return rows.filter((row) => keys.indexOf(row.key) !== -1);
}

function inputCwd(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
}

// A multi-workspace row's tenantName is the web-side workspace, so accounts are named by email.
function emailOf(row) {
  return row.email || row.key;
}

function nameOf(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

// "A", "A and B", "A, B and C".
function names(row, ids) {
  const list = ids.map((id) => nameOf(row, id));
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// How the targets notice names a place: a folder's ~ path, a repo's name, or sessions outside a project.
function noticePlace(key) {
  if (key == null) return 'this folder';
  if (key.kind === 'outside') return 'sessions outside a project';
  if (key.kind === 'folder' && key.label) return key.label;
  return shortLabel(key) || 'this folder';
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// The question wording for this directory: a repo, a folder, or the one "outside a project" place.
function placeOf(key) {
  if (key != null && key.kind === 'outside') {
    return {
      question: 'Where should analytics for sessions outside a project folder go?',
      dontTrack: 'Don\'t track these',
      nothing: 'Nothing from sessions outside a project folder is uploaded',
    };
  }
  const short = shortLabel(key);
  // A folder rule covers everything under it, so its question names the whole path and says so.
  const asked = key != null && key.kind === 'folder' ? `${key.label} (and everything inside it)` : short;
  return {
    question: `Where should analytics for ${asked} go?`,
    dontTrack: key != null && key.kind === 'repo' ? 'Don\'t track this repo' : 'Don\'t track this folder',
    nothing: `Nothing from ${short} is uploaded`,
  };
}

function optionText(o) {
  return o.description ? `"${o.label}" (description "${o.description}")` : `"${o.label}"`;
}

function optionList(options) {
  const texts = options.map(optionText);
  return texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

// One account's question (tool form and plain-sentence form) and the command its answer runs.
function accountAsk(row, resolved, place, { sessionId, root, several }) {
  const tenants = resolved.tenants.filter((t) => resolved.askTenants.indexOf(t.id) !== -1);
  const label = (t) => (t.name ? t.name : t.id);
  const suffix = several ? ` (${emailOf(row)})` : '';
  // The plain sentence drops the question mark so the choices can follow a colon.
  const stem = place.question.slice(0, -1);
  return {
    row,
    id: `beezi_workspace_${row.key}`,
    question: `${place.question}${suffix} Pick one, or name several under Other.`,
    options: tenants.map((t) => ({ label: label(t), description: roleLabel(t) }))
      .concat([{ label: place.dontTrack, description: place.nothing }]),
    sentence: `${stem}${suffix}: ${tenants.map((t) => describeTenant(t)).join(', ')} — one or more — or ${lowerFirst(place.dontTrack)}?`,
    fitsTool: tenants.length <= TOOL_MAX_WORKSPACES,
    command: `node "${root}/scripts/workspace.mjs" rule add --current --session ${sessionId} --account ${row.key} <ids>`,
    ids: tenants.map((t) => `${label(t)} = ${t.id}`).join(', '),
    dontTrack: place.dontTrack,
  };
}

// The tool is offered only when every account's question fits it; otherwise every question is a plain sentence.
function promptText(asks) {
  const one = asks.length === 1;
  const parts = ['Beezi is holding this session\'s analytics until the user says where they go.'];
  const toolable = asks.length <= TOOL_MAX_QUESTIONS && asks.every((a) => a.fitsTool);
  if (toolable) {
    const asked = one
      ? `one question, id "${asks[0].id}", header "${TOOL_HEADER}": "${asks[0].question}" with the options ${optionList(asks[0].options)}`
      : `${asks.length} questions in one call, each with header "${TOOL_HEADER}": ${asks.map((a, i) => `question ${i + 1}, id "${a.id}": "${a.question}" with the options ${optionList(a.options)}`).join('; ')}`;
    parts.push(`If a request_user_input tool is available this turn, use it before anything else to ask ${asked}. Use these labels exactly and mark none as recommended. ${one ? 'It allows' : 'Each allows'} one choice; the user can name several workspaces through "Other". Then continue with the user's request.`);
  }
  const sentences = asks.map((a) => `"${a.sentence}"`).join(' ');
  parts.push(`${toolable ? 'Otherwise, do' : 'Do'} the user's request first and end your reply with ${one ? 'this one plain sentence' : 'these plain sentences, one per account'}, with no numbered list or bullet menu: ${sentences}`);
  asks.forEach((a, i) => {
    const lead = one
      ? 'When the answer arrives, run exactly'
      : `${i === 0 ? 'When the answers arrive, for' : 'For'} ${emailOf(a.row)} run exactly`;
    const idsOf = one
      ? 'the chosen workspaces\' ids joined by commas'
      : `the ids of the workspaces chosen for ${emailOf(a.row)} joined by commas`;
    parts.push(`${lead} \`${a.command}\`. \`<ids>\` is ${idsOf} (${a.ids}), or \`none\` when "${a.dontTrack}" is chosen; it wins over the others.`);
  });
  // A hook message carries none of a skill's framing, so the sandbox escalation is spelled out here.
  // Up front, not on refusal: the write lands outside the workspace and the guard reads the OS
  // credential store, which macOS Seatbelt blocks (lib/codex-sandbox.mjs), so a sandboxed run never succeeds.
  parts.push(`${one ? 'The command reads' : 'Each command reads'} Beezi's sign-in from the system credential store and writes Beezi's settings under the user's home, outside the workspace, so the sandbox cannot run it: run it with escalated permissions from the start so the user can approve it.`);
  parts.push(one
    ? 'Show the user only the command\'s first line. If the user ignores or declines the question, run nothing and never ask it again in this session.'
    : 'Show the user only the first line of each command\'s output. If the user ignores or declines a question, run nothing for that account and never ask it again in this session.');
  return parts.join(' ');
}

// Binds each multi-workspace account's rule for this directory (null unbinds); the pending rows, or null when none.
export async function markPendingWorkspace(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const sessionId = input.session_id;
  const cwd = inputCwd(input);
  const rows = await linkedRows(deps);
  const bound = rows.filter(usesRules);
  if (bound.length === 0) return null;
  const ctx = createRouteContext();
  // Re-matched on every start, resume and compact: a rule added since binds, a removed one unbinds.
  // Written even when nothing is pending: it keeps this the newest session in its directory for the cwd fallback.
  const state = bindSessionRoutes(sessionId, cwd, bound, ctx);
  if (state == null) return null;
  // Pending/asks stay multi-only: a one-workspace row never has anything to ask.
  const multi = rows.filter(isMultiTenant);
  const pending = multi
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => r.resolved.pendingAsk);
  return pending.length === 0 ? null : { pending, cwd, ctx, several: rows.length > 1 };
}

// SessionStart: re-binds on every source; the ask text on startup, clear or no source, or null when nothing is pending.
// `earlier` is this start's first markPendingWorkspace answer: a refused re-bind (a stale workspace lock) asks from it instead.
export async function buildWorkspacePrompt(input, deps = {}, earlier = null) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  let marked;
  try {
    marked = await markPendingWorkspace(input, deps);
  } catch (error) {
    if (earlier == null) throw error;
    marked = earlier;
  }
  if (marked == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const usable = await withUsableLogin(marked.pending.map((p) => p.row), deps);
  const pending = marked.pending.filter((p) => usable.indexOf(p.row) !== -1);
  if (pending.length === 0) return null;
  const place = placeOf(routeKeyForDir(marked.cwd, marked.ctx));
  const root = pluginRoot(deps);
  const asks = pending.map(({ row, resolved }) => accountAsk(row, resolved, place, {
    sessionId: input.session_id, root, several: marked.several,
  }));
  return promptText(asks);
}

// SessionStart: one line per multi-workspace account that is not waiting for an answer, or null.
export async function buildTargetsNotice(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const rows = await linkedRows(deps);
  const state = readSessionWorkspace(input.session_id);
  // A no-rules one-workspace row can never produce a line here (resolveTargets gives 'single'), so
  // skip its credential read (M2).
  const shown = await withUsableLogin(rows.filter(usesRules), deps);
  const ctx = createRouteContext();
  let here;
  const hereKey = () => {
    if (here === undefined) here = routeKeyForDir(state != null && state.cwd != null ? state.cwd : inputCwd(input), ctx);
    return here;
  };
  const lines = shown
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => (r.resolved.multi && !r.resolved.pendingAsk) || (r.resolved.source === 'rule' && r.resolved.targets.length === 0))
    .map(({ row, resolved }) => {
      const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
      const key = resolved.rule != null ? resolved.rule : hereKey();
      const where = noticePlace(key);
      let text;
      if (resolved.source === 'rule' && resolved.targets.length === 0) {
        text = `${where} ${key != null && key.kind === 'outside' ? 'are' : 'is'} not tracked (your rule). Change it with the settings skill (Rules).`;
      } else if (resolved.source === 'none') {
        text = `analytics from ${where} are not uploaded (new folders: don't send). Change it with the settings skill (New folders).`;
      } else if (resolved.source === 'new-folders') {
        text = `analytics from ${where} go to ${names(row, resolved.targets)} (new folder default). Change it with the settings skill (New folders).`;
      } else {
        text = `analytics from ${where} go to ${names(row, resolved.targets)}. Change it with the settings skill (Rules).`;
      }
      return `${prefix}: ${text}`;
    });
  return lines.length === 0 ? null : lines.join('\n');
}

function joinedPromptText(rows, root, sessionId) {
  const who = rows.length === 1 ? `${emailOf(rows[0])} joined ${joinTenantNames(rows[0], newTenantsOf(rows[0]))}` : 'these Beezi accounts joined new workspaces';
  const commands = rows.map((row) => `\`node "${root}/scripts/workspace.mjs" joined --account ${row.key}\``).join(', then ');
  const parts = [
    `Beezi: ${who}.`,
    `Before anything else, run EXACTLY ${commands} with escalated permissions from the start: it reads Beezi's sign-in from the system credential store and writes Beezi's settings outside the workspace, so the sandbox cannot run it.`,
    'If it prints joined=0, say nothing about this.',
    `Otherwise read "${root}/skills/sync/SKILL.md" and follow its "First, new workspaces" part from "Its output is for you only. For an account that joined" up to the paragraph that begins "**Then, repos and folders with no rule.**", for that output only, running every command it prints with escalated permissions too, with these changes:`,
    '(1) always ask the first question ("You joined …") first, even with 4 or fewer J lines;',
    '(2) leave out the "Add … to all" choice when every J line ends in now=pending or now=none;',
    '(3) each repo-pick question asks which of one new workspace\'s repos and folders should also send analytics to it, and its answer runs a `joined pick` command (the `J<i>-command=` printed for that repo or folder, run unchanged except its final `<tenant>`, which becomes that workspace\'s `tenant=` id); ask with request_user_input (header "Beezi") where the skill allows request_user_input and that tool is available this turn; otherwise do the user\'s request first and end your reply with that question as one plain sentence (for a repo pick, one that lists that workspace\'s repos and folders as a numbered list), and act on the answer when it arrives;',
    '(4) a skipped or ignored question runs nothing; it is asked again next session;',
    '(5) stop after that part: run neither routes nor sync.mjs, because the upload starts by itself.',
  ];
  // The current-folder question below was built before this pass, so it is asked only if the pass left this folder without a rule.
  if (sessionId != null) {
    parts.push(`If Beezi's separate question about where this session's own folder goes follows (it begins "Beezi is holding this session's analytics"), ask it only after that part is finished (its last question answered or skipped and its commands run): first run EXACTLY \`node "${root}/scripts/workspace.mjs" rules --session ${sessionId} --account <key>\` with escalated permissions too, for each account it asks about (\`<key>\` is the \`--account\` value in that account's command), and ask that account's question only when the \`here:\` line shows \`no rule\`; otherwise skip it.`);
  }
  parts.push('Then continue with the user\'s request.');
  return parts.join(' ');
}

// SessionStart: the joined re-pick, asked on startup or clear until the join is reviewed; null when nothing is new.
export async function buildJoinedPrompt(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const fresh = (await linkedRows(deps)).filter((row) => newTenantsOf(row).length > 0);
  if (fresh.length === 0) return null;
  const rows = await withUsableLogin(fresh, deps);
  const sessionId = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
  return rows.length === 0 ? null : joinedPromptText(rows, pluginRoot(deps), sessionId);
}

// SessionStart: one user-only line per finished history upload, shown once on startup or clear.
export async function buildHistoryNotice(input, deps = {}) {
  if (input == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const rows = await linkedRows(deps);
  const waiting = rows.filter((row) => Array.isArray(row.historyResults) && row.historyResults.length > 0);
  if (waiting.length === 0) return null;
  const take = deps.takeHistoryResults == null ? (await import('./accounts.mjs')).takeHistoryResults : deps.takeHistoryResults;
  const lines = [];
  for (const row of waiting) {
    let taken = [];
    try { taken = await take(row.key); } catch { continue; }
    const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
    for (const result of taken) lines.push(resultLine(result, { prefix, nameOf: (id) => nameOf(row, id), syncName: 'the sync skill' }));
  }
  return lines.length === 0 ? null : lines.join('\n');
}

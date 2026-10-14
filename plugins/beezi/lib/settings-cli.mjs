import { getDefaultKey, listAccounts } from './accounts.mjs';
import { accountHealth, healHooks } from './me.mjs';
import { currentSessionWorkspace, describeTenant, isMultiTenant, isSingleTenant, newFoldersOf, tenantById, tenantsOf } from './workspace.mjs';
import { createRouteContext, routeForDir, routeKeyForDir, rulesOf, rulesTableLines, shortLabel } from './workspace-rules.mjs';
import { readBillingConfig, resolveSource } from './billing-config.mjs';
import { BillingSource } from './billing.mjs';
import { isLiveTrackingAllowed } from './tracking.mjs';
import { crashMode } from './diagnostics.mjs';
import { UserError, friendlyMessage } from './friendly-error.mjs';

// What the settings skill shows: the screen, the machine-readable `keys`, and one block per section.
//
// It lives here rather than in scripts/settings.mjs for the reason lib/accounts-cli.mjs does:
// tools/hermetic-env.mjs guards child_process, so the output is only testable in-process. Every
// function returns lines; the script prints them.

const LABEL_WIDTH = 16;
const NOT_LINKED = 'Beezi · not linked — use the login skill';

function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

function names(row, ids) {
  return ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  }).join(', ');
}

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${names(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// Where this folder's analytics go: its rule, else New folders.
function thisFolder(row, dir, ctx) {
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null) return `${place} → ${route.tenantIds.length === 0 ? 'not tracked' : names(row, route.tenantIds)}`;
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `${place} → ${names(row, newFolders.tenantIds)} (new folder default)`;
  if (newFolders.mode === 'none') return `${place} → not uploaded (new folders: don't send)`;
  // Not "asks at the next session start": with the hooks untrusted no session start runs.
  return `${place} → no rule yet (choose in the settings skill)`;
}

// This folder's status for a one-workspace account: not tracked (with its rule) or tracked.
// Skipped entirely when live tracking is off (audit mode or disabled): "→ tracked" would be wrong there.
function thisFolderSingle(row, dir, ctx) {
  if (!isLiveTrackingAllowed(row.key)) return null;
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return null;
  const place = shortLabel(key);
  const route = routeForDir(row, dir, ctx);
  if (route != null && route.tenantIds.length === 0) return `${place} → not tracked (R${route.index})`;
  return `${place} → tracked`;
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

// accountHealth's lines folded into one: "Beezi: " dropped, sentences joined.
function signInField(lines) {
  const text = lines.map((l) => l.trim()).join(' ').replace(/^Beezi: /, '');
  return field('Sign-in', text.charAt(0).toUpperCase() + text.slice(1));
}

// SERIAL, never Promise.all: two token refreshes at once in one process are refused as lock-order.
async function healthByKey(accounts, deps) {
  const health = {};
  for (const a of accounts) {
    try {
      health[a.key] = await accountHealth(a, deps);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }
  return health;
}

function currentDir() {
  const state = currentSessionWorkspace();
  return state != null && state.cwd != null ? state.cwd : process.cwd();
}

function crashLabel(mode) {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export async function screenLines(deps = {}) {
  const machine = [field('Crash reports', crashLabel(crashMode()))];
  const accounts = await listAccounts(deps);
  if (accounts.length === 0) return [NOT_LINKED].concat(machine);
  // Health checks refresh each account's workspaces, so the index is read again after.
  const health = await healthByKey(accounts, deps);
  // The hook repair the removed `me` skill ran, on linked machines only; a healthy install is left untouched.
  const healed = accounts.some((a) => health[a.key] != null && health[a.key].ok) ? healHooks(deps) : null;
  const rows = await listAccounts(deps);
  const def = await getDefaultKey(deps);
  const dir = currentDir();
  const ctx = createRouteContext();
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    if (isMultiTenant(row)) {
      const here = thisFolder(row, dir, ctx);
      if (here != null) out.push(field('This folder', here));
      out.push(field('Rules', rulesCount(rulesOf(row).length)));
      out.push(field('New folders', newFoldersLabel(row)));
      return;
    }
    if (!isSingleTenant(row)) return;
    const here = thisFolderSingle(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
    const ruleCount = rulesOf(row).length;
    if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  });
  if (several) out.push('', 'This machine');
  return healed ? out.concat(machine, [healed]) : out.concat(machine);
}

// Known workspace count; 0 when unknown.
function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// For the skill's routing only; never shown.
export async function keysLines(deps = {}) {
  const accounts = await listAccounts(deps);
  const def = await getDefaultKey(deps);
  const menu = [];
  if (accounts.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (accounts.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports');
  const out = [`menu=${menu.join('|')}`];
  for (const a of accounts) {
    out.push(`account=${a.key} default=${a.key === def ? 'yes' : 'no'} multi=${isMultiTenant(a) ? 'yes' : 'no'} workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}`);
  }
  out.push(`crash=${crashMode()}`);
  return out;
}

const PLAN_LABELS = {
  free: 'Free', plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x', go: 'Go', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
};

// The source is resolveSource's answer, the one every report carries; the plan is billing.json's.
function chatgptPlan() {
  const config = readBillingConfig();
  const source = resolveSource(config);
  if (source === BillingSource.OPENAI_API_KEY) return 'API key';
  if (source === BillingSource.THIRD_PARTY) return 'Third-party provider';
  const plan = config != null && typeof config.plan === 'string' ? config.plan : '';
  if (plan === '' || plan === 'unknown') return 'not captured yet — refresh it in the settings skill';
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : plan;
}

function workspaceList(row) {
  return (tenantsOf(row) || []).map(describeTenant).join(', ');
}

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is uploaded',
};

export async function rulesSection(deps = {}) {
  const rows = await listAccounts(deps);
  if (rows.length === 0) return [NOT_LINKED];
  return rulesTableLines(rows, currentDir(), createRouteContext());
}

export async function newFoldersSection(deps = {}) {
  const rows = (await listAccounts(deps)).filter((row) => isMultiTenant(row));
  if (rows.length === 0) return ['New folders applies only to an account in several workspaces.'];
  const dir = currentDir();
  const ctx = createRouteContext();
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(heading('New folders', row, rows.length > 1));
    const nf = newFoldersOf(row);
    out.push(field('Setting', nf.mode === 'send' ? `Send to ${names(row, nf.tenantIds)}` : NEW_FOLDERS_TEXT[nf.mode]));
    out.push(field('Workspaces', workspaceList(row)));
    const here = thisFolder(row, dir, ctx);
    if (here != null) out.push(field('This folder', here));
  });
  return out;
}

export async function accountSection(deps = {}) {
  const accounts = await listAccounts(deps);
  const machine = ['This machine', field('ChatGPT plan', chatgptPlan())];
  if (accounts.length === 0) return [NOT_LINKED, ''].concat(machine);
  const health = await healthByKey(accounts, deps);
  const rows = await listAccounts(deps);
  const def = await getDefaultKey(deps);
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row) => {
    out.push(`Account · ${row.email || row.name || row.key}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    else out.push(field('Sign-in', 'OK'));
    const tenants = tenantsOf(row) || [];
    if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
    if (several) out.push(field('Analytics reads', row.key === def ? 'yes (default account)' : 'no'));
    out.push('');
  });
  return out.concat(machine);
}

function crashText(mode) {
  if (mode === 'correlate') return 'On, with an installation ID so support can find your reports';
  if (mode === 'on') return 'On, without an installation ID (that choice stays open)';
  if (mode === 'anonymous') return 'Anonymous, without an installation ID (never offered again)';
  return 'Off';
}

export function privacySection() {
  return [field('Crash reports', crashText(crashMode()))];
}

export async function allSections(deps = {}) {
  const parts = [
    ['Rules', await rulesSection(deps)],
    ['New folders', await newFoldersSection(deps)],
    ['Account', await accountSection(deps)],
    ['Crash reports', privacySection()],
  ];
  const out = [];
  parts.forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    out.push(`## ${title}`, '');
    // The heading already names the section.
    out.push(...(lines[0] === title ? lines.slice(1) : lines));
  });
  return out;
}

const SECTIONS = {
  keys: keysLines,
  rules: rulesSection,
  'new-folders': newFoldersSection,
  account: accountSection,
  privacy: privacySection,
  all: allSections,
};

// `cmd` is the script's first argument; none prints the screen.
export async function settingsLines(cmd, deps = {}) {
  if (cmd == null) return screenLines(deps);
  if (Object.prototype.hasOwnProperty.call(SECTIONS, cmd)) return SECTIONS[cmd](deps);
  throw new UserError('Usage: settings.mjs [keys | rules | new-folders | account | privacy | all]');
}

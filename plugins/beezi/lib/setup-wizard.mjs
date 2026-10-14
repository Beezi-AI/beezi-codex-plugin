import { BillingSource, CHATGPT_PLANS } from './billing.mjs';
import {
  askNewFolders, lastLine, outputLines, report, reviewJoined, reviewRoutes, token,
} from './setup-routing.mjs';

// One `accounts.mjs list` row: "  <n>. <description> [<key>]", then "  (default, revoked)" marks when any.
const LISTED_ACCOUNT = /^ {2}\d+\. (.+) \[([0-9a-f]{8})\](?: {2}\(([a-z, ]+)\))?$/;
export const ACCOUNT_LINE = /^account=([0-9a-f]{8})$/;
const CAPTURED = / source=(\S+) plan=([^\s.]+)/;
export const PLAN_EXPIRED = /Codex sign-in expired/;
const ACCOUNT_QUESTION = 'This machine is already linked to Beezi. Which account should setup use?';
const KEEP_ACCOUNT = 'Keep this account; no browser sign-in';
const LINK_ANOTHER = { label: 'Link another account', description: 'Sign in through your browser' };
const EXPIRED_NOTE = 'Run `codex login`, then run this installer again.';
const PLAN_SKIPPED = 'No plan was saved. Your Beezi link itself already succeeded.';
const TIER_QUESTION = 'How does this machine pay for Codex?';
export const TIER_CHOICES = Object.freeze([
  { label: 'ChatGPT Free', value: 'free' },
  { label: 'ChatGPT Plus', value: 'plus' },
  { label: 'ChatGPT Pro — $100/mo (5× Plus usage)', value: 'pro_5x' },
  { label: 'ChatGPT Pro — $200/mo (20× Plus usage)', value: 'pro_20x' },
  { label: 'ChatGPT Go', value: 'go' },
  { label: 'ChatGPT Team', value: 'team' },
  { label: 'ChatGPT Business', value: 'business' },
  { label: 'ChatGPT Enterprise', value: 'enterprise' },
  { label: 'ChatGPT Edu', value: 'edu' },
  { label: 'An OpenAI API key (no ChatGPT subscription)', value: 'api_key' },
]);

export function parseLinkedAccounts(text) {
  return outputLines(text)
    .map((line) => LISTED_ACCOUNT.exec(line))
    .filter((found) => found !== null)
    .map((found) => {
      const marks = found[3] === undefined ? [] : found[3].split(', ');
      return {
        description: found[1],
        key: found[2],
        isDefault: marks.indexOf('default') !== -1,
        revoked: marks.indexOf('revoked') !== -1,
      };
    });
}

// The linked account to continue with, null to sign in, or false when the question is dismissed.
export async function pickAccount(ctx) {
  const listing = await ctx.run('accounts.mjs', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  const linked = parseLinkedAccounts(listing.stdout).filter((account) => !account.revoked);
  // The analytics default first, then the rest in listed order.
  const usable = linked.filter((account) => account.isDefault).concat(linked.filter((account) => !account.isDefault));
  if (usable.length === 0) return null;
  const options = usable.map((account) => ({ label: `Continue with ${account.description}`, description: KEEP_ACCOUNT })).concat([LINK_ANOTHER]);
  const pick = await ctx.ask.choose(ACCOUNT_QUESTION, options, { defaultIndex: 0 });
  if (pick === null) return false;
  return pick < usable.length ? usable[pick].key : null;
}

// Streams login.mjs with its key line hidden; the key is null unless it exited 0 with an `account=` line.
export async function signIn(ctx) {
  const result = await ctx.run('login.mjs', [], { stream: true, hide: /^account=/ });
  const last = lastLine(result.stdout, ACCOUNT_LINE);
  return { key: result.code === 0 && last !== null ? ACCOUNT_LINE.exec(last)[1] : null, output: result.stdout };
}

// True when the capture line names a priced plan or a billing source that is not a subscription.
export function planSettled(text) {
  const line = lastLine(text, CAPTURED);
  if (line === null) return false;
  const found = CAPTURED.exec(line);
  return CHATGPT_PLANS.indexOf(found[2]) !== -1
    || found[1] === BillingSource.OPENAI_API_KEY
    || found[1] === BillingSource.THIRD_PARTY;
}

export async function capturePlan(ctx, key) {
  const captured = await ctx.run('billing-capture.mjs', ['--from-codex', '--via', 'login', '--account', key]);
  report(ctx, captured);
  if (planSettled(captured.stdout)) return;
  if (PLAN_EXPIRED.test(captured.stdout)) {
    ctx.print(EXPIRED_NOTE);
    return;
  }
  const pick = await ctx.ask.choose(TIER_QUESTION, TIER_CHOICES);
  if (pick === null) {
    ctx.print(PLAN_SKIPPED);
    return;
  }
  report(ctx, await ctx.run('billing-capture.mjs', ['--plan', TIER_CHOICES[pick].value, '--via', 'login-user', '--account', key]));
}

export const FINALIZED = /your history pull is finalized/;
export const STILL_DEFAULT = /still reads from this machine/;
export const LINKED_AS = /linked as (.+?)\. (?:Nothing changed|Credentials stored)/;
export const TRUST_PENDING = /run \/hooks in Codex/;
const HOOK_OUTCOME = /^(?:[✓⚠]|Beezi: another )/;
const PLAN_PROGRESS = '==> Checking your plan…';
const SESSIONS_PROGRESS = '==> Looking at your past sessions…';
const FINALIZE_NOTE = 'History import is now closed for this account: past sessions on other machines can no longer be imported. New sessions are still tracked everywhere Beezi is installed.';
const DEFAULT_UNCHANGED = 'The default account is unchanged. The settings skill (Account → Default account) switches it later.';
const TRUST_NOTE = 'One step left in Codex: run /hooks and trust the Beezi entries.';
const CRASH_QUESTION = 'How should Beezi crash reports work?';
export const CRASH_CHOICES = Object.freeze([
  { mode: 'correlate', label: 'Correlate (recommended)', description: 'attaches an installation ID so support can find your report' },
  { mode: 'on', label: 'On', description: 'sends reports without an installation ID and leaves that choice open' },
  { mode: 'anonymous', label: 'Anonymous', description: 'sends reports without an installation ID and never offers one again' },
  { mode: 'off', label: 'Off', description: 'sends nothing and deletes pending reports' },
]);

// Runs `hooks.mjs install` and prints its ✓/⚠/busy outcome lines; resolves its stdout for the trust check.
async function checkHooks(ctx) {
  const result = await ctx.run('hooks.mjs', ['install']);
  if (result.code !== 0) report(ctx, result);
  else outputLines(result.stdout).filter((line) => HOOK_OUTCOME.test(line)).forEach((line) => ctx.print(line));
  return result.stdout;
}

async function uploadHistory(ctx, key) {
  const result = await ctx.run('backfill.mjs', ['--via', 'login', '--account', key], { stream: true });
  if (FINALIZED.test(result.stdout)) ctx.print(FINALIZE_NOTE);
}

// "<name> - <workspace>" from the sign-in's "linked as" sentence becomes "<name> (<workspace>)".
export function defaultQuestion(signInOutput) {
  const found = LINKED_AS.exec(signInOutput);
  const who = found === null ? 'this account' : found[1];
  const at = who.lastIndexOf(' - ');
  const name = at === -1 ? who : `${who.slice(0, at)} (${who.slice(at + 3)})`;
  return `Make ${name} the account the analytics skill reads from?`;
}

async function offerDefault(ctx, key, signInOutput) {
  if (!STILL_DEFAULT.test(signInOutput)) return;
  const yes = await ctx.ask.confirm(defaultQuestion(signInOutput), false);
  if (yes === true) await ctx.run('accounts.mjs', ['use', key], { stream: true });
  if (yes === false) ctx.print(DEFAULT_UNCHANGED);
}

export function crashModeOf(text) {
  const line = lastLine(text, /^crash=/);
  return line === null ? null : token(line, 'crash');
}

// Asks only when the current mode is known; it is the default, and every answer runs telemetry.mjs.
async function chooseCrashMode(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  const mode = crashModeOf(keys.stdout);
  const current = CRASH_CHOICES.findIndex((choice) => choice.mode === mode);
  if (current === -1) {
    if (keys.code !== 0) report(ctx, keys);
    return;
  }
  const options = CRASH_CHOICES.map((choice, i) => ({
    label: choice.label,
    description: i === current ? `${choice.description}, current setting` : choice.description,
  }));
  const pick = await ctx.ask.choose(CRASH_QUESTION, options, { defaultIndex: current });
  if (pick === null) return;
  report(ctx, await ctx.run('telemetry.mjs', [CRASH_CHOICES[pick].mode]));
}

// A blank line and the /hooks trust reminder, only when the sign-in or hooks check asked for it.
function finish(ctx, hooksOutput) {
  if (!TRUST_PENDING.test(hooksOutput)) return;
  ctx.print('');
  ctx.print(TRUST_NOTE);
}

// The login skill's steps in the terminal: 0 when done, 1 when the sign-in failed or the account question was dismissed.
export async function runSetup(ctx) {
  let key = await pickAccount(ctx);
  let signInOutput = '';
  let hooksOutput;
  if (key === false) return 1;
  if (key === null) {
    const signedIn = await signIn(ctx);
    if (signedIn.key === null) return 1;
    key = signedIn.key;
    signInOutput = signedIn.output;
    hooksOutput = signedIn.output;
  } else {
    hooksOutput = await checkHooks(ctx);
  }
  await askNewFolders(ctx, key);
  ctx.print(PLAN_PROGRESS);
  await capturePlan(ctx, key);
  ctx.print(SESSIONS_PROGRESS);
  await reviewJoined(ctx, key);
  await reviewRoutes(ctx, key);
  await uploadHistory(ctx, key);
  await offerDefault(ctx, key, signInOutput);
  await chooseCrashMode(ctx);
  finish(ctx, hooksOutput);
  return 0;
}

// A DEFAULT import, not a named one: tools/hermetic-env.mjs patches the child_process object, and
// a named binding is snapshotted at instantiation and bypasses that guard entirely.
import childProcess from 'child_process';
import { canonicalPlan } from './billing.mjs';
import { orDefault, readString } from './compat.mjs';

// Read off the namespace at CALL time, not at import time, so the default `deps.spawn` is whatever
// the object holds when the probe actually runs.
const _spawn = (file, args, options) => childProcess.spawn(file, args, options);

// Ask Codex itself which account it is using, instead of decoding the snapshot it left in
// ~/.codex/auth.json.
//
// `codex app-server` is a second Codex process speaking a line-delimited JSON-RPC protocol on
// stdin/stdout — MCP-shaped in transport, its own method set. Two of its methods answer everything
// this plugin needs, and neither starts a conversation or a model turn:
//
//   account/read              → { account: { type, email, planType }, requiresOpenaiAuth }
//   account/rateLimits/read   → { accountId, rateLimits: { planType, primary, secondary, … }, … }
//
// MEASURED against codex-cli 0.154.0 on 2026-09-14: `account/read` carries NO accountId. The id
// lives only on the rate-limit answer, which is why both calls are made and the second is not
// optional. The values matched auth.json exactly on that machine (`plus`, the same uuid, the same
// address) — so this path is not better DATA, it is a better CHANNEL: Codex may hold its
// credentials in the OS keychain or only in its own memory, and a machine like that has no plan in
// auth.json at all. lib/chatgpt-auth.mjs stays as the fallback tier for the same reason the
// command calls itself `[experimental]`.
//
// A SHORT-LIVED HELPER, not a persistent client. It is spawned at most weekly, behind the same
// isStale() gate that already bounds the plan capture, and never on the checkpoint hot path.
// NOTHING HERE SPAWNS AT IMPORT TIME — tools/verify-minimum-runtime.cjs imports every lib module.

// Why a probe returned what it returned, for this module's own reporting: `unavailable` means
// install/expose Codex, `no-credentials` means sign in to Codex, `timeout` means try again later,
// and `disabled` means the user turned this off.
export const APP_SERVER_REASON = Object.freeze({
  OK: 'ok',
  DISABLED: 'disabled',
  UNAVAILABLE: 'unavailable',
  NO_CREDENTIALS: 'no-credentials',
  TIMEOUT: 'timeout',
  ERROR: 'error',
});

// MEASURED, not guessed: on Windows with codex-cli 0.154.0 the full probe took 2929ms cold and
// ~1050ms warm. The `codex` entry point is an npm shim, so a cold launch is cmd.exe → node → the
// platform binary before a single byte of protocol moves, and the protocol exchange itself is the
// cheap part. A 4s bound would have cut the cold run off; this one leaves headroom and still sits
// well inside the SessionStart hook's 10s budget.
const DEFAULT_TIMEOUT_MS = 6000;

// A hung or babbling child must not be buffered without bound inside a hook. The real answers are
// ~1.5KB together; a megabyte means something is wrong with the stream, not with our patience.
const MAX_OUTPUT_BYTES = 1024 * 1024;

const ID_INITIALIZE = 1;
const ID_ACCOUNT = 2;
const ID_RATE_LIMITS = 3;

const FAILURE_FIELDS = Object.freeze({
  authType: null,
  plan: null,
  subscriptionType: null,
  accountId: null,
  email: null,
});

function failure(reason) {
  return { ok: false, reason: reason, ...FAILURE_FIELDS };
}

// Turned off with BEEZI_CODEX_APP_SERVER=0 (also false/off/no). Default ON: the whole point is that
// a machine whose credentials never touch auth.json currently reports no plan at all. The variable
// is in .mcp.json's `env_vars` allowlist — a variable missing from there is invisible to the MCP
// server while the hooks still see it, which is a split brain rather than an error.
function isDisabled(env) {
  const raw = String(orDefault(env.BEEZI_CODEX_APP_SERVER, '')).trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

// Which binary to launch. BEEZI_CODEX_CLI is the escape hatch for a machine where `codex` is not on
// the PATH the hook process inherited — the single most likely reason this path fails on a machine
// that has Codex installed and working.
function codexCommand(env) {
  const override = String(orDefault(env.BEEZI_CODEX_CLI, '')).trim();
  return override === '' ? 'codex' : override;
}

// How to actually launch it. MEASURED on Windows: `codex` is an npm .cmd shim, so a bare
// spawn('codex') is ENOENT and spawn('codex.cmd') is EINVAL — Node refuses to spawn a .cmd
// directly. A shell is genuinely required there.
//
// cmd.exe is invoked EXPLICITLY rather than through `shell: true`, which spawns the same
// `cmd.exe /d /s /c …` but emits Node's DEP0190 deprecation warning on stderr. Inside a hook that
// warning is noise in the user's session for no benefit. The only interpolated value is the command
// path; the arguments are a module constant.
//
// THE QUOTING IS NOT COSMETIC — measured against the real shim, all three forms:
//   `/c <path> app-server`            works, but breaks the moment the path holds a space
//   `/c "<path>" app-server`          FAILS: Node escapes those quotes into \" before cmd sees them
//   `/c ""<path>" app-server"` + verbatim   works
// So the whole command line gets an outer pair of quotes, which `/s` strips back off, and
// windowsVerbatimArguments stops Node from escaping them on the way. This is exactly what
// `shell: true` does internally; it is reproduced here only to avoid the deprecation warning.
function launchArgs(command) {
  if (process.platform !== 'win32') return { file: command, args: ['app-server'], verbatim: false };
  const quoted = command.indexOf(' ') === -1 ? command : `"${command}"`;
  // /d skips AutoRun scripts, /s makes the quote-stripping rule predictable, /c runs and exits.
  return {
    file: orDefault(process.env.ComSpec, 'cmd.exe'),
    args: ['/d', '/s', '/c', `"${quoted} app-server"`],
    verbatim: true,
  };
}

// Codex names ChatGPT auth `chatgpt` and key auth `apiKey`. Folded to the two labels the billing
// ladder already speaks (lib/billing-config.mjs step 4), so nothing downstream has to learn a third
// spelling of the same fact.
function normalizeAuthType(value) {
  const type = String(orDefault(value, '')).trim().toLowerCase();
  if (type === '') return null;
  if (type === 'apikey' || type === 'api_key') return 'apikey';
  return type;
}

// The plan tier goes through the SHARED normalizer, never a local copy: `canonicalPlan` already
// folds Codex's own vocabulary (`prolite` → `pro_5x`, `pro` → `pro_20x`, …) onto the labels the API
// prices, and a second table here is exactly how `go` came to be missing from both.
//
// AN UNRECOGNISED OR ABSENT TIER IS `unknown`, NEVER `free`. `free` is a plan we price, so writing
// it for "we could not tell" files a paying user under the free tier and then looks settled enough
// that nothing ever asks again.
function readPlan(account) {
  if (normalizeAuthType(account.type) !== 'chatgpt') return { plan: null, subscriptionType: null };
  const plan = canonicalPlan(account.planType);
  return { plan: orDefault(plan, 'unknown'), subscriptionType: plan };
}

// Read the account Codex is actually signed in as, by asking Codex.
//
// Never throws and never rejects: every failure is a typed `{ ok: false, reason }`. The child is
// always closed — on success, on timeout, and on protocol error.
export function readAccountViaAppServer(deps = {}) {
  const env = orDefault(deps.env, process.env);
  const timeoutMs = orDefault(deps.timeoutMs, DEFAULT_TIMEOUT_MS);
  const spawn = orDefault(deps.spawn, _spawn);

  if (isDisabled(env)) return Promise.resolve(failure(APP_SERVER_REASON.DISABLED));

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timer = null;
    let buffered = '';
    let bytes = 0;
    let accountResult;
    let rateLimitsResult;
    let accountDone = false;
    let rateLimitsDone = false;

    function cleanup() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!child) return;
      // stdin EOF is how this server is meant to end — it exits on its own, measured. `kill` is the
      // backstop for a build that does not, and for the Windows shell wrapper in between.
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already gone */ }
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function fail(reason) {
      finish(failure(reason));
    }

    function send(message) {
      if (settled || !child) return;
      try { child.stdin.write(JSON.stringify(message) + '\n'); } catch { fail(APP_SERVER_REASON.ERROR); }
    }

    // Both answers are in (or have failed). The plan is the point; the account id rides along, so a
    // rate-limit call that failed on its own costs the id and nothing else.
    function maybeComplete() {
      if (!accountDone || !rateLimitsDone) return;
      if (!accountResult) return fail(APP_SERVER_REASON.ERROR);
      const account = accountResult.account;
      if (!account || typeof account !== 'object') return fail(APP_SERVER_REASON.NO_CREDENTIALS);
      const limits = orDefault(rateLimitsResult, {});
      const plan = readPlan(account);
      finish({
        ok: true,
        reason: APP_SERVER_REASON.OK,
        authType: normalizeAuthType(account.type),
        plan: plan.plan,
        subscriptionType: plan.subscriptionType,
        accountId: readString(limits.accountId),
        email: readString(account.email),
      });
    }

    function handleMessage(message) {
      if (message === null || typeof message !== 'object') return;
      // A notification has no id (`remoteControl/status/changed` arrives unasked on every run).
      // Matching strictly on the ids we issued is what keeps one from being read as an answer.
      if (message.id === ID_INITIALIZE) {
        if (message.error) return fail(APP_SERVER_REASON.ERROR);
        send({ method: 'initialized' });
        // `refreshToken: false` — this is a read, not a credential operation. Both requests are
        // pipelined: the server answers them independently and the round trips are the slow part.
        send({ id: ID_ACCOUNT, method: 'account/read', params: { refreshToken: false } });
        send({ id: ID_RATE_LIMITS, method: 'account/rateLimits/read' });
        return;
      }
      if (message.id === ID_ACCOUNT) {
        accountDone = true;
        // An error on THIS call is terminal: there is nothing left to learn without it, and
        // waiting for the rate-limit answer would only delay the fallback tier.
        if (message.error) return fail(APP_SERVER_REASON.ERROR);
        accountResult = orDefault(message.result, {});
        return maybeComplete();
      }
      if (message.id === ID_RATE_LIMITS) {
        rateLimitsDone = true;
        if (!message.error) rateLimitsResult = orDefault(message.result, {});
        return maybeComplete();
      }
    }

    function onData(chunk) {
      const text = String(chunk);
      bytes += text.length;
      if (bytes > MAX_OUTPUT_BYTES) return fail(APP_SERVER_REASON.ERROR);
      buffered += text;
      let index = buffered.indexOf('\n');
      while (index >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.trim() !== '') {
          let message = null;
          // An unparseable line is skipped, not fatal: the answers we want are framed one per line
          // and a stray diagnostic on stdout must not cost the read.
          try { message = JSON.parse(line); } catch { message = null; }
          if (message) handleMessage(message);
        }
        if (settled) return;
        index = buffered.indexOf('\n');
      }
    }

    const launch = launchArgs(codexCommand(env));
    try {
      child = spawn(launch.file, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch {
      return fail(APP_SERVER_REASON.UNAVAILABLE);
    }

    timer = setTimeout(() => { fail(APP_SERVER_REASON.TIMEOUT); }, timeoutMs);
    // An unref'd timer would let the process exit with the probe still pending; this one is short
    // and always cleared, so it is left referenced deliberately.

    child.on('error', () => { fail(APP_SERVER_REASON.UNAVAILABLE); });
    // A child that exits while a request is in flight makes its stdin emit EPIPE ASYNCHRONOUSLY.
    // An unhandled 'error' on a stream THROWS — inside the SessionStart hook that is not a failed
    // probe, it is a dead hook. The close/timeout handlers already produce the right answer.
    child.stdin.on('error', () => {});
    // Reached only when the child dies before answering — after `finish`, `settled` swallows it.
    child.on('close', () => { fail(APP_SERVER_REASON.UNAVAILABLE); });
    child.stdout.on('data', onData);
    // Drained and discarded. Codex writes its own logs here, and an unread pipe fills and blocks
    // the child; the protocol stream is stdout and must stay separate from it.
    child.stderr.on('data', () => {});

    send({
      id: ID_INITIALIZE,
      method: 'initialize',
      params: { clientInfo: { name: 'beezi_codex_plugin', version: '1.0.0' } },
    });
  });
}

// Fold the live answer and the auth.json decode into ONE account object, shaped exactly like
// lib/chatgpt-auth.mjs's return so every consumer downstream is unchanged.
//
// Live wins for the things it actually knows — plan, tier, account id, address — and defers for the
// things it does not report: `hasStoredApiKey` is a fact about auth.json's contents, and the billing
// ladder (lib/billing-config.mjs step 4) genuinely reaches it with a null authMode.
//
// `expiresAt: null` IS THE POINT, not an omission. The expired-claim rule in lib/billing-capture.mjs
// exists because the plan in auth.json is a snapshot that rots in place — a token three days expired
// still asserted `free` on a real machine. A live lookup cannot rot, so handing it an expiry would
// downgrade a correct `plus` to `unknown`, leave the config stale, and re-nudge the user forever.
export function mergeAccounts(appServer, fileAccount) {
  const live = appServer && appServer.ok === true;
  if (!live) {
    if (!fileAccount) return null;
    return { ...fileAccount, live: false };
  }
  // THE LIVE ANSWER WINS THIS FIELD. `account.type` is something tier 1 knows first-hand, and it is
  // the field the billing ladder resolves on. Letting a stale auth.json outrank it puts a machine
  // that has moved to an API key back on `chatgpt` — and then readPlan, which only names a plan for
  // a ChatGPT account, reports none, so nothing is ever written and the nudge becomes permanent.
  const authMode = orDefault(
    orDefault(appServer.authType, null),
    fileAccount ? fileAccount.authMode : null,
  );
  return {
    authMode: authMode,
    // With no auth.json to read, an api-key sign-in is the only evidence that a key is in play —
    // and it is the machine whose billing source is otherwise resolved as `unknown`.
    hasStoredApiKey: fileAccount
      ? fileAccount.hasStoredApiKey === true
      : appServer.authType === 'apikey',
    subscriptionType: orDefault(appServer.subscriptionType, null),
    plan: orDefault(appServer.plan, null),
    expiresAt: null,
    accountId: orDefault(appServer.accountId, fileAccount ? fileAccount.accountId : null),
    email: orDefault(appServer.email, fileAccount ? fileAccount.email : null),
    live: true,
  };
}

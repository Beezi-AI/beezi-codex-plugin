import { parseArgs, buildConfig, captureFromCodexAccount } from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { getAuthentication } from '../lib/token.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { getAccount, getDefaultKey, parseAccountFlag } from '../lib/accounts.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// THIS SCRIPT DOES TWO THINGS AT TWO SCOPES, and only the second one takes a key. The ChatGPT plan
// it captures describes the MACHINE — one Codex install, one subscription paying for it — so the
// three tiers, the questions and billing.json stay exactly where they were. The Beezi check-in
// that follows is per account, because each linked account has its own row to update.

// One account's own { token, clientId }, or null when its stored state cannot produce one. A null
// is not an error here: syncAccountIfNeeded reads it as the quiet no-token path.
//
// The INDEX ROW is the fallback for the client id, never the authority — lib/accounts.mjs's own
// sessionFor states the rule: the credential blob is what the refresh actually rotated, so its
// client_id wins whenever it has one. A row migrated from a pre-0.13 install whose blob carried no
// client_id still names one, and dropping it would send this check-in with no X-Beezi-Client at
// all — a silent misattribution, not an error. Read only when it is needed, so the ordinary path
// still costs one authentication and no index read.
async function sessionFor(key) {
  const auth = await getAuthentication(key).catch(() => null);
  if (!auth || auth.state !== 'ready' || !auth.accessToken) return null;
  if (auth.clientId != null) return { token: auth.accessToken, clientId: auth.clientId };
  const row = await getAccount(key).catch(() => null);
  return { token: auth.accessToken, clientId: orDefault((row || {}).clientId, null) };
}

// A bare top-level `try` used to be the whole body. It cannot stay one: the account check-in below
// is async, and an `await` at brace depth zero is top-level await — Node 14.8+, past this plugin's
// 13.2 floor, and rejected by the ban gate. Same shape scripts/me.mjs already uses: the body is an
// async main(), and main().catch() is the single error exit.
async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  // `--account` is stripped before the billing flags are parsed, so the plan parser never sees a
  // flag that is not its own.
  const flagged = await parseAccountFlag(process.argv.slice(2));
  const parsed = parseArgs(flagged.rest);

  // The existing config feeds the source ladder: recorded evidence and a previous self-report are
  // both inputs, so capturing a plan must not resolve the source as if the machine were untouched.
  const existing = readBillingConfig();

  let config;
  // Which tier answered, appended to the confirmation line so a support question can tell a live
  // reading from a decoded snapshot without re-running anything. Empty on the self-report path.
  let capturedVia = '';
  if (parsed.fromCodex) {
    // --from-codex: ask Codex itself which account it is signed in as (`codex app-server`), and
    // fall back to the non-secret plan claim in ~/.codex/auth.json. Deterministic; no tokens are
    // read or returned and the model supplies no values. Shared with the SessionStart hook so both
    // apply the same rule to an expired claim.
    const captured = await captureFromCodexAccount({ via: parsed.via, existing });
    if (captured.reason === 'no-account') {
      console.log('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.');
      process.exit(0);
    }
    if (captured.reason === 'kept-self-reported') {
      console.log('Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.');
      process.exit(0);
    }
    if (captured.reason === 'expired-claim') {
      // Distinguished from a plain unknown on purpose: this one has a cheaper fix than asking the
      // user their tier, and the login skill branches on it.
      writeBillingConfig(captured.config);
      const on = new Date(captured.config.credentialsExpiresAt).toISOString().slice(0, 10);
      console.log(`Beezi: your Codex sign-in expired on ${on}, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.`);
      process.exit(0);
    }
    config = captured.config;
    capturedVia = ` via=${orDefault(captured.tier, 'auth-json')}`;
  } else {
    config = buildConfig(parsed, process.env, new Date(), existing);
  }

  writeBillingConfig(config);
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${orDefault(config.plan, 'n/a')}${capturedVia}.`);
  // Tell Beezi about the plan we just recorded, FORCED (G-2-1). Force is load-bearing here for the
  // same reason it is at login: the plan may have changed while the accountUuid and email did not,
  // and on a machine whose billing.json already named a plan the payload can be byte-identical to
  // the marker's — the resync interval would then swallow the one check-in this command exists to
  // send. Best-effort and bounded, and AFTER the confirmation line: the capture is already on disk,
  // so an offline machine must still report the write it made rather than waiting on a POST.
  //
  // The login skill passes the key it just linked; with no flag this is the analytics default,
  // and on a machine with no accounts at all there is nothing to check in against — reading the
  // index must never fail a capture that has already been written.
  let key = flagged.account;
  if (key === null) {
    try { key = await getDefaultKey(); } catch { key = null; }
  }
  if (key !== null) {
    try {
      await syncAccountIfNeeded(key, await sessionFor(key), { force: true });
    } catch { /* best-effort */ }
  }
}

main().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});

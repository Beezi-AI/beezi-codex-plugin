import { parseArgs, buildConfig, captureFromCodexAccount } from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));

  // The existing config feeds the source ladder: recorded evidence and a previous self-report are
  // both inputs, so capturing a plan must not resolve the source as if the machine were untouched.
  const existing = readBillingConfig();

  let config;
  if (parsed.fromCodex) {
    // --from-codex: read the non-secret ChatGPT plan claim from ~/.codex/auth.json ourselves,
    // deterministically. No tokens are read/returned; the model does not supply any values. Shared
    // with the SessionStart hook so both apply the same rule to an expired claim.
    const captured = captureFromCodexAccount({ via: parsed.via, existing });
    if (captured.reason === 'no-account') {
      console.log('Beezi: no ChatGPT subscription info found in ~/.codex/auth.json — nothing captured.');
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
  } else {
    config = buildConfig(parsed, process.env, new Date(), existing);
  }

  writeBillingConfig(config);
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan ?? 'n/a'}.`);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}

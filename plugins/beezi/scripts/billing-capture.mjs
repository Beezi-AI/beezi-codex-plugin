import { parseArgs, buildConfig, shouldKeepExisting } from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { readCodexAccount } from '../lib/codex-account.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));

  // --from-codex: read the non-secret ChatGPT plan claim from ~/.codex/auth.json ourselves,
  // deterministically. No tokens are read/returned; the model does not supply any values.
  let args = parsed;
  if (parsed.fromCodex) {
    const account = readCodexAccount();
    if (!account || !account.plan) {
      console.log('Beezi: no ChatGPT subscription info found in ~/.codex/auth.json — nothing captured.');
      process.exit(0);
    }
    args = {
      subscriptionType: account.subscriptionType,
      rateLimitTier: null,
      expiresAt: account.expiresAt,
      via: parsed.via,
    };
  }

  // The existing config feeds the source ladder: recorded evidence and a previous self-report are
  // both inputs, so capturing a plan must not resolve the source as if the machine were untouched.
  const existing = readBillingConfig();
  const config = buildConfig(args, process.env, new Date(), existing);

  if (parsed.fromCodex && shouldKeepExisting(config, existing)) {
    console.log('Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.');
    process.exit(0);
  }

  writeBillingConfig(config);
  console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan ?? 'n/a'}.`);
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}

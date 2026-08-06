import { linkStatus, describeLink, describeReporting } from '../lib/link-status.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { LinkState } from '../lib/link-status.mjs';

async function main() {
  const status = await linkStatus();
  console.log(`${status.state === LinkState.LINKED ? '✓' : '•'} Beezi: ${describeLink(status)}`);
  const reporting = describeReporting(status);
  if (reporting) console.log(`  ${reporting}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});

import path from 'path';
import url from 'url';
import { setupMain } from '../lib/setup-main.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { colorEnabled, createStyle, paint } from '../lib/setup-style.mjs';

// The installers' terminal setup: the login skill's steps, asked here instead of in a Codex thread.
setupMain(path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))).then(
  (code) => process.exit(code),
  (error) => {
    const style = createStyle({ enabled: colorEnabled({ stream: process.stderr, env: process.env }) });
    console.error('');
    console.error(paint(style, `✗ ${friendlyMessage(error)}`));
    process.exit(1);
  },
);

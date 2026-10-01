const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-runtime-'));
process.env.BEEZI_CODEX_HOME = home;
process.env.CODEX_HOME = path.join(home, 'codex');
const files = ['lib', 'scripts'].reduce((all, dir) => all.concat(fs.readdirSync(path.join(root, dir))
  .filter(name => name.endsWith('.mjs')).map(name => path.join(root, dir, name))), []);
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(checked.stderr);
}
Promise.all(files.filter(file => path.dirname(file) === path.join(root, 'lib'))
  .map(file => import(pathToFileURL(file).href))).then(() => {
  console.log(process.version + ': parsed ' + files.length + ' runtime files and imported all library modules');
}).catch(error => { console.error(error); process.exitCode = 1; });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  skillNameFromPath, skillInjectionOf, skillReadsOfCommands, skillReadsOfCall,
} from '../lib/skills-codex.mjs';

test('skillNameFromPath — plugin cache path gets plugin:name', () => {
  assert.equal(
    skillNameFromPath('C:\\Users\\u\\.codex\\plugins\\cache\\mkt\\superpowers\\6.3.0\\skills\\systematic-debugging\\SKILL.md'),
    'superpowers:systematic-debugging');
  assert.equal(
    skillNameFromPath('/home/u/.codex/plugins/cache/beezi-internal/beezi-staging/0.14.2-staging.5368/skills/me/SKILL.md'),
    'beezi-staging:me');
});

test('skillNameFromPath — user skill folder gets the bare name', () => {
  assert.equal(skillNameFromPath('/home/u/.codex/skills/my-skill/SKILL.md'), 'my-skill');
  assert.equal(skillNameFromPath('C:/repo/.agents/skills/deploy/skill.md'), 'deploy');
});

test('skillNameFromPath — non-skill paths are null', () => {
  assert.equal(skillNameFromPath('/repo/README.md'), null);
  assert.equal(skillNameFromPath('/repo/SKILL.md.bak'), null);
  assert.equal(skillNameFromPath(''), null);
  assert.equal(skillNameFromPath(undefined), null);
});

function userMsg(text) {
  return { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text }] } };
}

test('skillInjectionOf — reads the injected name and body size', () => {
  const text = '<skill>\n<name>beezi-staging:me</name>\n<path>C:\\x\\skills\\me\\SKILL.md</path>\n---\nname: me\n';
  const got = skillInjectionOf(userMsg(text));
  assert.equal(got.name, 'beezi-staging:me');
  assert.equal(got.bytes, Buffer.byteLength(text, 'utf-8'));
});

test('skillInjectionOf — CRLF bodies and whitespace between tags still match', () => {
  assert.equal(skillInjectionOf(userMsg('<skill>\r\n<name> a:b </name>\r\n')).name, 'a:b');
});

test('skillInjectionOf — the $mention, assistant prose and other records are not injections', () => {
  assert.equal(skillInjectionOf(userMsg('$beezi-staging:me')), null);
  assert.equal(skillInjectionOf(userMsg('please use <skill>x</skill>')), null);
  assert.equal(skillInjectionOf({ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: '<skill>\n<name>x</name>' }] } }), null);
  assert.equal(skillInjectionOf({ type: 'event_msg', payload: { type: 'user_message', message: '<skill>\n<name>x</name>' } }), null);
});

const P = 'C:\\Users\\u\\.codex\\plugins\\cache\\m\\superpowers\\6.3.0\\skills\\brainstorming\\SKILL.md';
const Q = 'C:/Users/u/.codex/plugins/cache/m/superpowers/6.3.0/skills/writing-plans/SKILL.md';
const one = (names) => ({ names, pure: true });

test('skillReadsOfCommands — a plain read of one SKILL.md names the skill', () => {
  assert.deepEqual(skillReadsOfCommands([`Get-Content -Raw '${P}'`]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([`cat "${P.replace(/\\/g, '/')}"`]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([`sed -n 1,200p ${P.replace(/\\/g, '/')}`]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([`type "${P}"`]), one(['superpowers:brainstorming']));
});

test('skillReadsOfCommands — shell wrappers and array commands are unwrapped', () => {
  assert.deepEqual(skillReadsOfCommands([['powershell.exe', '-Command', `Get-Content -Raw '${P}'`]]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([['bash', '-lc', `cat '${P.replace(/\\/g, '/')}'`]]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([`pwsh -c "Get-Content '${P}'"`]), one(['superpowers:brainstorming']));
});

test('skillReadsOfCommands — listing or searching skill folders reads no skill', () => {
  const d = P.replace(/\\SKILL\.md$/, '');
  assert.equal(skillReadsOfCommands([`Get-ChildItem -Recurse '${d}' -Filter SKILL.md`]), null);
  assert.equal(skillReadsOfCommands([`rg -l name ${d}`]), null);
  assert.equal(skillReadsOfCommands([`rg --files -g SKILL.md ${d}`]), null);
  assert.equal(skillReadsOfCommands([`Select-String -Path '${P}' -Pattern name`]), null);
  assert.equal(skillReadsOfCommands([`cat '${P}' | xargs rm`]), null);
  assert.equal(skillReadsOfCommands(['cat README.md']), null);
  assert.equal(skillReadsOfCommands([]), null);
});

test('skillReadsOfCommands — several skills read in one call are all named, in order', () => {
  assert.deepEqual(skillReadsOfCommands([`cat '${P}' '${Q}'`]),
    one(['superpowers:brainstorming', 'superpowers:writing-plans']));
  assert.deepEqual(skillReadsOfCommands([`Get-Content '${P}'; Get-Content ${Q}`]),
    one(['superpowers:brainstorming', 'superpowers:writing-plans']));
  assert.deepEqual(skillReadsOfCommands([`Get-Content '${P}'`, `Get-Content '${P}'`]), one(['superpowers:brainstorming']));
});

test('skillReadsOfCommands — skill reads chained to other work are named but not pure', () => {
  // The real shape of an automatic writing-plans run (measured): discovery + two SKILL.md reads.
  const real = `rg --files docs/gap-analysis; Get-Content C:/Users/u/.agents/skills/subagents/SKILL.md; Get-Content ${Q}`;
  assert.deepEqual(skillReadsOfCommands([real]), { names: ['subagents', 'superpowers:writing-plans'], pure: false });
  assert.deepEqual(skillReadsOfCommands([`Get-Content '${P}'; npm test`]), { names: ['superpowers:brainstorming'], pure: false });
  assert.deepEqual(skillReadsOfCommands([`cat '${P}' && npm test`]), { names: ['superpowers:brainstorming'], pure: false });
  assert.deepEqual(skillReadsOfCommands([`cat '${P}'\nnpm test`]), { names: ['superpowers:brainstorming'], pure: false });
  assert.deepEqual(skillReadsOfCommands([`Get-Content '${P}'`, 'npm test']), { names: ['superpowers:brainstorming'], pure: false });
  assert.deepEqual(skillReadsOfCommands([['bash', '-lc', `cat '${P}'; npm test`]]), { names: ['superpowers:brainstorming'], pure: false });
});

test('skillReadsOfCommands — piping the read into a pager or line limiter is still a plain read', () => {
  assert.deepEqual(skillReadsOfCommands([`Get-Content '${P}' | Select-Object -First 200`]), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCommands([`cat '${P}' | head -n 200`]), one(['superpowers:brainstorming']));
  // A separator inside the quoted path is part of the path, not a second command.
  const odd = '/home/u/.codex/plugins/cache/m/p;x/1.0.0/skills/brainstorming/SKILL.md';
  assert.deepEqual(skillReadsOfCommands([`cat '${odd}'`]), one(['p;x:brainstorming']));
});

test('skillReadsOfCall — exec program and legacy calls', () => {
  const program = `const r = await tools.exec_command({cmd: "Get-Content -LiteralPath '${P.replace(/\\/g, '\\\\')}'"}); text(r);`;
  assert.deepEqual(skillReadsOfCall({ type: 'custom_tool_call', name: 'exec', input: program }), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCall({ type: 'function_call', name: 'shell',
    arguments: JSON.stringify({ command: ['powershell.exe', '-Command', `Get-Content '${P}'`] }) }), one(['superpowers:brainstorming']));
  assert.deepEqual(skillReadsOfCall({ type: 'function_call', name: 'shell_command',
    arguments: JSON.stringify({ command: `Get-Content '${P}'` }) }), one(['superpowers:brainstorming']));
  assert.equal(skillReadsOfCall({ type: 'function_call', name: 'apply_patch', arguments: '{}' }), null);
  assert.equal(skillReadsOfCall({ type: 'message' }), null);
});

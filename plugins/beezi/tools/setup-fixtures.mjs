// Scripted ctx for the setup wizard tests: run answers by "<script> <argv…>", questions take queued answers (null once the queue is empty).
export const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
export const failed = (stderr) => ({ code: 1, stdout: '', stderr });

export function fakeCtx(outputs, answers) {
  const runs = [];
  const opts = {};
  const asked = [];
  const printed = [];
  const queue = answers.slice();
  const answer = (entry) => {
    asked.push(entry);
    return Promise.resolve(queue.length ? queue.shift() : null);
  };
  return {
    runs, opts, asked, printed,
    print: (line) => { printed.push(line); },
    run: (script, argv, options) => {
      const command = [script].concat(argv).join(' ');
      runs.push(command);
      opts[command] = options === undefined ? {} : options;
      return Promise.resolve(Object.hasOwn(outputs, command) ? outputs[command] : ok(''));
    },
    ask: {
      choose: (question, options, extra) => answer({ kind: 'choose', question, options, defaultIndex: extra ? extra.defaultIndex : undefined }),
      chooseMany: (question, options) => answer({ kind: 'chooseMany', question, options }),
      confirm: (question, defaultYes) => answer({ kind: 'confirm', question, defaultYes }),
    },
  };
}

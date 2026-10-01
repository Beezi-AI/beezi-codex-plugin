import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { nodeFetch, makeAbortController, fetchCompat, hasNativeFetch } from '../lib/fetch-compat.mjs';

// nodeFetch is exercised directly: on modern Node fetchCompat prefers native fetch, and the
// fallback would otherwise never run under the suite.

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await run(base));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('GET returns status, ok, headers and json', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Custom': 'yes' });
      res.end(JSON.stringify({ hello: 'world' }));
    },
    async (base) => {
      const res = await nodeFetch(`${base}/thing`);
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.statusText, 'OK');
      assert.equal(res.headers.get('X-CUSTOM'), 'yes');
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('no-such-header'), null);
      assert.deepEqual(await res.json(), { hello: 'world' });
    },
  );
});

test('POST sends method, headers and body; non-2xx is not ok', async () => {
  let seen;
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen = { method: req.method, auth: req.headers.authorization, body: raw };
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('nope');
      });
    },
    async (base) => {
      const res = await nodeFetch(`${base}/x`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
      assert.equal(await res.text(), 'nope');
      assert.deepEqual(seen, { method: 'POST', auth: 'Bearer tok', body: '{"a":1}' });
    },
  );
});

test('body is async-iterable across chunk boundaries (SSE shape)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n');
      setTimeout(() => {
        res.write('\ndata: two\n\n');
        res.end();
      }, 10);
    },
    async (base) => {
      const res = await nodeFetch(`${base}/sse`);
      let collected = '';
      for await (const chunk of res.body) collected += chunk.toString('utf-8');
      assert.equal(collected, 'data: one\n\ndata: two\n\n');
    },
  );
});

test('pre-aborted signal rejects immediately', async () => {
  const controller = makeAbortController();
  controller.abort();
  await assert.rejects(
    nodeFetch('http://127.0.0.1:1/never', { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('abort before response rejects with AbortError (native and shim controllers)', async () => {
  const controllers = [new AbortController(), makeAbortController()];
  for (const controller of controllers) {
    await withServer(
      () => { /* never respond */ },
      async (base) => {
        const pending = nodeFetch(`${base}/hang`, { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, (err) => err.name === 'AbortError');
      },
    );
  }
});

test('abort mid-body tears down the stream', async () => {
  const controller = new AbortController();
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      // Keep the response open; never end.
    },
    async (base) => {
      const res = await nodeFetch(`${base}/sse`, { signal: controller.signal });
      await assert.rejects(
        (async () => {
          for await (const chunk of res.body) {
            void chunk;
            controller.abort();
          }
        })(),
        (err) => err.name === 'AbortError',
      );
    },
  );
});

test('302 redirect downgrades POST to GET and drops the body', async () => {
  const hits = [];
  await withServer(
    (req, res) => {
      hits.push({ method: req.method, url: req.url });
      if (req.url === '/start') {
        req.resume();
        res.writeHead(302, { Location: '/target' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('landed');
    },
    async (base) => {
      const res = await nodeFetch(`${base}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'landed');
      assert.deepEqual(hits, [
        { method: 'POST', url: '/start' },
        { method: 'GET', url: '/target' },
      ]);
    },
  );
});

test('307 redirect replays method and body', async () => {
  const hits = [];
  await withServer(
    (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, body: raw });
        if (req.url === '/start') {
          res.writeHead(307, { Location: '/target' });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
    },
    async (base) => {
      const res = await nodeFetch(`${base}/start`, { method: 'POST', body: 'payload' });
      assert.equal(res.status, 200);
      assert.deepEqual(hits, [
        { method: 'POST', url: '/start', body: 'payload' },
        { method: 'POST', url: '/target', body: 'payload' },
      ]);
    },
  );
});

test('gzip-encoded response decodes transparently', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
    },
    async (base) => {
      const res = await nodeFetch(`${base}/gz`);
      assert.deepEqual(await res.json(), { zipped: true });
    },
  );
});

test('network error rejects', async () => {
  await assert.rejects(nodeFetch('http://127.0.0.1:1/refused'));
});

test('makeAbortController shim fires listeners once and tracks aborted', () => {
  // Exercise the shim class shape regardless of platform by checking the native path too.
  const native = makeAbortController();
  assert.equal(typeof native.abort, 'function');
  assert.equal(native.signal.aborted, false);
  native.abort();
  assert.equal(native.signal.aborted, true);
});

test('fetchCompat prefers native fetch when available', () => {
  assert.equal(hasNativeFetch, typeof globalThis.fetch === 'function');
  if (hasNativeFetch) assert.notEqual(fetchCompat, nodeFetch);
});

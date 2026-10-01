import http from 'http';
import https from 'https';
import zlib from 'zlib';

// Global fetch exists only on Node 18+. Every outbound request in the plugin goes through
// `fetchCompat`, which is the native fetch when present and `nodeFetch` — a minimal
// http/https-backed implementation of the surface the plugin actually consumes — otherwise.
// That surface is: ok, status, statusText, url, headers.get(), json(), text(), and `body` as
// an async iterable (mcp-bridge iterates it for SSE; IncomingMessage has been async-iterable
// since Node 10, so streaming works without a readable-stream adapter).

export const hasNativeFetch = typeof globalThis.fetch === 'function';

const MAX_REDIRECTS = 5;

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Global AbortController is Node 15+. Call sites only ever use `controller.signal` and
// `controller.abort()` for timeouts, and `nodeFetch` duck-types the signal, so this shim is
// enough wherever the native class is missing. Native fetch (18+) always pairs with the
// native class, never the shim.
class AbortSignalShim {
  constructor() {
    this.aborted = false;
    this._listeners = [];
  }

  addEventListener(type, fn) {
    if (type === 'abort') this._listeners.push(fn);
  }

  removeEventListener(type, fn) {
    this._listeners = this._listeners.filter(function (f) { return f !== fn; });
  }
}

class AbortControllerShim {
  constructor() {
    this.signal = new AbortSignalShim();
  }

  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    const listeners = this.signal._listeners.slice();
    for (const fn of listeners) fn();
  }
}

export function makeAbortController() {
  return typeof globalThis.AbortController === 'function'
    ? new globalThis.AbortController()
    : new AbortControllerShim();
}

// The response body stream: the raw IncomingMessage, or a zlib decode of it when the server
// compressed anyway. The plugin never sends Accept-Encoding, so a compliant server responds
// identity — this branch defends against always-compress middleboxes.
function decodedBody(res) {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return res.pipe(zlib.createInflate());
  if (encoding === 'br' && zlib.createBrotliDecompress) return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function headersView(rawHeaders) {
  return {
    get(name) {
      const value = rawHeaders[String(name).toLowerCase()];
      if (value === undefined || value === null) return null;
      return Array.isArray(value) ? value.join(', ') : String(value);
    },
  };
}

function collectText(stream) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    stream.on('data', function (chunk) { chunks.push(chunk); });
    stream.on('end', function () { resolve(Buffer.concat(chunks).toString('utf-8')); });
    stream.on('error', reject);
  });
}

function makeResponse(res, finalUrl) {
  const body = decodedBody(res);
  let textPromise = null;
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: http.STATUS_CODES[res.statusCode] || '',
    url: finalUrl,
    headers: headersView(res.headers),
    body,
    text() {
      if (!textPromise) textPromise = collectText(body);
      return textPromise;
    },
    json() {
      return this.text().then(JSON.parse);
    },
  };
}

function sameOrigin(a, b) {
  return a.protocol === b.protocol && a.host === b.host;
}

// A redirect response fetch would follow transparently.
function isRedirect(statusCode) {
  return statusCode === 301 || statusCode === 302 || statusCode === 303
    || statusCode === 307 || statusCode === 308;
}

export function nodeFetch(url, init) {
  const options = init || {};
  return new Promise(function (resolve, reject) {
    let settled = false;
    let currentReq = null;
    let currentRes = null;
    const signal = options.signal;

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function succeed(response) {
      if (settled) return;
      settled = true;
      resolve(response);
    }

    // The abort listener outlives the promise on purpose: a timeout that fires while the caller is
    // still iterating the body (mcp-bridge's SSE read) has to tear the stream down, exactly as
    // native fetch does. It is removed when the response stream closes.
    function onAbort() {
      const err = abortError();
      if (currentRes) currentRes.destroy(err);
      if (currentReq) currentReq.destroy(err);
      fail(err);
    }

    function cleanup() {
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
    }

    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort);

    function request(urlString, method, headers, requestBody, redirectsLeft) {
      let parsed;
      try {
        parsed = new URL(urlString);
      } catch (err) {
        fail(err);
        return;
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(parsed, { method, headers }, function (res) {
        if (isRedirect(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, parsed);
          } catch (err) {
            fail(err);
            return;
          }
          let nextMethod = method;
          let nextBody = requestBody;
          const nextHeaders = Object.assign({}, headers);
          // 301/302/303 downgrade to a body-less GET, like fetch; 307/308 replay as-is.
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
            nextMethod = 'GET';
            nextBody = undefined;
            for (const key of Object.keys(nextHeaders)) {
              const lower = key.toLowerCase();
              if (lower === 'content-type' || lower === 'content-length') delete nextHeaders[key];
            }
          }
          // Credentials never cross origins.
          if (!sameOrigin(parsed, nextUrl)) {
            for (const key of Object.keys(nextHeaders)) {
              if (key.toLowerCase() === 'authorization') delete nextHeaders[key];
            }
          }
          request(nextUrl.toString(), nextMethod, nextHeaders, nextBody, redirectsLeft - 1);
          return;
        }
        currentRes = res;
        res.on('close', cleanup);
        succeed(makeResponse(res, parsed.toString()));
      });
      currentReq = req;
      req.on('error', fail);
      if (requestBody !== undefined && requestBody !== null) {
        req.end(requestBody);
      } else {
        req.end();
      }
    }

    request(
      String(url),
      String(options.method || 'GET').toUpperCase(),
      Object.assign({}, options.headers || {}),
      options.body,
      MAX_REDIRECTS,
    );
  });
}

export const fetchCompat = hasNativeFetch ? globalThis.fetch.bind(globalThis) : nodeFetch;

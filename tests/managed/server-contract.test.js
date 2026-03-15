import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  connectWebSocketOnce,
  managedBootstrap,
  readSseFrame,
  startUpstreamStub,
  startVisServer,
  startVisServerExpectingFailure,
  wsOrigin,
} from './testHarness.js';

let upstream;
let vis;

async function startSseStatusStub(statusCode, body = '') {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (url.pathname === '/global/event') {
      res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'expected SSE status stub address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function getUnusedOrigin() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'expected unused origin address');

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });

  return `http://127.0.0.1:${address.port}`;
}

before(async () => {
  upstream = await startUpstreamStub();
  vis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
  });
});

after(async () => {
  await Promise.allSettled([vis?.stop(), upstream?.stop()]);
});

test('GET /api/bootstrap returns the exact managed bootstrap contract', async () => {
  const response = await fetch(`${vis.origin}/api/bootstrap`);

  assert.equal(response.status, 200, 'expected GET /api/bootstrap to exist');
  assert.match(
    response.headers.get('content-type') ?? '',
    /^application\/json\b/,
    'expected bootstrap to return JSON',
  );

  const body = await response.json();
  assert.deepEqual(body, managedBootstrap);
  assert.equal('upstreamUrl' in body, false, 'bootstrap must not leak upstreamUrl');
  assert.equal('username' in body, false, 'bootstrap must not leak username');
  assert.equal('password' in body, false, 'bootstrap must not leak password');
  assert.equal('token' in body, false, 'bootstrap must not leak token');
  assert.equal('authorization' in body, false, 'bootstrap must not leak authorization');
});

test('managed startup fails deterministically when VIS_UPSTREAM_URL is missing', async () => {
  const result = await startVisServerExpectingFailure({
    VIS_MODE: 'managed',
    VIS_EDGE_AUTH_MODE: 'edge',
  });

  assert.notEqual(result.exitCode, 0, 'expected managed startup failure to exit non-zero');
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /VIS_UPSTREAM_URL is required when VIS_MODE=managed/,
    'expected missing managed upstream config error message',
  );
});

test('GET /api/project relays an allowlisted REST route under /api/*', async () => {
  const response = await fetch(`${vis.origin}/api/project?directory=%2Froot%2Fvis`);

  assert.equal(response.status, 200, 'expected GET /api/project to proxy the upstream route');

  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    pathname: '/project',
    directory: '/root/vis',
    authorization: 'Basic managed-upstream',
  });
});

test('GET /api/global/event relays SSE with the documented global envelope intact', async () => {
  const response = await fetch(`${vis.origin}/api/global/event`, {
    headers: { Accept: 'text/event-stream' },
  });

  assert.equal(response.status, 200, 'expected GET /api/global/event to exist');
  assert.match(
    response.headers.get('content-type') ?? '',
    /^text\/event-stream\b/,
    'expected SSE relay to preserve event-stream content type',
  );

  const frame = await readSseFrame(response);
  assert.match(
    frame,
    /^data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n$/,
  );
  assert.equal(
    upstream.requests.at(-1)?.headers.authorization,
    'Basic managed-upstream',
    'expected managed SSE relay to use the server-owned upstream auth header',
  );
});

test('GET /api/global/event preserves upstream auth failures deterministically', async () => {
  const authUpstream = await startSseStatusStub(401, 'upstream auth failed');
  const authVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: authUpstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
  });

  try {
    const response = await fetch(`${authVis.origin}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    assert.equal(response.status, 401, 'expected upstream SSE auth failures to remain 401');
    assert.equal(await response.text(), 'upstream auth failed');
  } finally {
    await Promise.allSettled([authVis.stop(), authUpstream.stop()]);
  }
});

test('GET /api/global/event returns 502 when the upstream SSE endpoint is unavailable', async () => {
  const unavailableOrigin = await getUnusedOrigin();
  const unavailableVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: unavailableOrigin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
  });

  try {
    const response = await fetch(`${unavailableVis.origin}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
    });

    assert.equal(response.status, 502, 'expected unavailable upstream SSE to surface as 502');
    assert.deepEqual(await response.json(), { error: 'Upstream request failed' });
  } finally {
    await unavailableVis.stop();
  }
});

test('GET /api/pty/:ptyID/connect relays the PTY websocket endpoint under /api', async () => {
  const message = await connectWebSocketOnce(
    `${wsOrigin(vis.origin)}/api/pty/pty-managed/connect?directory=%2Froot%2Fvis`,
    { sendText: 'ping-from-client' },
  );

  assert.equal(message, 'pty:pty-managed:ping-from-client');
  const upgrade = upstream.upgrades.at(-1);
  assert.deepEqual(upgrade?.searchParams, { directory: '/root/vis' });
  assert.equal(upgrade?.pathname, '/pty/pty-managed/connect');
  assert.equal(upgrade?.headers.authorization, 'Basic managed-upstream');
  assert.equal(upgrade?.clientMessage, 'ping-from-client');
});

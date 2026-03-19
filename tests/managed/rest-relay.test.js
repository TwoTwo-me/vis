import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startUpstreamStub, startVisServer } from './testHarness.js';

let upstream;
let vis;

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

test('GET /api/path relays scoped query and directory headers', async () => {
  const response = await fetch(`${vis.origin}/api/path?directory=%2Froot%2Fvis`, {
    headers: {
      'x-opencode-directory': '/srv/opencode-instance',
    },
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.pathname, '/path');
  assert.equal(body.method, 'GET');
  assert.deepEqual(body.searchParams, { directory: '/root/vis' });
  assert.equal(body.directoryHeader, '/srv/opencode-instance');
  assert.equal(body.authorization, 'Basic managed-upstream');
});

test('POST /api/session relays JSON bodies and query parameters', async () => {
  const payload = {
    title: 'Managed relay session',
    parentID: 'ses-parent',
  };
  const response = await fetch(`${vis.origin}/api/session?directory=%2Froot%2Fvis`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.pathname, '/session');
  assert.equal(body.method, 'POST');
  assert.deepEqual(body.searchParams, { directory: '/root/vis' });
  assert.deepEqual(body.body, payload);
  assert.equal(body.authorization, 'Basic managed-upstream');
});

test('GET /api/permission relays an allowlisted request', async () => {
  const response = await fetch(`${vis.origin}/api/permission?directory=%2Froot%2Fvis`);

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.pathname, '/permission');
  assert.equal(body.method, 'GET');
  assert.deepEqual(body.searchParams, { directory: '/root/vis' });
  assert.equal(body.authorization, 'Basic managed-upstream');
});

test('GET /api/command relays an allowlisted request', async () => {
  const response = await fetch(`${vis.origin}/api/command?directory=%2Froot%2Fvis`);

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.pathname, '/command');
  assert.equal(body.method, 'GET');
  assert.deepEqual(body.searchParams, { directory: '/root/vis' });
  assert.equal(body.authorization, 'Basic managed-upstream');
});

test('deny-by-default blocks non-allowlisted managed API routes', async () => {
  const requestCount = upstream.requests.length;
  const deniedRequests = [
    { path: '/api/auth/github', method: 'PUT' },
    { path: '/api/config', method: 'GET' },
    { path: '/api/global/config', method: 'GET' },
    { path: '/api/vis/token-providers', method: 'GET' },
  ];

  for (const denied of deniedRequests) {
    const response = await fetch(`${vis.origin}${denied.path}`, {
      method: denied.method,
      headers:
        denied.method === 'PUT'
          ? {
              'content-type': 'application/json',
            }
          : undefined,
      body: denied.method === 'PUT' ? JSON.stringify({ token: 'secret' }) : undefined,
    });

    assert.equal(response.status, 404, `${denied.path} should be denied in managed mode`);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  }

  assert.equal(
    upstream.requests.length,
    requestCount,
    'denied managed API routes must not reach the upstream server',
  );
});

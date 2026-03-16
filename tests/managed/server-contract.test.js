import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  connectWebSocketOnce,
  managedBootstrap,
  readSseFrame,
  startCodexUsageStub,
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

async function startProjectRootStub(projectRoot) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (url.pathname === '/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'proj-1',
            worktree: projectRoot,
            sandboxes: [],
            time: { created: 1, updated: 1 },
          },
        ]),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'expected project root stub address');

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


test('GET /api/file/content/pdf serves local PDFs under known project roots', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-file-content-pdf-'));
  const upstreamStub = await startProjectRootStub(workspace);
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstreamStub.origin,
    VIS_EDGE_AUTH_MODE: 'edge',
  });
  const pdfPath = join(workspace, 'fixture.pdf');
  const expected = Buffer.from('%PDF-1.4\n%test');
  await writeFile(pdfPath, expected);

  try {
    const response = await fetch(
      `${localVis.origin}/api/file/content/pdf?directory=${encodeURIComponent(workspace)}&path=fixture.pdf`,
    );

    assert.equal(response.status, 200, 'expected local PDF endpoint to return binary PDF');
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(await response.arrayBuffer().then((buffer) => Buffer.from(buffer).compare(expected)), 0);
  } finally {
    await Promise.allSettled([localVis.stop(), upstreamStub.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET /api/file/content/pdf rejects unknown roots and invalid paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-file-content-pdf-error-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'vis-file-content-pdf-outside-'));
  const upstreamStub = await startProjectRootStub(workspace);
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstreamStub.origin,
    VIS_EDGE_AUTH_MODE: 'edge',
  });
  await writeFile(join(workspace, 'fixture.pdf'), Buffer.from('%PDF-1.4\n%inside'));
  await writeFile(join(outsideRoot, 'secret.pdf'), Buffer.from('%PDF-1.4\n%outside'));

  try {
    const missing = await fetch(
      `${localVis.origin}/api/file/content/pdf?directory=${encodeURIComponent(workspace)}&path=missing.pdf`,
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'File read failed' });

    const invalidTraversal = await fetch(
      `${localVis.origin}/api/file/content/pdf?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(outsideRoot, 'secret.pdf'))}`,
    );
    assert.equal(invalidTraversal.status, 400);
    assert.deepEqual(await invalidTraversal.json(), { error: 'Invalid path' });

    const invalidRoot = await fetch(
      `${localVis.origin}/api/file/content/pdf?directory=${encodeURIComponent('/')}&path=${encodeURIComponent(join(outsideRoot, 'secret.pdf'))}`,
    );
    assert.equal(invalidRoot.status, 400);
    assert.deepEqual(await invalidRoot.json(), { error: 'Invalid path' });
  } finally {
    await Promise.allSettled([
      localVis.stop(),
      upstreamStub.stop(),
      rm(workspace, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});

test('GET /api/file/download serves files and archives directories under known project roots', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-file-download-'));
  const nestedDir = join(workspace, 'fixtures');
  const textPath = join(workspace, 'fixture.txt');
  const nestedPath = join(nestedDir, 'nested.txt');
  const upstreamStub = await startProjectRootStub(workspace);
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstreamStub.origin,
    VIS_EDGE_AUTH_MODE: 'edge',
  });
  await mkdir(nestedDir, { recursive: true });
  await writeFile(textPath, 'plain fixture\n');
  await writeFile(nestedPath, 'nested fixture\n');

  try {
    const fileResponse = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent(workspace)}&path=fixture.txt`,
    );
    assert.equal(fileResponse.status, 200, 'expected file download endpoint to return file bytes');
    assert.equal(fileResponse.headers.get('content-type'), 'text/plain');
    assert.match(fileResponse.headers.get('content-disposition') ?? '', /attachment; .*fixture\.txt/);
    assert.equal(await fileResponse.text(), 'plain fixture\n');

    const dirResponse = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent(workspace)}&path=fixtures`,
    );
    assert.equal(dirResponse.status, 200, 'expected directory download endpoint to return archive bytes');
    assert.equal(dirResponse.headers.get('content-type'), 'application/gzip');
    assert.match(dirResponse.headers.get('content-disposition') ?? '', /fixtures\.tar\.gz/);
    const archiveBuffer = Buffer.from(await dirResponse.arrayBuffer());
    const tarBuffer = gunzipSync(archiveBuffer);
    assert.equal(archiveBuffer[0], 0x1f, 'expected gzip magic byte 1');
    assert.equal(archiveBuffer[1], 0x8b, 'expected gzip magic byte 2');
    assert.equal(tarBuffer.includes(Buffer.from('fixtures/nested.txt')), true);
  } finally {
    await Promise.allSettled([
      localVis.stop(),
      upstreamStub.stop(),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

test('GET /api/file/download archives directories whose names begin with a dash', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-file-download-dash-'));
  const dashDir = join(workspace, '-fixtures');
  const upstreamStub = await startProjectRootStub(workspace);
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstreamStub.origin,
    VIS_EDGE_AUTH_MODE: 'edge',
  });
  await mkdir(dashDir, { recursive: true });
  await writeFile(join(dashDir, 'nested.txt'), 'nested fixture\n');

  try {
    const response = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('-fixtures')}`,
    );
    assert.equal(response.status, 200, 'expected leading-dash directory download to succeed');
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.match(response.headers.get('content-disposition') ?? '', /-fixtures\.tar\.gz/);
    const archiveBuffer = Buffer.from(await response.arrayBuffer());
    const tarBuffer = gunzipSync(archiveBuffer);
    assert.equal(tarBuffer.includes(Buffer.from('-fixtures/nested.txt')), true);
  } finally {
    await Promise.allSettled([
      localVis.stop(),
      upstreamStub.stop(),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

test('GET /api/file/download rejects unknown roots and invalid paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-file-download-error-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'vis-file-download-outside-'));
  const upstreamStub = await startProjectRootStub(workspace);
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstreamStub.origin,
    VIS_EDGE_AUTH_MODE: 'edge',
  });
  await writeFile(join(workspace, 'fixture.txt'), 'inside\n');
  await writeFile(join(outsideRoot, 'secret.txt'), 'outside\n');

  try {
    const missing = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent(workspace)}&path=missing.txt`,
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'File read failed' });

    const invalidTraversal = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(outsideRoot, 'secret.txt'))}`,
    );
    assert.equal(invalidTraversal.status, 400);
    assert.deepEqual(await invalidTraversal.json(), { error: 'Invalid path' });

    const invalidRoot = await fetch(
      `${localVis.origin}/api/file/download?directory=${encodeURIComponent('/')}&path=${encodeURIComponent(join(outsideRoot, 'secret.txt'))}`,
    );
    assert.equal(invalidRoot.status, 400);
    assert.deepEqual(await invalidRoot.json(), { error: 'Invalid path' });
  } finally {
    await Promise.allSettled([
      localVis.stop(),
      upstreamStub.stop(),
      rm(workspace, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
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

function createCodexWhamPayload(nowSeconds = Math.floor(Date.now() / 1000)) {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 35,
        reset_at: nowSeconds + 3600,
        limit_window_seconds: 5 * 3600,
      },
      secondary_window: {
        used_percent: 40,
        reset_at: nowSeconds * 1000 + 2 * 24 * 3600 * 1000,
        limit_window_seconds: 7 * 24 * 3600,
      },
    },
    code_review_rate_limit: {
      primary_window: {
        used_percent: 55,
        reset_at: nowSeconds + 14 * 24 * 3600,
        limit_window_seconds: 30 * 24 * 3600,
      },
    },
  };
}

async function writeCodexAuthFixture(workspace, payload) {
  const authPath = join(workspace, 'codex-auth.json');
  await writeFile(authPath, JSON.stringify(payload));
  return authPath;
}

async function writeCodexCacheFixture(workspace, payload) {
  const cachePath = join(workspace, 'tmux-codex-usage.json');
  await writeFile(cachePath, JSON.stringify({ payload }));
  return cachePath;
}

test('GET /api/codex/usage returns the sanitized ok contract', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-codex-usage-ok-'));
  const usageStub = await startCodexUsageStub({ body: createCodexWhamPayload() });
  const authPath = await writeCodexAuthFixture(workspace, { openai: { access: 'test-access-token', accountId: 'acct_123' } });
  const cachePath = join(workspace, 'codex-cache.json');
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    CODEX_USAGE_API_URL: `${usageStub.origin}/backend-api/wham/usage`,
    CODEX_AUTH_FILE: authPath,
    CODEX_QUOTA_CACHE_FILE: cachePath,
    CODEX_QUOTA_CACHE_TTL_SEC: '1',
    CODEX_QUOTA_STALE_SEC: '1800',
  });

  try {
    const response = await fetch(`${localVis.origin}/api/codex/usage`);
    assert.equal(response.status, 200, 'expected GET /api/codex/usage to exist');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    const body = await response.json();
    assert.equal(body.state, 'ok');
    assert.equal(body.stale, false);
    assert.equal(body.windows.fiveHour.label, '5h');
    assert.equal(body.windows.sevenDay.label, '7d');
    assert.equal(body.windows.tools30Day.label, '30d');
    assert.equal(body.windows.fiveHour.remainingPercent, 65);
    assert.equal(body.windows.sevenDay.remainingPercent, 60);
    assert.equal(body.windows.tools30Day.remainingPercent, 45);
    assert.equal('token' in body, false);
    assert.equal('accountId' in body, false);
    assert.equal('authorization' in body, false);
    assert.equal('authFile' in body, false);
    assert.equal('payload' in body, false);
    assert.ok(usageStub.requests.length > 0, 'expected the usage stub to receive a request');
    assert.equal(usageStub.requests[0]?.headers.authorization, 'Bearer test-access-token');
    assert.equal(usageStub.requests[0]?.headers['chatgpt-account-id'], 'acct_123');
  } finally {
    await Promise.allSettled([localVis.stop(), usageStub.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET /api/codex/usage returns login_required without auth', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-codex-usage-login-'));
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    CODEX_AUTH_FILE: join(workspace, 'missing-auth.json'),
    CODEX_QUOTA_CACHE_FILE: join(workspace, 'codex-cache.json'),
  });

  try {
    const response = await fetch(`${localVis.origin}/api/codex/usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.state, 'login_required');
    assert.equal(body.message, 'Codex login required');
    assert.equal(body.windows.fiveHour.label, '5h');
    assert.equal(body.windows.sevenDay.label, '7d');
    assert.equal(body.windows.tools30Day.label, '30d');
    assert.equal(body.windows.fiveHour.remainingPercent, null);
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET /api/codex/usage returns unavailable on malformed upstream payload', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-codex-usage-unavailable-'));
  const usageStub = await startCodexUsageStub({ body: 'not-json', contentType: 'application/json' });
  const authPath = await writeCodexAuthFixture(workspace, { openai: { access: 'test-access-token' } });
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    CODEX_USAGE_API_URL: `${usageStub.origin}/backend-api/wham/usage`,
    CODEX_AUTH_FILE: authPath,
    CODEX_QUOTA_CACHE_FILE: join(workspace, 'codex-cache.json'),
    CODEX_QUOTA_CACHE_TTL_SEC: '1',
  });

  try {
    const response = await fetch(`${localVis.origin}/api/codex/usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'unavailable');
    assert.equal(body.message, 'Codex quota unavailable');
    assert.equal(body.windows.fiveHour.label, '5h');
    assert.equal(body.windows.sevenDay.label, '7d');
    assert.equal(body.windows.tools30Day.label, '30d');
  } finally {
    await Promise.allSettled([localVis.stop(), usageStub.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET /api/codex/usage returns stale cached data when upstream fails', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-codex-usage-stale-'));
  const usageStub = await startCodexUsageStub({ statusCode: 502, body: { error: 'bad gateway' } });
  const authPath = await writeCodexAuthFixture(workspace, { openai: { access: 'test-access-token' } });
  const cachePath = await writeCodexCacheFixture(workspace, createCodexWhamPayload());
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    CODEX_USAGE_API_URL: `${usageStub.origin}/backend-api/wham/usage`,
    CODEX_AUTH_FILE: authPath,
    CODEX_QUOTA_CACHE_FILE: cachePath,
    CODEX_QUOTA_CACHE_TTL_SEC: '1',
    CODEX_QUOTA_STALE_SEC: '1800',
  });

  try {
    const response = await fetch(`${localVis.origin}/api/codex/usage`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, 'ok');
    assert.equal(body.stale, true);
    assert.equal(typeof body.staleMinutes, 'number');
  } finally {
    await Promise.allSettled([localVis.stop(), usageStub.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET /api/codex/usage keeps auth-file account id when CODEX_ACCESS_TOKEN is explicit', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-codex-usage-explicit-token-'));
  const usageStub = await startCodexUsageStub({ body: createCodexWhamPayload() });
  const authPath = await writeCodexAuthFixture(workspace, { openai: { access: 'file-token', accountId: 'acct_from_file' } });
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    CODEX_USAGE_API_URL: `${usageStub.origin}/backend-api/wham/usage`,
    CODEX_AUTH_FILE: authPath,
    CODEX_ACCESS_TOKEN: 'explicit-token',
    CODEX_QUOTA_CACHE_FILE: join(workspace, 'codex-cache.json'),
  });

  try {
    const response = await fetch(`${localVis.origin}/api/codex/usage`);
    assert.equal(response.status, 200);
    assert.equal(usageStub.requests[0]?.headers.authorization, 'Bearer explicit-token');
    assert.equal(usageStub.requests[0]?.headers['chatgpt-account-id'], 'acct_from_file');
  } finally {
    await Promise.allSettled([localVis.stop(), usageStub.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

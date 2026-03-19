import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  getTokenProvidersFile,
  loadTokenProviders,
  parseTokenProviderOutput,
  refreshTokenProviders,
  saveTokenProviders,
  testTokenProvider,
} from '../../server/visTokenProviders.js';
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

function toShellWord(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildNodeCommand(script, ...args) {
  const argv = args.map((arg) => ` ${toShellWord(arg)}`).join('');
  return `${toShellWord(process.execPath)} -e ${toShellWord(script)}${argv}`;
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

test('GET and PUT /api/vis/token-providers/config round-trip full provider definitions without upstream relay', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-config-route-'));
  const env = {
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const localVis = await startVisServer(env);
  const definitions = [
    {
      id: 'codex',
      name: 'Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: Date.parse('2026-03-19T00:00:00.000Z'),
    },
    {
      id: 'tools',
      name: 'Tools',
      command: 'printf "30d | 54%\\n"',
      updatedAt: Date.parse('2026-03-19T00:00:01.000Z'),
    },
  ];
  const requestCount = upstream.requests.length;

  try {
    const initialGet = await fetch(`${localVis.origin}/api/vis/token-providers/config`);
    assert.equal(initialGet.status, 200, 'expected vis token provider config route to exist');
    assert.deepEqual(await initialGet.json(), { definitions: [] });

    const putResponse = await fetch(`${localVis.origin}/api/vis/token-providers/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitions }),
    });
    assert.equal(putResponse.status, 200, 'expected vis token provider config save route to exist');
    assert.deepEqual(await putResponse.json(), { definitions });

    const getResponse = await fetch(`${localVis.origin}/api/vis/token-providers/config`);
    assert.equal(getResponse.status, 200, 'expected vis token provider config load route to exist');
    assert.deepEqual(await getResponse.json(), { definitions });

    const loaded = await loadTokenProviders({
      ...process.env,
      HOME: workspace,
      XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
      XDG_DATA_HOME: join(workspace, 'xdg-data'),
    });
    assert.deepEqual(loaded.providers, definitions.map((definition) => ({
      ...definition,
      updatedAt: new Date(definition.updatedAt).toISOString(),
    })));
    assert.equal(
      upstream.requests.length,
      requestCount,
      'managed vis token provider config routes must not proxy upstream requests',
    );
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('PUT /api/vis/token-providers/config accepts browser save payloads without updatedAt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-config-browser-route-'));
  const env = {
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const localVis = await startVisServer(env);
  const initialDefinitions = [
    {
      id: 'codex',
      name: 'Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: Date.parse('2026-03-19T00:00:00.000Z'),
    },
    {
      id: 'tools',
      name: 'Tools',
      command: 'printf "30d | 54%\\n"',
      updatedAt: Date.parse('2026-03-19T00:00:01.000Z'),
    },
  ];
  const browserDefinitions = initialDefinitions.map(({ updatedAt: _updatedAt, ...definition }) => definition);

  try {
    const initialPut = await fetch(`${localVis.origin}/api/vis/token-providers/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitions: initialDefinitions }),
    });
    assert.equal(initialPut.status, 200);

    const browserPut = await fetch(`${localVis.origin}/api/vis/token-providers/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitions: browserDefinitions }),
    });
    assert.equal(browserPut.status, 200, 'expected browser save payload without updatedAt to succeed');

    const browserBody = await browserPut.json();
    assert.deepEqual(
      browserBody.definitions.map(({ id, name, command }) => ({ id, name, command })),
      browserDefinitions,
    );
    assert.deepEqual(
      browserBody.definitions.map((definition) => definition.updatedAt),
      initialDefinitions.map((definition) => definition.updatedAt),
      'expected unchanged providers to preserve their timestamps when updatedAt is omitted',
    );

    const loaded = await loadTokenProviders({
      ...process.env,
      HOME: workspace,
      XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
      XDG_DATA_HOME: join(workspace, 'xdg-data'),
    });
    assert.deepEqual(loaded.providers, initialDefinitions.map((definition) => ({
      ...definition,
      updatedAt: new Date(definition.updatedAt).toISOString(),
    })));
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('GET and PUT /api/vis/token-providers/config preserve legacy-read migration and canonical-write semantics', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-config-route-migration-'));
  const env = {
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const localVis = await startVisServer(env);
  const canonicalPath = getTokenProvidersFile(env);
  const legacyPath = join(env.XDG_DATA_HOME, 'vis', 'token-providers.json');
  const legacyDefinitions = [
    {
      id: 'legacy-codex',
      name: 'Legacy Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
  ];
  const savedDefinitions = [
    {
      id: 'codex',
      name: 'Codex',
      command: 'printf "30d | 54%\\n"',
      updatedAt: Date.parse('2026-03-19T00:00:01.000Z'),
    },
  ];

  try {
    await mkdir(join(env.XDG_DATA_HOME, 'vis'), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyDefinitions, null, 2)}\n`, { mode: 0o600 });

    const initialGet = await fetch(`${localVis.origin}/api/vis/token-providers/config`);
    assert.equal(initialGet.status, 200, 'expected migration-aware config route load to succeed');
    assert.deepEqual(await initialGet.json(), {
      definitions: legacyDefinitions.map((definition) => ({
        ...definition,
        updatedAt: Date.parse(definition.updatedAt),
      })),
    });
    await assert.rejects(readFile(canonicalPath, 'utf8'), /ENOENT/);

    const putResponse = await fetch(`${localVis.origin}/api/vis/token-providers/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definitions: savedDefinitions }),
    });
    assert.equal(putResponse.status, 200, 'expected migration-aware config route save to succeed');
    assert.deepEqual(await putResponse.json(), { definitions: savedDefinitions });

    const canonicalRaw = await readFile(canonicalPath, 'utf8');
    const legacyRaw = await readFile(legacyPath, 'utf8');
    assert.deepEqual(
      JSON.parse(canonicalRaw),
      savedDefinitions.map((definition) => ({
        ...definition,
        updatedAt: new Date(definition.updatedAt).toISOString(),
      })),
      'expected route saves to target canonical config path with normalized timestamps',
    );
    assert.deepEqual(
      JSON.parse(legacyRaw),
      legacyDefinitions,
      'expected legacy config file to remain untouched after canonical route save',
    );
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('POST /api/vis/token-providers/test returns draft preview rows without persisting config', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-test-route-'));
  const env = {
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const localVis = await startVisServer(env);
  const requestCount = upstream.requests.length;

  try {
    const response = await fetch(`${localVis.origin}/api/vis/token-providers/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Draft provider',
        command: buildNodeCommand("process.stdout.write('7d | 30%\\n30d | 54%\\n');"),
      }),
    });

    assert.equal(response.status, 200, 'expected vis token provider draft test route to exist');
    assert.deepEqual(await response.json(), {
      result: {
        id: 'draft',
        name: 'Draft provider',
        status: 'ok',
        message: 'Provider ready',
        rows: [
          { leftText: '7d', rightText: '30%' },
          { leftText: '30d', rightText: '54%' },
        ],
      },
    });

    const loaded = await loadTokenProviders({
      ...process.env,
      HOME: workspace,
      XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
      XDG_DATA_HOME: join(workspace, 'xdg-data'),
    });
    assert.deepEqual(loaded.providers, []);
    assert.equal(
      upstream.requests.length,
      requestCount,
      'managed vis token provider test route must not proxy upstream requests',
    );
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('POST /api/vis/token-providers/refresh returns ready panel DTOs without command strings', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-refresh-route-'));
  const markerPath = join(workspace, 'marker.txt');
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const localVis = await startVisServer({
    VIS_MODE: 'managed',
    VIS_UPSTREAM_URL: upstream.origin,
    VIS_UPSTREAM_AUTH_HEADER: 'Basic managed-upstream',
    VIS_EDGE_AUTH_MODE: 'edge',
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  });
  const requestCount = upstream.requests.length;

  try {
    await saveTokenProviders(
      [
        {
          id: 'first',
          name: 'First',
          command: buildNodeCommand(
            "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'ready'); process.stdout.write('7d | 30%\\n'); }, 50);",
            markerPath,
          ),
          updatedAt: '2026-03-19T00:00:00.000Z',
        },
        {
          id: 'second',
          name: 'Second',
          command: buildNodeCommand(
            "process.stdout.write(`${require('node:fs').existsSync(process.argv[1]) ? 'marker' : 'missing'} | 54%\\n`);",
            markerPath,
          ),
          updatedAt: '2026-03-19T00:00:01.000Z',
        },
      ],
      env,
    );

    const response = await fetch(`${localVis.origin}/api/vis/token-providers/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 200, 'expected vis token provider refresh route to exist');
    assert.deepEqual(await response.json(), {
      state: 'ready',
      message: 'Token providers refreshed',
      providers: [
        {
          id: 'first',
          name: 'First',
          status: 'ok',
          message: 'Provider ready',
          rows: [{ leftText: '7d', rightText: '30%' }],
        },
        {
          id: 'second',
          name: 'Second',
          status: 'ok',
          message: 'Provider ready',
          rows: [{ leftText: 'marker', rightText: '54%' }],
        },
      ],
    });
    assert.equal(
      upstream.requests.length,
      requestCount,
      'managed vis token provider refresh route must not proxy upstream requests',
    );
  } finally {
    await Promise.allSettled([localVis.stop(), rm(workspace, { recursive: true, force: true })]);
  }
});

test('token provider config path migration falls back from legacy read and saves only canonical config path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-config-path-migration-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const legacyDefinitions = [
    {
      id: 'legacy-codex',
      name: 'Legacy Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
  ];
  const canonicalDefinitions = [
    {
      id: 'canonical-codex',
      name: 'Canonical Codex',
      command: 'printf "30d | 54%\\n"',
      updatedAt: '2026-03-19T00:00:01.000Z',
    },
  ];
  const canonicalPath = getTokenProvidersFile(env);
  const legacyPath = join(env.XDG_DATA_HOME, 'vis', 'token-providers.json');

  try {
    await mkdir(join(env.XDG_DATA_HOME, 'vis'), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyDefinitions, null, 2)}\n`, { mode: 0o600 });

    const loadedFromLegacy = await loadTokenProviders(env);
    assert.deepEqual(loadedFromLegacy, {
      status: 'ok',
      providers: legacyDefinitions,
      filePath: canonicalPath,
    });

    const saved = await saveTokenProviders(canonicalDefinitions, env);
    const canonicalRaw = await readFile(canonicalPath, 'utf8');
    const canonicalStat = await stat(canonicalPath);
    const legacyRaw = await readFile(legacyPath, 'utf8');
    const loadedCanonical = await loadTokenProviders(env);

    assert.equal(saved.status, 'ok');
    assert.equal(saved.filePath, canonicalPath);
    assert.deepEqual(JSON.parse(canonicalRaw), canonicalDefinitions);
    assert.equal(canonicalStat.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(legacyRaw), legacyDefinitions);
    assert.deepEqual(loadedCanonical, {
      status: 'ok',
      providers: canonicalDefinitions,
      filePath: canonicalPath,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider invalid new config path returns config_error without legacy fallback', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-invalid-new-config-path-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const canonicalPath = getTokenProvidersFile(env);
  const legacyPath = join(env.XDG_DATA_HOME, 'vis', 'token-providers.json');
  const legacyDefinitions = [
    {
      id: 'legacy-codex',
      name: 'Legacy Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
  ];

  try {
    await mkdir(join(env.XDG_CONFIG_HOME, 'vis', 'token'), { recursive: true });
    await writeFile(canonicalPath, '{not-json}\n', { mode: 0o600 });
    await mkdir(join(env.XDG_DATA_HOME, 'vis'), { recursive: true });
    await writeFile(legacyPath, `${JSON.stringify(legacyDefinitions, null, 2)}\n`, { mode: 0o600 });

    const loaded = await loadTokenProviders(env);
    assert.deepEqual(loaded, {
      status: 'config_error',
      providers: [],
      filePath: canonicalPath,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider save writes the exact vis-owned config path with 0600 mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-save-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_CONFIG_HOME: join(workspace, 'xdg-config'),
  };
  const definitions = [
    {
      id: 'codex',
      name: 'Codex',
      command: 'printf "7d | 30%\\n"',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
  ];

  try {
    const saved = await saveTokenProviders(definitions, env);
    const filePath = getTokenProvidersFile(env);
    const loaded = await loadTokenProviders(env);
    const fileStat = await stat(filePath);
    const raw = await readFile(filePath, 'utf8');

    assert.equal(saved.status, 'ok');
    assert.equal(filePath, join(env.XDG_CONFIG_HOME, 'vis', 'token', 'providers.json'));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.deepEqual(loaded, { status: 'ok', providers: definitions, filePath });
    assert.deepEqual(JSON.parse(raw), definitions);
    await assert.rejects(readFile(`${filePath}.tmp`, 'utf8'), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider parse trims strict left-right rows', () => {
  assert.deepEqual(parseTokenProviderOutput(' 7d : 2d 1h 02m | 30% \n\n 30d : 12d 04h 10m | 54%  \n'), {
    status: 'ok',
    rows: [
      { leftText: '7d : 2d 1h 02m', rightText: '30%' },
      { leftText: '30d : 12d 04h 10m', rightText: '54%' },
    ],
  });
});

test('token provider ok refresh runs saved providers sequentially', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-ok-'));
  const markerPath = join(workspace, 'marker.txt');
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };
  const definitions = [
    {
      id: 'first',
      name: 'First',
      command: buildNodeCommand(
        "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'ready'); process.stdout.write('7d | 30%\\n'); }, 50);",
        markerPath,
      ),
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
    {
      id: 'second',
      name: 'Second',
      command: buildNodeCommand(
        "process.stdout.write(`${require('node:fs').existsSync(process.argv[1]) ? 'marker' : 'missing'} | 54%\\n`);",
        markerPath,
      ),
      updatedAt: '2026-03-19T00:00:01.000Z',
    },
  ];

  try {
    await saveTokenProviders(definitions, env);
    const refreshed = await refreshTokenProviders({ env });

    assert.equal(refreshed.status, 'ok');
    assert.equal(refreshed.providers.length, 2);
    assert.equal(refreshed.providers[0].status, 'ok');
    assert.deepEqual(refreshed.providers[0].rows, [{ leftText: '7d', rightText: '30%' }]);
    assert.equal(refreshed.providers[1].status, 'ok');
    assert.deepEqual(refreshed.providers[1].rows, [{ leftText: 'marker', rightText: '54%' }]);
    assert.equal('command' in refreshed.providers[0], false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider invalid blank output returns empty status', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-empty-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };

  try {
    const result = await testTokenProvider(
      {
        name: 'Codex',
        command: buildNodeCommand("process.stdout.write('\\n\\n');"),
      },
      { env },
    );

    assert.equal(result.status, 'empty');
    assert.deepEqual(result.rows, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider invalid output rejects malformed rows', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-invalid-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };

  try {
    const result = await testTokenProvider(
      {
        name: 'Codex',
        command: buildNodeCommand("process.stdout.write('broken-row\\n');"),
      },
      { env },
    );

    assert.equal(result.status, 'invalid_output');
    assert.deepEqual(result.rows, []);
    assert.equal('stderr' in result, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider timeout returns timed_out deterministically', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-timeout-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };

  try {
    const result = await testTokenProvider(
      {
        name: 'Codex',
        command: buildNodeCommand('setTimeout(() => {}, 1000);'),
      },
      { env, timeoutMs: 25 },
    );

    assert.equal(result.status, 'timed_out');
    assert.deepEqual(result.rows, []);
    assert.equal('stderr' in result, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('token provider oversize output returns error without leaking raw output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vis-token-provider-oversize-'));
  const env = {
    ...process.env,
    HOME: workspace,
    XDG_DATA_HOME: join(workspace, 'xdg-data'),
  };

  try {
    const result = await testTokenProvider(
      {
        name: 'Codex',
        command: buildNodeCommand("process.stdout.write('x'.repeat(33000));"),
      },
      { env },
    );

    assert.equal(result.status, 'error');
    assert.deepEqual(result.rows, []);
    assert.equal('stdout' in result, false);
    assert.equal('stderr' in result, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

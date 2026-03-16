import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(__dirname, '..', '..');
const managedProjectId = 'proj-managed';
const managedSessionId = 'ses-managed-root';
const managedDirectory = repoRoot;
export const managedHarnessVisPort = 30001;
export const managedHarnessRequestLogPath = resolve(
  repoRoot,
  'test-results',
  'managed-mention-requests.json',
);
export const managedHarnessStatePath = resolve(
  repoRoot,
  'test-results',
  '.managed-playwright-harness.json',
);
export const managedHarnessLogPath = resolve(
  repoRoot,
  'test-results',
  '.managed-playwright-harness.log',
);
export const managedBootstrap = Object.freeze({
  mode: 'managed',
  auth: 'edge',
  capabilities: {
    rest: true,
    sse: true,
    pty: true,
  },
});

export function wsOrigin(origin) {
  return origin.replace(/^http/, 'ws');
}

export async function readRepoFile(relativePath) {
  return readFile(resolve(repoRoot, relativePath), 'utf8');
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function isPortAvailable(port) {
  const server = createServer();

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', resolveListen);
    });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      return false;
    }
    throw error;
  } finally {
    if (server.listening) {
      await closeServer(server);
    }
  }
}

async function resolvePort(preferredPort) {
  if (preferredPort === undefined) return getFreePort();

  if (!Number.isInteger(preferredPort) || preferredPort <= 0) {
    throw new Error(`invalid preferred port: ${preferredPort}`);
  }

  if (!(await isPortAvailable(preferredPort))) {
    throw new Error(`vis server port ${preferredPort} is already in use`);
  }

  return preferredPort;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(100);
  }
  return !isProcessAlive(pid);
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'expected TCP server address');
  const { port } = address;
  await closeServer(server);
  return port;
}

function createWebSocketAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeTextFrame(message) {
  const payload = Buffer.from(message);
  if (payload.length >= 126) {
    throw new Error('websocket fixture only supports short messages');
  }
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function encodeMaskedTextFrame(message) {
  const payload = Buffer.from(message);
  if (payload.length >= 126) {
    throw new Error('websocket fixture only supports short messages');
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;

  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

export async function startCodexUsageStub(options = {}) {
  const requests = [];
  const port = await getFreePort();
  const statusCode = options.statusCode ?? 200;
  const headers = { 'content-type': options.contentType ?? 'application/json', ...(options.headers ?? {}) };
  const body = options.body;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    requests.push({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      headers: { ...req.headers },
    });

    if (url.pathname !== '/backend-api/wham/usage') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    res.writeHead(statusCode, headers);
    if (body === undefined || body === null) {
      res.end();
      return;
    }
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
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

export async function startUpstreamStub(options = {}) {
  const requests = [];
  const upgrades = [];
  const ptyResponses = new Map();
  let ptyCounter = 0;
  const requestLogPath = options.requestLogPath;
  const scenario = options.scenario ?? 'default';
  const port = await getFreePort();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const body = await readRequestBody(req);
    requests.push({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      headers: { ...req.headers },
      body,
    });
    if (requestLogPath) {
      await writeJsonFile(requestLogPath, requests);
    }

    if (url.pathname === '/project') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'playwright-managed') {
        res.end(
          JSON.stringify([
            {
              id: managedProjectId,
              name: 'Managed Harness Project',
              worktree: managedDirectory,
              sandboxes: [managedDirectory],
            },
          ]),
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            pathname: url.pathname,
            directory: url.searchParams.get('directory'),
            authorization: req.headers.authorization ?? null,
          }),
        );
      }
      return;
    }

    if (url.pathname === '/path') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'playwright-managed') {
        res.end(
          JSON.stringify({
            home: '/root',
            worktree: managedDirectory,
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method ?? 'GET',
            pathname: url.pathname,
            searchParams: Object.fromEntries(url.searchParams.entries()),
            authorization: req.headers.authorization ?? null,
            directoryHeader: req.headers['x-opencode-directory'] ?? null,
            workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
            body,
          }),
        );
      }
      return;
    }

    if (url.pathname === '/vcs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        scenario === 'playwright-managed'
          ? JSON.stringify({ branch: 'main' })
          : JSON.stringify({
              ok: true,
              pathname: url.pathname,
              directory: url.searchParams.get('directory'),
              authorization: req.headers.authorization ?? null,
            }),
      );
      return;
    }

    if (url.pathname === '/agent') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        scenario === 'playwright-managed'
          ? JSON.stringify([
              {
                name: 'build',
                mode: 'primary',
                description: 'Build agent',
                color: '#22c55e',
              },
              {
                name: 'plan',
                mode: 'primary',
                description: 'Plan agent',
                color: '#f59e0b',
              },
            ])
          : JSON.stringify({
              ok: true,
              pathname: url.pathname,
              directory: url.searchParams.get('directory'),
              authorization: req.headers.authorization ?? null,
            }),
      );
      return;
    }

    if (url.pathname === '/command') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        scenario === 'playwright-managed'
          ? JSON.stringify([
              {
                name: 'debug',
                description: 'Managed harness debug command',
              },
            ])
          : JSON.stringify({
              ok: true,
              method: req.method ?? 'GET',
              pathname: url.pathname,
              searchParams: Object.fromEntries(url.searchParams.entries()),
              authorization: req.headers.authorization ?? null,
              directoryHeader: req.headers['x-opencode-directory'] ?? null,
              workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
              body,
            }),
      );
      return;
    }

    if (url.pathname === '/config/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        scenario === 'playwright-managed'
          ? JSON.stringify({ providers: [] })
          : JSON.stringify({
              ok: true,
              pathname: url.pathname,
              directory: url.searchParams.get('directory'),
              authorization: req.headers.authorization ?? null,
            }),
      );
      return;
    }

    if (url.pathname === '/session' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'playwright-managed') {
        res.end(
          JSON.stringify([
            {
              id: managedSessionId,
              projectID: managedProjectId,
              title: 'Managed Harness Session',
              directory: managedDirectory,
              timeCreated: Date.now(),
              timeUpdated: Date.now(),
            },
          ]),
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method ?? 'GET',
            pathname: url.pathname,
            searchParams: Object.fromEntries(url.searchParams.entries()),
            authorization: req.headers.authorization ?? null,
            directoryHeader: req.headers['x-opencode-directory'] ?? null,
            workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
            body,
          }),
        );
      }
      return;
    }

    if (url.pathname === '/session' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (scenario === 'playwright-managed') {
        res.end(
          JSON.stringify({
            id: managedSessionId,
            projectID: managedProjectId,
            title: 'Managed Harness Session',
            directory: managedDirectory,
            timeCreated: Date.now(),
            timeUpdated: Date.now(),
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method ?? 'GET',
            pathname: url.pathname,
            searchParams: Object.fromEntries(url.searchParams.entries()),
            authorization: req.headers.authorization ?? null,
            directoryHeader: req.headers['x-opencode-directory'] ?? null,
            workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
            body,
          }),
        );
      }
      return;
    }

    if (url.pathname === '/session/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        scenario === 'playwright-managed'
          ? JSON.stringify({ [managedSessionId]: { type: 'idle' } })
          : JSON.stringify({
              ok: true,
              method: req.method ?? 'GET',
              pathname: url.pathname,
              searchParams: Object.fromEntries(url.searchParams.entries()),
              authorization: req.headers.authorization ?? null,
              directoryHeader: req.headers['x-opencode-directory'] ?? null,
              workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
              body,
            }),
      );
      return;
    }

    if (url.pathname === '/pty' && req.method === 'POST') {
      if (scenario !== 'playwright-managed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            method: req.method ?? 'GET',
            pathname: url.pathname,
            searchParams: Object.fromEntries(url.searchParams.entries()),
            authorization: req.headers.authorization ?? null,
            directoryHeader: req.headers['x-opencode-directory'] ?? null,
            workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
            body,
          }),
        );
        return;
      }
      const ptyId = `pty-${++ptyCounter}`;
      const bodyArgs = Array.isArray(body?.args) ? body.args.map((item) => String(item)) : [];
      const joinedArgs = bodyArgs.join(' ');
      let output = '\n__OPENCODE_PTY_EXIT_CODE__:0\n';
      if (joinedArgs.includes('git ls-files --cached --others --exclude-standard -z')) {
        output = `app/App.vue\0app/views/App.vue\0app/components/InputPanel.vue\0README.md\0\n__OPENCODE_PTY_EXIT_CODE__:0\n`;
      } else if (joinedArgs.includes('git -c color.status=false -c color.ui=false --no-pager status --porcelain=v1 -z -b')) {
        output = `## main\0\0##HEAD\0a68b6e8\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0\n__OPENCODE_PTY_EXIT_CODE__:0\n`;
      }
      ptyResponses.set(ptyId, output);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: ptyId }));
      return;
    }

    if (url.pathname === '/file') {
      const requestedPath = url.searchParams.get('path') || '.';
      const entries =
        requestedPath === '.'
          ? [
              { path: `${managedDirectory}/app`, type: 'directory' },
              { path: `${managedDirectory}/README.md`, type: 'file' },
            ]
          : requestedPath === 'app'
            ? [
                { path: `${managedDirectory}/app/App.vue`, type: 'file' },
                { path: `${managedDirectory}/app/components`, type: 'directory' },
              ]
            : requestedPath === 'app/components'
              ? [{ path: `${managedDirectory}/app/components/InputPanel.vue`, type: 'file' }]
              : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(entries));
      return;
    }

    if (url.pathname === '/global/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(
        'data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n',
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        searchParams: Object.fromEntries(url.searchParams.entries()),
        authorization: req.headers.authorization ?? null,
        directoryHeader: req.headers['x-opencode-directory'] ?? null,
        workspaceHeader: req.headers['x-opencode-workspace'] ?? null,
        body,
      }),
    );
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const upgradeInfo = {
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      headers: { ...req.headers },
      clientMessage: null,
    };
    upgrades.push(upgradeInfo);

    const match = url.pathname.match(/^\/pty\/([^/]+)\/connect$/);
    const key = req.headers['sec-websocket-key'];
    if (!match || typeof key !== 'string') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
        '',
        '',
      ].join('\r\n'),
    );
    void readWebSocketTextFrame(socket, head, { expectMasked: true })
      .then((message) => {
        upgradeInfo.clientMessage = message;
        socket.write(encodeTextFrame(ptyResponses.get(match[1]) ?? `pty:${match[1]}:${message}`));
        setTimeout(() => socket.end(), 25);
      })
      .catch(() => {
        socket.destroy();
      });
  });

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    upgrades,
    async stop() {
      await closeServer(server);
    },
  };
}

async function waitForListening(child, port) {
  const started = new Promise((resolveStarted, rejectStarted) => {
    const timeout = setTimeout(() => {
      rejectStarted(new Error(`vis server did not start on port ${port}`));
    }, 10000);

    const handleStdout = (chunk) => {
      const output = chunk.toString();
      if (!output.includes(`Listening on http://localhost:${port}`)) return;
      cleanup();
      resolveStarted();
    };

    const handleExit = (code, signal) => {
      cleanup();
      rejectStarted(new Error(`vis server exited before startup (code=${code}, signal=${signal})`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', handleStdout);
      child.off('exit', handleExit);
    };

    child.stdout.on('data', handleStdout);
    child.on('exit', handleExit);
  });

  await started;
}

export async function startVisServer(env = {}, options = {}) {
  const port = await resolvePort(options.port);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VIS_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForListening(child, port);

  return {
    origin: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const exit = once(child, 'exit');
      const timeout = delay(2000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      await Promise.race([exit, timeout]);
    },
  };
}

export async function startVisServerExpectingFailure(env = {}, options = {}) {
  const port = await resolvePort(options.port);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VIS_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exit = new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      rejectExit(new Error(`vis server did not fail on port ${port}`));
    }, 10000);

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  const startup = waitForListening(child, port).then(
    () => ({ started: true }),
    () => ({ started: false }),
  );

  const outcome = await Promise.race([
    exit.then((result) => ({ type: 'exit', result })),
    startup.then((result) => ({ type: 'startup', result })),
  ]);

  if (outcome.type === 'startup' && outcome.result.started) {
    child.kill('SIGTERM');
    await once(child, 'exit');
    throw new Error(`expected vis server startup failure on port ${port}`);
  }

  const result = outcome.type === 'exit' ? outcome.result : await exit;
  return {
    exitCode: result.code,
    signal: result.signal,
    stdout,
    stderr,
  };
}

export async function startManagedPlaywrightHarness(options = {}) {
  const visPort = options.visPort ?? managedHarnessVisPort;
  const requestLogPath = options.requestLogPath ?? managedHarnessRequestLogPath;
  const upstream = await startUpstreamStub({ requestLogPath, scenario: 'playwright-managed' });
  let vis;
  let stopped = false;

  try {
    vis = await startVisServer(
      {
        VIS_MODE: 'managed',
        VIS_UPSTREAM_URL: upstream.origin,
        VIS_EDGE_AUTH_MODE: 'edge',
      },
      { port: visPort },
    );
  } catch (error) {
    await upstream.stop();
    throw error;
  }

  return {
    origin: vis.origin,
    upstreamOrigin: upstream.origin,
    requestLogPath,
    requests: upstream.requests,
    async stop() {
      if (stopped) return;
      stopped = true;
      await writeJsonFile(requestLogPath, upstream.requests);
      await Promise.allSettled([vis.stop(), upstream.stop()]);
    },
  };
}

export async function stopManagedHarnessFromState() {
  let rawState;

  try {
    rawState = await readFile(managedHarnessStatePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let pid;
  try {
    pid = JSON.parse(rawState).pid;
  } catch {
    await rm(managedHarnessStatePath, { force: true });
    return false;
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    await rm(managedHarnessStatePath, { force: true });
    return false;
  }

  if (!signalProcessGroup(pid, 'SIGTERM')) {
    await rm(managedHarnessStatePath, { force: true });
    return false;
  }

  if (!(await waitForProcessExit(pid))) {
    signalProcessGroup(pid, 'SIGKILL');
    await waitForProcessExit(pid, 2000);
  }

  await rm(managedHarnessStatePath, { force: true });
  return true;
}

export async function readSseFrame(response) {
  assert(response.body, 'expected SSE response body');
  const reader = response.body.getReader();
  let chunk = '';
  while (!chunk.includes('\n\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    chunk += new TextDecoder().decode(value, { stream: true });
  }
  await reader.cancel();
  return chunk;
}

export async function connectWebSocketOnce(url, options = {}) {
  return new Promise((resolveMessage, rejectMessage) => {
    const target = new URL(url);
    const key = randomBytes(16).toString('base64');
    const timer = setTimeout(() => {
      rejectMessage(new Error(`websocket timed out for ${url}`));
    }, 5000);

    const finish = (callback) => {
      clearTimeout(timer);
      callback();
    };

    const req = httpRequest({
      protocol: target.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', async (_response, socket, head) => {
      try {
        if (typeof options.sendText === 'string') {
          socket.write(encodeMaskedTextFrame(options.sendText));
        }
        const message = await readWebSocketTextFrame(socket, head);
        finish(() => resolveMessage(message));
      } catch (error) {
        finish(() => rejectMessage(error));
      } finally {
        socket.end();
      }
    });

    req.on('response', (response) => {
      finish(() => {
        rejectMessage(new Error(`websocket upgrade rejected with ${response.statusCode}`));
      });
      response.resume();
    });

    req.on('error', (error) => {
      finish(() => rejectMessage(error));
    });

    req.end();
  });
}

function readWebSocketTextFrame(socket, initialData, options = {}) {
  return new Promise((resolveFrame, rejectFrame) => {
    let buffer = Buffer.from(initialData);
    const expectMasked = options.expectMasked === true;

    const tryResolve = () => {
      if (buffer.length < 2) return false;

      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return false;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        rejectFrame(new Error('websocket fixture does not support 64-bit frames'));
        return true;
      }

      if (masked && !expectMasked) {
        rejectFrame(new Error('expected unmasked server websocket frame'));
        return true;
      }
      if (!masked && expectMasked) {
        rejectFrame(new Error('expected masked client websocket frame'));
        return true;
      }

      let maskOffset = offset;
      let payloadOffset = offset;
      if (masked) {
        if (buffer.length < offset + 4) return false;
        maskOffset = offset;
        payloadOffset = offset + 4;
      }

      if (opcode !== 1) {
        rejectFrame(new Error(`expected text websocket frame, got opcode ${opcode}`));
        return true;
      }

      if (buffer.length < payloadOffset + length) return false;

      const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      resolveFrame(payload.toString('utf8'));
      return true;
    };

    const handleData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!tryResolve()) return;
      cleanup();
    };

    const handleError = (error) => {
      cleanup();
      rejectFrame(error);
    };

    const cleanup = () => {
      socket.off('data', handleData);
      socket.off('error', handleError);
    };

    socket.on('data', handleData);
    socket.on('error', handleError);

    if (tryResolve()) {
      cleanup();
    }
  });
}

async function runManagedPlaywrightHarnessProcess() {
  await mkdir(dirname(managedHarnessStatePath), { recursive: true });
  await rm(managedHarnessStatePath, { force: true });
  const harness = await startManagedPlaywrightHarness();
  let shuttingDown = false;

  const shutdown = async (exitCode, error) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (error) {
      console.error(error);
    }

    try {
      await harness.stop();
    } finally {
      await rm(managedHarnessStatePath, { force: true });
    }

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown(130);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });
  process.on('uncaughtException', (error) => {
    void shutdown(1, error);
  });
  process.on('unhandledRejection', (error) => {
    void shutdown(1, error);
  });

  await writeJsonFile(managedHarnessStatePath, {
    pid: process.pid,
    origin: harness.origin,
    upstreamOrigin: harness.upstreamOrigin,
    requestLogPath: harness.requestLogPath,
    visPort: managedHarnessVisPort,
  });
}

const isCliEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntrypoint && process.argv[2] === 'playwright-managed-harness') {
  runManagedPlaywrightHarnessProcess().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

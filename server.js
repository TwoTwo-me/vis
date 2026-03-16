#!/usr/bin/env node
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { request as requestHTTP } from 'node:http';
import { request as requestHTTPS } from 'node:https';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { getCodexUsage } from './server/codexUsage.js';

const app = new Hono();
const hopByHopHeaders = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const managedDeniedResponse = Object.freeze({
  error: 'Not found',
});
const managedRestRoutes = [
  '/path',
  '/file/content',
  '/file',
  '/project/current',
  '/project/:projectID',
  '/project',
  '/session/status',
  '/session/:sessionID/diff',
  '/session/:sessionID/children',
  '/session/:sessionID/message/:messageID/part/:partID',
  '/session/:sessionID/message/:messageID',
  '/session/:sessionID/message',
  '/session/:sessionID/todo',
  '/session/:sessionID/fork',
  '/session/:sessionID/revert',
  '/session/:sessionID/unrevert',
  '/session/:sessionID/command',
  '/session/:sessionID/prompt_async',
  '/session/:sessionID/abort',
  '/session/:sessionID',
  '/session',
  '/agent',
  '/command',
  '/permission/:permissionID/reply',
  '/permission',
  '/question/:questionID/reply',
  '/question/:questionID/reject',
  '/question',
  '/pty/:ptyID',
  '/pty',
  '/vcs',
  '/experimental/worktree',
  '/config/providers',
];
const managedBootstrap = Object.freeze({
  mode: 'managed',
  auth: 'edge',
  capabilities: {
    rest: true,
    sse: true,
    pty: true,
  },
});

const BINARY_MIME_TYPES = Object.freeze({
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.json': 'application/json',
});

function resolveMimeType(filePath) {
  const extension = extname(filePath).toLowerCase();
  return BINARY_MIME_TYPES[extension] || 'application/octet-stream';
}

function isPdfPath(pathname) {
  return pathname.toLowerCase().endsWith('.pdf');
}

function jsonErrorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function encodeContentDispositionFilename(filename) {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function createTarGzArchiveBuffer(targetPath) {
  const parentPath = dirname(targetPath);
  const entryName = basename(targetPath);
  return new Promise((resolveArchive, rejectArchive) => {
    const child = spawn('tar', ['-czf', '-', '-C', parentPath, '--', entryName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectArchive);
    child.on('close', (code) => {
      if (code === 0) {
        resolveArchive(Buffer.concat(chunks));
        return;
      }
      rejectArchive(new Error(stderr.trim() || `tar failed (${code ?? 'unknown'})`));
    });
  });
}

function toWebStream(stream) {
  return Readable.toWeb(stream);
}

function createTarGzArchiveStream(targetPath) {
  const parentPath = dirname(targetPath);
  const entryName = basename(targetPath);
  const child = spawn('tar', ['-czf', '-', '-C', parentPath, '--', entryName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', () => {
    child.stdout.destroy();
  });
  child.stderr.on('data', () => {});

  return toWebStream(child.stdout);
}

function isWithinPath(basePath, targetPath) {
  const rel = relative(basePath, targetPath);
  return rel === '' || (!rel.startsWith('..') && rel !== '' && !rel.startsWith('/'));
}

function collectProjectRoots(payload) {
  if (!Array.isArray(payload)) return [];
  const roots = new Set();
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const record = item;
    if (typeof record.worktree === 'string' && record.worktree.trim()) {
      roots.add(resolve(record.worktree.trim()));
    }
    if (Array.isArray(record.sandboxes)) {
      for (const sandbox of record.sandboxes) {
        if (typeof sandbox === 'string' && sandbox.trim()) {
          roots.add(resolve(sandbox.trim()));
        }
      }
    }
  }
  return Array.from(roots);
}

async function fetchManagedProjectRoots(c, managedConfig) {
  const upstreamURL = buildManagedUpstreamURL(managedConfig.upstreamURL, '/project', '');
  const response = await fetch(upstreamURL, {
    method: 'GET',
    headers: createManagedUpstreamRequestHeaders(c.req.raw.headers, managedConfig),
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error('Project root lookup failed');
  }
  const data = await response.json();
  return collectProjectRoots(data);
}

async function resolveManagedPdfTarget(c, managedConfig) {
  const directory = c.req.query('directory') ?? '';
  const path = c.req.query('path') ?? '';
  if (!isPdfPath(path)) {
    return { error: new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) };
  }

  const normalizedDirectory = directory.trim() ? resolve(directory.trim()) : '';
  const normalizedTarget = path.trim() ? path.trim() : '';
  if (!normalizedDirectory || !normalizedTarget) {
    return { error: new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
  }

  const allowedRoots = await fetchManagedProjectRoots(c, managedConfig);
  if (allowedRoots.length === 0) {
    return { error: new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
  }

  const resolvedDirectory = await realpath(normalizedDirectory).catch(() => null);
  if (!resolvedDirectory) {
    return { error: new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
  }

  const matchedRoot = allowedRoots.find((root) => isWithinPath(root, resolvedDirectory));
  if (!matchedRoot) {
    return { error: new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
  }

  const absoluteTarget = normalizedTarget.startsWith('/')
    ? resolve(normalizedTarget)
    : resolve(resolvedDirectory, normalizedTarget);
  const resolvedTarget = await realpath(absoluteTarget).catch(() => null);
  if (!resolvedTarget) {
    return { error: new Response(JSON.stringify({ error: 'File read failed' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) };
  }
  if (!isWithinPath(resolvedDirectory, resolvedTarget) || !isWithinPath(matchedRoot, resolvedTarget)) {
    return { error: new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
  }

  return { target: resolvedTarget };
}

async function resolveManagedDownloadTarget(c, managedConfig) {
  const directory = c.req.query('directory') ?? '';
  const path = c.req.query('path') ?? '';
  const normalizedDirectory = directory.trim() ? resolve(directory.trim()) : '';
  const normalizedTarget = path.trim() ? path.trim() : '';
  if (!normalizedDirectory || !normalizedTarget) {
    return { error: jsonErrorResponse(400, 'Invalid path') };
  }

  const allowedRoots = await fetchManagedProjectRoots(c, managedConfig);
  if (allowedRoots.length === 0) {
    return { error: jsonErrorResponse(400, 'Invalid path') };
  }

  const resolvedDirectory = await realpath(normalizedDirectory).catch(() => null);
  if (!resolvedDirectory) {
    return { error: jsonErrorResponse(400, 'Invalid path') };
  }

  const matchedRoot = allowedRoots.find((root) => isWithinPath(root, resolvedDirectory));
  if (!matchedRoot) {
    return { error: jsonErrorResponse(400, 'Invalid path') };
  }

  const absoluteTarget = normalizedTarget.startsWith('/')
    ? resolve(normalizedTarget)
    : resolve(resolvedDirectory, normalizedTarget);
  const resolvedTarget = await realpath(absoluteTarget).catch(() => null);
  if (!resolvedTarget) {
    return { error: jsonErrorResponse(404, 'File read failed') };
  }
  if (!isWithinPath(resolvedDirectory, resolvedTarget) || !isWithinPath(matchedRoot, resolvedTarget)) {
    return { error: jsonErrorResponse(400, 'Invalid path') };
  }

  return { target: resolvedTarget };
}

async function serveLocalPdfFile(c, managedConfig) {
  const resolved = await resolveManagedPdfTarget(c, managedConfig);
  if (resolved.error) return resolved.error;

  try {
    const file = await readFile(resolved.target);
    return new Response(file, {
      status: 200,
      headers: {
        'Content-Type': resolveMimeType(resolved.target),
        'Content-Length': String(file.byteLength),
      },
    });
  } catch {
    return c.json({ error: 'File read failed' }, 404);
  }
}

async function serveManagedDownload(c, managedConfig) {
  const resolved = await resolveManagedDownloadTarget(c, managedConfig);
  if (resolved.error) return resolved.error;

  try {
    const targetStat = await stat(resolved.target);
    if (targetStat.isDirectory()) {
      const filename = `${basename(resolved.target)}.tar.gz`;
      return new Response(createTarGzArchiveStream(resolved.target), {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': encodeContentDispositionFilename(filename),
        },
      });
    }

    return new Response(toWebStream(createReadStream(resolved.target)), {
      status: 200,
      headers: {
        'Content-Type': resolveMimeType(resolved.target),
        'Content-Disposition': encodeContentDispositionFilename(basename(resolved.target)),
      },
    });
  } catch {
    return c.json({ error: 'File read failed' }, 404);
  }
}

function readManagedConfig(env) {
  if (env.VIS_MODE !== 'managed') return null;

  const upstreamURLValue = env.VIS_UPSTREAM_URL?.trim();
  if (!upstreamURLValue) {
    throw new Error('VIS_UPSTREAM_URL is required when VIS_MODE=managed');
  }

  let upstreamURL;
  try {
    upstreamURL = new URL(upstreamURLValue);
  } catch {
    throw new Error('VIS_UPSTREAM_URL must be a valid URL when VIS_MODE=managed');
  }

  const edgeAuthMode = env.VIS_EDGE_AUTH_MODE?.trim();
  if (!edgeAuthMode) {
    throw new Error('VIS_EDGE_AUTH_MODE is required when VIS_MODE=managed');
  }
  if (edgeAuthMode !== 'edge') {
    throw new Error('VIS_EDGE_AUTH_MODE must be edge when VIS_MODE=managed');
  }

  return Object.freeze({
    mode: 'managed',
    upstreamURL: upstreamURL.toString(),
    upstreamAuthHeader: env.VIS_UPSTREAM_AUTH_HEADER?.trim() || null,
    edgeAuthMode,
  });
}

function buildManagedUpstreamURL(baseURL, pathname, search) {
  const upstreamURL = new URL(baseURL);
  upstreamURL.pathname = `${upstreamURL.pathname.replace(/\/$/, '')}${pathname}`;
  upstreamURL.search = search;
  return upstreamURL;
}

function createManagedUpstreamRequestHeaders(headers, managedConfig) {
  const upstreamHeaders = new Headers(headers);

  for (const header of hopByHopHeaders) {
    upstreamHeaders.delete(header);
  }

  upstreamHeaders.delete('authorization');
  upstreamHeaders.delete('cookie');

  if (managedConfig.upstreamAuthHeader) {
    upstreamHeaders.set('authorization', managedConfig.upstreamAuthHeader);
  }

  return upstreamHeaders;
}

function createManagedUpstreamWebSocketHeaders(headers, managedConfig) {
  const upstreamHeaders = new Headers(headers);

  upstreamHeaders.delete('connection');
  upstreamHeaders.delete('host');
  upstreamHeaders.delete('origin');
  upstreamHeaders.delete('cookie');
  upstreamHeaders.delete('authorization');
  upstreamHeaders.delete('x-forwarded-for');
  upstreamHeaders.delete('x-forwarded-host');
  upstreamHeaders.delete('x-forwarded-proto');
  upstreamHeaders.delete('x-real-ip');

  upstreamHeaders.set('connection', 'Upgrade');
  upstreamHeaders.set('upgrade', 'websocket');

  if (managedConfig.upstreamAuthHeader) {
    upstreamHeaders.set('authorization', managedConfig.upstreamAuthHeader);
  }

  return upstreamHeaders;
}

function createRelayResponseHeaders(headers) {
  const responseHeaders = new Headers(headers);

  for (const header of hopByHopHeaders) {
    responseHeaders.delete(header);
  }

  return responseHeaders;
}

async function relayManagedRestRequest(c, managedConfig) {
  const requestURL = new URL(c.req.url);
  const managedPath = c.req.path.slice('/api'.length);
  const upstreamURL = buildManagedUpstreamURL(
    managedConfig.upstreamURL,
    managedPath,
    requestURL.search,
  );
  const init = {
    method: c.req.method,
    headers: createManagedUpstreamRequestHeaders(c.req.raw.headers, managedConfig),
    redirect: 'manual',
  };

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const body = await c.req.raw.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  try {
    const response = await fetch(upstreamURL, init);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: createRelayResponseHeaders(response.headers),
    });
  } catch {
    return c.json({ error: 'Upstream request failed' }, 502);
  }
}

async function relayManagedSseRequest(c, managedConfig) {
  const requestURL = new URL(c.req.url);
  const upstreamURL = buildManagedUpstreamURL(
    managedConfig.upstreamURL,
    '/global/event',
    requestURL.search,
  );

  try {
    const response = await fetch(upstreamURL, {
      method: 'GET',
      headers: createManagedUpstreamRequestHeaders(c.req.raw.headers, managedConfig),
      redirect: 'manual',
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: createRelayResponseHeaders(response.headers),
    });
  } catch {
    return c.json({ error: 'Upstream request failed' }, 502);
  }
}

function toNodeRequestHeaders(headers) {
  const requestHeaders = {};

  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  return requestHeaders;
}

function isManagedPtyUpgradeRequest(req) {
  if (!req.url) return false;
  const pathname = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
  return /^\/api\/pty\/[^/]+\/connect$/.test(pathname);
}

function writeRawSocketResponse(socket, statusCode, statusMessage, rawHeaders, body) {
  const headerLines = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1] ?? '';
    if (!name) continue;
    if (hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'upgrade') {
      continue;
    }
    headerLines.push(`${name}: ${value}`);
  }

  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusMessage}`,
      ...headerLines,
      body ? `Content-Length: ${body.length}` : 'Content-Length: 0',
      '',
      '',
    ].join('\r\n'),
  );

  if (body && body.length > 0) {
    socket.write(body);
  }

  socket.end();
}

function writeSocketJsonError(socket, statusCode, statusMessage, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusMessage}`,
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.write(body);
  socket.end();
}

function writeWebSocketUpgradeResponse(socket, statusCode, statusMessage, rawHeaders) {
  const headerLines = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1] ?? '';
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (hopByHopHeaders.has(normalized) && normalized !== 'connection' && normalized !== 'upgrade') {
      continue;
    }
    headerLines.push(`${name}: ${value}`);
  }

  socket.write([`HTTP/1.1 ${statusCode} ${statusMessage}`, ...headerLines, '', ''].join('\r\n'));
}

function pipeWebSocketSockets(clientSocket, upstreamSocket, clientHead, upstreamHead) {
  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
  upstreamSocket.on('error', () => {
    clientSocket.destroy();
  });

  clientSocket.on('end', () => {
    upstreamSocket.end();
  });
  upstreamSocket.on('end', () => {
    clientSocket.end();
  });

  clientSocket.on('close', () => {
    upstreamSocket.destroy();
  });
  upstreamSocket.on('close', () => {
    clientSocket.destroy();
  });

  if (upstreamHead.length > 0) {
    clientSocket.write(upstreamHead);
  }
  if (clientHead.length > 0) {
    upstreamSocket.write(clientHead);
  }

  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
  clientSocket.resume();
  upstreamSocket.resume();
}

function relayManagedPtyWebSocket(req, socket, head, managedConfig) {
  const requestURL = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const upstreamURL = buildManagedUpstreamURL(
    managedConfig.upstreamURL,
    requestURL.pathname.slice('/api'.length),
    requestURL.search,
  );
  const upstreamRequest = (upstreamURL.protocol === 'https:' ? requestHTTPS : requestHTTP)(upstreamURL, {
    method: 'GET',
    headers: toNodeRequestHeaders(createManagedUpstreamWebSocketHeaders(req.headers, managedConfig)),
  });

  let finished = false;

  const fail = (statusCode, statusMessage, payload) => {
    if (finished) return;
    finished = true;
    upstreamRequest.destroy();
    writeSocketJsonError(socket, statusCode, statusMessage, payload);
  };

  socket.pause();
  socket.on('error', () => {
    upstreamRequest.destroy();
  });
  socket.on('close', () => {
    upstreamRequest.destroy();
  });

  upstreamRequest.on('response', (response) => {
    const chunks = [];

    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => {
      if (finished) return;
      finished = true;
      writeRawSocketResponse(
        socket,
        response.statusCode ?? 502,
        response.statusMessage ?? 'Bad Gateway',
        response.rawHeaders,
        chunks.length > 0 ? Buffer.concat(chunks) : null,
      );
    });
  });

  upstreamRequest.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    if (finished) {
      upstreamSocket.destroy();
      return;
    }

    finished = true;
    clientSocketCleanup();
    upstreamSocket.pause();
    writeWebSocketUpgradeResponse(
      socket,
      response.statusCode ?? 101,
      response.statusMessage ?? 'Switching Protocols',
      response.rawHeaders,
    );
    pipeWebSocketSockets(socket, upstreamSocket, head, upstreamHead);
  });

  upstreamRequest.on('error', () => {
    fail(502, 'Bad Gateway', { error: 'Upstream request failed' });
  });

  upstreamRequest.end();

  function clientSocketCleanup() {
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
  }
}

const managedConfig = readManagedConfig(process.env);

if (managedConfig) {
  app.get('/api/bootstrap', (c) => c.json(managedBootstrap));
  app.get('/api/codex/usage', async (c) => {
    const payload = await getCodexUsage(process.env);
    c.header('Cache-Control', 'no-store');
    return c.json(payload, 200);
  });
  app.get('/api/global/event', (c) => relayManagedSseRequest(c, managedConfig));
  app.get('/api/file/content/pdf', (c) => serveLocalPdfFile(c, managedConfig));
  app.get('/api/file/download', (c) => serveManagedDownload(c, managedConfig));
  for (const route of managedRestRoutes) {
    app.all(`/api${route}`, (c) => relayManagedRestRequest(c, managedConfig));
  }
  app.all('/api/*', (c) => c.json(managedDeniedResponse, 404));
  app.use('*', serveStatic({ root: join(import.meta.dirname, 'dist/') }));
} else {
  app.use('*', serveStatic({ root: join(import.meta.dirname, 'dist/') }));
}

const port = process.env.VIS_PORT || 3000;
const server = createAdaptorServer({
  fetch: app.fetch,
});

if (managedConfig) {
  server.on('upgrade', (req, socket, head) => {
    if (!isManagedPtyUpgradeRequest(req)) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    relayManagedPtyWebSocket(req, socket, head, managedConfig);
  });
}

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});

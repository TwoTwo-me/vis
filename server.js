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
import {
  loadTokenProviders,
  refreshTokenProviders,
  saveTokenProviders,
  testTokenProvider,
  TOKEN_PROVIDER_STATUSES,
} from './server/visTokenProviders.js';

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

const tokenProviderConfigInvalidMessage = 'Token provider config is invalid';
const tokenProviderConfigSaveFailedMessage = 'Token provider config save failed';
const tokenProviderPanelEmptyMessage = 'No token providers configured';
const tokenProviderPanelReadyMessage = 'Token providers refreshed';

function parseJsonBody(c) {
  return c.req.json().catch(() => null);
}

function parseTokenProviderTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      const isoValue = new Date(value).toISOString();
      return Number.isNaN(Date.parse(isoValue)) ? null : isoValue;
    } catch {
      return null;
    }
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      try {
        return new Date(parsed).toISOString();
      } catch {
        return null;
      }
    }
  }

  return null;
}

function toTokenProviderConfigDefinition(definition) {
  const updatedAt = Date.parse(definition.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  return {
    id: definition.id,
    name: definition.name,
    command: definition.command,
    updatedAt,
  };
}

function toTokenProviderConfigResponse(definitions) {
  const mappedDefinitions = [];
  for (const definition of definitions) {
    const mappedDefinition = toTokenProviderConfigDefinition(definition);
    if (!mappedDefinition) return null;
    mappedDefinitions.push(mappedDefinition);
  }
  return { definitions: mappedDefinitions };
}

function toTokenProviderResultBlock(result) {
  return {
    id: result.id,
    name: result.name,
    status: result.status,
    message: result.message,
    rows: result.rows,
  };
}

function toTokenProviderSavePayload(body, existingDefinitions = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).length !== 1 || !('definitions' in body) || !Array.isArray(body.definitions)) {
    return null;
  }

  const existingDefinitionById = new Map(existingDefinitions.map((definition) => [definition.id, definition]));
  const fallbackUpdatedAt = new Date().toISOString();
  const definitions = [];
  for (const entry of body.definitions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entryKeys = Object.keys(entry);
    const hasUpdatedAt = entryKeys.includes('updatedAt');
    const expectedKeys = hasUpdatedAt
      ? ['id', 'name', 'command', 'updatedAt']
      : ['id', 'name', 'command'];
    if (entryKeys.length !== expectedKeys.length || expectedKeys.some((key) => !(key in entry))) {
      return null;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!id || !name || !command) return null;

    let updatedAt = hasUpdatedAt ? parseTokenProviderTimestamp(entry.updatedAt) : null;
    if (hasUpdatedAt && !updatedAt) return null;
    if (!updatedAt) {
      const existingDefinition = existingDefinitionById.get(id);
      if (
        existingDefinition &&
        existingDefinition.name === name &&
        existingDefinition.command === command
      ) {
        updatedAt = parseTokenProviderTimestamp(existingDefinition.updatedAt);
      }
    }

    definitions.push({
      id,
      name,
      command,
      updatedAt: updatedAt || fallbackUpdatedAt,
    });
  }

  return definitions;
}

async function getManagedTokenProviderConfig(c) {
  const loaded = await loadTokenProviders(process.env);
  if (loaded.status === TOKEN_PROVIDER_STATUSES.CONFIG_ERROR) {
    return jsonErrorResponse(500, tokenProviderConfigInvalidMessage);
  }

  const payload = toTokenProviderConfigResponse(loaded.providers);
  if (!payload) {
    return jsonErrorResponse(500, tokenProviderConfigInvalidMessage);
  }

  return c.json(payload, 200);
}

async function putManagedTokenProviderConfig(c) {
  const body = await parseJsonBody(c);
  const loaded = await loadTokenProviders(process.env);
  const definitions = toTokenProviderSavePayload(
    body,
    loaded.status === TOKEN_PROVIDER_STATUSES.OK ? loaded.providers : [],
  );
  if (!definitions) {
    return jsonErrorResponse(400, tokenProviderConfigInvalidMessage);
  }

  const saved = await saveTokenProviders(definitions, process.env);
  if (saved.status === TOKEN_PROVIDER_STATUSES.CONFIG_ERROR) {
    return jsonErrorResponse(400, tokenProviderConfigInvalidMessage);
  }
  if (saved.status !== TOKEN_PROVIDER_STATUSES.OK) {
    return jsonErrorResponse(500, tokenProviderConfigSaveFailedMessage);
  }

  const payload = toTokenProviderConfigResponse(saved.providers);
  if (!payload) {
    return jsonErrorResponse(500, tokenProviderConfigInvalidMessage);
  }

  return c.json(payload, 200);
}

async function postManagedTokenProviderTest(c) {
  const body = await parseJsonBody(c);
  const result = await testTokenProvider(body, { env: process.env });
  return c.json({ result: toTokenProviderResultBlock(result) }, 200);
}

function createTokenProviderPanelResponse(refreshed) {
  if (refreshed.status === TOKEN_PROVIDER_STATUSES.CONFIG_ERROR) {
    return {
      state: 'config_error',
      message: tokenProviderConfigInvalidMessage,
      providers: [],
    };
  }

  if (refreshed.status === TOKEN_PROVIDER_STATUSES.EMPTY) {
    return {
      state: 'empty',
      message: tokenProviderPanelEmptyMessage,
      providers: [],
    };
  }

  return {
    state: 'ready',
    message: tokenProviderPanelReadyMessage,
    providers: refreshed.providers.map((provider) => toTokenProviderResultBlock(provider)),
  };
}

async function postManagedTokenProviderRefresh(c) {
  const refreshed = await refreshTokenProviders({ env: process.env });
  return c.json(createTokenProviderPanelResponse(refreshed), 200);
}

function encodeContentDispositionFilename(filename) {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
  app.get('/api/vis/token-providers/config', (c) => getManagedTokenProviderConfig(c));
  app.put('/api/vis/token-providers/config', (c) => putManagedTokenProviderConfig(c));
  app.post('/api/vis/token-providers/test', (c) => postManagedTokenProviderTest(c));
  app.post('/api/vis/token-providers/refresh', (c) => postManagedTokenProviderRefresh(c));
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

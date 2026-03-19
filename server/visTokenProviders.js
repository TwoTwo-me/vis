import { spawn as spawnProcess } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MAX_TOKEN_PROVIDERS = 20;
export const MAX_TOKEN_PROVIDER_ROWS = 12;
export const TOKEN_PROVIDER_TIMEOUT_MS = 10_000;
export const TOKEN_PROVIDER_STDOUT_LIMIT_BYTES = 32 * 1024;
export const TOKEN_PROVIDER_STATUSES = Object.freeze({
  EMPTY: 'empty',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
  TIMED_OUT: 'timed_out',
  INVALID_OUTPUT: 'invalid_output',
  CONFIG_ERROR: 'config_error',
});

const STATUS_MESSAGES = Object.freeze({
  [TOKEN_PROVIDER_STATUSES.EMPTY]: 'Provider returned no rows',
  [TOKEN_PROVIDER_STATUSES.RUNNING]: 'Provider is running',
  [TOKEN_PROVIDER_STATUSES.OK]: 'Provider ready',
  [TOKEN_PROVIDER_STATUSES.ERROR]: 'Provider command failed',
  [TOKEN_PROVIDER_STATUSES.TIMED_OUT]: 'Provider command timed out',
  [TOKEN_PROVIDER_STATUSES.INVALID_OUTPUT]: 'Provider output is invalid',
  [TOKEN_PROVIDER_STATUSES.CONFIG_ERROR]: 'Provider config is invalid',
});

function resolveHomeDirectory(env = process.env) {
  return env.HOME?.trim() || homedir();
}

function hasExactShape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recordKeys = Object.keys(value);
  return recordKeys.length === keys.length && keys.every((key) => recordKeys.includes(key));
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProviderIdentity(value) {
  return {
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    name: typeof value?.name === 'string' ? value.name.trim() : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt.trim() : '',
  };
}

export function getTokenProvidersFile(env = process.env) {
  const homeDir = resolveHomeDirectory(env);
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config');
  return join(configHome, 'vis', 'token', 'providers.json');
}

function getTokenProvidersLegacyFile(env = process.env) {
  const homeDir = resolveHomeDirectory(env);
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share');
  return join(dataHome, 'vis', 'token-providers.json');
}

function parseTokenProvidersFromRaw(raw, filePath) {
  try {
    const parsed = JSON.parse(raw);
    const validated = validateTokenProviders(parsed);
    if (!validated.ok) {
      return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
    }
    return { status: TOKEN_PROVIDER_STATUSES.OK, providers: validated.providers, filePath };
  } catch {
    return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
  }
}

export function createTokenProviderResult(provider, status, rows = []) {
  const identity = normalizeProviderIdentity(provider);
  return {
    id: identity.id,
    name: identity.name,
    updatedAt: identity.updatedAt,
    status,
    message: STATUS_MESSAGES[status] || STATUS_MESSAGES[TOKEN_PROVIDER_STATUSES.ERROR],
    rows,
  };
}

export function validateTokenProviderDefinition(value) {
  if (!hasExactShape(value, ['id', 'name', 'command', 'updatedAt'])) {
    return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
  }
  const id = normalizeNonEmptyString(value.id);
  const name = normalizeNonEmptyString(value.name);
  const command = normalizeNonEmptyString(value.command);
  const updatedAt = normalizeNonEmptyString(value.updatedAt);
  if (!id || !name || !command || !updatedAt) {
    return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
  }
  return {
    ok: true,
    value: { id, name, command, updatedAt },
  };
}

export function validateTokenProviderDraft(value) {
  if (!hasExactShape(value, ['name', 'command'])) {
    return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
  }
  const name = normalizeNonEmptyString(value.name);
  const command = normalizeNonEmptyString(value.command);
  if (!name || !command) {
    return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
  }
  return {
    ok: true,
    value: { name, command },
  };
}

export function validateTokenProviders(value) {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_PROVIDERS) {
    return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
  }

  const providers = [];
  const seenIds = new Set();
  for (const entry of value) {
    const validated = validateTokenProviderDefinition(entry);
    if (!validated.ok) {
      return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
    }
    if (seenIds.has(validated.value.id)) {
      return { ok: false, error: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR };
    }
    seenIds.add(validated.value.id);
    providers.push(validated.value);
  }

  return { ok: true, providers };
}

export async function loadTokenProviders(env = process.env) {
  const filePath = getTokenProvidersFile(env);
  const legacyFilePath = getTokenProvidersLegacyFile(env);

  try {
    const raw = await readFile(filePath, 'utf8');
    return parseTokenProvidersFromRaw(raw, filePath);
  } catch (error) {
    const missingPrimary = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (!missingPrimary) {
      return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
    }
  }

  try {
    const legacyRaw = await readFile(legacyFilePath, 'utf8');
    const parsedLegacy = parseTokenProvidersFromRaw(legacyRaw, filePath);
    if (parsedLegacy.status !== TOKEN_PROVIDER_STATUSES.OK) {
      return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
    }
    return parsedLegacy;
  } catch (error) {
    const missingLegacy = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    if (missingLegacy) {
      return { status: TOKEN_PROVIDER_STATUSES.OK, providers: [], filePath };
    }
    return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
  }
}

export async function saveTokenProviders(value, env = process.env) {
  const filePath = getTokenProvidersFile(env);
  const validated = validateTokenProviders(value);
  if (!validated.ok) {
    return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath };
  }

  const tempFilePath = `${filePath}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempFilePath, `${JSON.stringify(validated.providers, null, 2)}\n`, { mode: 0o600 });
    await rename(tempFilePath, filePath);
    return { status: TOKEN_PROVIDER_STATUSES.OK, providers: validated.providers, filePath };
  } catch {
    await rm(tempFilePath, { force: true }).catch(() => {});
    return { status: TOKEN_PROVIDER_STATUSES.ERROR, providers: [], filePath };
  }
}

export function parseTokenProviderOutput(output) {
  const rows = [];
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if ((rawLine.match(/ \| /g) || []).length !== 1) {
      return { status: TOKEN_PROVIDER_STATUSES.INVALID_OUTPUT, rows: [] };
    }
    const parts = rawLine.split(' | ');
    if (parts.length !== 2) {
      return { status: TOKEN_PROVIDER_STATUSES.INVALID_OUTPUT, rows: [] };
    }
    if (rows.length >= MAX_TOKEN_PROVIDER_ROWS) {
      return { status: TOKEN_PROVIDER_STATUSES.INVALID_OUTPUT, rows: [] };
    }
    const leftText = parts[0].trim();
    const rightText = parts[1].trim();
    if (!leftText || !rightText) {
      return { status: TOKEN_PROVIDER_STATUSES.INVALID_OUTPUT, rows: [] };
    }
    rows.push({ leftText, rightText });
  }

  return rows.length === 0
    ? { status: TOKEN_PROVIDER_STATUSES.EMPTY, rows: [] }
    : { status: TOKEN_PROVIDER_STATUSES.OK, rows };
}

async function runProviderCommand(definition, options = {}) {
  const env = options.env || process.env;
  const cwd = resolveHomeDirectory(env);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TOKEN_PROVIDER_TIMEOUT_MS;
  const stdoutLimitBytes = Number.isFinite(options.stdoutLimitBytes)
    ? options.stdoutLimitBytes
    : TOKEN_PROVIDER_STDOUT_LIMIT_BYTES;
  const spawnImpl = options.spawn || spawnProcess;

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let stdoutBytes = 0;
    const stdoutChunks = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawnImpl(definition.command, {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(createTokenProviderResult(definition, TOKEN_PROVIDER_STATUSES.ERROR));
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        child.kill('SIGKILL');
      }, 250);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.on('error', () => {
      clearTimeout(timeout);
      finish(createTokenProviderResult(definition, TOKEN_PROVIDER_STATUSES.ERROR));
    });

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > stdoutLimitBytes) {
        outputTooLarge = true;
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(buffer);
    });

    child.stderr.on('data', () => {});

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        finish(createTokenProviderResult(definition, TOKEN_PROVIDER_STATUSES.TIMED_OUT));
        return;
      }
      if (outputTooLarge) {
        finish(createTokenProviderResult(definition, TOKEN_PROVIDER_STATUSES.ERROR));
        return;
      }
      if (code !== 0 || signal) {
        finish(createTokenProviderResult(definition, TOKEN_PROVIDER_STATUSES.ERROR));
        return;
      }

      const parsed = parseTokenProviderOutput(Buffer.concat(stdoutChunks).toString('utf8'));
      finish(createTokenProviderResult(definition, parsed.status, parsed.rows));
    });
  });
}

export async function testTokenProvider(value, options = {}) {
  const validated = validateTokenProviderDraft(value);
  if (!validated.ok) {
    return createTokenProviderResult({ id: 'draft', name: '', updatedAt: '' }, TOKEN_PROVIDER_STATUSES.CONFIG_ERROR);
  }

  return runProviderCommand(
    {
      id: 'draft',
      name: validated.value.name,
      command: validated.value.command,
      updatedAt: '',
    },
    options,
  );
}

export async function refreshTokenProviders(options = {}) {
  const env = options.env || process.env;
  const loaded = await loadTokenProviders(env);
  if (loaded.status === TOKEN_PROVIDER_STATUSES.CONFIG_ERROR) {
    return { status: TOKEN_PROVIDER_STATUSES.CONFIG_ERROR, providers: [], filePath: loaded.filePath };
  }
  if (loaded.providers.length === 0) {
    return { status: TOKEN_PROVIDER_STATUSES.EMPTY, providers: [], filePath: loaded.filePath };
  }

  const providers = [];
  for (const definition of loaded.providers) {
    providers.push(await runProviderCommand(definition, options));
  }

  return { status: TOKEN_PROVIDER_STATUSES.OK, providers, filePath: loaded.filePath };
}

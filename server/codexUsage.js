import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_CACHE_TTL_SEC = 60;
const DEFAULT_STALE_AFTER_SEC = 1800;
const DEFAULT_TIMEOUT_MS = 8000;
const SECONDARY_WINDOW_SECONDS = 7 * 24 * 3600;
const TOOLS_WINDOW_SECONDS = 30 * 24 * 3600;

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveHomeDirectory() {
  return process.env.HOME?.trim() || homedir();
}

function selectAuthFile(env = process.env) {
  if (env.CODEX_AUTH_FILE?.trim()) return env.CODEX_AUTH_FILE.trim();
  const homeDir = resolveHomeDirectory();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share');
  return [join(dataHome, 'opencode', 'auth.json'), join(homeDir, '.codex', 'auth.json')][0];
}

function authCandidates(env = process.env) {
  const homeDir = resolveHomeDirectory();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share');
  const explicit = env.CODEX_AUTH_FILE?.trim();
  return explicit
    ? [explicit]
    : [join(dataHome, 'opencode', 'auth.json'), join(homeDir, '.codex', 'auth.json')];
}

async function readFirstExisting(paths) {
  for (const filePath of paths) {
    try {
      const raw = await readFile(filePath, 'utf8');
      return { filePath, raw };
    } catch {}
  }
  return { filePath: paths[0] ?? '', raw: '' };
}

function readNested(record, path) {
  return path.reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return current[key];
  }, record);
}

function readAuthCredentials(parsed) {
  const accessToken =
    readNested(parsed, ['openai', 'access']) ??
    readNested(parsed, ['codex', 'access']) ??
    readNested(parsed, ['chatgpt', 'access']) ??
    readNested(parsed, ['tokens', 'access_token']) ??
    '';
  const accountId =
    readNested(parsed, ['openai', 'accountId']) ??
    readNested(parsed, ['codex', 'accountId']) ??
    readNested(parsed, ['chatgpt', 'accountId']) ??
    readNested(parsed, ['tokens', 'account_id']) ??
    readNested(parsed, ['tokens', 'accountId']) ??
    '';
  return {
    accessToken: typeof accessToken === 'string' ? accessToken.trim() : '',
    accountId: typeof accountId === 'string' ? accountId.trim() : '',
  };
}

async function loadCredentials(env = process.env) {
  const explicitToken = env.CODEX_ACCESS_TOKEN?.trim() || '';
  const explicitAccountId = env.CODEX_ACCOUNT_ID?.trim() || '';
  const { filePath, raw } = await readFirstExisting(authCandidates(env));
  if (explicitToken) {
    if (!raw.trim()) {
      return { accessToken: explicitToken, accountId: explicitAccountId, authFile: filePath };
    }
    try {
      const parsed = JSON.parse(raw);
      const credentials = readAuthCredentials(parsed);
      return {
        accessToken: explicitToken,
        accountId: explicitAccountId || credentials.accountId,
        authFile: filePath,
      };
    } catch {
      return { accessToken: explicitToken, accountId: explicitAccountId, authFile: filePath };
    }
  }
  if (!raw.trim()) {
    return { accessToken: '', accountId: explicitAccountId, authFile: filePath };
  }
  try {
    const parsed = JSON.parse(raw);
    const credentials = readAuthCredentials(parsed);
    return {
      accessToken: credentials.accessToken,
      accountId: explicitAccountId || credentials.accountId,
      authFile: filePath,
    };
  } catch {
    return { accessToken: '', accountId: explicitAccountId, authFile: filePath };
  }
}

function getCacheFile(env = process.env) {
  if (env.CODEX_QUOTA_CACHE_FILE?.trim()) return env.CODEX_QUOTA_CACHE_FILE.trim();
  return join(resolveHomeDirectory(), '.cache', 'tmux-codex-usage.json');
}

async function readCachePayload(cacheFile) {
  try {
    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
  } catch {
    return null;
  }
}

async function readCacheAgeSec(cacheFile) {
  try {
    const cacheStat = await stat(cacheFile);
    const ageMs = Date.now() - cacheStat.mtimeMs;
    return ageMs > 0 ? Math.floor(ageMs / 1000) : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

async function writeCachePayload(cacheFile, payload) {
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, `${JSON.stringify({ payload })}\n`, { mode: 0o600 });
  } catch {}
}

async function fetchUsagePayload({ accessToken, accountId, env = process.env }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    normalizePositiveInteger(env.CODEX_QUOTA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  );
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    const response = await fetch(env.CODEX_USAGE_API_URL?.trim() || DEFAULT_USAGE_API_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function toTimestampSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1e12) return Math.floor(numeric / 1000);
  if (numeric > 1e9) return Math.floor(numeric);
  return null;
}

function formatLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const rounded = Math.floor(seconds);
  if (rounded < 3600) return `${Math.max(1, Math.floor(rounded / 60))}m`;
  if (rounded < 24 * 3600) return `${Math.floor(rounded / 3600)}h`;
  return `${Math.floor(rounded / (24 * 3600))}d`;
}

function calcRemainingText(resetAt) {
  const ts = toTimestampSeconds(resetAt);
  if (!ts) return '?';
  return formatLeft(ts - Math.floor(Date.now() / 1000));
}

function buildUnknownWindow(label) {
  return { label, remainingPercent: null, remainingText: '?', alert: false };
}

function extractNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function buildWindow(label, usedPercent, resetAt, limitWindowSeconds, compareProgress = false) {
  const used = extractNumber(usedPercent);
  if (used === null) return buildUnknownWindow(label);
  const remainingPercent = Math.max(0, 100 - used);
  const remainingText = calcRemainingText(resetAt);
  let alert = remainingPercent < 20;
  if (compareProgress) {
    const resetSeconds = toTimestampSeconds(resetAt);
    const remainingSeconds = resetSeconds ? Math.max(0, resetSeconds - Math.floor(Date.now() / 1000)) : null;
    const windowSeconds =
      extractNumber(limitWindowSeconds) ?? (label === '7d' ? SECONDARY_WINDOW_SECONDS : TOOLS_WINDOW_SECONDS);
    if (remainingSeconds !== null && windowSeconds > 0) {
      const elapsedPercent = Math.max(
        0,
        Math.min(100, Math.floor(((windowSeconds - remainingSeconds) * 100) / windowSeconds)),
      );
      alert = used > elapsedPercent;
    }
  }
  return { label, remainingPercent, remainingText, alert };
}

function buildWindows(payload) {
  const additionalLimits = Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : [];
  const reviewLimit =
    payload?.code_review_rate_limit?.primary_window ??
    additionalLimits.find((entry) => /code|review|tool/i.test(String(entry?.metered_feature ?? '')))?.rate_limit?.primary_window ??
    {};
  return {
    fiveHour: buildWindow(
      '5h',
      payload?.rate_limit?.primary_window?.used_percent,
      payload?.rate_limit?.primary_window?.reset_at,
      payload?.rate_limit?.primary_window?.limit_window_seconds,
      false,
    ),
    sevenDay: buildWindow(
      '7d',
      payload?.rate_limit?.secondary_window?.used_percent,
      payload?.rate_limit?.secondary_window?.reset_at,
      payload?.rate_limit?.secondary_window?.limit_window_seconds,
      true,
    ),
    tools30Day: buildWindow(
      '30d',
      reviewLimit?.used_percent,
      reviewLimit?.reset_at,
      reviewLimit?.limit_window_seconds,
      true,
    ),
  };
}

function createBaseResponse(state, stale, staleMinutes, message) {
  return {
    state,
    stale,
    staleMinutes,
    message,
    windows: {
      fiveHour: buildUnknownWindow('5h'),
      sevenDay: buildUnknownWindow('7d'),
      tools30Day: buildUnknownWindow('30d'),
    },
  };
}

export async function getCodexUsage(env = process.env) {
  const cacheFile = getCacheFile(env);
  const cacheTtl = normalizePositiveInteger(env.CODEX_QUOTA_CACHE_TTL_SEC, DEFAULT_CACHE_TTL_SEC);
  const staleAfter = Math.max(
    cacheTtl,
    normalizePositiveInteger(env.CODEX_QUOTA_STALE_SEC, DEFAULT_STALE_AFTER_SEC),
  );
  const cacheAgeSec = await readCacheAgeSec(cacheFile);
  const credentials = await loadCredentials(env);

  if (!credentials.accessToken) {
    return createBaseResponse('login_required', false, 0, 'Codex login required');
  }

  let payload = cacheAgeSec <= cacheTtl ? await readCachePayload(cacheFile) : null;
  let stale = false;
  let staleMinutes = Number.isFinite(cacheAgeSec) ? Math.floor(cacheAgeSec / 60) : 0;

  if (!payload) {
    const freshPayload = await fetchUsagePayload({
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      env,
    });
    if (freshPayload) {
      payload = freshPayload;
      staleMinutes = 0;
      await writeCachePayload(cacheFile, freshPayload);
    } else {
      payload = await readCachePayload(cacheFile);
      const fallbackAge = await readCacheAgeSec(cacheFile);
      stale = true;
      staleMinutes = Number.isFinite(fallbackAge) ? Math.floor(fallbackAge / 60) : 0;
    }
  }

  if (!payload) {
    return createBaseResponse('unavailable', false, 0, 'Codex quota unavailable');
  }

  const latestAge = stale ? await readCacheAgeSec(cacheFile) : 0;
  if (stale || latestAge > staleAfter) {
    stale = true;
    staleMinutes = Number.isFinite(latestAge) ? Math.floor(latestAge / 60) : staleMinutes;
  }

  return {
    state: 'ok',
    stale,
    staleMinutes,
    message: stale ? 'Codex quota stale' : 'Codex quota ready',
    windows: buildWindows(payload),
  };
}

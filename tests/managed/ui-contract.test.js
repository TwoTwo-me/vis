import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRepoFile } from './testHarness.js';

test('managed REST client seams use exact /api bootstrap and /api REST routes', async () => {
  const [appSource, opencodeSource] = await Promise.all([
    readRepoFile('app/App.vue'),
    readRepoFile('app/utils/opencode.ts'),
  ]);

  assert.match(
    opencodeSource,
    /['"`]\/api\/bootstrap['"`]/,
    'app/utils/opencode.ts must define GET /api/bootstrap for managed startup',
  );
  assert.match(
    opencodeSource,
    /['"`]\/api\/project['"`]/,
    'app/utils/opencode.ts must call representative REST routes through /api/*',
  );
  assert.doesNotMatch(
    opencodeSource,
    /Authorization/,
    'app/utils/opencode.ts REST helpers must not attach browser Authorization headers',
  );
  assert.doesNotMatch(
    appSource,
    /setAuthorization\(/,
    'app/App.vue must stop wiring browser Authorization into opencode REST helpers',
  );
});

test('managed SSE seam uses GET /api/global/event', async () => {
  const sseSource = await readRepoFile('app/utils/sseConnection.ts');

  assert.match(
    sseSource,
    /\/api\/global\/event/,
    'app/utils/sseConnection.ts must use GET /api/global/event',
  );
});

test('managed global-events transport uses a fixed worker identity without browser upstream auth', async () => {
  const globalEventsSource = await readRepoFile('app/composables/useGlobalEvents.ts');

  assert.match(
    globalEventsSource,
    /const MANAGED_CONNECTION_KEY = 'vis-managed-global-events';/,
    'app/composables/useGlobalEvents.ts must define a fixed managed SSE identity',
  );
  assert.match(
    globalEventsSource,
    /await transport\.connect\(MANAGED_CONNECTION_KEY, undefined, options\);/,
    'managed global events must connect with the fixed worker identity',
  );
  assert.match(
    globalEventsSource,
    /const message: TabToWorkerMessage = \{\s*type: 'connect',\s*baseUrl: normalized,\s*\};/s,
    'worker connect messages must omit browser-stored upstream authorization',
  );
  assert.doesNotMatch(
    globalEventsSource,
    /\[\(\) => credentials\.baseUrl\.value, \(\) => credentials\.authHeader\.value\]/,
    'managed global-events reconnect logic must not key off browser auth changes',
  );
});

test('managed SSE shared worker de-duplicates tabs behind one fixed connection key', async () => {
  const workerSource = await readRepoFile('app/workers/sse-shared-worker.ts');

  assert.match(
    workerSource,
    /const MANAGED_CONNECTION_KEY = 'vis-managed-global-events';/,
    'app/workers/sse-shared-worker.ts must use the fixed managed SSE key',
  );
  assert.match(
    workerSource,
    /function toKey\(\) \{\s*return MANAGED_CONNECTION_KEY;\s*\}/s,
    'shared worker dedupe must collapse all managed tabs onto one connection key',
  );
  assert.match(
    workerSource,
    /state\.client\.connect\(\{ baseUrl: MANAGED_CONNECTION_KEY \}\);/,
    'worker SSE reconnects must use the fixed managed identity only',
  );
  assert.match(
    workerSource,
    /if \(message\.type === 'connect'\) \{[\s\S]*?attachPort\(port\);/,
    'worker connect handling must attach tabs without requiring browser upstream credentials',
  );
  assert.doesNotMatch(
    workerSource,
    /attachPort\(port, message\.baseUrl, message\.authorization\)/,
    'worker tab attach must no longer depend on browser baseUrl or auth',
  );
});

test('managed PTY seam uses /api/pty/:ptyID/connect', async () => {
  const [ptySource, opencodeSource] = await Promise.all([
    readRepoFile('app/composables/usePtyOneshot.ts'),
    readRepoFile('app/utils/opencode.ts'),
  ]);

  assert.match(
    ptySource,
    /createWsUrl\(`\/api\/pty\/\$\{pty\.id\}\/connect`/,
    'app/composables/usePtyOneshot.ts must use /api/pty/:ptyID/connect',
  );
  assert.match(
    opencodeSource,
    /path\.startsWith\('\/pty\/'\) \? `\$\{MANAGED_API_PREFIX\}\$\{path\}` : path/,
    'app/utils/opencode.ts must upgrade runtime /pty connects onto same-origin /api/pty/*',
  );
  assert.match(
    opencodeSource,
    /getBrowserOriginBaseUrl\(\) \|\| getBaseUrlOrThrow\(\)/,
    'app/utils/opencode.ts PTY websocket runtime must prefer the browser same-origin base URL',
  );
});

test('managed boot failure UX is a blocking splash with retry-only actions', async () => {
  const appSource = await readRepoFile('app/App.vue');

  assert.match(
    appSource,
    /Access denied/,
    'managed UX must define edge-auth deny copy exactly',
  );
  assert.match(
    appSource,
    /Server unavailable/,
    'managed UX must define upstream unavailable copy exactly',
  );
  assert.match(
    appSource,
    /Upstream authentication failed/,
    'managed UX must define upstream auth failure copy exactly',
  );

  const errorBlockMatch = appSource.match(
    /<div v-else>[\s\S]*?<div class="app-loading-actions">[\s\S]*?<\/div>\s*<\/div>/,
  );
  assert(errorBlockMatch, 'app loading error block should be present and inspectable');
  const errorBlock = errorBlockMatch[0];

  assert.match(
    errorBlock,
    /<button\s+v-if="uiInitState === 'error'"[^>]*class="app-loading-retry"[\s\S]*?>\s*Retry\s*<\/button>/,
    'managed failure UI must show only one Retry action in error state',
  );
  assert.equal(
    (errorBlock.match(/class="app-loading-retry"/g) || []).length,
    1,
    'managed failure UI must not offer alternate recovery buttons',
  );
  assert.doesNotMatch(
    errorBlock,
    /name="url"|name="username"|type="password"|handleLogin|Connect to OpenCode Server/,
    'managed failure UI must never render upstream credential fields',
  );
});

test('managed frontend removes browser-stored upstream credentials and auth toggles', async () => {
  const [credentialsSource, storageKeysSource, topPanelSource] = await Promise.all([
    readRepoFile('app/composables/useCredentials.ts'),
    readRepoFile('app/utils/storageKeys.ts'),
    readRepoFile('app/components/TopPanel.vue'),
  ]);

  assert.match(
    credentialsSource,
    /localStorage\.removeItem\(storageKey\(LEGACY_UPSTREAM_CREDENTIALS_KEY\)\)/,
    'managed boot should proactively clear the legacy upstream credential key',
  );
  assert.doesNotMatch(
    credentialsSource,
    /storageSet\(|storageGet\(|username|password/,
    'managed credential cleanup must not keep browser-stored upstream username/password state',
  );
  assert.doesNotMatch(
    storageKeysSource,
    /auth\s*:\s*\{/,
    'managed storage keys must not define an auth credential namespace',
  );
  assert.doesNotMatch(
    topPanelSource,
    /Logout/,
    'managed UI should not expose an in-app logout toggle once browser auth is removed',
  );
});

test('git tree snapshot keeps a full visible tree and full file index in git mode', async () => {
  const fileTreeSource = await readRepoFile('app/composables/useFileTree.ts');

  assert.match(
    fileTreeSource,
    /function buildFullTreeFromPaths\(allPaths: string\[\]\): TreeNode\[] \{/,
    'git tree hydration should still build the visible tree from the full tracked path set',
  );
  assert.match(
    fileTreeSource,
    /function build\(paths: string\[], prefix: string\): TreeNode\[] \{/,
    'git full-tree builder should recursively expand tracked paths into nested tree nodes',
  );
  assert.match(
    fileTreeSource,
    /children: build\(childPaths, fullPath\),\s*loaded: false,/s,
    'git directories should eagerly materialize nested children from tracked paths',
  );
  assert.match(
    fileTreeSource,
    /const gitTree = buildFullTreeFromPaths\(allPaths\);/,
    'git snapshot refresh should rebuild the full visible tree from tracked paths',
  );
  assert.match(
    fileTreeSource,
    /const sorted = Array\.from\(new Set\(allPaths\)\)\.sort\(\(a, b\) => a\.localeCompare\(b\)\);[\s\S]*files\.value = sorted;/,
    'git snapshot refresh must still keep the full flat file index for file refs',
  );
});

test('git directory expansion still hydrates a folder through loadSingleDirectory(path)', async () => {
  const fileTreeSource = await readRepoFile('app/composables/useFileTree.ts');

  assert.match(
    fileTreeSource,
    /function toggleTreeDirectory\(path: string\) \{[\s\S]*const node = findTreeNodeByPath\(treeNodes\.value, path\);[\s\S]*if \(node\?\.loaded\) return;[\s\S]*void loadSingleDirectory\(path\);/,
    'directory toggles should still lazy-load unopened folders through loadSingleDirectory(path)',
  );
  assert.match(
    fileTreeSource,
    /async function loadSingleDirectory\(path: string\) \{[\s\S]*if \(fileTreeStrategy\.value === 'git'\) \{[\s\S]*if \(path === '\.'\) \{[\s\S]*await refreshGitFileSnapshot\(\);[\s\S]*return;[\s\S]*const data = await opencodeApi\.listFiles\(\{ directory, path \}\);/,
    'git mode should keep root refresh separate and load expanded directories via listFiles(path)',
  );
});

test('tree download affordance skips synthetic nodes and surfaces a managed download event', async () => {
  const [treeViewSource, sidePanelSource, appSource] = await Promise.all([
    readRepoFile('app/components/TreeView.vue'),
    readRepoFile('app/components/SidePanel.vue'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    treeViewSource,
    /function canDownloadNode\(node: TreeNode\) \{\s*if \(node\.synthetic\) return false;/,
    'tree download action should skip synthetic nodes that are not backed by a real file-system target',
  );
  assert.match(
    treeViewSource,
    /emit\('download', \{ path: node\.path, isDirectory: node\.type === 'directory' \}\);/,
    'tree rows should emit a dedicated download event with path and directory metadata',
  );
  assert.match(
    sidePanelSource,
    /@download="\(payload\) => emit\('download', payload\)"/,
    'side panel should forward tree download events to the app shell',
  );
  assert.match(
    appSource,
    /@download="downloadTreePath"/,
    'app shell should consume tree download events',
  );
  assert.match(
    appSource,
    /window\.alert\(message\)|window\.alert\(payload\.isDirectory \? 'Directory download failed\.' : 'File download failed\.'\);/,
    'download failures should surface an explicit browser alert instead of silently failing',
  );
});


test('managed codex usage helper stays on the same-origin /api seam', async () => {
  const [opencodeSource, topPanelSource, appSource] = await Promise.all([
    readRepoFile('app/utils/opencode.ts'),
    readRepoFile('app/components/TopPanel.vue'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    opencodeSource,
    /createUrl\('\/codex\/usage'\)/,
    'app/utils/opencode.ts must request the managed codex route through /api/codex/usage',
  );
  assert.match(
    opencodeSource,
    /if \(response\.status === 404\) return null;/,
    'app/utils/opencode.ts must soft-disable the feature on 404',
  );
  assert.doesNotMatch(
    topPanelSource,
    /fetch\(.*codex\/usage/s,
    'TopPanel.vue must stay prop-driven and never fetch codex usage directly',
  );
  assert.doesNotMatch(
    appSource,
    /fetch\(.*codex\/usage/s,
    'App.vue must consume the composable rather than fetching codex usage directly',
  );
});

test('managed codex quota polling stays non-blocking and visibility-aware', async () => {
  const [composableSource, appSource] = await Promise.all([
    readRepoFile('app/composables/useCodexQuota.ts'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    composableSource,
    /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/,
    'useCodexQuota.ts must refresh when the tab becomes visible again',
  );
  assert.match(
    composableSource,
    /AbortController/,
    'useCodexQuota.ts must cancel in-flight requests before starting another one',
  );
  assert.match(
    composableSource,
    /window\.setInterval\(/,
    'useCodexQuota.ts must poll on a fixed interval',
  );
  assert.match(
    composableSource,
    /if \(!enabled\.value \|\| disabled\.value \|\| loading\.value\) return;/,
    'useCodexQuota.ts must stop polling once the route is soft-disabled',
  );
  assert.match(
    appSource,
    /const codexQuotaEnabled = computed\(\(\) => uiInitState\.value === 'ready'\);/,
    'App.vue must only enable codex polling after the main UI is ready',
  );
});

test('managed top panel renders a prop-driven codex quota chip with stable selectors', async () => {
  const [topPanelSource, appSource] = await Promise.all([
    readRepoFile('app/components/TopPanel.vue'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    topPanelSource,
    /data-testid="codex-quota-chip"/,
    'TopPanel.vue must expose a stable selector for the codex quota chip',
  );
  assert.match(
    topPanelSource,
    /data-testid="codex-quota-window-5h"/,
    'TopPanel.vue must expose a stable selector for the 5h quota segment',
  );
  assert.match(
    topPanelSource,
    /@media \(max-width: 1100px\)/,
    'TopPanel.vue must hide the codex chip on narrow layouts',
  );
  assert.match(
    appSource,
    /:codex-quota="codexQuotaValue"/,
    'App.vue must pass quota data into TopPanel via props',
  );
  assert.match(
    appSource,
    /:codex-quota-state="codexQuotaState"/,
    'App.vue must pass quota UI state into TopPanel via props',
  );
});

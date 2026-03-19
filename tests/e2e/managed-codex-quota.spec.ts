import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const VIS_PORT = 30002;
const VIS_ORIGIN = `http://127.0.0.1:${VIS_PORT}`;

type MockProviderDefinition = {
  id: string;
  name: string;
  command: string;
  updatedAt: number;
};

type MockDraft = {
  name: string;
  command: string;
};

type MockProviderResultRow = {
  leftText: string;
  rightText: string;
};

type MockProviderResultStatus =
  | 'empty'
  | 'running'
  | 'ok'
  | 'error'
  | 'timed_out'
  | 'invalid_output'
  | 'config_error';

type MockProviderResultBlock = {
  id: string;
  name: string;
  status: MockProviderResultStatus;
  message: string;
  rows: MockProviderResultRow[];
};

type MockRefreshPayload = {
  state: 'ready' | 'empty' | 'config_error';
  message: string;
  providers: MockProviderResultBlock[];
};

type ManagedMockOptions = {
  initialTokenProviderDefinitions?: MockProviderDefinition[];
  refreshPayloadFactory?: (definitions: MockProviderDefinition[]) => MockRefreshPayload;
};

type ManagedMockState = {
  savedDefinitions: MockProviderDefinition[];
  lastSavePayload: { definitions?: MockProviderDefinition[] } | null;
  lastTestDraft: MockDraft | null;
};

let visProcess: ReturnType<typeof spawn> | undefined;

async function startStaticVisServer() {
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIS_PORT: String(VIS_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  visProcess = serverProcess;

  if (!serverProcess.stdout || !serverProcess.stderr) {
    throw new Error('vis server stdio is unavailable');
  }

  let stdout = '';
  let stderr = '';
  serverProcess.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const started = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`vis server did not start
STDOUT:
${stdout}
STDERR:
${stderr}`));
    }, 15000);

    serverProcess.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes(`Listening on http://localhost:${VIS_PORT}`)) return;
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `vis server exited early (code=${code}, signal=${signal})
STDOUT:
${stdout}
STDERR:
${stderr}`,
        ),
      );
    });
  });

  await started;
}

function cloneProviderDefinitions(definitions: MockProviderDefinition[] = []) {
  return definitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    command: definition.command,
    updatedAt: Number(definition.updatedAt),
  }));
}

function buildDraftTestResult(draft: MockDraft) {
  if (draft.command === 'mock-invalid-output') {
    return {
      result: {
        id: 'draft',
        name: draft.name,
        status: 'invalid_output',
        message: 'Provider output is invalid',
        rows: [],
      },
    };
  }

  if (draft.command === 'mock-empty') {
    return {
      result: {
        id: 'draft',
        name: draft.name,
        status: 'empty',
        message: 'Provider returned no rows',
        rows: [],
      },
    };
  }

  const rowsByCommand: Record<string, Array<{ leftText: string; rightText: string }>> = {
    'mock-ok-codex': [
      { leftText: '7d', rightText: '30%' },
      { leftText: '5h', rightText: '1h' },
    ],
    'mock-ok-helper': [{ leftText: '30d', rightText: '45%' }],
  };

  return {
    result: {
      id: 'draft',
      name: draft.name,
      status: 'ok',
      message: 'Provider ready',
      rows: rowsByCommand[draft.command] ?? [{ leftText: '7d', rightText: '30%' }],
    },
  };
}

function buildRefreshPayload(definitions: MockProviderDefinition[]): MockRefreshPayload {
  if (definitions.length === 0) {
    return {
      state: 'empty',
      message: 'No token providers configured',
      providers: [],
    };
  }

  return {
    state: 'ready',
    message: 'Token providers refreshed',
    providers: definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      status: 'ok',
      message: 'Provider ready',
      rows: [{ leftText: definition.name, rightText: definition.id }],
    })),
  };
}

async function openSettingsModal(page: Page) {
  await page.locator('.menu-button').click();
  await page.locator('.menu-item-content').click();
  await expect(page.getByText('Local composer behavior and trusted deployment controls.')).toBeVisible();
}

async function openTokenUsagePanel(page: Page) {
  await page.getByTestId('token-usage-trigger').click();
  await expect(page.getByTestId('token-usage-panel')).toBeVisible();
}

async function selectCodexPreset(page: Page) {
  await expect(page.getByTestId('token-provider-preset-gallery')).toBeVisible();
  await expect(page.getByTestId('token-provider-preset-placeholder')).toBeVisible();
  await page.getByTestId('token-provider-preset-card-codex').click();
}

async function installManagedBrowserMocks(
  page: Page,
  options: ManagedMockOptions = {},
) {
  const state: ManagedMockState = {
    savedDefinitions: cloneProviderDefinitions(options.initialTokenProviderDefinitions ?? []),
    lastSavePayload: null,
    lastTestDraft: null,
  };

  await page.addInitScript(() => {
    class MockPort {
      listeners: Array<(event: { data: unknown }) => void>;
      onmessage: ((event: { data: unknown }) => void) | null;

      constructor() {
        this.listeners = [];
        this.onmessage = null;
      }

      start() {}
      close() {}

      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        if (type === 'message') this.listeners.push(listener);
      }

      removeEventListener(type: string, listener: (event: { data: unknown }) => void) {
        if (type !== 'message') return;
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }

      emit(data: unknown) {
        const event = { data };
        if (typeof this.onmessage === 'function') this.onmessage(event);
        this.listeners.forEach((listener) => {
          listener(event);
        });
      }

      postMessage(message: { type?: string } | undefined) {
        if (message?.type === 'connect') {
          queueMicrotask(() => this.emit({ type: 'connection.open' }));
          queueMicrotask(() =>
            this.emit({
              type: 'state.bootstrap',
              projects: {
                global: {
                  id: 'global',
                  name: 'global',
                  worktree: '/root/vis',
                  sandboxes: {
                    '/root/vis': {
                      directory: '/root/vis',
                      name: '',
                      rootSessions: ['sess-1'],
                      sessions: {
                        'sess-1': {
                          id: 'sess-1',
                          title: 'Seed session',
                          directory: '/root/vis',
                          status: 'idle',
                          timeCreated: 1,
                          timeUpdated: 1,
                        },
                      },
                    },
                  },
                },
              },
              notifications: {},
            }),
          );
        }
      }
    }

    class MockSharedWorker {
      port: MockPort;

      constructor() {
        this.port = new MockPort();
      }
    }

    Object.defineProperty(window, 'SharedWorker', {
      configurable: true,
      value: MockSharedWorker,
    });
    Object.defineProperty(globalThis, 'SharedWorker', {
      configurable: true,
      value: MockSharedWorker,
    });
  });

  const context = page.context();

  await context.route('**/api/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'managed',
        auth: 'edge',
        capabilities: { rest: true, sse: true, pty: true },
      }),
    });
  });

  await context.route('**/api/path', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ home: '/root', worktree: '/root/vis' }),
    });
  });

  await context.route('**/api/config/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [] }),
    });
  });

  await context.route('**/api/agent', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await context.route('**/api/command*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await context.route('**/api/permission*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await context.route('**/api/question*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await context.route('**/api/vcs*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await context.route('**/api/vis/token-providers/config', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ definitions: state.savedDefinitions }),
      });
      return;
    }

    if (request.method() === 'PUT') {
      const payload = request.postDataJSON() as { definitions?: MockProviderDefinition[] } | null;
      state.lastSavePayload = payload;
      state.savedDefinitions = cloneProviderDefinitions(payload?.definitions ?? []);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ definitions: state.savedDefinitions }),
      });
      return;
    }

    await route.fulfill({ status: 405, contentType: 'application/json', body: '{}' });
  });

  await context.route('**/api/vis/token-providers/test', async (route) => {
    const draft = route.request().postDataJSON() as MockDraft;
    state.lastTestDraft = draft;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildDraftTestResult(draft)),
    });
  });

  await context.route('**/api/vis/token-providers/refresh', async (route) => {
    const payload = options.refreshPayloadFactory
      ? options.refreshPayloadFactory(cloneProviderDefinitions(state.savedDefinitions))
      : buildRefreshPayload(state.savedDefinitions);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  return state;
}

async function expectTokenTriggerPlacement(page: Page) {
  const shellButton = page.locator('.open-shell-button');
  const tokenTrigger = page.getByTestId('token-usage-trigger');

  await expect(shellButton).toBeVisible();
  await expect(tokenTrigger).toBeVisible();

  const controlOrder = await page.locator('.top-center').evaluate((element) =>
    Array.from(element.children)
      .map((child) => {
        if (child.matches('.open-shell-button')) return 'shell';
        if (child.querySelector('[data-testid="token-usage-trigger"]')) return 'token';
        return null;
      })
      .filter((value): value is 'shell' | 'token' => value !== null),
  );

  const shellIndex = controlOrder.indexOf('shell');
  expect(shellIndex).toBeGreaterThanOrEqual(0);
  expect(controlOrder[shellIndex + 1]).toBe('token');

  const shellBox = await shellButton.boundingBox();
  const tokenBox = await tokenTrigger.boundingBox();
  expect(shellBox).not.toBeNull();
  expect(tokenBox).not.toBeNull();

  if (!shellBox || !tokenBox) return;

  expect(tokenBox.width).toBeGreaterThanOrEqual(31);
  expect(tokenBox.width).toBeLessThanOrEqual(33);
  expect(tokenBox.height).toBeGreaterThanOrEqual(31);
  expect(tokenBox.height).toBeLessThanOrEqual(33);
  expect(Math.abs(tokenBox.width - shellBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(tokenBox.height - shellBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(tokenBox.y - shellBox.y)).toBeLessThanOrEqual(1);
  expect(tokenBox.x).toBeGreaterThan(shellBox.x);

  const gap = tokenBox.x - (shellBox.x + shellBox.width);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(12);

  const tokenGlyphMetrics = await tokenTrigger.locator('.token-usage-glyph').evaluate((element) => ({
    widthAttr: element.getAttribute('width'),
    heightAttr: element.getAttribute('height'),
    height: getComputedStyle(element).height,
  }));
  expect(tokenGlyphMetrics).toEqual({ widthAttr: '20', heightAttr: '20', height: '20px' });
}

async function expectTokenUsagePanelWidth(page: Page, minWidth: number, maxWidth: number) {
  const panelShell = page.locator('.ui-dropdown-menu:has([data-testid="token-usage-panel"])');
  await expect(panelShell).toBeVisible();

  const panelBox = await panelShell.boundingBox();
  expect(panelBox).not.toBeNull();

  if (!panelBox) return;

  expect(panelBox.width).toBeGreaterThanOrEqual(minWidth);
  expect(panelBox.width).toBeLessThanOrEqual(maxWidth);
}

async function expectWrappedPanelCopy(copy: ReturnType<Page['locator']>) {
  const metrics = await copy.evaluate((element) => {
    const style = getComputedStyle(element);
    const parent = element.parentElement;
    const lineHeight = Number.parseFloat(style.lineHeight);

    return {
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
      parentClientWidth: parent?.clientWidth ?? 0,
      parentScrollWidth: parent?.scrollWidth ?? 0,
    };
  });

  expect(metrics.whiteSpace).toBe('normal');
  expect(metrics.overflowWrap).toBe('anywhere');
  expect(metrics.wordBreak).toBe('break-word');
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.parentScrollWidth).toBeLessThanOrEqual(metrics.parentClientWidth + 1);
  expect(metrics.clientHeight).toBeGreaterThan(metrics.lineHeight * 1.5);
}

test.beforeAll(async () => {
  await startStaticVisServer();
});

test.afterAll(async () => {
  if (visProcess && visProcess.exitCode === null) {
    visProcess.kill('SIGTERM');
    await once(visProcess, 'exit').catch(() => {});
  }
});

test('top-panel token usage trigger stays shell-adjacent on desktop and mobile', async ({ page }) => {
  await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);

  await expectTokenTriggerPlacement(page);
  await page.getByTestId('token-usage-trigger').click();
  await expectTokenUsagePanelWidth(page, 360, 444);

  await page.getByTestId('token-usage-trigger').click();
  await page.setViewportSize({ width: 375, height: 812 });

  await expectTokenTriggerPlacement(page);
  await page.getByTestId('token-usage-trigger').click();
  await expectTokenUsagePanelWidth(page, 360, 364);
});

test('token usage dropdown renders saved-order provider blocks, trimmed rows, and failure blocks', async ({ page }) => {
  await installManagedBrowserMocks(page, {
    initialTokenProviderDefinitions: [
      { id: 'codex', name: 'Codex', command: 'mock-ok-codex', updatedAt: 1 },
      { id: 'helper', name: 'Quota Helper', command: 'mock-ok-helper', updatedAt: 2 },
      { id: 'broken', name: 'Broken Output', command: 'mock-invalid-output', updatedAt: 3 },
      { id: 'slow', name: 'Slow Provider', command: 'mock-timeout', updatedAt: 4 },
      { id: 'blank', name: 'No Rows', command: 'mock-empty', updatedAt: 5 },
    ],
    refreshPayloadFactory: () => ({
      state: 'ready',
      message: 'Token providers refreshed',
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          status: 'ok',
          message: 'Provider ready',
          rows: [
            { leftText: ' 7d : 2d 1h 02m ', rightText: ' 30% ' },
            { leftText: ' 7d : 2d 1h 02m ', rightText: ' 18% ' },
          ],
        },
        {
          id: 'helper',
          name: 'Quota Helper',
          status: 'ok',
          message: 'Provider ready',
          rows: [{ leftText: ' 30d : 12d 4h ', rightText: ' 45% ' }],
        },
        {
          id: 'broken',
          name: 'Broken Output',
          status: 'invalid_output',
          message: 'Provider output is invalid',
          rows: [],
        },
        {
          id: 'slow',
          name: 'Slow Provider',
          status: 'timed_out',
          message: 'Provider command timed out',
          rows: [],
        },
        {
          id: 'blank',
          name: 'No Rows',
          status: 'empty',
          message: 'Provider returned no rows',
          rows: [],
        },
      ],
    }),
  });
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openTokenUsagePanel(page);

  const providerOrder = await page.locator('[data-testid^="token-provider-block-"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-testid')),
  );
  expect(providerOrder).toEqual([
    'token-provider-block-codex',
    'token-provider-block-helper',
    'token-provider-block-broken',
    'token-provider-block-slow',
    'token-provider-block-blank',
  ]);

  await expect(page.getByTestId('token-provider-block-codex')).toContainText('Codex');
  await expect(page.locator('[data-testid="token-provider-row-codex-0"] .token-provider-row-left')).toHaveText(
    '7d : 2d 1h 02m',
  );
  await expect(page.locator('[data-testid="token-provider-row-codex-0"] .token-provider-row-right')).toHaveText(
    '30%',
  );
  await expect(page.locator('[data-testid="token-provider-row-codex-1"] .token-provider-row-left')).toHaveText(
    '7d : 2d 1h 02m',
  );
  await expect(page.locator('[data-testid="token-provider-row-codex-1"] .token-provider-row-right')).toHaveText(
    '18%',
  );
  await expect(page.locator('[data-testid="token-provider-row-helper-0"] .token-provider-row-left')).toHaveText(
    '30d : 12d 4h',
  );
  await expect(page.locator('[data-testid="token-provider-row-helper-0"] .token-provider-row-right')).toHaveText(
    '45%',
  );

  const codexRowLayout = await page.getByTestId('token-provider-row-codex-0').evaluate((element) => {
    const left = element.querySelector('.token-provider-row-left');
    const right = element.querySelector('.token-provider-row-right');
    if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return null;
    const leftBox = left.getBoundingClientRect();
    const rightBox = right.getBoundingClientRect();
    return {
      display: getComputedStyle(element).display,
      textAlign: getComputedStyle(right).textAlign,
      rightStartsAfterLeft: rightBox.left >= leftBox.right,
    };
  });
  expect(codexRowLayout).toEqual({ display: 'grid', textAlign: 'right', rightStartsAfterLeft: true });

  await expect(page.getByTestId('token-provider-block-broken')).toContainText('Broken Output');
  await expect(page.getByTestId('token-provider-status-broken')).toHaveText('Provider output is invalid');
  await expect(page.getByTestId('token-provider-block-slow')).toContainText('Slow Provider');
  await expect(page.getByTestId('token-provider-status-slow')).toHaveText('Provider command timed out');
  await expect(page.getByTestId('token-provider-block-blank')).toContainText('No Rows');
  await expect(page.getByTestId('token-provider-status-blank')).toHaveText('Provider returned no rows');
  await expect(page.locator('[data-testid^="token-provider-row-broken-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="token-provider-row-slow-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="token-provider-row-blank-"]')).toHaveCount(0);
});

test('token usage dropdown empty and config-error states expose deterministic copy and settings CTA', async ({ page }) => {
  let refreshMode: 'empty' | 'config_error' = 'empty';

  await installManagedBrowserMocks(page, {
    refreshPayloadFactory: () =>
      refreshMode === 'empty'
        ? {
            state: 'empty',
            message: 'No token providers configured',
            providers: [],
          }
        : {
            state: 'config_error',
            message: 'Token provider config is invalid',
            providers: [],
          },
  });
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();

  await openTokenUsagePanel(page);
  await expect(page.getByTestId('token-provider-panel-state-empty')).toContainText(
    'No token providers configured',
  );
  await expect(page.getByTestId('token-provider-panel-settings-cta')).toBeVisible();
  await page.getByTestId('token-provider-panel-settings-cta').click();
  await expect(page.getByText('Local composer behavior and trusted deployment controls.')).toBeVisible();
  await page.locator('dialog[open] .modal-close-button').first().click();

  refreshMode = 'config_error';
  await openTokenUsagePanel(page);
  await expect(page.getByTestId('token-provider-panel-state-config-error')).toContainText(
    'Token provider config is invalid',
  );
  await expect(page.getByTestId('token-provider-panel-settings-cta')).toBeVisible();
});

test('token usage dropdown keeps long config-error and refresh-error copy wrapped inside the panel', async ({
  page,
}) => {
  const longConfigError =
    'GET /api/vis/token-providers/config?worktree=/root/vis/projects/very-long-route-segment/and/even-more/managed/token/provider/config request failed (500) while validating the saved provider shell.';
  const longRefreshError =
    'GET /api/vis/token-providers/refresh?worktree=/root/vis/projects/very-long-route-segment/and/even-more/managed/token/provider/refresh request failed (503) while refreshing the current panel.';

  await installManagedBrowserMocks(page, {
    refreshPayloadFactory: () => ({
      state: 'config_error',
      message: longConfigError,
      providers: [],
    }),
  });
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();

  await openTokenUsagePanel(page);
  await expectTokenUsagePanelWidth(page, 360, 364);
  const configErrorCopy = page.getByTestId('token-provider-panel-state-config-error').locator(
    '.token-provider-panel-copy',
  );
  await expect(configErrorCopy).toHaveText(longConfigError);
  await expectWrappedPanelCopy(configErrorCopy);

  await page.addInitScript(({ message }) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);

      if (requestUrl.includes('/api/vis/token-providers/refresh')) {
        return Promise.reject(new Error(message));
      }

      return originalFetch(input, init);
    };
  }, { message: longRefreshError });
  await page.reload();
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openTokenUsagePanel(page);
  await expectTokenUsagePanelWidth(page, 360, 364);
  const refreshErrorCopy = page.getByTestId('token-provider-panel-state-refresh-error').locator(
    '.token-provider-panel-copy',
  );
  await expect(refreshErrorCopy).toHaveText(longRefreshError);
  await expectWrappedPanelCopy(refreshErrorCopy);
});

test('settings token providers support add, test, save, reorder, reload, and delete flows', async ({ page }) => {
  const state = await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);

  await selectCodexPreset(page);
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex');
  await expect(page.getByTestId('token-provider-command-input')).toHaveValue('');
  await expect(page.getByTestId('token-provider-command-input')).toBeFocused();
  await expect(page.getByTestId('token-provider-save-action-codex')).toBeDisabled();

  await page.getByTestId('token-provider-command-input').fill('mock-ok-codex');
  await page.getByTestId('token-provider-test-action-codex').click();
  await expect(page.getByTestId('token-provider-block-draft')).toContainText('Provider ready');
  await expect(page.getByTestId('token-provider-row-draft-0')).toContainText(/7d\s*30%/);
  await expect(page.getByTestId('token-provider-row-draft-1')).toContainText(/5h\s*1h/);
  await page.getByTestId('token-provider-save-action-codex').click();

  await expect.poll(() => state.savedDefinitions.map((definition) => definition.id).join(',')).toBe('codex');

  await selectCodexPreset(page);
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex 2');
  await expect(page.getByTestId('token-provider-command-input')).toBeFocused();
  await page.getByTestId('token-provider-name-input').fill('Quota Helper');
  await page.getByTestId('token-provider-command-input').fill('mock-ok-helper');
  await page.getByTestId('token-provider-save-action-codex-2').click();

  await expect.poll(() => state.savedDefinitions.map((definition) => definition.name).join(',')).toBe('Codex,Quota Helper');

  await page.getByTestId('token-provider-reorder-up-action-codex-2').click();
  await page.getByTestId('token-provider-save-action-codex-2').click();

  await expect.poll(() => state.savedDefinitions.map((definition) => definition.name).join(',')).toBe('Quota Helper,Codex');

  await page.reload();
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);
  const providerItems = page.locator('[data-testid^="token-provider-list-item-"]');
  await expect(providerItems).toHaveCount(2);
  await expect(providerItems.nth(0)).toContainText('Quota Helper');
  await expect(providerItems.nth(1)).toContainText('Codex');
  await page.locator('dialog[open] .modal-close-button').first().click();

  await openTokenUsagePanel(page);
  const reorderedProviderBlocks = await page
    .locator('[data-testid^="token-provider-block-"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));
  expect(reorderedProviderBlocks).toEqual(['token-provider-block-codex-2', 'token-provider-block-codex']);

  await openSettingsModal(page);

  await page.getByTestId('token-provider-list-item-codex-2').click();
  await page.getByTestId('token-provider-delete-action-codex-2').click();
  await expect(page.getByTestId('token-provider-delete-confirm-codex-2')).toBeVisible();
  expect(state.savedDefinitions).toHaveLength(2);
  await page.getByTestId('token-provider-delete-confirm-codex-2').click();
  await expect(page.getByTestId('token-provider-list-item-codex-2')).toHaveCount(0);
  await page.getByTestId('token-provider-save-action-codex').click();

  await expect.poll(() => state.savedDefinitions.map((definition) => definition.id).join(',')).toBe('codex');

  await page.reload();
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);
  await expect(page.locator('[data-testid^="token-provider-list-item-"]')).toHaveCount(1);
  await expect(page.getByTestId('token-provider-list-item-codex')).toContainText('Codex');
});

test('settings token provider failed draft tests stay local and unsaved deletes stay immediate', async ({ page }) => {
  const state = await installManagedBrowserMocks(page, {
    initialTokenProviderDefinitions: [
      {
        id: 'codex',
        name: 'Codex',
        command: 'mock-ok-codex',
        updatedAt: 1,
      },
    ],
  });
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);

  await expect(page.getByTestId('token-provider-list-item-codex')).toBeVisible();
  await selectCodexPreset(page);
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex 2');
  await expect(page.getByTestId('token-provider-command-input')).toBeFocused();
  await page.getByTestId('token-provider-name-input').fill('Broken Draft');
  await page.getByTestId('token-provider-command-input').fill('mock-invalid-output');
  await page.getByTestId('token-provider-test-action-codex-2').click();

  await expect(page.getByTestId('token-provider-block-draft')).toContainText('invalid output');
  await expect(page.getByTestId('token-provider-row-draft-0')).toHaveCount(0);
  expect(state.savedDefinitions).toHaveLength(1);

  await page.getByTestId('token-provider-delete-action-codex-2').click();
  await expect(page.getByTestId('token-provider-delete-confirm-codex-2')).toHaveCount(0);
  await expect(page.getByTestId('token-provider-list-item-codex-2')).toHaveCount(0);
  expect(state.savedDefinitions).toHaveLength(1);

  await page.reload();
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);
  await expect(page.locator('[data-testid^="token-provider-list-item-"]')).toHaveCount(1);
  await expect(page.getByTestId('token-provider-list-item-codex')).toContainText('Codex');
});

test('settings preserve multiple unsaved provider drafts before save', async ({ page }) => {
  const state = await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);

  await selectCodexPreset(page);
  await page.getByTestId('token-provider-command-input').fill('mock-ok-codex');

  await selectCodexPreset(page);
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex 2');
  await expect(page.getByTestId('token-provider-command-input')).toBeFocused();
  await page.getByTestId('token-provider-command-input').fill('mock-ok-helper');

  await page.getByTestId('token-provider-list-item-codex').click();
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex');
  await expect(page.getByTestId('token-provider-command-input')).toHaveValue('mock-ok-codex');

  await page.getByTestId('token-provider-list-item-codex-2').click();
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex 2');
  await expect(page.getByTestId('token-provider-command-input')).toHaveValue('mock-ok-helper');

  await page.getByTestId('token-provider-save-action-codex-2').click();
  await expect.poll(() => state.savedDefinitions.map((definition) => definition.id).join(',')).toBe(
    'codex,codex-2',
  );
});

test('settings preset gallery inserts editable Codex draft before any explicit save', async ({ page }) => {
  const state = await installManagedBrowserMocks(page, {
    initialTokenProviderDefinitions: [
      {
        id: 'codex',
        name: 'Codex',
        command: 'mock-ok-codex',
        updatedAt: 1,
      },
    ],
  });
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await openSettingsModal(page);

  await expect(page.getByTestId('token-provider-list-item-codex')).toBeVisible();
  await selectCodexPreset(page);

  await expect(page.getByTestId('token-provider-list-item-codex-2')).toContainText('Codex 2');
  await expect(page.getByTestId('token-provider-name-input')).toHaveValue('Codex 2');
  await expect(page.getByTestId('token-provider-command-input')).toHaveValue('');
  await expect(page.getByTestId('token-provider-command-input')).toBeFocused();
  expect(state.savedDefinitions).toHaveLength(1);
  expect(state.lastSavePayload).toBeNull();

  await page.getByTestId('token-provider-name-input').fill('Codex Draft');
  await page.getByTestId('token-provider-command-input').fill('mock-ok-helper');
  await page.getByTestId('token-provider-test-action-codex-2').click();

  await expect(page.getByTestId('token-provider-block-draft')).toContainText('Provider ready');
  expect(state.lastTestDraft).toEqual({ name: 'Codex Draft', command: 'mock-ok-helper' });
  expect(state.savedDefinitions).toHaveLength(1);
  expect(state.lastSavePayload).toBeNull();

  await page.locator('dialog[open] .modal-close-button').first().click();
  await openSettingsModal(page);
  await expect(page.locator('[data-testid^="token-provider-list-item-"]')).toHaveCount(1);
  await expect(page.getByTestId('token-provider-list-item-codex')).toContainText('Codex');
  await expect(page.getByTestId('token-provider-list-item-codex-2')).toHaveCount(0);
});

test('settings surface external-state token provider load and save failures to admins', async ({ page }) => {
  await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  const context = page.context();
  await context.unroute('**/api/vis/token-providers/config');

  let failLoad = true;
  let failSave = false;
  await context.route('**/api/vis/token-providers/config', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (failLoad) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ definitions: [] }),
      });
      return;
    }

    if (request.method() === 'PUT') {
      if (failSave) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ definitions: request.postDataJSON()?.definitions ?? [] }),
      });
      return;
    }

    await route.fulfill({ status: 405, contentType: 'application/json', body: '{}' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);
  await expect(page.getByTitle('GitHub')).toBeVisible();

  await openSettingsModal(page);
  await expect(page.getByTestId('token-provider-status-message')).toContainText(
    '/vis/token-providers/config request failed (500)',
  );
  await page.locator('dialog[open] .modal-close-button').first().click();

  failLoad = false;
  failSave = true;

  await openSettingsModal(page);
  await expect(page.getByTestId('token-provider-status-message')).toHaveCount(0);
  await selectCodexPreset(page);
  await page.getByTestId('token-provider-command-input').fill('mock-ok-codex');
  await page.getByTestId('token-provider-save-action-codex').click();
  await expect(page.getByTestId('token-provider-status-message')).toContainText(
    '/vis/token-providers/config request failed (500)',
  );
});

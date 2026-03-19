import { expect, test, type Page } from '@playwright/test';

const repoRoot = process.cwd();
const rootSessionId = 'ses-managed-root';
const otherSessionId = 'ses-session-two';
const subagentSessionId = 'ses-subagent';
const readmeWindowKey = 'file-viewer:README.md';
const appWindowKey = 'file-viewer:app/App.vue';

async function installManagedTaskbarMock(page: Page) {
  await page.addInitScript(({ repoRoot, rootSessionId, otherSessionId, subagentSessionId }) => {
    type MockPortInstance = { emit: (message: unknown) => void };

    const state: {
      ports: MockPortInstance[];
      bootstrap: {
        type: string;
        projects: Record<string, unknown>;
        notifications: Record<string, never>;
      };
    } = {
      ports: [],
      bootstrap: {
        type: 'state.bootstrap',
        projects: {
          'proj-managed': {
            id: 'proj-managed',
            name: 'Managed Harness Project',
            worktree: repoRoot,
            sandboxes: {
              [repoRoot]: {
                directory: repoRoot,
                name: '',
                rootSessions: [rootSessionId, otherSessionId],
                sessions: {
                  [rootSessionId]: {
                    id: rootSessionId,
                    title: 'Managed Harness Session',
                    directory: repoRoot,
                    status: 'idle',
                    timeCreated: 10,
                    timeUpdated: 20,
                  },
                  [otherSessionId]: {
                    id: otherSessionId,
                    title: 'Other Session',
                    directory: repoRoot,
                    status: 'idle',
                    timeCreated: 1,
                    timeUpdated: 2,
                  },
                  [subagentSessionId]: {
                    id: subagentSessionId,
                    parentID: rootSessionId,
                    title: 'Subagent Session',
                    directory: repoRoot,
                    status: 'busy',
                    timeCreated: 11,
                    timeUpdated: 12,
                  },
                },
              },
            },
          },
        },
        notifications: {},
      },
    };

    const controller = {
      emitWorkerMessage(message: unknown) {
        for (const port of state.ports) port.emit(message);
      },
      emitPacket(packet: unknown) {
        controller.emitWorkerMessage({ type: 'packet', packet });
      },
    };

    class MockPort {
      listeners: Array<(event: MessageEvent) => void>;
      onmessage: ((event: MessageEvent) => void) | null;

      constructor() {
        this.listeners = [];
        this.onmessage = null;
        state.ports.push(this);
      }

      start() {}
      close() {
        state.ports = state.ports.filter((entry) => entry !== this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === 'message') this.listeners.push(listener);
      }
      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type !== 'message') return;
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
      emit(data: unknown) {
        const event = { data } as MessageEvent;
        this.onmessage?.(event);
        for (const listener of this.listeners) listener(event);
      }
      postMessage(message: { type?: string }) {
        if (message?.type !== 'connect') return;
        queueMicrotask(() => this.emit({ type: 'connection.open' }));
        queueMicrotask(() => this.emit(state.bootstrap));
      }
    }

    class MockSharedWorker {
      port: MockPort;
      constructor() {
        this.port = new MockPort();
      }
    }

    Object.defineProperty(window, 'SharedWorker', { configurable: true, value: MockSharedWorker });
    Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: MockSharedWorker });
    Object.defineProperty(window, '__VIS_TASKBAR_MOCK__', { configurable: true, value: controller });
  }, { repoRoot, rootSessionId, otherSessionId, subagentSessionId });
}

async function waitForManagedApp(page: Page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto('/');
    const retry = page.getByRole('button', { name: 'Retry' });
    if (await retry.isVisible().catch(() => false)) {
      await retry.click();
      await page.waitForTimeout(1000);
    }
    const textarea = page.locator('textarea.input-textarea');
    if (await textarea.isVisible().catch(() => false)) {
      await expect(page.getByTitle('Open shell')).toBeVisible();
      return;
    }
  }

  await expect(page.locator('textarea.input-textarea')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTitle('Open shell')).toBeVisible({ timeout: 30000 });
}

async function emitPacket(page: Page, packet: unknown) {
  await page.evaluate((value) => {
    const mock = (window as Window & {
      __VIS_TASKBAR_MOCK__?: { emitPacket: (packet: unknown) => void };
    }).__VIS_TASKBAR_MOCK__;
    mock?.emitPacket(value);
  }, packet);
}

async function taskbarKeys(page: Page) {
  return await page.getByTestId('window-taskbar-item').evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-window-key'))
      .filter((value): value is string => Boolean(value)),
  );
}

async function taskbarStates(page: Page) {
  return await page.getByTestId('window-taskbar-item').evaluateAll((elements) =>
    elements.map((element) => ({
      key: element.getAttribute('data-window-key'),
      state: element.getAttribute('data-taskbar-state'),
    })),
  );
}

async function overflowKeys(page: Page) {
  return await page.getByTestId('window-taskbar-overflow-item').evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-window-key'))
      .filter((value): value is string => Boolean(value)),
  );
}

async function openFile(page: Page, rowText: string, windowKey: string) {
  await page.locator('.tree-row').filter({ hasText: rowText }).dblclick({ force: true });
  await expect(page.locator(`[data-window-key="${windowKey}"]`)).toBeVisible();
}

async function openAppVueFile(page: Page) {
  await page.locator('.tree-row').filter({ hasText: 'app' }).click({ force: true });
  await expect(page.locator('.tree-row').filter({ hasText: 'App.vue' })).toBeVisible();
  await openFile(page, 'App.vue', appWindowKey);
}

function toolPacket(callId: string, start: number, title = 'Tool One') {
  return {
    directory: '',
    payload: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: `${callId}-part`,
          sessionID: rootSessionId,
          messageID: `${callId}-message`,
          type: 'tool',
          callID: callId,
          tool: 'bash',
          state: {
            status: 'running',
            input: {},
            title,
            metadata: {},
            time: { start },
          },
        },
      },
    },
  };
}

async function emitToolWindowsUntilOverflow(
  page: Page,
  {
    prefix,
    titlePrefix,
    minCount = 4,
    maxCount = 80,
    start = 100,
  }: {
    prefix: string;
    titlePrefix: string;
    minCount?: number;
    maxCount?: number;
    start?: number;
  },
) {
  const overflowTrigger = page.getByTestId('window-taskbar-overflow');
  const keys: string[] = [];
  const titles: string[] = [];

  for (let index = 0; index < maxCount; index += 1) {
    const key = `${prefix}-${index}`;
    const title = `${titlePrefix} ${index}`;
    keys.push(key);
    titles.push(title);
    await emitPacket(page, toolPacket(key, start + index, title));
    await expect.poll(async () => {
      if ((await overflowTrigger.count()) > 0) return 'overflow';
      return (await taskbarKeys(page)).includes(key) ? 'visible' : 'pending';
    }).not.toBe('pending');

    if ((await overflowTrigger.count()) > 0 && keys.length >= minCount) {
      return { keys, titles };
    }
  }

  throw new Error(`Expected overflow for ${prefix} after ${maxCount} windows`);
}

async function overflowRows(page: Page) {
  return await page.getByTestId('window-taskbar-overflow-item').evaluateAll((elements) =>
    elements.map((element) => ({
      title: element.getAttribute('title'),
      label:
        element.querySelector<HTMLElement>('.window-taskbar-overflow-label')?.textContent?.trim() ?? '',
      state:
        element.querySelector<HTMLElement>('.window-taskbar-overflow-state')?.textContent?.trim() ?? '',
    })),
  );
}

async function actionBarLayout(page: Page) {
  return await page.evaluate(() => {
    const selectors = [
      '[data-testid="window-taskbar-overflow"]',
      '.input-actions .suppress-button',
      '.input-actions .bookmark-button',
      '.input-actions .attach-button',
      '.input-actions .send-button',
    ];

    return selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        selector,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    });
  });
}

function reasoningPacket() {
  return {
    directory: '',
    payload: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'reasoning-part',
          sessionID: rootSessionId,
          messageID: 'reasoning-message',
          type: 'reasoning',
          text: 'thinking',
          time: { start: 101 },
        },
      },
    },
  };
}

function subagentMessagePacket() {
  return {
    directory: '',
    payload: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'subagent-message',
          sessionID: subagentSessionId,
          role: 'assistant',
          time: { created: 102 },
          parentID: 'parent-message',
          modelID: 'gpt',
          providerID: 'openai',
          mode: 'build',
          agent: 'build',
          path: { cwd: repoRoot, root: repoRoot },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    },
  };
}

function subagentTextPacket() {
  return {
    directory: '',
    payload: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'subagent-part',
          sessionID: subagentSessionId,
          messageID: 'subagent-message',
          type: 'text',
          text: 'working',
          time: { start: 102 },
        },
      },
    },
  };
}

test('window taskbar keeps auto items left of manual items and newest manual items on the right', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForManagedApp(page);

  await emitPacket(page, toolPacket('call-ordering', 100));
  await expect(page.locator('[data-window-key="call-ordering"]')).toBeVisible();

  await openFile(page, 'README.md', readmeWindowKey);
  await openAppVueFile(page);

  await expect.poll(() => taskbarKeys(page)).toEqual(['call-ordering', readmeWindowKey, appWindowKey]);
});

test('window taskbar tracks suppressed auto work without reopening popup windows', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForManagedApp(page);

  await page.getByTitle('Suppress auto windows').click();
  await emitPacket(page, toolPacket('call-suppressed', 100));
  await emitPacket(page, reasoningPacket());
  await emitPacket(page, subagentMessagePacket());
  await emitPacket(page, subagentTextPacket());

  await expect.poll(() => taskbarStates(page)).toEqual([
    { key: 'call-suppressed', state: 'suppressed' },
    { key: 'reasoning:ses-managed-root', state: 'suppressed' },
    { key: 'subagent:ses-subagent', state: 'suppressed' },
  ]);
  await expect(page.locator('[data-floating-key]')).toHaveCount(0);
});

test('window taskbar minimizes and restores file windows from the strip', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForManagedApp(page);

  await openFile(page, 'README.md', readmeWindowKey);
  await page.getByTestId('floating-window-minimize').click();

  await expect(page.locator(`[data-floating-key="${readmeWindowKey}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-window-key="${readmeWindowKey}"]`)).toHaveAttribute(
    'data-taskbar-state',
    'minimized',
  );

  await page.locator(`[data-window-key="${readmeWindowKey}"]`).click();
  await expect(page.locator(`[data-floating-key="${readmeWindowKey}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-window-key="${readmeWindowKey}"]`)).toHaveAttribute(
    'data-taskbar-state',
    'visible',
  );
});

test('window taskbar exposes ordered overflow rows only when windows outgrow the strip', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForManagedApp(page);

  const { keys } = await emitToolWindowsUntilOverflow(page, {
    prefix: 'call-overflow',
    titlePrefix: 'Overflow verification window title',
  });
  const overflowTrigger = page.getByTestId('window-taskbar-overflow');
  await expect(overflowTrigger).toBeVisible();
  const visibleKeys = await taskbarKeys(page);
  if (visibleKeys.length > 0) {
    expect(visibleKeys[visibleKeys.length - 1]).toBe(keys[keys.length - 1]);
  }

  await overflowTrigger.click({ force: true });
  await expect(page.getByTestId('window-taskbar-overflow-menu')).toBeVisible();
  await expect.poll(() => overflowKeys(page)).toEqual(keys.slice(0, keys.length - visibleKeys.length));
  await expect.poll(async () => {
    const rows = await overflowRows(page);
    return {
      count: rows.length,
      valid: rows.every((row) => row.title === `${row.label} (${row.state})`),
    };
  }).toEqual({ count: keys.length - visibleKeys.length, valid: true });
});

test('window taskbar keeps the strip and footer actions usable at 390px mobile width', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForManagedApp(page);

  await emitToolWindowsUntilOverflow(page, {
    prefix: 'call-mobile-overflow',
    titlePrefix: 'Mobile overflow verification window title',
  });

  const overflowTrigger = page.getByTestId('window-taskbar-overflow');
  const suppressButton = page.locator('.input-actions .suppress-button');
  const bookmarkButton = page.locator('.input-actions .bookmark-button');
  const attachButton = page.locator('.input-actions .attach-button');
  const sendButton = page.locator('.input-actions .send-button');

  await expect(overflowTrigger).toBeVisible();
  await expect(suppressButton).toBeVisible();
  await expect(bookmarkButton).toBeVisible();
  await expect(attachButton).toBeVisible();
  await expect(sendButton).toBeVisible();

  const layout = await actionBarLayout(page);
  expect(layout.every((item) => item && item.width > 0 && item.height > 0)).toBe(true);
  const metrics = layout.filter((item): item is NonNullable<(typeof layout)[number]> => Boolean(item));
  const centers = metrics.map((item) => item.top + item.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1.5);
  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(metrics.every((item) => item.left >= 0 && item.right <= viewportWidth)).toBe(true);

  await suppressButton.click();
  await expect(suppressButton).toHaveAttribute('title', 'Auto windows suppressed');
  await expect(overflowTrigger).toBeEnabled();
});

test('window taskbar clears tracked windows when switching sessions', async ({ page }) => {
  await installManagedTaskbarMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForManagedApp(page);

  await emitPacket(page, toolPacket('call-cleanup', 100));
  await openFile(page, 'README.md', readmeWindowKey);
  await expect.poll(() => taskbarKeys(page)).toEqual(['call-cleanup', readmeWindowKey]);

  await page.getByTitle('Select session (Ctrl-G)').click();
  await page.getByText('Other Session', { exact: true }).click();

  await expect(page.locator('[data-window-key="call-cleanup"]')).toHaveCount(0);
  await expect(page.locator(`[data-window-key="${readmeWindowKey}"]`)).toHaveCount(0);
  await expect(page.locator('[data-floating-key="call-cleanup"]')).toHaveCount(0);
  await expect(page.locator(`[data-floating-key="${readmeWindowKey}"]`)).toHaveCount(0);
});

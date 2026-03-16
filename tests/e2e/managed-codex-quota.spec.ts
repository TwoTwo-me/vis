import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const VIS_PORT = 30002;
const VIS_ORIGIN = `http://127.0.0.1:${VIS_PORT}`;

let visProcess;

async function startStaticVisServer() {
  visProcess = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIS_PORT: String(VIS_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  visProcess.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  visProcess.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`vis server did not start\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 15000);

    visProcess.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes(`Listening on http://localhost:${VIS_PORT}`)) return;
      clearTimeout(timeout);
      resolve(undefined);
    });

    visProcess.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`vis server exited early (code=${code}, signal=${signal})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });

  await started;
}

async function installManagedBrowserMocks(page) {
  await page.addInitScript(() => {
    class MockPort {
      constructor() {
        this.listeners = [];
        this.onmessage = null;
      }
      start() {}
      close() {}
      addEventListener(type, listener) {
        if (type === 'message') this.listeners.push(listener);
      }
      removeEventListener(type, listener) {
        if (type !== 'message') return;
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
      emit(data) {
        const event = { data };
        if (typeof this.onmessage === 'function') this.onmessage(event);
        this.listeners.forEach((listener) => listener(event));
      }
      postMessage(message) {
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

test('codex quota chip renders ordered windows in the desktop top panel', async ({ page }) => {
  await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'ok',
        stale: false,
        staleMinutes: 0,
        message: 'Codex quota ready',
        windows: {
          fiveHour: { label: '5h', remainingPercent: 65, remainingText: '1h', alert: false },
          sevenDay: { label: '7d', remainingPercent: 60, remainingText: '2d', alert: false },
          tools30Day: { label: '30d', remainingPercent: 45, remainingText: '14d', alert: true },
        },
      }),
      headers: { 'Cache-Control': 'no-store' },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);

  const chip = page.getByTestId('codex-quota-chip');
  await expect(page.getByTitle('GitHub')).toBeVisible();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Codex');
  await expect(page.getByTestId('codex-quota-window-5h')).toContainText('5h 65% 1h');
  await expect(page.getByTestId('codex-quota-window-7d')).toContainText('7d 60% 2d');
  await expect(page.getByTestId('codex-quota-window-30d')).toContainText('30d 45% 14d');
});

test('codex quota chip hides when the route is unavailable', async ({ page }) => {
  await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);

  await expect(page.getByTitle('GitHub')).toBeVisible();
  await expect(page.getByTestId('codex-quota-chip')).toHaveCount(0);
});

test('codex quota chip renders the login fallback state', async ({ page }) => {
  await installManagedBrowserMocks(page);
  await page.context().route('**/api/codex/usage', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'login_required',
        stale: false,
        staleMinutes: 0,
        message: 'Codex login required',
        windows: {
          fiveHour: { label: '5h', remainingPercent: null, remainingText: '?', alert: false },
          sevenDay: { label: '7d', remainingPercent: null, remainingText: '?', alert: false },
          tools30Day: { label: '30d', remainingPercent: null, remainingText: '?', alert: false },
        },
      }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIS_ORIGIN);

  await expect(page.getByTitle('GitHub')).toBeVisible();
  await expect(page.getByTestId('codex-quota-chip')).toContainText('Codex');
  await expect(page.getByTestId('codex-quota-chip')).toContainText('login');
});

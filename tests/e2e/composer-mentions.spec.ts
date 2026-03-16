import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const requestLogPath = resolve(process.cwd(), 'test-results', 'managed-mention-requests.json');

async function readRequestLog() {
  try {
    return JSON.parse(await readFile(requestLogPath, 'utf8')) as Array<{
      method: string;
      pathname: string;
      body: Record<string, unknown> | null;
    }>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return [];
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function waitForPromptAsyncRequest(previousCount: number) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const log = await readRequestLog();
    const promptRequests = log.filter(
      (entry) => entry.method === 'POST' && /\/session\/.*\/prompt_async$/.test(entry.pathname),
    );
    if (promptRequests.length > previousCount) {
      return promptRequests[promptRequests.length - 1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for prompt_async request');
}

async function waitForComposer(page: Page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto('/');
    const textarea = page.locator('textarea.input-textarea');
    const retry = page.getByRole('button', { name: 'Retry' });
    if (await retry.isVisible().catch(() => false)) {
      await retry.click();
      await page.waitForTimeout(1000);
    }
    if (await textarea.isVisible().catch(() => false)) {
      return textarea;
    }
  }
  const textarea = page.locator('textarea.input-textarea');
  await expect(textarea).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(500);
  return textarea;
}

test('composer mention opens grouped popup', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('@');

  await expect(page.getByTestId('composer-mention-popup')).toBeVisible();
  await expect(page.getByTestId('composer-mention-group-agents')).toBeVisible();
  await expect(page.getByTestId('composer-mention-group-files')).toBeVisible();
});

test('composer mention empty state', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('@zzzzzzzz');

  await expect(page.getByTestId('composer-mention-popup')).toBeVisible();
  await expect(page.getByTestId('composer-mention-empty')).toHaveText('No matching agents or files');
});

test('composer mention inserts agent token', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('please ask @bu');
  await expect(page.getByTestId('composer-mention-popup')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(textarea).toHaveValue('please ask @build ');
});

test('composer mention inserts file token', async ({ page }) => {
  const textarea = await waitForComposer(page);

  const reloadTreeButton = page.getByRole('button', { name: 'Reload file tree' });
  if (await reloadTreeButton.isVisible().catch(() => false)) {
    await reloadTreeButton.click();
    await page.waitForTimeout(500);
  }

  await textarea.click();
  await textarea.fill('@App.');
  await expect(page.getByTestId('composer-mention-popup')).toBeVisible();
  await expect(page.getByTestId('composer-mention-option-file-app-App-vue')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(textarea).toHaveValue('@app/App.vue ');
});

test('composer mention escape dismissal', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('@bu');
  await expect(page.getByTestId('composer-mention-popup')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('composer-mention-popup')).toBeHidden();
  await expect(textarea).toHaveValue('@bu');
});

test('composer mention submits raw text body', async ({ page }) => {
  const textarea = await waitForComposer(page);
  const initialLog = await readRequestLog();
  const initialPromptCount = initialLog.filter(
    (entry) => entry.method === 'POST' && /\/session\/.*\/prompt_async$/.test(entry.pathname),
  ).length;

  await textarea.click();
  await textarea.fill('review @plan and @app/App.vue');
  await page.keyboard.press('Control+Enter');

  const request = await waitForPromptAsyncRequest(initialPromptCount);
  expect(request.body).toBeTruthy();
  expect((request.body as { agent?: string }).agent).toBe('build');
  expect((request.body as { parts?: Array<{ type: string; text?: string }> }).parts).toEqual([
    { type: 'text', text: 'review @plan and @app/App.vue' },
  ]);
});

test('composer mention draft restore', async ({ page }) => {
  const textarea = await waitForComposer(page);
  const initialLog = await readRequestLog();
  const initialPromptCount = initialLog.filter(
    (entry) => entry.method === 'POST' && /\/session\/.*\/prompt_async$/.test(entry.pathname),
  ).length;

  await textarea.click();
  await textarea.fill('review @app/App.vue ');
  await page.reload();

  const restoredTextarea = await waitForComposer(page);
  await expect(restoredTextarea).toHaveValue('review @app/App.vue ');
  await page.keyboard.press('Control+Enter');

  const request = await waitForPromptAsyncRequest(initialPromptCount);
  expect((request.body as { parts?: Array<{ type: string; text?: string }> }).parts).toEqual([
    { type: 'text', text: 'review @app/App.vue' },
  ]);
});

test('composer mention resolves ambiguous file', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('@App.vue');

  await expect(page.getByTestId('composer-mention-option-file-app-App-vue')).toBeVisible();
  await expect(page.getByTestId('composer-mention-option-file-app-views-App-vue')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(textarea).toHaveValue('@app/App.vue ');
});

test('composer mention slash coexistence', async ({ page }) => {
  const textarea = await waitForComposer(page);

  await textarea.click();
  await textarea.fill('/deb');

  await expect(page.getByText('/debug')).toBeVisible();
  await expect(page.getByTestId('composer-mention-popup')).toBeHidden();
});

test('composer mention no candidates fallback', async ({ page }) => {
  const textarea = await waitForComposer(page);
  const initialLog = await readRequestLog();
  const initialPromptCount = initialLog.filter(
    (entry) => entry.method === 'POST' && /\/session\/.*\/prompt_async$/.test(entry.pathname),
  ).length;

  await textarea.click();
  await textarea.fill('@zzzzzzzz');
  await expect(page.getByTestId('composer-mention-empty')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(textarea).toHaveValue('@zzzzzzzz');
  await page.waitForTimeout(500);

  const finalLog = await readRequestLog();
  const finalPromptCount = finalLog.filter(
    (entry) => entry.method === 'POST' && /\/session\/.*\/prompt_async$/.test(entry.pathname),
  ).length;
  expect(finalPromptCount).toBe(initialPromptCount);
});

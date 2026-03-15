import { expect, test } from '@playwright/test';

test('managed app loads without connect panel', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/Vis - OpenCode Visualizer/i);
  await expect(page.getByText('Connect to OpenCode Server')).toHaveCount(0);
  await expect(page.locator('input[name="url"]')).toHaveCount(0);
  await expect(page.locator('input[name="username"]')).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

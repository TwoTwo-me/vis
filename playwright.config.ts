import { defineConfig } from '@playwright/test';
import { managedHarnessVisPort } from './tests/managed/testHarness.js';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${managedHarnessVisPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global.setup.ts',
  globalTeardown: './tests/e2e/global.teardown.ts',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  },
});

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  managedHarnessLogPath,
  managedHarnessRequestLogPath,
  managedHarnessStatePath,
  repoRoot,
  stopManagedHarnessFromState,
} from '../managed/testHarness.js';

async function readHarnessLog() {
  try {
    return (await readFile(managedHarnessLogPath, 'utf8')).trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function waitForHarnessState(child: ReturnType<typeof spawn>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  while (Date.now() < deadline) {
    try {
      const rawState = await readFile(managedHarnessStatePath, 'utf8');
      return JSON.parse(rawState);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }

    if (exited) {
      const harnessLog = await readHarnessLog();
      const details = harnessLog ? `\n${harnessLog}` : '';
      throw new Error(
        `managed Playwright harness exited before readiness (code=${exitCode}, signal=${exitSignal})${details}`,
      );
    }

    await delay(100);
  }

  const harnessLog = await readHarnessLog();
  const details = harnessLog ? `\n${harnessLog}` : '';
  throw new Error(`timed out waiting for managed Playwright harness${details}`);
}

async function runBuild() {
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn('pnpm', ['build'], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }

      rejectBuild(new Error(`pnpm build failed (code=${code}, signal=${signal})`));
    });
    child.on('error', rejectBuild);
  });
}

export default async function globalSetup() {
  await stopManagedHarnessFromState();
  await mkdir(dirname(managedHarnessLogPath), { recursive: true });
  await Promise.all([
    rm(managedHarnessStatePath, { force: true }),
    rm(managedHarnessRequestLogPath, { force: true }),
    rm(managedHarnessLogPath, { force: true }),
  ]);

  await runBuild();

  const logFd = openSync(managedHarnessLogPath, 'a');
  const child = spawn(process.execPath, ['tests/managed/testHarness.js', 'playwright-managed-harness'], {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();

  try {
    await waitForHarnessState(child);
  } catch (error) {
    await stopManagedHarnessFromState();
    throw error;
  }
}

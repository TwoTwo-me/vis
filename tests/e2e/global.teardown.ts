import { stopManagedHarnessFromState } from '../managed/testHarness.js';

export default async function globalTeardown() {
  await stopManagedHarnessFromState();
}

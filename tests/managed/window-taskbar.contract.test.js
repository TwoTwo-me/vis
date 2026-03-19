import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRepoFile } from './testHarness.js';

test('window taskbar state model contract keeps tracked entries separate from visible canvas entries', async () => {
  const [floatingWindowsSource, appSource] = await Promise.all([
    readRepoFile('app/composables/useFloatingWindows.ts'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    floatingWindowsSource,
    /export type FloatingWindowTaskbarGroup = 'manual' \| 'auto' \| 'prompt';/,
  );
  assert.match(floatingWindowsSource, /taskbarEligible: boolean;/);
  assert.match(floatingWindowsSource, /taskbarGroup\?: FloatingWindowTaskbarGroup;/);
  assert.match(floatingWindowsSource, /taskbarKind\?: FloatingWindowTaskbarKind;/);
  assert.match(floatingWindowsSource, /minimizable: boolean;/);
  assert.match(floatingWindowsSource, /minimizedByUser: boolean;/);
  assert.match(floatingWindowsSource, /suppressedBySetting: boolean;/);
  assert.match(
    floatingWindowsSource,
    /const entries = computed\(\(\) => \[\.\.\.entriesMap\.values\(\)\]\.filter\(\(e\) => e\.isReady\)\);/,
  );
  assert.match(
    floatingWindowsSource,
    /const canvasEntries = computed\([\s\S]*entries\.value\.filter\(\(entry\) => !entry\.minimizedByUser && !entry\.suppressedBySetting\),[\s\S]*\);/,
  );
  assert.match(floatingWindowsSource, /function minimize\(key: string\): void \{/);
  assert.match(floatingWindowsSource, /function restore\(key: string\): void \{/);
  assert.match(
    floatingWindowsSource,
    /function setSuppressed\(key: string, suppressed: boolean\): void \{/,
  );
  assert.match(floatingWindowsSource, /time: existing\?\.time \?\? Date\.now\(\),/);
  assert.match(appSource, /v-for="entry in fw\.canvasEntries\.value"/);
});

test('window taskbar hidden cleanup still uses the existing close path', async () => {
  const [floatingWindowsSource, appSource] = await Promise.all([
    readRepoFile('app/composables/useFloatingWindows.ts'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(
    floatingWindowsSource,
    /const timerId = setTimeout\(\(\) => \{[\s\S]*timerMap\.delete\(key\);[\s\S]*close\(key\);[\s\S]*\}, delay\);/,
  );
  assert.match(floatingWindowsSource, /entriesMap\.delete\(key\);/);
  assert.match(
    floatingWindowsSource,
    /for \(const key of \[\.\.\.entriesMap\.keys\(\)\]\) \{[\s\S]*close\(key\);[\s\S]*\}/,
  );
  assert.match(
    appSource,
    /watch\(suppressAutoWindows, \(suppressed\) => \{[\s\S]*for \(const entry of fw\.canvasEntries\.value\) \{[\s\S]*fw\.setSuppressed\(entry\.key, true\);[\s\S]*\}\s*\}\);/,
  );
  assert.match(appSource, /fw\.closeAll\(\{ exclude: \(key\) => key\.startsWith\('shell:'\) \}\);/);
});

test('suppressed auto windows are still tracked with hidden taskbar entries', async () => {
  const [appSource, reasoningSource, subagentSource] = await Promise.all([
    readRepoFile('app/App.vue'),
    readRepoFile('app/composables/useReasoningWindows.ts'),
    readRepoFile('app/composables/useSubagentWindows.ts'),
  ]);

  assert.doesNotMatch(appSource, /if \(suppressAutoWindows\.value\) return;/);
  assert.match(
    appSource,
    /openToolPartAsWindow\(part, \{[\s\S]*taskbarEligible: true,[\s\S]*taskbarGroup: 'auto',[\s\S]*taskbarKind: 'tool',[\s\S]*minimizable: true,[\s\S]*suppressedBySetting: suppressAutoWindows\.value,[\s\S]*\}\);/,
  );
  assert.match(
    appSource,
    /return Boolean\(baseSuppressedBySetting\) \|\| Boolean\(fw\.get\(key\)\?\.suppressedBySetting\);/,
  );

  assert.match(reasoningSource, /taskbarEligible: true,/);
  assert.match(reasoningSource, /taskbarGroup: 'auto',/);
  assert.match(reasoningSource, /taskbarKind: 'reasoning',/);
  assert.match(reasoningSource, /minimizable: true,/);
  assert.match(reasoningSource, /suppressedBySetting: shouldSuppress,/);
  assert.match(
    reasoningSource,
    /const shouldSuppress =[\s\S]*Boolean\(suppressAutoWindows\?\.value\) \|\| Boolean\(fw\.get\(windowKey\)\?\.suppressedBySetting\);/,
  );

  assert.match(subagentSource, /taskbarEligible: true,/);
  assert.match(subagentSource, /taskbarGroup: 'auto',/);
  assert.match(subagentSource, /taskbarKind: 'subagent',/);
  assert.match(subagentSource, /minimizable: true,/);
  assert.match(subagentSource, /suppressedBySetting: shouldSuppress,/);
  assert.match(
    subagentSource,
    /const shouldSuppress =[\s\S]*Boolean\(suppressAutoWindows\?\.value\) \|\| Boolean\(fw\.get\(windowKey\)\?\.suppressedBySetting\);/,
  );
});

test('window taskbar ordering selector keeps auto oldest-first before manual oldest-first ordering', async () => {
  const selectorSource = await readRepoFile('app/composables/useWindowTaskbar.ts');

  assert.match(selectorSource, /export function selectWindowTaskbarLayout\(/);
  assert.match(
    selectorSource,
    /entry\) => entry\.taskbarEligible && entry\.taskbarGroup !== 'prompt'/,
  );
  assert.match(selectorSource, /if \(a\.time !== b\.time\) return a\.time - b\.time;/);
  assert.match(selectorSource, /return a\.key\.localeCompare\(b\.key\);/);
  assert.match(selectorSource, /filter\(\(entry\) => entry\.taskbarGroup === 'auto'\)/);
  assert.match(selectorSource, /filter\(\(entry\) => entry\.taskbarGroup !== 'auto'\)/);
  assert.match(selectorSource, /const orderedItems = \[\.\.\.autoItems, \.\.\.manualItems\];/);
  assert.match(selectorSource, /visibleItems: orderedItems,/);
  assert.match(selectorSource, /const visibleItems = orderedItems\.slice\(-visibleCount\);/);
});

test('window taskbar overflow selector only reserves overflow slot when needed', async () => {
  const selectorSource = await readRepoFile('app/composables/useWindowTaskbar.ts');

  assert.match(selectorSource, /const slotCount = toSlotCount\(availableWidth\);/);
  assert.match(selectorSource, /if \(orderedItems\.length <= slotCount\) \{/);
  assert.match(selectorSource, /overflowItems: \[],/);
  assert.match(selectorSource, /if \(slotCount <= 1\) \{/);
  assert.match(selectorSource, /visibleItems: \[],/);
  assert.match(selectorSource, /overflowItems: orderedItems,/);
  assert.match(selectorSource, /const visibleCount = Math\.max\(0, slotCount - 1\);/);
  assert.match(
    selectorSource,
    /const overflowItems = orderedItems\.slice\(0, orderedItems\.length - visibleCount\);/,
  );
});

test('manual callsites set explicit taskbar metadata for manual viewer windows', async () => {
  const appSource = await readRepoFile('app/App.vue');

  assert.match(
    appSource,
    /function ensureShellWindow\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'shell',/,
  );
  assert.match(
    appSource,
    /function openDebugSessionViewer\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'debug',/,
  );
  assert.match(
    appSource,
    /function openDebugNotificationViewer\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'debug',/,
  );
  assert.match(
    appSource,
    /async function openGitDiff\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'diff',/,
  );
  assert.match(
    appSource,
    /async function openAllGitDiff\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'diff',/,
  );
  assert.match(
    appSource,
    /function handleShowMessageDiff\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'diff',/,
  );
  assert.match(
    appSource,
    /async function handleShowCommit\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'diff',/,
  );
  assert.match(
    appSource,
    /function handleOpenHistoryTool\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'tool-history',/,
  );
  assert.match(
    appSource,
    /function handleOpenHistoryReasoning\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'history',/,
  );
  assert.match(
    appSource,
    /function handleShowThreadHistory\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'history',/,
  );
  assert.match(
    appSource,
    /function handleOpenImage\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'image',/,
  );
  assert.match(
    appSource,
    /async function openFileViewer\([\s\S]*?taskbarEligible: true,[\s\S]*?taskbarGroup: 'manual',[\s\S]*?taskbarKind: 'file',/,
  );
});

test('prompt exclusion keeps permission and question windows outside manual taskbar contract', async () => {
  const [permissionsSource, questionsSource] = await Promise.all([
    readRepoFile('app/composables/usePermissions.ts'),
    readRepoFile('app/composables/useQuestions.ts'),
  ]);

  assert.match(
    permissionsSource,
    /options\.fw\.open\(key, \{[\s\S]*?closable: false,[\s\S]*?expiry: Infinity,[\s\S]*?\}\);/,
  );
  assert.match(
    questionsSource,
    /options\.fw\.open\(key, \{[\s\S]*?closable: false,[\s\S]*?expiry: Infinity,[\s\S]*?\}\);/,
  );
  assert.doesNotMatch(permissionsSource, /taskbarEligible:\s*true/);
  assert.doesNotMatch(questionsSource, /taskbarEligible:\s*true/);
  assert.doesNotMatch(permissionsSource, /taskbarGroup:\s*'manual'/);
  assert.doesNotMatch(questionsSource, /taskbarGroup:\s*'manual'/);
});

test('window taskbar minimize and restore semantics keep close behavior distinct', async () => {
  const [floatingWindowSource, appSource] = await Promise.all([
    readRepoFile('app/components/FloatingWindow.vue'),
    readRepoFile('app/App.vue'),
  ]);

  assert.match(floatingWindowSource, /minimize: \[key: string\];/);
  assert.match(floatingWindowSource, /function onMinimize\(\) \{/);
  assert.match(floatingWindowSource, /emit\('minimize', props\.entry\.key\);/);
  assert.match(floatingWindowSource, /v-if="entry\.minimizable"/);
  assert.match(floatingWindowSource, /data-testid="floating-window-minimize"/);
  assert.match(floatingWindowSource, /closest\('\.titlebar-action-btn'\)/);

  assert.match(appSource, /@minimize="handleFloatingWindowMinimize\(entry\.key\)"/);
  assert.match(appSource, /function handleFloatingWindowMinimize\(key: string\) \{\s*fw\.minimize\(key\);\s*\}/);
  assert.match(
    appSource,
    /function restoreTaskbarWindow\(key: string\) \{[\s\S]*fw\.restore\(key\);[\s\S]*fw\.bringToFront\(key\);[\s\S]*focusFloatingWindowBody\(key\);[\s\S]*\}/,
  );
  assert.match(
    appSource,
    /function handleFloatingWindowClose\(key: string\) \{[\s\S]*if \(key\.startsWith\('shell:'\)\) \{[\s\S]*removeShellWindow\(ptyId, \{ kill: true \}\);[\s\S]*\}[\s\S]*void fw\.close\(key\);[\s\S]*\}/,
  );
  assert.match(appSource, /if \(fw\.has\(key\)\) \{[\s\S]*restoreTaskbarWindow\(key\);[\s\S]*return;[\s\S]*\}/);
});

test('window taskbar UI exposes stable selectors and key hooks for strip, overflow, and minimize flows', async () => {
  const [taskbarSource, floatingWindowSource] = await Promise.all([
    readRepoFile('app/components/WindowTaskbar.vue'),
    readRepoFile('app/components/FloatingWindow.vue'),
  ]);

  assert.match(taskbarSource, /data-testid="window-taskbar"/);
  assert.match(taskbarSource, /data-testid="window-taskbar-item"/);
  assert.match(taskbarSource, /data-testid="window-taskbar-overflow"/);
  assert.match(taskbarSource, /popup-class="window-taskbar-overflow-popup"/);
  assert.match(taskbarSource, /data-testid="window-taskbar-overflow-menu"/);
  assert.match(taskbarSource, /data-testid="window-taskbar-overflow-item"/);
  assert.match(
    taskbarSource,
    /data-testid="window-taskbar-overflow-item"[\s\S]*:title="taskbarTooltip\(entry\)"/,
  );
  assert.match(taskbarSource, /:data-window-key="entry\.key"/);
  assert.match(taskbarSource, /v-for="entry in visibleItems"/);
  assert.match(taskbarSource, /v-for="entry in overflowItems"/);
  assert.match(taskbarSource, /--taskbar-size: 26px;/);
  assert.match(taskbarSource, /--taskbar-gap: 6px;/);
  assert.match(taskbarSource, /case 'shell':[\s\S]*return 'lucide:terminal';/);
  assert.match(taskbarSource, /case 'diff':[\s\S]*return 'lucide:git-compare';/);
  assert.match(taskbarSource, /case 'tool-history':[\s\S]*return 'lucide:wrench';/);
  assert.match(floatingWindowSource, /data-testid="floating-window-minimize"/);
});

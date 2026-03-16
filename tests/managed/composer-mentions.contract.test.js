import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRepoFile } from './testHarness.js';

test('mention contract foundation', async () => {
  const source = await readRepoFile('app/utils/composerMentions.ts');

  assert.match(source, /export type ActiveMention = \{/);
  assert.match(source, /export function extractActiveMention\(text: string, caret: number\): ActiveMention \| null \{/);
  assert.match(source, /export function rankAgentMentionCandidates\(agentOptions: Array<\{ id: string \}>, query: string\) \{/);
  assert.match(source, /export function rankFileMentionCandidates\(files: string\[], query: string\) \{/);
  assert.match(source, /export function buildMentionReplacement\(kind: 'agent' \| 'file', value: string\) \{/);
  assert.match(source, /export function shouldUseFileOnlyMode\(query: string\) \{/);
  assert.match(source, /return `@\$\{value\} `;/);
});

test('mention ranking rules', async () => {
  const source = await readRepoFile('app/utils/composerMentions.ts');

  assert.match(source, /if \(normalizedValue === normalizedQuery\) return 0;/);
  assert.match(source, /if \(normalizedValue\.startsWith\(normalizedQuery\)\) return 1;/);
  assert.match(source, /if \(normalizedValue\.includes\(normalizedQuery\)\) return 2;/);
  assert.match(source, /\.slice\(0, 10\);/);
  assert.match(source, /return query\.includes\('\/'\) \|\| query\.includes\('\.'\);/);
  assert.match(source, /function readSegmentEnd\(text: string, caret: number\)/);
  assert.match(source, /const end = readSegmentEnd\(text, safeCaret\);/);
});

test('mention whitespace paths', async () => {
  const source = await readRepoFile('app/utils/composerMentions.ts');

  assert.match(source, /files\.filter\(\(path\) => !\/\\s\/\.test\(path\)\)/);
  assert.ok(
    source.includes('return sortByMatch('),
    'file ranking should still run through the shared matcher after whitespace filtering',
  );
});

test('app passes mention candidates', async () => {
  const [appSource, inputPanelSource, fileTreeSource] = await Promise.all([
    readRepoFile('app/App.vue'),
    readRepoFile('app/components/InputPanel.vue'),
    readRepoFile('app/composables/useFileTree.ts'),
  ]);

  assert.match(fileTreeSource, /files,/);
  assert.match(fileTreeSource, /fileCacheVersion,/);
  assert.match(appSource, /const \{[\s\S]*files,[\s\S]*fileCacheVersion,[\s\S]*\} = useFileTree\(\{ activeDirectory \}\);/);
  assert.match(appSource, /:file-candidates="files"/);
  assert.match(appSource, /:file-candidates-version="fileCacheVersion"/);
  assert.match(inputPanelSource, /fileCandidates: string\[];/);
  assert.match(inputPanelSource, /fileCandidatesVersion: number;/);
});

test('mention popup markup', async () => {
  const inputPanelSource = await readRepoFile('app/components/InputPanel.vue');

  assert.match(inputPanelSource, /data-testid="composer-mention-popup"/);
  assert.match(inputPanelSource, /data-testid="composer-mention-group-agents"/);
  assert.match(inputPanelSource, /data-testid="composer-mention-group-files"/);
  assert.match(inputPanelSource, /data-testid="composer-mention-empty"/);
  assert.match(inputPanelSource, /No matching agents or files/);
  assert.match(inputPanelSource, /composer-mention-option-\$\{kind\}-\$\{value\.replace/);
});

test('send path stays raw text', async () => {
  const appSource = await readRepoFile('app/App.vue');

  assert.match(appSource, /const parts = \[] as Array<Record<string, unknown>>;/);
  assert.match(appSource, /if \(hasText\) parts\.push\(\{ type: 'text', text \}\);/);
  assert.match(appSource, /parts\.push\([\s\S]*type: 'file',[\s\S]*mime: item\.mime,[\s\S]*url: item\.dataUrl,[\s\S]*filename: item\.filename,[\s\S]*\)/);
  assert.match(appSource, /await opencodeApi\.sendPromptAsync\(sessionId, \{[\s\S]*agent: selectedMode\.value,[\s\S]*parts,[\s\S]*\}\);/);
  assert.doesNotMatch(appSource, /type: 'agent'/);
});

test('mention suggestion cap stays at ten total', async () => {
  const inputPanelSource = await readRepoFile('app/components/InputPanel.vue');

  assert.match(
    inputPanelSource,
    /const limit = mentionFileOnlyMode\.value \? 10 : Math\.max\(0, 10 - mentionAgentOptions\.value\.length\);/,
  );
  assert.match(
    inputPanelSource,
    /rankFileMentionCandidates\(mentionFileCandidates\.value, mention\.query\)\s*\.slice\(0, limit\)/s,
  );
});

<script setup lang="ts">
import { computed } from 'vue';
import CodeContent from '../CodeContent.vue';
import { useCodeRender } from '../../utils/useCodeRender';
import { guessLanguageFromPath } from './utils';

const props = defineProps<{
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  toolName?: string;
  diff?: string;
  code?: string;
  after?: string;
  index?: number;
  total?: number;
}>();

const displayContent = computed(() => {
  return props.diff ?? (typeof props.metadata?.diff === 'string' ? props.metadata.diff : '');
});

const isDiff = computed(() => {
  const c = displayContent.value;
  if (!c) return false;
  return c.includes('diff --git') || (c.includes('---') && c.includes('+++')) || /^@@\s+-\d/.m.test(c);
});

const filePath = computed(() => {
  const input = props.input;
  if (typeof input?.filePath === 'string') return input.filePath;
  if (typeof input?.path === 'string') return input.path;
  return undefined;
});

const lang = computed(() => guessLanguageFromPath(filePath.value));

const { html: renderedHtml } = useCodeRender(() => {
  const content = displayContent.value;
  if (!content) return { code: '', lang: 'text', theme: 'github-dark', gutterMode: 'none' as const };
  if (isDiff.value) {
    // Use patch-based rendering for proper colorized diff.
    // When before (code) and after are available, Shiki can apply full
    // language-aware syntax highlighting instead of falling back to
    // reconstructed stubs that lose context (e.g. Vue <script> blocks).
    return {
      code: props.code ?? '',
      after: props.after,
      patch: content,
      lang: lang.value,
      theme: 'github-dark',
      gutterMode: 'double' as const,
    };
  }
  return { code: content, lang: 'text', theme: 'github-dark', gutterMode: 'single' as const };
});
</script>

<template>
  <CodeContent :html="renderedHtml" :variant="isDiff ? 'diff' : 'code'" />
</template>

<template>
  <div v-if="state.html" class="message-viewer min-h-[1.2em] leading-[inherit] text-[inherit]">
    <div class="message-content leading-[inherit] text-[inherit]" v-html="state.html"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, toRaw, watch } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

const props = defineProps<{
  code: string;
  lang: string;
  theme: string;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const state = reactive({
  isLoading: true,
  html: '',
  error: '',
  requestId: 0,
});

async function startRender() {
  const nextId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const hasPreviousHtml = state.html.length > 0;
  state.requestId += 1;
  const current = state.requestId;
  state.isLoading = !hasPreviousHtml;
  if (!hasPreviousHtml) state.error = '';
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderWorkerHtml({
    id: nextId,
    code: props.code,
    lang: props.lang,
    theme: props.theme,
    gutterMode: 'none',
  })
    .then((html) => {
      if (current !== state.requestId) return;
      state.html = html;
      state.error = '';
      state.isLoading = false;
      emit('rendered');
    })
    .catch((error) => {
      if (current !== state.requestId) return;
      if (!state.html) {
        state.error = error instanceof Error ? error.message : 'Render failed';
      }
      state.isLoading = false;
      emit('rendered');
    });
}

watch(
  () => [
    props.code,
    props.lang,
    props.theme,
  ],
  startRender,
  { immediate: true },
);

onBeforeUnmount(() => {
  state.requestId += 1;
});
</script>

<style scoped>
.message-content :deep(pre),
.message-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.message-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.message-content :deep(code) {
  display: grid;
  grid-template-columns: 1fr;
  column-gap: 0;
}

.message-content :deep(.code-row) {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: start;
}

.message-content :deep(.code-gutter) {
  display: none;
}

.message-content :deep(.line) {
  display: block;
  min-height: 1em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  box-sizing: border-box;
}

.message-content :deep(.line:empty)::after {
  content: ' ';
}

.message-content :deep(.grep-match) {
  color: #fef08a;
  background: rgba(234, 179, 8, 0.3);
  border-radius: 2px;
  padding: 0 0.08em;
  font-weight: 700;
}

.message-content :deep(.grep-match strong) {
  font-weight: inherit;
}

/* markdown-it rendered content — match shiki line density */
.message-content :deep(.markdown-host) {
  line-height: 1.15;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.message-content :deep(.markdown-host ul),
.message-content :deep(.markdown-host ol),
.message-content :deep(.markdown-host li),
.message-content :deep(.markdown-host blockquote),
.message-content :deep(.markdown-host p),
.message-content :deep(.markdown-host h1),
.message-content :deep(.markdown-host h2),
.message-content :deep(.markdown-host h3),
.message-content :deep(.markdown-host h4),
.message-content :deep(.markdown-host h5),
.message-content :deep(.markdown-host h6) {
  margin: 0.5em 0;
  padding: 0;
  font-weight: 600;
  color: #e2e8f0;
}

.message-content :deep(.markdown-host h1) { font-size: 1.4em; }
.message-content :deep(.markdown-host h2) { font-size: 1.25em; }
.message-content :deep(.markdown-host h3) { font-size: 1.1em; }
.message-content :deep(.markdown-host h4) { font-size: 1em; }

.message-content :deep(.markdown-host a) {
  color: #60a5fa;
  text-decoration: underline;
  text-decoration-color: rgba(96, 165, 250, 0.4);
  text-underline-offset: 2px;
}

.message-content :deep(.markdown-host a:hover) {
  text-decoration-color: #60a5fa;
}

.message-content :deep(.markdown-host ul),
.message-content :deep(.markdown-host ol) {
  margin: 0.4em 0;
  padding-left: 1.6em;
}

.message-content :deep(.markdown-host li) {
  margin: 0.15em 0;
}

.message-content :deep(.markdown-host li > p) {
  margin: 0.2em 0;
}

.message-content :deep(.markdown-host blockquote) {
  margin: 0.5em 0;
  padding: 0.2em 0.8em;
  border-left: 3px solid #64748b;
  color: #94a3b8;
  font-style: italic;
}

.message-content :deep(.markdown-host table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  width: auto;
  max-width: 100%;
  overflow-x: auto;
  display: block;
  font-size: 0.95em;
}

.message-content :deep(.markdown-host th),
.message-content :deep(.markdown-host td) {
  border: 1px solid #334155;
  padding: 0.35em 0.7em;
  text-align: left;
}

.message-content :deep(.markdown-host th) {
  background: rgba(51, 65, 85, 0.4);
  font-weight: 600;
  color: #e2e8f0;
}

.message-content :deep(.markdown-host tr:nth-child(even)) {
  background: rgba(51, 65, 85, 0.15);
}

.message-content :deep(.markdown-host hr) {
  border: none;
  border-top: 1px solid #334155;
  margin: 0.8em 0;
}

.message-content :deep(.markdown-host code) {
  display: inline;
  background: rgba(51, 65, 85, 0.5);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: 0.9em;
}

.message-content :deep(.markdown-host pre) {
  margin: 0.5em 0;
  padding: 0.6em 0.8em;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre;
}

.message-content :deep(.markdown-host pre code) {
  display: block;
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
  white-space: pre;
}

.message-content :deep(.markdown-host img) {
  max-width: 100%;
  height: auto;
}

.message-content :deep(.markdown-host strong) {
  font-weight: 600;
  color: #e2e8f0;
}

.message-content :deep(.markdown-host em) {
  font-style: italic;
}
</style>

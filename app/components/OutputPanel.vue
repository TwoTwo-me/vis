<template>
  <div class="output-panel-root">
    <div
      class="output-panel-shell"
    >
      <div
        ref="panelEl"
        class="output-panel-scroll"
        @scroll="$emit('scroll')"
        @wheel="$emit('wheel', $event)"
        @touchmove="$emit('touchmove')"
      >
      <div
        v-for="q in queue.filter((entry) => entry.isMessage && !entry.isSubagentMessage)"
        :key="q.messageId ?? q.time"
        class="output-entry"
        :class="{
          'is-user': q.role === 'user',
          'is-user-build': q.role === 'user' && getAgentTone(q) === 'build',
          'is-user-plan': q.role === 'user' && getAgentTone(q) === 'plan',
          'is-user-neutral': q.role === 'user' && getAgentTone(q) === 'neutral',
        }"
      >
          <div
            v-if="q.role === 'user' && q.messageId && q.sessionId"
            class="output-entry-actions"
          >
            <button type="button" class="output-entry-action" @click="confirmFork(q)">fork</button>
            <button
              type="button"
              class="output-entry-action output-entry-action-danger"
              @click="confirmRevert(q)"
            >
              revert
            </button>
          </div>
          <div
            v-if="q.role === 'user' && formatMessageAgent(q)"
            class="output-entry-agent"
          >
            {{ formatMessageAgent(q) }}
          </div>
          <div
            class="output-entry-inner"
            :class="{ 'is-scrolling': q.scroll }"
            :style="{
              '--scroll-distance': `${q.scrollDistance}px`,
              '--scroll-duration': `${q.scrollDuration}s`,
            }"
          >
            <div class="shiki-host is-message" v-html="q.html"></div>
            <div v-if="q.attachments && q.attachments.length > 0" class="output-entry-attachments">
              <img
                v-for="item in q.attachments"
                :key="item.id"
                class="output-entry-attachment"
                :src="item.url"
                :alt="item.filename"
                loading="lazy"
              />
            </div>
          </div>
          <div
            v-if="formatMessageMeta(q)"
            class="output-entry-meta"
          >
            {{ formatMessageMeta(q) }}
          </div>
        </div>
        <button
          v-show="!isFollowing"
          type="button"
          class="follow-button"
          aria-label="Scroll to latest"
          @click="$emit('resume-follow')"
        >
          ↓
        </button>
      </div>
      <div class="statusbar" role="status" aria-live="polite">
        <div class="statusbar-section statusbar-left">
          <span class="statusbar-text">{{ isThinking ? `Thinking${thinkingSuffix}` : 'Idle' }}</span>
        </div>
        <div class="statusbar-section statusbar-right" :class="{ 'is-error': isStatusError, 'is-retry': isRetryStatus }">
          {{ statusText }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
type FileReadEntry = {
  time: number;
  expiresAt: number;
  x: number;
  y: number;
  header: string;
  content: string;
  scroll: boolean;
  scrollDistance: number;
  scrollDuration: number;
  html: string;
  attachments?: Array<{ id: string; url: string; mime: string; filename: string }>;
  isWrite: boolean;
  isMessage: boolean;
  isSubagentMessage?: boolean;
  sessionId?: string;
  role?: 'user' | 'assistant';
  messageAgent?: string;
  messageModel?: string;
  messageVariant?: string;
  messageTime?: number;
  toolStatus?: string;
  toolName?: string;
  messageId?: string;
  callId?: string;
};

const props = defineProps<{
  queue: FileReadEntry[];
  isFollowing: boolean;
  statusText: string;
  isStatusError: boolean;
  isThinking: boolean;
  isRetryStatus?: boolean;
}>();

const emit = defineEmits<{
  (event: 'scroll'): void;
  (event: 'wheel', eventArg: WheelEvent): void;
  (event: 'touchmove'): void;
  (event: 'resume-follow'): void;
  (event: 'fork-message', payload: { sessionId: string; messageId: string }): void;
  (event: 'revert-message', payload: { sessionId: string; messageId: string }): void;
}>();

const panelEl = ref<HTMLDivElement | null>(null);
const thinkingFrames = ['', '.', '..', '...'];
const thinkingIndex = ref(0);
const thinkingSuffix = ref('');
let thinkingTimer: number | undefined;

function confirmFork(entry: FileReadEntry) {
  if (!entry.sessionId || !entry.messageId || entry.role !== 'user') return;
  if (!window.confirm('Fork from this message?')) return;
  emit('fork-message', { sessionId: entry.sessionId, messageId: entry.messageId });
}

function confirmRevert(entry: FileReadEntry) {
  if (!entry.sessionId || !entry.messageId || entry.role !== 'user') return;
  if (!window.confirm('Revert to this message?')) return;
  emit('revert-message', { sessionId: entry.sessionId, messageId: entry.messageId });
}

function formatMessageMeta(entry: FileReadEntry) {
  const model = entry.messageModel?.trim();
  const variant = entry.messageVariant?.trim();
  const baseParts: string[] = [];
  if (model) baseParts.push(model);
  if (variant) baseParts.push(`(${variant})`);
  const base = baseParts.join(' ');
  const timestamp = formatMessageTime(entry.messageTime);
  return [base, timestamp].filter((part) => part).join(' • ');
}

function formatMessageAgent(entry: FileReadEntry) {
  const agent = entry.messageAgent?.trim();
  if (!agent) return '';
  return `[${agent.toUpperCase()}]`;
}

function getAgentTone(entry: FileReadEntry) {
  const agent = entry.messageAgent?.trim().toLowerCase() ?? '';
  if (agent === 'build') return 'build';
  if (agent === 'plan') return 'plan';
  return 'neutral';
}

function formatMessageTime(value?: number) {
  if (typeof value !== 'number') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

watch(
  () => props.isThinking,
  (active) => {
    if (!active) {
      if (thinkingTimer !== undefined) {
        window.clearInterval(thinkingTimer);
        thinkingTimer = undefined;
      }
      thinkingIndex.value = 0;
      thinkingSuffix.value = '';
      return;
    }
    thinkingIndex.value = 0;
    thinkingSuffix.value = thinkingFrames[thinkingIndex.value] ?? '';
    if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
    thinkingTimer = window.setInterval(() => {
      thinkingIndex.value = (thinkingIndex.value + 1) % thinkingFrames.length;
      thinkingSuffix.value = thinkingFrames[thinkingIndex.value] ?? '';
    }, 350);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (thinkingTimer !== undefined) window.clearInterval(thinkingTimer);
});

defineExpose({ panelEl });
</script>

<style scoped>
.output-panel-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.output-panel-shell {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
}

.output-panel-scroll {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.output-entry {
  position: relative;
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 10px 10px;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
}

.output-entry.is-user {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(148, 163, 184, 0.55);
  padding-top: 18px;
  padding-bottom: 18px;
}

.output-entry.is-user-build {
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(59, 130, 246, 0.6);
}

.output-entry.is-user-plan {
  background: rgba(124, 58, 237, 0.2);
  border-color: rgba(168, 85, 247, 0.62);
}

.output-entry.is-user-neutral {
  background: rgba(15, 23, 42, 0.72);
  border-color: rgba(148, 163, 184, 0.55);
}

.output-entry-inner {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  --message-line-height: 1.2;
  line-height: var(--message-line-height);
}

.output-entry-agent {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 10px;
  color: rgba(191, 219, 254, 0.9);
}

.output-entry-actions {
  position: absolute;
  top: 6px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.output-entry-action {
  border: 1px solid rgba(148, 163, 184, 0.65);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.75);
  color: #bfdbfe;
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
}

.output-entry-action:hover {
  background: rgba(30, 41, 59, 0.92);
}

.output-entry-action-danger {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(127, 29, 29, 0.35);
  color: #fecaca;
}

.output-entry-action-danger:hover {
  background: rgba(153, 27, 27, 0.5);
}

.output-entry-meta {
  position: absolute;
  bottom: 6px;
  right: 10px;
  font-size: 10px;
  color: rgba(191, 219, 254, 0.9);
}

.output-panel-shell .shiki-host {
  color: inherit;
  line-height: var(--message-line-height);
}

.output-panel-shell .shiki-host :deep(pre) {
  color: inherit;
  white-space: normal;
}

.output-panel-shell .shiki-host :deep(code) {
  color: inherit;
  white-space: normal;
  line-height: 0 !important;
}

.output-panel-shell .shiki-host :deep(pre.shiki) {
  line-height: 0 !important;
}

.output-panel-shell .shiki-host :deep(.line),
.output-panel-shell .shiki-host :deep(.line)::before {
  line-height: var(--message-line-height) !important;
  color: inherit;
}

.output-panel-shell .shiki-host :deep(.line) {
  white-space: pre-wrap;
  word-break: break-word;
}


.output-entry-attachments {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.output-entry-attachment {
  width: 100%;
  max-height: 180px;
  border-radius: 8px;
  border: 1px solid #1e293b;
  object-fit: cover;
  background: #0b1320;
}

.output-panel-shell .shiki-host :deep(.line:empty)::after {
  content: ' ';
}

.output-entry-inner.is-scrolling {
  animation: scroll-down var(--scroll-duration) linear forwards;
}

.output-panel-shell .output-entry-inner.is-scrolling {
  animation: none;
}

.follow-button {
  position: sticky;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid #334155;
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  font-size: 18px;
  line-height: 1;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.45);
  cursor: pointer;
  align-self: center;
  margin-top: 4px;
  z-index: 2;
}

.statusbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 12px;
  border-top: none;
  background: transparent;
  color: #94a3b8;
  font-size: 8pt;
  line-height: 1.2;
  margin: 0;
  border-radius: 0;
  box-sizing: border-box;
  z-index: 2;
}

.statusbar-section {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.statusbar-right {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.statusbar-right.is-error,
.statusbar-right.is-retry {
  color: #fecaca;
}

.follow-button:hover {
  background: rgba(30, 41, 59, 0.98);
}


.shiki-host :deep(pre),
.shiki-host :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
}

.shiki-host :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.shiki-host :deep(pre.shiki span) {
  background-color: transparent !important;
}

.shiki-host :deep(.line),
.shiki-host :deep(.line)::before {
  line-height: inherit !important;
}

.shiki-host.is-message :deep(pre),
.shiki-host.is-message :deep(code) {
  white-space: pre-wrap;
  word-break: break-word;
}

.shiki-host :deep(pre) {
  counter-reset: shiki-line;
}

.shiki-host :deep(.line) {
  display: block;
  padding-left: 0;
  position: relative;
}

.shiki-host.is-message :deep(.line)::before {
  content: '';
}
</style>

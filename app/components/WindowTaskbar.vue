<template>
  <div
    ref="rootEl"
    class="window-taskbar"
    :class="{ 'has-items': itemCount > 0 }"
    :data-slot-count="slotCount"
    data-testid="window-taskbar"
  >
    <div class="window-taskbar-track">
      <Dropdown
        v-if="overflowItems.length > 0"
        v-model:open="overflowOpen"
        auto-close
        popup-class="window-taskbar-overflow-popup"
        @select="handleOverflowSelect"
      >
        <template #trigger>
          <button
            type="button"
            class="window-taskbar-button window-taskbar-overflow-button"
            title="More windows"
            aria-haspopup="listbox"
            :aria-expanded="overflowOpen"
            data-testid="window-taskbar-overflow"
            @click.stop="overflowOpen = !overflowOpen"
          >
            <span aria-hidden="true">...</span>
          </button>
        </template>
        <template #default>
          <div class="window-taskbar-overflow-list" data-testid="window-taskbar-overflow-menu">
            <DropdownItem v-for="entry in overflowItems" :key="entry.key" :value="entry.key">
              <div
                class="window-taskbar-overflow-row"
                :class="{ 'is-muted': isMuted(entry) }"
                :data-taskbar-kind="entry.taskbarKind ?? 'unknown'"
                :data-taskbar-state="taskbarState(entry)"
                :data-window-key="entry.key"
                data-testid="window-taskbar-overflow-item"
                :title="taskbarTooltip(entry)"
              >
                <Icon
                  class="window-taskbar-overflow-icon"
                  :icon="taskbarIcon(entry.taskbarKind)"
                  :width="14"
                  :height="14"
                />
                <span class="window-taskbar-overflow-label">{{ taskbarLabel(entry) }}</span>
                <span class="window-taskbar-overflow-state">{{ taskbarStateLabel(entry) }}</span>
              </div>
            </DropdownItem>
          </div>
        </template>
      </Dropdown>
      <button
        v-for="entry in visibleItems"
        :key="entry.key"
        type="button"
        class="window-taskbar-button"
        :class="{ 'is-muted': isMuted(entry) }"
        :title="taskbarTooltip(entry)"
        :data-taskbar-kind="entry.taskbarKind ?? 'unknown'"
        :data-taskbar-state="taskbarState(entry)"
        :data-window-key="entry.key"
        data-testid="window-taskbar-item"
        @click="emit('activate', entry.key)"
      >
        <Icon :icon="taskbarIcon(entry.taskbarKind)" :width="14" :height="14" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef } from 'vue';
import { Icon } from '@iconify/vue';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import { useWindowTaskbar } from '../composables/useWindowTaskbar';
import type {
  FloatingWindowEntry,
  FloatingWindowTaskbarKind,
} from '../composables/useFloatingWindows';

const props = defineProps<{
  entries: readonly FloatingWindowEntry[];
}>();

const emit = defineEmits<{
  (event: 'activate', key: string): void;
}>();

const rootEl = ref<HTMLElement | null>(null);
const availableWidth = ref(0);
const overflowOpen = ref(false);

const { visibleItems, overflowItems, slotCount } = useWindowTaskbar(
  toRef(props, 'entries'),
  availableWidth,
);

const itemCount = computed(() => visibleItems.value.length + overflowItems.value.length);

let resizeObserver: ResizeObserver | null = null;

function updateAvailableWidth() {
  availableWidth.value = rootEl.value?.clientWidth ?? 0;
}

function isMuted(entry: FloatingWindowEntry) {
  return entry.minimizedByUser || entry.suppressedBySetting;
}

function taskbarState(entry: FloatingWindowEntry) {
  if (entry.minimizedByUser) return 'minimized';
  if (entry.suppressedBySetting) return 'suppressed';
  return 'visible';
}

function taskbarStateLabel(entry: FloatingWindowEntry) {
  return taskbarState(entry) === 'visible' ? 'open' : taskbarState(entry);
}

function taskbarIcon(kind?: FloatingWindowTaskbarKind) {
  switch (kind) {
    case 'shell':
      return 'lucide:terminal';
    case 'file':
      return 'lucide:file-text';
    case 'image':
      return 'lucide:image';
    case 'diff':
      return 'lucide:git-compare';
    case 'history':
      return 'lucide:history';
    case 'debug':
      return 'lucide:bug';
    case 'tool-history':
      return 'lucide:wrench';
    case 'tool':
      return 'lucide:wrench';
    case 'reasoning':
      return 'lucide:brain';
    case 'subagent':
      return 'lucide:bot';
    default:
      return 'lucide:square';
  }
}

function fallbackLabel(kind?: FloatingWindowTaskbarKind) {
  switch (kind) {
    case 'shell':
      return 'Shell';
    case 'file':
      return 'File';
    case 'image':
      return 'Image';
    case 'diff':
      return 'Diff';
    case 'history':
      return 'History';
    case 'debug':
      return 'Debug';
    case 'tool-history':
      return 'Tool history';
    case 'tool':
      return 'Tool';
    case 'reasoning':
      return 'Reasoning';
    case 'subagent':
      return 'Subagent';
    default:
      return 'Window';
  }
}

function taskbarLabel(entry: FloatingWindowEntry) {
  const title = entry.title?.trim();
  return title || fallbackLabel(entry.taskbarKind);
}

function taskbarTooltip(entry: FloatingWindowEntry) {
  const stateLabel = taskbarStateLabel(entry);
  return `${taskbarLabel(entry)} (${stateLabel})`;
}

function handleOverflowSelect(value: unknown) {
  if (typeof value !== 'string') return;
  emit('activate', value);
}

onMounted(() => {
  updateAvailableWidth();
  resizeObserver = new ResizeObserver(() => updateAvailableWidth());
  if (rootEl.value) resizeObserver.observe(rootEl.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<style scoped>
.window-taskbar {
  --taskbar-size: 26px;
  --taskbar-gap: 6px;
  --taskbar-border: rgba(71, 85, 105, 0.7);
  --taskbar-border-active: rgba(96, 165, 250, 0.45);
  --taskbar-bg: rgba(15, 23, 42, 0.62);
  --taskbar-bg-active: rgba(30, 41, 59, 0.86);
  --taskbar-bg-muted: rgba(15, 23, 42, 0.28);
  --taskbar-fg: #cbd5e1;
  --taskbar-fg-muted: #64748b;
  min-width: 0;
  flex: 0 1 0;
  width: 0;
  overflow: hidden;
}

.window-taskbar.has-items {
  flex: 1 1 auto;
  width: auto;
  min-width: 32px;
}

.window-taskbar-track {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--taskbar-gap);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.window-taskbar-button {
  width: var(--taskbar-size);
  height: var(--taskbar-size);
  min-width: var(--taskbar-size);
  border: 1px solid var(--taskbar-border-active);
  border-radius: 8px;
  background: var(--taskbar-bg-active);
  color: var(--taskbar-fg);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s,
    opacity 0.15s;
}

.window-taskbar-button:hover {
  background: rgba(30, 64, 175, 0.25);
  color: #e2e8f0;
}

.window-taskbar-button.is-muted {
  border-color: var(--taskbar-border);
  background: var(--taskbar-bg-muted);
  color: var(--taskbar-fg-muted);
}

.window-taskbar-button.is-muted:hover {
  background: var(--taskbar-bg);
  color: #94a3b8;
}

.window-taskbar-overflow-button {
  border-style: dashed;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.window-taskbar-overflow-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.window-taskbar-overflow-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.window-taskbar-overflow-row.is-muted {
  color: #94a3b8;
}

.window-taskbar-overflow-icon {
  flex: 0 0 auto;
}

.window-taskbar-overflow-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.window-taskbar-overflow-state {
  flex: 0 0 auto;
  color: #64748b;
  font-size: 10px;
  text-transform: lowercase;
}

:deep(.window-taskbar-overflow-popup) {
  top: auto;
  bottom: anchor(top);
  margin-top: 0;
  margin-bottom: 6px;
  min-width: 220px;
  max-width: min(320px, 80vw);
  max-height: 50vh;
  overflow: auto;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid #334155;
  outline: none;
  box-shadow: 0 -8px 24px rgba(2, 6, 23, 0.5);
  box-sizing: border-box;
}

:deep(.window-taskbar-overflow-popup) .ui-dropdown-item {
  background: rgba(2, 6, 23, 0.6);
  border: 1px solid #1e293b;
  border-radius: 10px;
  padding: 8px;
}

:deep(.window-taskbar-overflow-popup) .ui-dropdown-item + .ui-dropdown-item {
  margin-top: 4px;
}

:deep(.window-taskbar-overflow-popup) .ui-dropdown-item[aria-selected='true'],
:deep(.window-taskbar-overflow-popup) .ui-dropdown-item:hover {
  background: rgba(30, 41, 59, 0.7);
  border-color: #475569;
}
</style>

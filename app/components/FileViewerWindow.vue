<template>
  <div class="file-viewer" :style="style" @pointerdown.capture="onFocus">
    <div class="viewer-titlebar" @pointerdown="onDragStart">
      <span class="viewer-title">{{ title }}</span>
      <button
        type="button"
        class="viewer-close"
        aria-label="Close file viewer"
        @pointerdown.stop
        @click.stop="onClose"
      >
        ×
      </button>
    </div>
    <div class="viewer-body" @scroll="onFloatingScroll" @wheel="onFloatingWheel">
      <div
        class="viewer-content"
        :class="{ 'is-binary': entry.isBinary, 'no-gutter': entry.toolGutterMode === 'none' }"
        v-html="entry.html"
      ></div>
    </div>
    <div class="viewer-resizer" @pointerdown="onResizeStart"></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

type ViewerEntry = {
  x: number;
  y: number;
  zIndex?: number;
  width?: number;
  height?: number;
  path?: string;
  html: string;
  isBinary?: boolean;
  toolGutterMode?: 'default' | 'none' | 'grep-source';
};

const props = defineProps<{
  entry: ViewerEntry;
  title: string;
  onFocusEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onDragEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onResizeEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onFloatingScrollEntry: (entry: ViewerEntry, event: Event) => void;
  onFloatingWheelEntry: (entry: ViewerEntry, event: WheelEvent) => void;
  onCloseEntry: (entry: ViewerEntry) => void;
}>();

const entry = computed(() => props.entry);

const style = computed(() => ({
  left: `${entry.value.x ?? 0}px`,
  top: `calc(var(--tool-top-offset) + ${entry.value.y ?? 0}px)`,
  '--term-width': entry.value.width ? `${entry.value.width}px` : undefined,
  '--term-height': entry.value.height ? `${entry.value.height}px` : undefined,
  zIndex: entry.value.zIndex ?? undefined,
}));

function onFocus(event: PointerEvent) {
  props.onFocusEntry(entry.value, event);
}

function onDragStart(event: PointerEvent) {
  props.onDragEntry(entry.value, event);
}

function onResizeStart(event: PointerEvent) {
  props.onResizeEntry(entry.value, event);
}

function onFloatingScroll(event: Event) {
  props.onFloatingScrollEntry(entry.value, event);
}

function onFloatingWheel(event: WheelEvent) {
  props.onFloatingWheelEntry(entry.value, event);
}

function onClose() {
  props.onCloseEntry(entry.value);
}
</script>

<style scoped>
.file-viewer {
  position: absolute;
  font-size: var(--term-font-size);
  width: var(--term-width);
  height: var(--term-height);
  background: #050505;
  color: #f3f4f6;
  border: 1px solid #1f2937;
  overflow: hidden;
  font-family: var(--term-font-family);
  line-height: var(--term-line-height);
  padding: 0;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.viewer-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: 12px;
  color: #cbd5e1;
  background: rgba(2, 6, 23, 0.95);
  border-bottom: 1px solid rgba(148, 163, 184, 0.28);
  cursor: grab;
  user-select: none;
}

.viewer-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.viewer-close {
  border: 0;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  width: 18px;
  height: 18px;
}

.viewer-close:hover {
  color: #fca5a5;
}

.viewer-body {
  flex: 1;
  min-height: 0;
  padding: 2px;
  overflow: auto;
  white-space: normal;
}

.viewer-content {
  line-height: var(--term-line-height);
  color: #c9d1d9;
}

.viewer-content :deep(pre),
.viewer-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.viewer-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.viewer-content :deep(pre) {
  counter-reset: shiki-line;
}

.viewer-content :deep(.line),
.viewer-content :deep(.line)::before {
  line-height: inherit !important;
}

.viewer-content :deep(.line) {
  display: block;
  padding-left: 3.2em;
  position: relative;
  min-height: 1em;
  white-space: pre;
}

.viewer-content.no-gutter :deep(.line) {
  padding-left: 0;
}

.viewer-content :deep(.line)::before {
  counter-increment: shiki-line;
  content: counter(shiki-line);
  position: absolute;
  left: 0;
  width: 2.6em;
  text-align: right;
  color: #8a8a8a;
}

.viewer-content.no-gutter :deep(.line)::before {
  content: '';
  counter-increment: none;
  width: 0;
}

.viewer-content.is-binary :deep(pre) {
  white-space: pre;
}

.viewer-content.is-binary :deep(.hexdump-address) {
  color: #60a5fa;
}

.viewer-content.is-binary :deep(.hexdump-separator) {
  color: #64748b;
}

.viewer-content.is-binary :deep(.hexdump-control) {
  color: #f59e0b;
}

.viewer-content.is-binary :deep(.hexdump-ascii) {
  color: #dbeafe;
}

.viewer-content.is-binary :deep(.hexdump-exascii) {
  color: #fca5a5;
}

.viewer-content.is-binary :deep(.hexdump-null) {
  color: #64748b;
}

.viewer-content :deep(.line.line-added) {
  background: rgba(46, 160, 67, 0.22);
  box-shadow: inset 3px 0 0 #2ea043;
  color: #aff5b4;
}

.viewer-content :deep(.line.line-removed) {
  background: rgba(248, 81, 73, 0.2);
  box-shadow: inset 3px 0 0 #f85149;
  color: #ffdcd7;
}

.viewer-content :deep(.line.line-hunk) {
  background: rgba(56, 139, 253, 0.18);
  color: #c9d1d9;
}

.viewer-content :deep(.line.line-header) {
  background: rgba(110, 118, 129, 0.18);
  color: #c9d1d9;
}

.viewer-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: se-resize;
  background: transparent;
  z-index: 2;
}

.viewer-resizer::before {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent #1f2937 transparent;
}
</style>

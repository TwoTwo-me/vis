<script setup lang="ts">
import { ref, computed, provide } from 'vue';
import CodeContent from './CodeContent.vue';
import { FLOATING_WINDOW_KEY, type FloatingWindowAPI } from '../composables/useFloatingWindow';
import type { FloatingWindowEntry } from '../composables/useFloatingWindows';

const props = defineProps<{
  entry: FloatingWindowEntry;
}>();

const emit = defineEmits<{
  focus: [key: string];
  close: [key: string];
}>();

const bodyEl = ref<HTMLElement>();

// Provide inject API to child components
const api: FloatingWindowAPI = {
  key: props.entry.key,
  content: computed(() => props.entry.content || ''),
  html: computed(() => props.entry.resolvedHtml),
  title: computed(() => props.entry.title || ''),
  status: computed(() => props.entry.status || ''),
  setContent: (text: string) => {
    // This would need to call back to the composable
    console.warn('setContent not fully implemented');
  },
  appendContent: (text: string) => {
    console.warn('appendContent not fully implemented');
  },
  setTitle: (title: string) => {
    props.entry.title = title;
  },
  setStatus: (status: string) => {
    props.entry.status = status as 'running' | 'completed' | 'error';
  },
  setColor: (color: string) => {
    props.entry.color = color;
  },
  bringToFront: () => {
    emit('focus', props.entry.key);
  },
  close: () => {
    emit('close', props.entry.key);
  },
  onResize: (callback: (w: number, h: number) => void) => {
    // Store callback for resize events
  },
};

provide(FLOATING_WINDOW_KEY, api);

const windowStyle = computed(() => {
  const color = props.entry.color || '#3a4150';
  return {
    left: `${props.entry.x}px`,
    top: `${props.entry.y}px`,
    width: props.entry.width ? `${props.entry.width}px` : '600px',
    height: props.entry.height ? `${props.entry.height}px` : '400px',
    zIndex: props.entry.zIndex,
    '--window-color': color,
  };
});

const scrollClass = computed(() => {
  return {
    'scroll-force': props.entry.scroll === 'force',
    'scroll-follow': props.entry.scroll === 'follow',
    'scroll-manual': props.entry.scroll === 'manual',
    'scroll-none': props.entry.scroll === 'none',
  };
});

function onFocus() {
  emit('focus', props.entry.key);
}

function onClose() {
  emit('close', props.entry.key);
}

// Drag handling
let dragStartX = 0;
let dragStartY = 0;
let windowStartX = 0;
let windowStartY = 0;

function onDragStart(e: PointerEvent) {
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  windowStartX = props.entry.x;
  windowStartY = props.entry.y;
  
  const target = e.target as HTMLElement;
  target.setPointerCapture(e.pointerId);
  target.addEventListener('pointermove', onDragMove);
  target.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e: PointerEvent) {
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  props.entry.x = windowStartX + dx;
  props.entry.y = windowStartY + dy;
}

function onDragEnd(e: PointerEvent) {
  const target = e.target as HTMLElement;
  target.removeEventListener('pointermove', onDragMove);
  target.removeEventListener('pointerup', onDragEnd);
  target.releasePointerCapture(e.pointerId);
}

// Resize handling
let resizeStartX = 0;
let resizeStartY = 0;
let windowStartWidth = 0;
let windowStartHeight = 0;

function onResizeStart(e: PointerEvent) {
  e.stopPropagation();
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  windowStartWidth = props.entry.width || 600;
  windowStartHeight = props.entry.height || 400;
  
  const target = e.target as HTMLElement;
  target.setPointerCapture(e.pointerId);
  target.addEventListener('pointermove', onResizeMove);
  target.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e: PointerEvent) {
  const dx = e.clientX - resizeStartX;
  const dy = e.clientY - resizeStartY;
  props.entry.width = Math.max(200, windowStartWidth + dx);
  props.entry.height = Math.max(150, windowStartHeight + dy);
}

function onResizeEnd(e: PointerEvent) {
  const target = e.target as HTMLElement;
  target.removeEventListener('pointermove', onResizeMove);
  target.removeEventListener('pointerup', onResizeEnd);
  target.releasePointerCapture(e.pointerId);
  
  if (props.entry.onResize) {
    props.entry.onResize(props.entry.width || 600, props.entry.height || 400);
  }
}
</script>

<template>
  <div 
    class="floating-window" 
    :style="windowStyle" 
    @pointerdown.capture="onFocus"
    :data-floating-key="entry.key"
  >
    <div class="floating-window-titlebar" @pointerdown="onDragStart">
      <span class="title">{{ entry.title || 'Tool' }}</span>
      <button 
        v-if="entry.closable" 
        class="close-btn"
        @click.stop="onClose"
      >×</button>
    </div>
    <div 
      class="floating-window-body" 
      :class="scrollClass"
      ref="bodyEl"
    >
      <component 
        :is="entry.component || CodeContent" 
        v-bind="entry.props || {}"
        :content="entry.content"
        :html="entry.resolvedHtml"
      />
    </div>
    <div 
      v-if="entry.resizable" 
      class="floating-window-resizer" 
      @pointerdown="onResizeStart"
    />
  </div>
</template>

<style scoped>
.floating-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--window-color, #3a4150) 12%, #1a1d24);
  border: 1px solid var(--window-color, #3a4150);
  border-radius: 5px;
  overflow: hidden;
  font-family: var(--term-font-family, monospace);
  font-size: var(--term-font-size, 14px);
  line-height: var(--term-line-height, 1.5);
  pointer-events: auto;
}

.floating-window-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  font-size: 12px;
  color: color-mix(in srgb, var(--window-color, #3a4150) 40%, #e2e8f0);
  background: color-mix(in srgb, var(--window-color, #3a4150) 22%, rgba(36, 40, 50, 0.95));
  border-bottom: 1px solid color-mix(in srgb, var(--window-color, #3a4150) 35%, rgba(90, 100, 120, 0.35));
  cursor: grab;
  user-select: none;
}

.floating-window-titlebar:active {
  cursor: grabbing;
}

.floating-window-titlebar .title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.close-btn {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  opacity: 0.8;
}

.floating-window-body {
  flex: 1;
  overflow: auto;
  padding: 2px 4px;
}

.floating-window-body.scroll-force {
  overflow: hidden;
}

.floating-window-body.scroll-none {
  overflow: hidden;
}

.floating-window-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: se-resize;
  background: transparent;
}

.floating-window-resizer::before {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent var(--window-color, #3a4150) transparent;
}

.floating-window-resizer:hover::before {
  filter: brightness(1.15);
}
</style>

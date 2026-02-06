<template>
  <div ref="root" class="ui-dropdown" :class="{ 'is-open': isActive, 'is-disabled': props.disabled }">
    <slot name="trigger">
      <button
        type="button"
        class="ui-dropdown-button"
        :class="props.buttonClass"
        :style="props.buttonStyle"
        :disabled="props.disabled"
        ref="trigger"
        @click.stop="toggle"
        @keydown.esc.prevent="close"
      >
        <span class="ui-dropdown-label">{{ displayLabel }}</span>
        <span class="ui-dropdown-icon">{{ props.menuIcon ?? 'v' }}</span>
      </button>
    </slot>
    <div
      v-if="isActive"
      class="ui-dropdown-menu"
      :class="props.popupClass"
      :style="[props.popupStyle, menuStyle]"
      role="listbox"
      @click.stop
    >
      <slot :close="close" />
    </div>
  </div>
</template>

<script lang="ts" setup generic="T">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, type StyleValue } from 'vue';

export interface DropdownAPI {
  select: (item: unknown) => void;
  close: () => void;
  selected: unknown | undefined;
  update: () => Promise<void>;
}

const props = defineProps<{
  menuIcon?: string;
  modelValue?: T;
  label?: string;
  placeholder?: string;
  buttonClass?: unknown;
  buttonStyle?: StyleValue;
  popupClass?: unknown;
  popupStyle?: StyleValue;
  autoClose?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  select: [T];
  'update:modelValue': [T];
}>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLElement | null>(null);
const isActive = ref(false);
const menuStyle = ref<StyleValue>();

const displayLabel = computed(() => {
  if (props.label) return props.label;
  if (props.modelValue !== undefined && props.modelValue !== null) return String(props.modelValue);
  return props.placeholder ?? 'Select';
});

function toggle() {
  if (props.disabled) return;
  isActive.value = !isActive.value;
  if (isActive.value) void nextTick(updateMenuPosition);
}

function close() {
  isActive.value = false;
}

function updateMenuPosition() {
  const triggerEl = trigger.value;
  if (!triggerEl) return;
  const rect = triggerEl.getBoundingClientRect();
  menuStyle.value = {
    position: 'fixed',
    top: `${rect.bottom + 6}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
  };
}

function handlePointerDown(event: PointerEvent) {
  if (!root.value) return;
  if (root.value.contains(event.target as Node)) return;
  close();
}

onMounted(() => {
  window.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('resize', updateMenuPosition);
  window.addEventListener('scroll', updateMenuPosition, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handlePointerDown);
  window.removeEventListener('resize', updateMenuPosition);
  window.removeEventListener('scroll', updateMenuPosition, true);
});

const api = reactive({
  select(item: T) {
    if (props.autoClose !== false) close();
    if (item !== undefined) emit('update:modelValue', item);
    emit('select', item);
  },
  close,
  selected: computed(() => props.modelValue),
  update: async () => undefined,
});

provide('x-selectable', api);
</script>

<style scoped>
.ui-dropdown {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.ui-dropdown.is-disabled {
  opacity: 0.6;
}

.ui-dropdown-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #0b1320;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
}

.ui-dropdown-button:disabled {
  cursor: default;
}

.ui-dropdown-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-dropdown-icon {
  font-size: 12px;
  opacity: 0.7;
}

.ui-dropdown-menu {
  position: fixed;
  background: rgba(2, 6, 23, 0.98);
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 24px rgba(2, 6, 23, 0.45);
  max-height: 280px;
  overflow: auto;
  z-index: 120;
}
</style>

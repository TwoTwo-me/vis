<template>
  <div
    class="ui-dropdown-item ui-input-candidate-item"
    :aria-disabled="props.disabled"
    :data-value="JSON.stringify(props.value)"
    :class="{ 'is-active': isActive, 'is-disabled': props.disabled }"
    @click="onClick"
  >
    <slot />
  </div>
</template>

<script lang="ts" setup>
import { computed, inject } from 'vue';
import type { DropdownAPI } from '../Dropdown.vue';

defineOptions({
  inheritAttrs: false,
});

type Props = {
  value?: unknown;
  disabled?: boolean;
  active?: boolean | undefined;
};

const props = defineProps<Props>();
const api = inject<DropdownAPI>('x-selectable');

const selectedValue = computed(() => {
  const selected = api?.selected as unknown;
  if (selected && typeof selected === 'object' && 'value' in selected) {
    return (selected as { value?: unknown }).value;
  }
  return selected;
});

const isActive = computed(() =>
  Boolean(props.active || (props.value !== undefined && selectedValue.value === props.value)),
);

function onClick() {
  if (props.disabled) return;
  api?.select(props.value);
}
</script>

<style scoped>
.ui-dropdown-item {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
}

.ui-dropdown-item.is-active {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.ui-dropdown-item:hover,
.ui-dropdown-item[aria-selected="true"] {
  background: rgba(15, 23, 42, 0.9);
}

.ui-dropdown-item.is-disabled {
  opacity: 0.6;
  cursor: default;
}
</style>

<template>
  <component
    :is="props.href ? 'a' : 'div'"
    class="ui-dropdown-item ui-input-candidate-item"
    :href="props.href || undefined"
    :aria-disabled="props.disabled"
    :data-value="JSON.stringify(props.value)"
    :class="{ 'is-active': isActive, 'is-disabled': props.disabled }"
    @click="onClick"
  >
    <slot />
  </component>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, watch } from 'vue';
import type { DropdownAPI } from '../Dropdown.vue';

defineOptions({
  inheritAttrs: false,
});

type Props = {
  value?: unknown;
  disabled?: boolean;
  active?: boolean | undefined;
  href?: string;
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

onMounted(() => api?.update());
watch(
  () => props.value,
  () => api?.update(),
);

function onClick(event: MouseEvent) {
  if (props.disabled) {
    if (props.href) event.preventDefault();
    return;
  }
  if (
    props.href &&
    (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
  ) {
    return;
  }
  if (props.href) event.preventDefault();
  api?.select(props.value);
}
</script>

<style scoped>
a.ui-dropdown-item {
  color: inherit;
  text-decoration: none;
}

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
.ui-dropdown-item[aria-selected='true'] {
  background: rgba(15, 23, 42, 0.9);
}

.ui-dropdown-item.is-disabled {
  cursor: default;
}
</style>

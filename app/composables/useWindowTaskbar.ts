import { computed, type Ref } from 'vue';
import type { FloatingWindowEntry } from './useFloatingWindows';

const TASKBAR_SLOT_WIDTH_PX = 32;

type TaskbarLayoutInput = {
  entries: readonly FloatingWindowEntry[];
  availableWidth: number;
};

export type WindowTaskbarLayout = {
  visibleItems: FloatingWindowEntry[];
  overflowItems: FloatingWindowEntry[];
  slotCount: number;
};

function compareTaskbarEntries(a: FloatingWindowEntry, b: FloatingWindowEntry): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.key.localeCompare(b.key);
}

function toSlotCount(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 0;
  return Math.max(0, Math.floor(availableWidth / TASKBAR_SLOT_WIDTH_PX));
}

export function selectWindowTaskbarLayout({
  entries,
  availableWidth,
}: TaskbarLayoutInput): WindowTaskbarLayout {
  const eligibleItems = entries.filter(
    (entry) => entry.taskbarEligible && entry.taskbarGroup !== 'prompt',
  );
  const autoItems = eligibleItems
    .filter((entry) => entry.taskbarGroup === 'auto')
    .sort(compareTaskbarEntries);
  const manualItems = eligibleItems
    .filter((entry) => entry.taskbarGroup !== 'auto')
    .sort(compareTaskbarEntries);
  const orderedItems = [...autoItems, ...manualItems];
  const slotCount = toSlotCount(availableWidth);

  if (orderedItems.length <= slotCount) {
    return {
      visibleItems: orderedItems,
      overflowItems: [],
      slotCount,
    };
  }

  if (slotCount <= 1) {
    return {
      visibleItems: [],
      overflowItems: orderedItems,
      slotCount,
    };
  }

  const visibleCount = Math.max(0, slotCount - 1);
  const visibleItems = orderedItems.slice(-visibleCount);
  const overflowItems = orderedItems.slice(0, orderedItems.length - visibleCount);

  return {
    visibleItems,
    overflowItems,
    slotCount,
  };
}

export function useWindowTaskbar(
  entries: Ref<readonly FloatingWindowEntry[]>,
  availableWidth: Ref<number>,
) {
  const layout = computed(() =>
    selectWindowTaskbarLayout({
      entries: entries.value,
      availableWidth: availableWidth.value,
    }),
  );

  return {
    visibleItems: computed(() => layout.value.visibleItems),
    overflowItems: computed(() => layout.value.overflowItems),
    slotCount: computed(() => layout.value.slotCount),
  };
}

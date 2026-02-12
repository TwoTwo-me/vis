import { nextTick } from 'vue';
import type { Ref } from 'vue';

type OutputPanelRef = {
  panelEl: HTMLDivElement | null;
} | null;

export function useOutputPanelFollow(options: {
  outputPanelRef: Ref<OutputPanelRef>;
  isFollowing: Ref<boolean>;
  followThresholdPx: number;
}) {
  function getPanelElement() {
    return options.outputPanelRef.value?.panelEl ?? null;
  }

  function isAtBottom() {
    const panel = getPanelElement();
    if (!panel) return true;
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight <= options.followThresholdPx;
  }

  function scrollToBottom(smooth = false) {
    const panel = getPanelElement();
    if (!panel) return;
    const target = Math.max(0, panel.scrollHeight - panel.clientHeight);
    if (smooth) {
      panel.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      panel.scrollTop = target;
    }
  }

  function handleOutputPanelScroll() {
    options.isFollowing.value = isAtBottom();
  }

  function handleOutputPanelWheel(event: WheelEvent) {
    if (event.deltaY < 0) {
      options.isFollowing.value = false;
    }
  }

  function scheduleFollowScroll() {
    if (!options.isFollowing.value) return;
    nextTick(() => scrollToBottom());
  }

  let smoothFollowTimer: ReturnType<typeof setTimeout> | undefined;

  function resumeFollow(smooth = false) {
    options.isFollowing.value = true;
    nextTick(() => scrollToBottom(smooth));
    if (!smooth) return;
    clearTimeout(smoothFollowTimer);
    smoothFollowTimer = setTimeout(() => {
      options.isFollowing.value = true;
    }, 500);
  }

  return {
    handleOutputPanelScroll,
    handleOutputPanelWheel,
    scheduleFollowScroll,
    resumeFollow,
  };
}

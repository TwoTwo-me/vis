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

  function scrollToBottom() {
    const panel = getPanelElement();
    if (!panel) return;
    panel.scrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
  }

  function updateFollowState() {
    const panel = getPanelElement();
    if (!panel) return;
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    options.isFollowing.value = distanceFromBottom <= options.followThresholdPx;
  }

  function handleOutputPanelScroll() {
    updateFollowState();
  }

  function handleOutputPanelWheel(event: WheelEvent) {
    if (event.deltaY < 0) {
      options.isFollowing.value = false;
      return;
    }
    updateFollowState();
  }

  function scheduleFollowScroll() {
    if (!options.isFollowing.value) return;
    nextTick(() => {
      requestAnimationFrame(() => {
        scrollToBottom();
        updateFollowState();
      });
    });
  }

  function resumeFollow() {
    options.isFollowing.value = true;
    nextTick(scrollToBottom);
  }

  return {
    scrollToBottom,
    updateFollowState,
    handleOutputPanelScroll,
    handleOutputPanelWheel,
    scheduleFollowScroll,
    resumeFollow,
  };
}

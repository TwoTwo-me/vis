import { ref, computed, watch, onUnmounted, type Ref } from 'vue';

export type ScrollMode = 'follow' | 'force' | 'manual' | 'none';

const BOTTOM_THRESHOLD_PX = 8;
const SCROLL_SPEED_PX_PER_MS = 1.5;
const INTERVENTION_TOLERANCE_PX = 2;
const MAX_FRAME_DT_MS = 50;
const POPUP_DURATION_MS = 150;
const NATIVE_SMOOTH_TIMEOUT_MS = 1_500;

type SmoothEngine = 'raf' | 'native';

type ScrollFollowOptions = {
  bottomThresholdPx?: number;
  observeDelayMs?: number;
  smoothEngine?: SmoothEngine;
  smoothOnMutation?: boolean;
  smoothOnInitialFollow?: boolean;
  enabled?: boolean;
};

export function useScrollFollow(
  containerEl: Ref<HTMLElement | undefined>,
  scrollMode: Ref<ScrollMode>,
  options: ScrollFollowOptions = {},
) {
  const bottomThresholdPx = options.bottomThresholdPx ?? BOTTOM_THRESHOLD_PX;
  const observeDelayMs = options.observeDelayMs ?? POPUP_DURATION_MS;
  const smoothEngine = options.smoothEngine ?? 'raf';
  const smoothOnMutation = options.smoothOnMutation ?? true;
  const smoothOnInitialFollow = options.smoothOnInitialFollow ?? true;
  const isFollowing = ref(scrollMode.value === 'follow' || scrollMode.value === 'force');
  const isTrackingPaused = ref(options.enabled === false);

  let mutationObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafId: number | null = null;
  let popupTimerId: ReturnType<typeof setTimeout> | null = null;
  let animating = false;
  let lastSetScrollTop = -1;
  let contentChangeScheduled = false;
  let nativeSmoothMonitorTimeout: ReturnType<typeof setTimeout> | null = null;
  let nativeSmoothCleanup: (() => void) | null = null;

  const showResumeButton = computed(() => {
    return scrollMode.value === 'follow' && !isFollowing.value;
  });

  function isAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= bottomThresholdPx;
  }

  function cancelAnimation() {
    animating = false;
    lastSetScrollTop = -1;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function pauseTracking() {
    isTrackingPaused.value = true;
  }

  function resumeTracking(options: { syncToBottom?: boolean } = {}) {
    if (!isTrackingPaused.value) {
      if (options.syncToBottom) scrollToBottom(false);
      return;
    }
    if (options.syncToBottom) {
      scrollToBottom(false);
      isTrackingPaused.value = false;
      return;
    }
    isTrackingPaused.value = false;
    if (scrollMode.value !== 'follow') return;
    const el = containerEl.value;
    if (!el) return;
    isFollowing.value = isAtBottom(el);
  }

  function runWithoutTracking<T>(fn: () => T): T {
    const wasPaused = isTrackingPaused.value;
    isTrackingPaused.value = true;
    try {
      return fn();
    } finally {
      if (!wasPaused) resumeTracking();
    }
  }

  function clearNativeSmoothMonitor() {
    if (nativeSmoothMonitorTimeout !== null) {
      clearTimeout(nativeSmoothMonitorTimeout);
      nativeSmoothMonitorTimeout = null;
    }
    if (nativeSmoothCleanup) {
      nativeSmoothCleanup();
      nativeSmoothCleanup = null;
    }
  }

  function startNativeSmoothMonitor(el: HTMLElement) {
    clearNativeSmoothMonitor();
    pauseTracking();

    let done = false;
    let cleanupBound = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (cleanupBound) {
        el.removeEventListener('scrollend', onScrollEnd as EventListener);
        cleanupBound = false;
      }
      if (nativeSmoothMonitorTimeout !== null) {
        clearTimeout(nativeSmoothMonitorTimeout);
        nativeSmoothMonitorTimeout = null;
      }
      nativeSmoothCleanup = null;
      resumeTracking();
      isFollowing.value = true;
    };

    const onScrollEnd = () => {
      finish();
    };

    el.addEventListener('scrollend', onScrollEnd as EventListener);
    cleanupBound = true;
    nativeSmoothMonitorTimeout = setTimeout(() => {
      finish();
    }, NATIVE_SMOOTH_TIMEOUT_MS);
    nativeSmoothCleanup = finish;
  }

  function scrollToBottom(smooth: boolean) {
    const el = containerEl.value;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    if (target <= 0) return;
    if (Math.abs(el.scrollTop - target) < 1) return;

    if (!smooth) {
      clearNativeSmoothMonitor();
      cancelAnimation();
      el.scrollTop = target;
      lastSetScrollTop = target;
      return;
    }

    if (smoothEngine === 'native') {
      cancelAnimation();
      startNativeSmoothMonitor(el);
      el.scrollTo({ top: target, behavior: 'smooth' });
      lastSetScrollTop = target;
      return;
    }

    clearNativeSmoothMonitor();

    if (animating) return;

    animating = true;
    let lastTime = performance.now();
    lastSetScrollTop = el.scrollTop;

    function frame(now: number) {
      const el = containerEl.value;
      if (!el || !animating) {
        animating = false;
        return;
      }

      if (
        lastSetScrollTop >= 0 &&
        Math.abs(el.scrollTop - lastSetScrollTop) > INTERVENTION_TOLERANCE_PX
      ) {
        animating = false;
        lastSetScrollTop = -1;
        if (scrollMode.value === 'follow') {
          isFollowing.value = isAtBottom(el);
        }
        return;
      }

      const dt = Math.min(now - lastTime, MAX_FRAME_DT_MS);
      lastTime = now;
      const target = el.scrollHeight - el.clientHeight;
      const remaining = target - el.scrollTop;

      if (remaining <= 0.5) {
        el.scrollTop = target;
        lastSetScrollTop = target;
        animating = false;
        return;
      }

      const step = SCROLL_SPEED_PX_PER_MS * dt;
      const newTop = Math.min(el.scrollTop + step, target);
      el.scrollTop = newTop;
      lastSetScrollTop = newTop;

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  function scheduleAutoScroll(smooth: boolean) {
    if (isTrackingPaused.value) return;
    if (contentChangeScheduled) return;
    contentChangeScheduled = true;
    requestAnimationFrame(() => {
      contentChangeScheduled = false;
      const m = scrollMode.value;
      if (m === 'force') {
        scrollToBottom(smooth);
      } else if (m === 'follow' && isFollowing.value) {
        scrollToBottom(smooth);
      }
    });
  }

  function onScroll() {
    if (isTrackingPaused.value) return;
    if (animating) return;
    if (scrollMode.value !== 'follow') return;
    const el = containerEl.value;
    if (!el) return;
    isFollowing.value = isAtBottom(el);
  }

  function onContentMutation() {
    if (isTrackingPaused.value) return;
    scheduleAutoScroll(smoothOnMutation);
  }

  function onContainerResize() {
    if (isTrackingPaused.value) return;
    const m = scrollMode.value;
    if (m === 'force' || (m === 'follow' && isFollowing.value)) {
      scrollToBottom(false);
    }
  }

  function resumeFollow(smooth = true) {
    isFollowing.value = true;
    scrollToBottom(smooth);
  }

  function startObserving(el: HTMLElement) {
    mutationObserver = new MutationObserver(onContentMutation);
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    let resizeInitial = true;
    resizeObserver = new ResizeObserver(() => {
      if (resizeInitial) {
        resizeInitial = false;
        return;
      }
      onContainerResize();
    });
    resizeObserver.observe(el);

    if (scrollMode.value === 'follow' || scrollMode.value === 'force') {
      scrollToBottom(smoothOnInitialFollow);
    }
  }

  function setup(el: HTMLElement) {
    el.addEventListener('scroll', onScroll, { passive: true });

    if (observeDelayMs <= 0) {
      startObserving(el);
      return;
    }

    popupTimerId = setTimeout(() => {
      popupTimerId = null;
      if (containerEl.value === el) startObserving(el);
    }, observeDelayMs);
  }

  function teardown(el: HTMLElement) {
    el.removeEventListener('scroll', onScroll);
    if (popupTimerId !== null) {
      clearTimeout(popupTimerId);
      popupTimerId = null;
    }
    clearNativeSmoothMonitor();
    cancelAnimation();
    mutationObserver?.disconnect();
    mutationObserver = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  watch(containerEl, (newEl, oldEl) => {
    if (oldEl) teardown(oldEl);
    if (newEl) setup(newEl);
  });

  watch(scrollMode, (m) => {
    isFollowing.value = m === 'follow' || m === 'force';
  });

  onUnmounted(() => {
    if (containerEl.value) teardown(containerEl.value);
    clearNativeSmoothMonitor();
    cancelAnimation();
  });

  return {
    isTrackingPaused: computed(() => isTrackingPaused.value),
    isFollowing: computed(() => isFollowing.value),
    showResumeButton,
    pauseTracking,
    resumeTracking,
    runWithoutTracking,
    resumeFollow,
    scrollToBottom,
  };
}

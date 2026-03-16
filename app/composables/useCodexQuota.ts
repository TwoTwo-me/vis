import { onBeforeUnmount, onMounted, readonly, ref, watch, type Ref } from 'vue';
import type { CodexUsageResponse } from '../types/codex-usage';
import * as opencodeApi from '../utils/opencode';

const REFRESH_INTERVAL_MS = 60_000;

export function useCodexQuota(enabled: Ref<boolean>) {
  const quota = ref<CodexUsageResponse | null>(null);
  const loading = ref(false);
  const disabled = ref(false);
  const error = ref('');
  let refreshTimer = 0;
  let currentController: AbortController | null = null;

  function clearRefreshTimer() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = 0;
    }
  }

  function cancelInFlight() {
    currentController?.abort();
    currentController = null;
  }

  async function refresh() {
    if (!enabled.value || disabled.value || loading.value) return;
    loading.value = true;
    error.value = '';
    const controller = new AbortController();
    currentController = controller;
    try {
      const payload = await opencodeApi.getCodexUsage({ signal: controller.signal });
      if (payload === null) {
        disabled.value = true;
        quota.value = null;
        clearRefreshTimer();
        return;
      }
      disabled.value = false;
      quota.value = payload;
    } catch (errorValue) {
      if (controller.signal.aborted) return;
      error.value = errorValue instanceof Error ? errorValue.message : 'Codex quota request failed.';
    } finally {
      if (currentController === controller) currentController = null;
      loading.value = false;
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && !disabled.value) {
      void refresh();
    }
  }

  watch(
    enabled,
    (isEnabled) => {
      if (!isEnabled) {
        clearRefreshTimer();
        cancelInFlight();
        quota.value = null;
        loading.value = false;
        error.value = '';
        disabled.value = false;
        return;
      }
      void refresh();
      if (!refreshTimer) {
        refreshTimer = window.setInterval(() => {
          void refresh();
        }, REFRESH_INTERVAL_MS);
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    clearRefreshTimer();
    cancelInFlight();
  });

  return {
    quota: readonly(quota),
    loading: readonly(loading),
    disabled: readonly(disabled),
    error: readonly(error),
  };
}

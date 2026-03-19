import { onBeforeUnmount, readonly, ref, watch, type Ref } from 'vue';
import type {
  VisTokenProviderDefinition,
  VisTokenProviderPanelResponse,
  VisTokenProviderResultBlock,
  VisTokenProviderSaveDefinition,
  VisTokenProviderTestDraft,
} from '../types/vis-token-provider';
import * as opencodeApi from '../utils/opencode';

const REFRESH_INTERVAL_MS = 60_000;

export function useVisTokenProviders(enabled: Ref<boolean>) {
  const definitions = ref<VisTokenProviderDefinition[]>([]);
  const configLoading = ref(false);
  const configError = ref('');
  const saving = ref(false);
  const saveError = ref('');
  const draftTestResult = ref<VisTokenProviderResultBlock | null>(null);
  const draftTesting = ref(false);
  const draftTestError = ref('');
  const panel = ref<VisTokenProviderPanelResponse | null>(null);
  const panelLoading = ref(false);
  const panelError = ref('');
  const isPanelOpen = ref(false);

  let refreshTimer = 0;
  let configController: AbortController | null = null;
  let saveController: AbortController | null = null;
  let draftTestController: AbortController | null = null;
  let panelController: AbortController | null = null;

  function clearRefreshTimer() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = 0;
    }
  }

  function cancelConfigInFlight() {
    configController?.abort();
    configController = null;
  }

  function cancelSaveInFlight() {
    saveController?.abort();
    saveController = null;
  }

  function cancelDraftTestInFlight() {
    draftTestController?.abort();
    draftTestController = null;
  }

  function cancelPanelInFlight() {
    panelController?.abort();
    panelController = null;
  }

  function startRefreshTimer() {
    if (refreshTimer || !enabled.value || !isPanelOpen.value) return;
    refreshTimer = window.setInterval(() => {
      void refreshPanel();
    }, REFRESH_INTERVAL_MS);
  }

  async function loadConfig() {
    if (configLoading.value) return definitions.value;
    configLoading.value = true;
    configError.value = '';
    saveError.value = '';
    cancelConfigInFlight();
    const controller = new AbortController();
    configController = controller;
    try {
      const payload = await opencodeApi.loadVisTokenProviderConfig({
        signal: controller.signal,
      });
      definitions.value = Array.isArray(payload.definitions) ? payload.definitions : [];
      return definitions.value;
    } catch (errorValue) {
      if (controller.signal.aborted) return definitions.value;
      configError.value =
        errorValue instanceof Error ? errorValue.message : 'Token provider config load failed.';
      return definitions.value;
    } finally {
      if (configController === controller) configController = null;
      configLoading.value = false;
    }
  }

  async function saveConfig(nextDefinitions: VisTokenProviderSaveDefinition[]) {
    if (saving.value) return definitions.value;
    saving.value = true;
    saveError.value = '';
    configError.value = '';
    cancelSaveInFlight();
    const controller = new AbortController();
    saveController = controller;
    try {
      const payload = await opencodeApi.saveVisTokenProviderConfig(nextDefinitions, {
        signal: controller.signal,
      });
      definitions.value = Array.isArray(payload.definitions) ? payload.definitions : [];
      if (isPanelOpen.value && enabled.value) void refreshPanel();
      return definitions.value;
    } catch (errorValue) {
      if (controller.signal.aborted) return definitions.value;
      saveError.value = errorValue instanceof Error ? errorValue.message : 'Token provider save failed.';
      return definitions.value;
    } finally {
      if (saveController === controller) saveController = null;
      saving.value = false;
    }
  }

  async function testDraft(draft: VisTokenProviderTestDraft) {
    if (draftTesting.value) return draftTestResult.value;
    draftTesting.value = true;
    draftTestError.value = '';
    cancelDraftTestInFlight();
    const controller = new AbortController();
    draftTestController = controller;
    try {
      const payload = await opencodeApi.testVisTokenProviderDraft(draft, {
        signal: controller.signal,
      });
      draftTestResult.value = payload.result ?? null;
      return draftTestResult.value;
    } catch (errorValue) {
      if (controller.signal.aborted) return draftTestResult.value;
      draftTestError.value =
        errorValue instanceof Error ? errorValue.message : 'Token provider draft test failed.';
      return draftTestResult.value;
    } finally {
      if (draftTestController === controller) draftTestController = null;
      draftTesting.value = false;
    }
  }

  async function refreshPanel() {
    if (!enabled.value || panelLoading.value) return panel.value;
    panelLoading.value = true;
    panelError.value = '';
    cancelPanelInFlight();
    const controller = new AbortController();
    panelController = controller;
    try {
      const payload = await opencodeApi.refreshVisTokenProviderPanel({
        signal: controller.signal,
      });
      panel.value = payload;
      return panel.value;
    } catch (errorValue) {
      if (controller.signal.aborted) return panel.value;
      panelError.value =
        errorValue instanceof Error ? errorValue.message : 'Token provider refresh failed.';
      return panel.value;
    } finally {
      if (panelController === controller) panelController = null;
      panelLoading.value = false;
    }
  }

  function startOpenPolling() {
    isPanelOpen.value = true;
    if (!enabled.value) return;
    void refreshPanel();
    startRefreshTimer();
  }

  function stopOpenPolling() {
    isPanelOpen.value = false;
    clearRefreshTimer();
    cancelPanelInFlight();
    panelLoading.value = false;
  }

  watch(
    enabled,
    (isEnabled) => {
      if (!isEnabled) {
        clearRefreshTimer();
        cancelPanelInFlight();
        panelLoading.value = false;
        return;
      }
      if (!isPanelOpen.value) return;
      void refreshPanel();
      startRefreshTimer();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    clearRefreshTimer();
    cancelConfigInFlight();
    cancelSaveInFlight();
    cancelDraftTestInFlight();
    cancelPanelInFlight();
  });

  return {
    definitions: readonly(definitions),
    configLoading: readonly(configLoading),
    configError: readonly(configError),
    saving: readonly(saving),
    saveError: readonly(saveError),
    draftTestResult: readonly(draftTestResult),
    draftTesting: readonly(draftTesting),
    draftTestError: readonly(draftTestError),
    panel: readonly(panel),
    panelLoading: readonly(panelLoading),
    panelError: readonly(panelError),
    loadConfig,
    saveConfig,
    testDraft,
    refreshPanel,
    startOpenPolling,
    stopOpenPolling,
  };
}

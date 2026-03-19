<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    @close="emit('close')"
    @cancel.prevent
    @click.self="dialogRef?.close()"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title-group">
          <div class="modal-title">Settings</div>
          <div class="modal-subtitle">Local composer behavior and trusted deployment controls.</div>
        </div>
        <button type="button" class="modal-close-button" @click="dialogRef?.close()">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <div class="modal-body">
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Enter to send</div>
            <div class="setting-description">
              Send messages by pressing Enter. When off, use Ctrl+Enter.
            </div>
          </div>
          <label class="toggle-switch">
            <input v-model="enterToSend" type="checkbox" class="toggle-input" />
            <span class="toggle-track" />
          </label>
        </div>

        <section
          class="provider-section"
          data-testid="token-provider-settings-section"
          :class="{ 'is-disabled': !tokenProviderSectionEnabled }"
        >
          <div class="provider-section-header">
            <div class="provider-section-copy">
              <div class="provider-section-kicker">Managed usage</div>
              <div class="provider-section-title">Token Usage Providers</div>
              <p class="provider-section-description">
                Configure trusted server-side commands that render token usage rows for the managed top bar.
              </p>
            </div>
          </div>

          <div class="provider-warning">
            <Icon icon="lucide:shield-alert" :width="14" :height="14" />
            <span>
              Trusted admins only. These commands run on the vis server and affect every viewer of this managed deployment.
            </span>
          </div>

          <div
            v-if="providerStatusMessage"
            class="provider-feedback"
            data-testid="token-provider-status-message"
            role="status"
            aria-live="polite"
          >
            <Icon icon="lucide:triangle-alert" :width="14" :height="14" />
            <span>{{ providerStatusMessage }}</span>
          </div>

          <div class="provider-preset-shell" data-testid="token-provider-preset-gallery">
            <div class="provider-preset-copy">
              <div class="provider-preset-title">Preset gallery</div>
              <p class="provider-preset-description">
                Start from a trusted shell template, then edit the draft before testing or saving it.
              </p>
            </div>

            <div class="provider-preset-grid">
              <button
                type="button"
                class="provider-preset-card"
                data-testid="token-provider-preset-card-codex"
                :disabled="providerActionsDisabled || providerLimitReached"
                @click="handlePresetSelect('codex')"
              >
                <div class="provider-preset-top">
                  <span class="provider-preset-badge">Preset</span>
                  <span class="provider-preset-kicker">Managed shell</span>
                </div>
                <div class="provider-preset-name-wrap">
                  <span class="provider-preset-name">Codex</span>
                  <span class="provider-preset-arrow" aria-hidden="true">
                    <Icon icon="lucide:arrow-up-right" :width="14" :height="14" />
                  </span>
                </div>
                <p class="provider-preset-body">
                  Inserts the next editable `Codex` draft into the working config and lands focus in the command field.
                </p>
                <div class="provider-preset-footer">
                  <span class="button-icon-wrap">
                    <Icon icon="lucide:plus" :width="14" :height="14" />
                    <span class="selector-proxy" data-testid="token-provider-add-action" aria-hidden="true" />
                  </span>
                  <span data-testid="token-provider-add-button">Create draft</span>
                </div>
              </button>

              <div class="provider-preset-placeholder" data-testid="token-provider-preset-placeholder">
                <div class="provider-preset-placeholder-title">Gallery shell ready</div>
                <p class="provider-preset-placeholder-copy">
                  Keep this grid open for additional trusted provider presets later.
                </p>
              </div>
            </div>
          </div>

          <div class="provider-shell">
            <aside class="provider-list-region" data-testid="token-provider-list-region">
              <div v-if="hasProviderEntries" class="provider-list-scroll">
                <button
                  v-for="(definition, index) in workingDefinitions"
                  :key="definition.id"
                  type="button"
                  class="provider-list-item"
                  :class="{ 'is-active': definition.id === activeProviderId }"
                  :data-testid="`token-provider-list-item-${definition.id}`"
                  @click="handleSelectProvider(definition.id)"
                >
                  <div class="provider-list-item-top">
                    <span class="provider-list-name">{{ definition.name || definition.id }}</span>
                    <div class="provider-list-badges">
                      <span class="provider-list-order">{{ index + 1 }}</span>
                      <span v-if="isUnsavedDefinition(definition.id)" class="provider-list-badge">draft</span>
                    </div>
                  </div>
                  <div class="provider-list-meta">{{ definition.id }}</div>
                </button>
              </div>

              <div v-else class="provider-empty-state">
                <div class="provider-empty-title">
                  {{ isLoadingTokenProviders ? 'Loading providers...' : 'No providers configured yet' }}
                </div>
                <p class="provider-empty-copy">
                  Choose the Codex preset above, edit the draft inline, then save only when the ordered config looks right.
                </p>
              </div>
            </aside>

            <div class="provider-detail-region" data-testid="token-provider-detail-region">
              <template v-if="editableDraft">
                <div class="provider-detail-scroll">
                  <div class="detail-header">
                    <div class="detail-copy">
                      <div class="detail-eyebrow">Provider shell</div>
                      <div class="detail-title">{{ editableDraft.name || 'Untitled provider' }}</div>
                      <p class="detail-description">
                        Keep command output in exact `left | right` rows so preview and top-bar rendering stay deterministic.
                      </p>
                    </div>

                    <div class="detail-toolbar">
                      <button
                        type="button"
                        class="icon-action"
                        :data-testid="`token-provider-reorder-up-action-${activeProviderId}`"
                        :disabled="providerActionsDisabled || !canMoveUp"
                        @click="handleMoveProvider('up')"
                      >
                        <Icon icon="lucide:arrow-up" :width="14" :height="14" />
                      </button>
                      <button
                        type="button"
                        class="icon-action"
                        :data-testid="`token-provider-reorder-down-action-${activeProviderId}`"
                        :disabled="providerActionsDisabled || !canMoveDown"
                        @click="handleMoveProvider('down')"
                      >
                        <Icon icon="lucide:arrow-down" :width="14" :height="14" />
                      </button>
                      <button
                        type="button"
                        class="icon-action danger"
                        :class="{ 'is-pending': showDeleteConfirm }"
                        :data-testid="`token-provider-delete-action-${activeProviderId}`"
                        :disabled="providerActionsDisabled || !activeProviderId"
                        @click="handleDeleteProvider"
                      >
                        <Icon icon="lucide:trash-2" :width="14" :height="14" />
                      </button>
                    </div>
                  </div>

                  <div v-if="showDeleteConfirm" class="delete-confirmation">
                    <div class="delete-confirmation-copy">
                      Remove this saved provider from the pending config? Save to persist the deletion.
                    </div>
                    <div class="delete-confirmation-actions">
                      <button
                        type="button"
                        class="action-button secondary"
                        :data-testid="`token-provider-delete-cancel-${activeProviderId}`"
                        :disabled="providerActionsDisabled"
                        @click="clearPendingDelete"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="action-button danger"
                        :data-testid="`token-provider-delete-confirm-${activeProviderId}`"
                        :disabled="providerActionsDisabled"
                        @click="handleConfirmDelete"
                      >
                        Delete provider
                      </button>
                    </div>
                  </div>

                  <div class="field-grid">
                    <label class="field">
                      <span class="field-label">Provider name</span>
                      <input
                        class="field-input"
                        data-testid="token-provider-name-input"
                        type="text"
                        :value="editableDraft.name"
                        :disabled="providerActionsDisabled"
                        placeholder="Codex"
                        @input="handleDraftFieldChange('name', $event)"
                      />
                    </label>

                    <label class="field">
                      <span class="field-label">Provider id</span>
                      <input
                        class="field-input field-input-readonly"
                        type="text"
                        :value="editableDraft.id"
                        readonly
                        tabindex="-1"
                      />
                    </label>

                    <label class="field field-full">
                      <span class="field-label">Shell command</span>
                      <textarea
                        ref="commandInputRef"
                        class="field-textarea"
                        data-testid="token-provider-command-input"
                        rows="5"
                        :value="editableDraft.command"
                        :disabled="providerActionsDisabled"
                        placeholder="printf '7d : 2d 1h | 30%'"
                        spellcheck="false"
                        @input="handleDraftFieldChange('command', $event)"
                      />
                    </label>
                  </div>
                </div>

                <div class="detail-actions">
                  <div class="detail-status-copy">
                    <span v-if="providerStatusMessage">{{ providerStatusMessage }}</span>
                    <span v-else-if="providerLimitReached">Provider limit reached (20 max).</span>
                    <span v-else-if="!canSaveDraft && workingDefinitions.length > 0">
                      Complete every provider name and command before saving.
                    </span>
                    <span v-else>Save replaces the full ordered config exactly as listed.</span>
                  </div>
                  <button
                    type="button"
                    class="action-button secondary"
                    :data-testid="`token-provider-test-action-${activeProviderId}`"
                    :disabled="providerActionsDisabled || !canTestDraft"
                    @click="handleTest"
                  >
                    Test display
                  </button>
                  <button
                    type="button"
                    class="action-button save"
                    :data-testid="`token-provider-save-action-${activeProviderId}`"
                    :disabled="providerActionsDisabled || !canSaveDraft"
                    @click="handleSave"
                  >
                    Save
                  </button>
                </div>
              </template>

              <div v-else class="provider-detail-placeholder">
                <div class="provider-empty-title">Select a provider to edit</div>
                <p class="provider-empty-copy">
                  The detail panel is reserved for draft editing, trusted-command testing, and ordered save controls.
                </p>
              </div>

              <div class="provider-preview-region" data-testid="token-provider-preview-region">
                <template v-if="currentPreview">
                  <div
                    class="preview-block"
                    :class="`is-${currentPreview.status}`"
                    :data-testid="`token-provider-block-${previewBlockId}`"
                  >
                    <div class="preview-header">
                      <div>
                        <div class="preview-title">Inline test preview</div>
                        <div class="preview-subtitle">{{ currentPreview.name || previewBlockId }}</div>
                      </div>
                      <span class="preview-status">{{ formatStatus(currentPreview.status) }}</span>
                    </div>

                    <p class="preview-message">{{ currentPreview.message }}</p>

                    <div v-if="currentPreview.rows.length > 0" class="preview-rows">
                      <div
                        v-for="(row, index) in currentPreview.rows"
                        :key="`${previewBlockId}-${index}`"
                        class="preview-row"
                        :data-testid="`token-provider-row-${previewBlockId}-${index}`"
                      >
                        <span class="preview-row-left">{{ row.leftText }}</span>
                        <span class="preview-row-right">{{ row.rightText }}</span>
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="preview-placeholder">
                  Run a draft test to preview parsed rows and failure states without saving anything.
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useSettings } from '../composables/useSettings';
import { useVisTokenProviders } from '../composables/useVisTokenProviders';
import type {
  VisTokenProviderDefinition,
  VisTokenProviderDraft,
  VisTokenProviderResultBlock,
  VisTokenProviderResultStatus,
  VisTokenProviderTestDraft,
} from '../types/vis-token-provider';

const MAX_TOKEN_PROVIDERS = 20;
const EXTERNAL_TOKEN_PROVIDER_PROP_NAMES = [
  'tokenProviderDefinitions',
  'token-provider-definitions',
  'tokenProviderSavedDefinitions',
  'token-provider-saved-definitions',
  'selectedTokenProviderId',
  'selected-token-provider-id',
  'tokenProviderDraft',
  'token-provider-draft',
  'tokenProviderPreview',
  'token-provider-preview',
  'tokenProviderCommandFocusRequest',
  'token-provider-command-focus-request',
  'tokenProviderBusy',
  'token-provider-busy',
  'tokenProviderStatusMessage',
  'token-provider-status-message',
  'tokenProviderSectionEnabled',
  'token-provider-section-enabled',
] as const;

const props = withDefaults(
  defineProps<{
    open: boolean;
    tokenProviderDefinitions?: VisTokenProviderDefinition[];
    tokenProviderSavedDefinitions?: VisTokenProviderDefinition[];
    selectedTokenProviderId?: string;
    tokenProviderDraft?: VisTokenProviderDraft | null;
    tokenProviderPreview?: VisTokenProviderResultBlock | null;
    tokenProviderCommandFocusRequest?: number;
    tokenProviderBusy?: boolean;
    tokenProviderStatusMessage?: string;
    tokenProviderSectionEnabled?: boolean;
  }>(),
  {
    tokenProviderDefinitions: () => [],
    tokenProviderSavedDefinitions: () => [],
    selectedTokenProviderId: '',
    tokenProviderDraft: null,
    tokenProviderPreview: null,
    tokenProviderCommandFocusRequest: 0,
    tokenProviderBusy: false,
    tokenProviderStatusMessage: '',
    tokenProviderSectionEnabled: true,
  },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'token-provider-preset-select', presetId: string): void;
  (event: 'token-provider-select', providerId: string): void;
  (event: 'token-provider-change', draft: VisTokenProviderDraft): void;
  (event: 'token-provider-delete', providerId: string): void;
  (event: 'token-provider-move', payload: { id: string; direction: 'up' | 'down' }): void;
  (event: 'token-provider-test', draft: VisTokenProviderTestDraft): void;
  (event: 'token-provider-save', definitions: VisTokenProviderDraft[]): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const commandInputRef = ref<HTMLTextAreaElement | null>(null);
const { enterToSend } = useSettings();
const instance = getCurrentInstance();
const tokenProviderController = useVisTokenProviders(computed(() => props.tokenProviderSectionEnabled));
const localSavedDefinitions = ref<VisTokenProviderDefinition[]>([]);
const localWorkingDefinitions = ref<VisTokenProviderDraft[]>([]);
const localSelectedProviderId = ref('');
const localPreview = ref<VisTokenProviderResultBlock | null>(null);
const localCommandFocusRequest = ref(0);
const localStatusMessage = ref('');
const pendingDeleteProviderId = ref('');

const usesExternalTokenProviderState = computed(() => {
  const vnodeProps = instance?.vnode.props ?? {};
  return EXTERNAL_TOKEN_PROVIDER_PROP_NAMES.some((key) => Object.prototype.hasOwnProperty.call(vnodeProps, key));
});

const savedDefinitions = computed<VisTokenProviderDefinition[]>(() => {
  return usesExternalTokenProviderState.value ? props.tokenProviderSavedDefinitions : localSavedDefinitions.value;
});

const workingDefinitions = computed<VisTokenProviderDraft[]>(() => {
  if (!usesExternalTokenProviderState.value) return localWorkingDefinitions.value;
  const mergedDefinitions = props.tokenProviderDefinitions.map((definition) => ({
    id: definition.id,
    name: definition.name,
    command: definition.command,
  }));
  const draft = props.tokenProviderDraft;
  if (mergedDefinitions.length === 0 && draft?.id.trim()) {
    mergedDefinitions.push({
      id: draft.id,
      name: draft.name,
      command: draft.command,
    });
  }
  return mergedDefinitions;
});

const tokenProviderBusy = computed(
  () =>
    tokenProviderController.configLoading.value ||
    tokenProviderController.saving.value ||
    tokenProviderController.draftTesting.value,
);

const providerStatusMessage = computed(() => {
  if (usesExternalTokenProviderState.value) return props.tokenProviderStatusMessage.trim();
  return (
    localStatusMessage.value ||
    tokenProviderController.configError.value ||
    tokenProviderController.saveError.value ||
    ''
  );
});

const isLoadingTokenProviders = computed(
  () => !usesExternalTokenProviderState.value && tokenProviderController.configLoading.value,
);

const savedDefinitionMap = computed(() => {
  return new Map(savedDefinitions.value.map((definition) => [definition.id, definition]));
});

const savedProviderIds = computed(() => new Set(savedDefinitions.value.map((definition) => definition.id)));

const currentPreview = computed(() => {
  return usesExternalTokenProviderState.value ? props.tokenProviderPreview : localPreview.value;
});

const commandFocusRequest = computed(() => {
  return usesExternalTokenProviderState.value
    ? props.tokenProviderCommandFocusRequest
    : localCommandFocusRequest.value;
});

const selectedProviderId = computed(() => {
  return usesExternalTokenProviderState.value
    ? props.selectedTokenProviderId.trim()
    : localSelectedProviderId.value.trim();
});

function resolveSelectedProviderId(providerId: string, definitions: VisTokenProviderDraft[]) {
  if (!definitions.length) return '';
  return definitions.some((definition) => definition.id === providerId) ? providerId : definitions[0].id;
}

const editableDraft = computed<VisTokenProviderDraft | null>(() => {
  const resolvedId = resolveSelectedProviderId(selectedProviderId.value, workingDefinitions.value);
  return workingDefinitions.value.find((definition) => definition.id === resolvedId) ?? null;
});

const activeProviderId = computed(() => {
  return editableDraft.value?.id || resolveSelectedProviderId(selectedProviderId.value, workingDefinitions.value);
});

const hasProviderEntries = computed(() => workingDefinitions.value.length > 0);

const providerActionsDisabled = computed(
  () => props.tokenProviderBusy || tokenProviderBusy.value || !props.tokenProviderSectionEnabled,
);

const activeDefinitionIndex = computed(() =>
  workingDefinitions.value.findIndex((definition) => definition.id === activeProviderId.value),
);

const canMoveUp = computed(() => activeDefinitionIndex.value > 0);
const canMoveDown = computed(
  () => activeDefinitionIndex.value >= 0 && activeDefinitionIndex.value < workingDefinitions.value.length - 1,
);
const canTestDraft = computed(
  () => Boolean(editableDraft.value?.name.trim() && editableDraft.value.command.trim()),
);
const providerLimitReached = computed(() => workingDefinitions.value.length >= MAX_TOKEN_PROVIDERS);
const canSaveDraft = computed(
  () =>
    workingDefinitions.value.length > 0 &&
    workingDefinitions.value.every(
      (definition) => Boolean(definition.id.trim() && definition.name.trim() && definition.command.trim()),
    ),
);
const showDeleteConfirm = computed(
  () =>
    Boolean(activeProviderId.value) &&
    pendingDeleteProviderId.value === activeProviderId.value &&
    savedProviderIds.value.has(activeProviderId.value),
);

const previewBlockId = computed(() => currentPreview.value?.id || activeProviderId.value || 'draft');

function isUnsavedDefinition(providerId: string) {
  return !savedProviderIds.value.has(providerId);
}

function clearPendingDelete() {
  pendingDeleteProviderId.value = '';
}

function clearLocalPreview() {
  if (usesExternalTokenProviderState.value) return;
  localPreview.value = null;
}

function createSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'provider';
}

function buildNextProviderDraft() {
  const reservedIds = new Set([
    ...workingDefinitions.value.map((definition) => definition.id),
    ...savedDefinitions.value.map((definition) => definition.id),
  ]);
  let index = 1;
  while (index <= MAX_TOKEN_PROVIDERS + 1) {
    const name = index === 1 ? 'Codex' : `Codex ${index}`;
    const id = createSlug(name);
    if (!reservedIds.has(id)) return { id, name, command: '' };
    index += 1;
  }
  return {
    id: `provider-${Date.now()}`,
    name: `Codex ${workingDefinitions.value.length + 1}`,
    command: '',
  };
}

function buildPresetDraft(presetId: string) {
  if (presetId === 'codex') return buildNextProviderDraft();
  return null;
}

function replaceLocalWorkingDefinitions(nextDefinitions: VisTokenProviderDraft[], nextSelectedId = '') {
  localWorkingDefinitions.value = nextDefinitions;
  localSelectedProviderId.value = resolveSelectedProviderId(nextSelectedId, nextDefinitions);
}

function syncLocalStateFromSaved(definitions: VisTokenProviderDefinition[], preferredSelectedId = '') {
  localSavedDefinitions.value = definitions;
  replaceLocalWorkingDefinitions(
    definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      command: definition.command,
    })),
    preferredSelectedId,
  );
}

async function loadLocalTokenProviders() {
  if (usesExternalTokenProviderState.value || !props.tokenProviderSectionEnabled) return;
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  const definitions = await tokenProviderController.loadConfig();
  if (tokenProviderController.configError.value) {
    localStatusMessage.value = tokenProviderController.configError.value;
    syncLocalStateFromSaved([], '');
    return;
  }
  syncLocalStateFromSaved(definitions, localSelectedProviderId.value);
}

function requestCommandInputFocus() {
  if (usesExternalTokenProviderState.value) return;
  localCommandFocusRequest.value += 1;
}

function handlePresetSelect(presetId: string) {
  emit('token-provider-preset-select', presetId);
  if (providerActionsDisabled.value || providerLimitReached.value || usesExternalTokenProviderState.value) return;
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  const nextDraft = buildPresetDraft(presetId);
  if (!nextDraft) return;
  replaceLocalWorkingDefinitions([...localWorkingDefinitions.value, nextDraft], nextDraft.id);
  requestCommandInputFocus();
}

function handleSelectProvider(providerId: string) {
  emit('token-provider-select', providerId);
  clearPendingDelete();
  clearLocalPreview();
  if (usesExternalTokenProviderState.value) return;
  localSelectedProviderId.value = resolveSelectedProviderId(providerId, localWorkingDefinitions.value);
}

function updateLocalDraft(nextDraft: VisTokenProviderDraft) {
  replaceLocalWorkingDefinitions(
    localWorkingDefinitions.value.map((definition) =>
      definition.id === nextDraft.id ? nextDraft : definition,
    ),
    nextDraft.id,
  );
}

function handleDraftFieldChange(field: 'name' | 'command', event: Event) {
  if (!editableDraft.value) return;
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const nextDraft = {
    ...editableDraft.value,
    [field]: target.value,
  };
  emit('token-provider-change', nextDraft);
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  if (usesExternalTokenProviderState.value) return;
  updateLocalDraft(nextDraft);
}

function moveLocalDefinition(providerId: string, direction: 'up' | 'down') {
  const currentIndex = localWorkingDefinitions.value.findIndex((definition) => definition.id === providerId);
  if (currentIndex < 0) return;
  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= localWorkingDefinitions.value.length) return;
  const nextDefinitions = [...localWorkingDefinitions.value];
  const [movedDefinition] = nextDefinitions.splice(currentIndex, 1);
  nextDefinitions.splice(nextIndex, 0, movedDefinition);
  replaceLocalWorkingDefinitions(nextDefinitions, providerId);
}

function handleMoveProvider(direction: 'up' | 'down') {
  if (!activeProviderId.value) return;
  emit('token-provider-move', { id: activeProviderId.value, direction });
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  if (usesExternalTokenProviderState.value) return;
  moveLocalDefinition(activeProviderId.value, direction);
}

function deleteLocalDefinition(providerId: string) {
  const currentIndex = localWorkingDefinitions.value.findIndex((definition) => definition.id === providerId);
  const nextDefinitions = localWorkingDefinitions.value.filter((definition) => definition.id !== providerId);
  const fallbackId = nextDefinitions[Math.min(currentIndex, nextDefinitions.length - 1)]?.id ?? '';
  replaceLocalWorkingDefinitions(nextDefinitions, fallbackId);
}

function handleDeleteProvider() {
  if (!activeProviderId.value) return;
  const providerId = activeProviderId.value;
  if (savedProviderIds.value.has(providerId)) {
    pendingDeleteProviderId.value = providerId;
    return;
  }
  emit('token-provider-delete', providerId);
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  if (usesExternalTokenProviderState.value) return;
  deleteLocalDefinition(providerId);
}

function handleConfirmDelete() {
  if (!activeProviderId.value) return;
  const providerId = activeProviderId.value;
  emit('token-provider-delete', providerId);
  clearPendingDelete();
  clearLocalPreview();
  localStatusMessage.value = '';
  if (usesExternalTokenProviderState.value) return;
  deleteLocalDefinition(providerId);
}

async function handleTest() {
  if (!editableDraft.value) return;
  const draft = {
    name: editableDraft.value.name,
    command: editableDraft.value.command,
  };
  emit('token-provider-test', draft);
  clearPendingDelete();
  if (usesExternalTokenProviderState.value) return;
  localStatusMessage.value = '';
  localPreview.value = {
    id: 'draft',
    name: editableDraft.value.name.trim(),
    status: 'running',
    message: 'Provider is running',
    rows: [],
  };
  const result = await tokenProviderController.testDraft(draft);
  if (tokenProviderController.draftTestError.value) {
    localPreview.value = {
      id: 'draft',
      name: editableDraft.value.name.trim(),
      status: 'error',
      message: tokenProviderController.draftTestError.value,
      rows: [],
    };
    return;
  }
  localPreview.value = result
    ? {
        id: result.id,
        name: result.name,
        status: result.status,
        message: result.message,
        rows: result.rows,
      }
    : {
        id: 'draft',
        name: editableDraft.value.name.trim(),
        status: 'error',
        message: 'Token provider draft test failed.',
        rows: [],
      };
}

function buildSaveDrafts() {
  return workingDefinitions.value.map((definition) => ({
    id: definition.id.trim(),
    name: definition.name.trim(),
    command: definition.command.trim(),
  }));
}

function buildSavePayload() {
  const now = Date.now();
  return buildSaveDrafts().map((definition) => {
    const savedDefinition = savedDefinitionMap.value.get(definition.id);
    const updatedAt =
      savedDefinition &&
      savedDefinition.name === definition.name &&
      savedDefinition.command === definition.command
        ? savedDefinition.updatedAt
        : now;
    return {
      ...definition,
      updatedAt,
    };
  });
}

async function handleSave() {
  const saveDrafts = buildSaveDrafts();
  emit('token-provider-save', saveDrafts);
  clearPendingDelete();
  clearLocalPreview();
  if (usesExternalTokenProviderState.value) return;
  localStatusMessage.value = '';
  const savedDefinitionsResult = await tokenProviderController.saveConfig(buildSavePayload());
  if (tokenProviderController.saveError.value) {
    localStatusMessage.value = tokenProviderController.saveError.value;
    return;
  }
  syncLocalStateFromSaved(savedDefinitionsResult, activeProviderId.value);
}

function formatStatus(status: VisTokenProviderResultStatus) {
  return status.replace(/_/g, ' ');
}

watch(
  () => props.open,
  async (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      if (!usesExternalTokenProviderState.value) {
        await loadLocalTokenProviders();
      }
    } else if (el.open) {
      clearPendingDelete();
      el.close();
    }
  },
);

watch(
  [commandFocusRequest, editableDraft, () => props.open],
  ([request, draft, open], [previousRequest]) => {
    if (!open || !draft || request === previousRequest) return;
    nextTick(() => commandInputRef.value?.focus());
  },
  { flush: 'post' },
);
</script>

<style scoped>
.modal-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-backdrop:not([open]) {
  display: none;
}

.modal-backdrop::backdrop {
  background: rgba(2, 6, 23, 0.65);
}

.modal {
  width: min(920px, 95vw);
  max-height: min(760px, 90vh);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: rgba(15, 23, 42, 0.98);
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.modal-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
}

.modal-subtitle {
  font-size: 11px;
  color: #64748b;
}

.modal-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid #334155;
  border-radius: 6px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  flex: 0 0 auto;
}

.modal-close-button:hover {
  background: #1e293b;
  color: #e2e8f0;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid #1e293b;
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.45);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
}

.setting-description {
  font-size: 11px;
  color: #64748b;
}

.toggle-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-track {
  width: 36px;
  height: 20px;
  background: #334155;
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #94a3b8;
  border-radius: 50%;
  transition:
    transform 0.2s,
    background 0.2s;
}

.toggle-input:checked + .toggle-track {
  background: #3b82f6;
}

.toggle-input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: #fff;
}

.provider-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 14px;
  border: 1px solid #1e293b;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(2, 6, 23, 0.58), rgba(15, 23, 42, 0.4));
}

.provider-section.is-disabled {
  opacity: 0.72;
}

.provider-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.provider-section-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.provider-section-kicker,
.detail-eyebrow,
.preview-title {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #60a5fa;
}

.provider-section-title,
.detail-title {
  font-size: 13px;
  font-weight: 600;
  color: #f8fafc;
}

.provider-section-description,
.detail-description,
.provider-empty-copy,
.preview-message {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.provider-warning {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(245, 158, 11, 0.28);
  border-radius: 8px;
  background: rgba(120, 53, 15, 0.18);
  color: #fdba74;
  font-size: 11px;
  line-height: 1.5;
}

.provider-feedback {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 8px;
  background: rgba(69, 10, 10, 0.36);
  color: #fecaca;
  font-size: 11px;
  line-height: 1.5;
}

.provider-preset-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid #1e293b;
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.32);
}

.provider-preset-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.provider-preset-title {
  font-size: 12px;
  font-weight: 600;
  color: #f8fafc;
}

.provider-preset-description,
.provider-preset-body,
.provider-preset-placeholder-copy {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.provider-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.provider-preset-card,
.provider-preset-placeholder {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
}

.provider-preset-card {
  border: 1px solid rgba(96, 165, 250, 0.38);
  background: linear-gradient(180deg, rgba(30, 64, 175, 0.2), rgba(15, 23, 42, 0.86));
  color: #e2e8f0;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.provider-preset-card:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(37, 99, 235, 0.28), rgba(15, 23, 42, 0.92));
  border-color: rgba(147, 197, 253, 0.5);
}

.provider-preset-card:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.provider-preset-top,
.provider-preset-name-wrap,
.provider-preset-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.provider-preset-badge,
.provider-preset-kicker {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.provider-preset-badge {
  border: 1px solid rgba(96, 165, 250, 0.36);
  border-radius: 999px;
  padding: 2px 6px;
  color: #bfdbfe;
  background: rgba(2, 6, 23, 0.4);
}

.provider-preset-kicker,
.provider-preset-arrow {
  color: #60a5fa;
}

.provider-preset-name,
.provider-preset-placeholder-title {
  font-size: 13px;
  font-weight: 600;
  color: #f8fafc;
}

.provider-preset-placeholder {
  justify-content: center;
  border: 1px dashed rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.42);
}

.provider-preset-footer {
  margin-top: auto;
  font-size: 11px;
  color: #dbeafe;
}

.provider-shell {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
  gap: 12px;
  min-height: 360px;
  max-height: min(52vh, 460px);
}

.provider-list-region,
.provider-detail-region {
  min-height: 0;
  border: 1px solid #1e293b;
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.44);
}

.provider-list-region {
  overflow: hidden;
}

.provider-list-scroll {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-list-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.78);
  color: #cbd5e1;
  cursor: pointer;
  text-align: left;
}

.provider-list-item:hover {
  background: #1d2a45;
}

.provider-list-item.is-active {
  border-color: #2563eb;
  background: rgba(30, 64, 175, 0.2);
}

.provider-list-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.provider-list-badges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.provider-list-name,
.provider-empty-title,
.preview-subtitle {
  font-size: 12px;
  color: #e2e8f0;
  font-weight: 600;
}

.provider-list-order,
.provider-list-badge,
.preview-status {
  flex: 0 0 auto;
  border: 1px solid #334155;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 10px;
  color: #94a3b8;
  background: rgba(15, 23, 42, 0.88);
}

.provider-list-meta {
  font-size: 10px;
  color: #64748b;
}

.provider-empty-state,
.provider-detail-placeholder,
.preview-placeholder {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 20px;
}

.provider-detail-region {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.provider-detail-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.detail-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.delete-confirmation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 8px;
  background: rgba(69, 10, 10, 0.36);
}

.delete-confirmation-copy,
.detail-status-copy {
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.delete-confirmation-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.detail-toolbar,
.detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field-full {
  grid-column: 1 / -1;
}

.field-label {
  font-size: 11px;
  color: #94a3b8;
}

.field-input,
.field-textarea {
  background: rgba(2, 6, 23, 0.45);
  border: 1px solid #334155;
  border-radius: 8px;
  color: #e2e8f0;
  font-family: inherit;
  font-size: 12px;
  padding: 8px 10px;
  outline: none;
}

.field-input:focus,
.field-textarea:focus {
  border-color: #475569;
  background: rgba(2, 6, 23, 0.6);
}

.field-input-readonly {
  color: #64748b;
  background: rgba(2, 6, 23, 0.28);
}

.field-textarea {
  resize: vertical;
  min-height: 120px;
}

.detail-actions {
  padding: 0 14px 14px;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid rgba(51, 65, 85, 0.4);
}

.detail-status-copy {
  flex: 1 1 220px;
}

.provider-preview-region {
  flex: 0 0 auto;
  min-height: 132px;
  max-height: 200px;
  overflow: auto;
  border-top: 1px solid rgba(51, 65, 85, 0.4);
  background: rgba(2, 6, 23, 0.28);
}

.preview-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
}

.preview-block.is-ok .preview-status {
  color: #86efac;
}

.preview-block.is-running .preview-status {
  color: #93c5fd;
}

.preview-block.is-error .preview-status,
.preview-block.is-invalid_output .preview-status,
.preview-block.is-config_error .preview-status,
.preview-block.is-timed_out .preview-status,
.preview-block.is-empty .preview-status {
  color: #fca5a5;
}

.preview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.preview-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid #1e293b;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
  font-size: 11px;
}

.preview-row-left {
  color: #94a3b8;
}

.preview-row-right {
  color: #f8fafc;
  text-align: right;
}

.action-button,
.icon-action {
  border: 1px solid #334155;
  border-radius: 8px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  background: #111a2c;
  color: #e2e8f0;
}

.action-button:hover:not(:disabled),
.icon-action:hover:not(:disabled) {
  background: #1d2a45;
}

.action-button.secondary {
  color: #cbd5e1;
}

.action-button.danger {
  background: rgba(127, 29, 29, 0.66);
  border-color: rgba(248, 113, 113, 0.42);
  color: #fecaca;
}

.action-button.danger:hover:not(:disabled) {
  background: rgba(153, 27, 27, 0.78);
}

.action-button.save {
  background: #1e40af;
  border-color: #2563eb;
  color: #e2e8f0;
  font-weight: 600;
}

.action-button.save:hover:not(:disabled) {
  background: #2563eb;
}

.add-button {
  flex: 0 0 auto;
}

.icon-action {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #111a2c;
  color: #94a3b8;
  padding: 0;
}

.icon-action.danger {
  color: #fca5a5;
}

.icon-action.danger.is-pending {
  border-color: rgba(248, 113, 113, 0.42);
  background: rgba(127, 29, 29, 0.3);
}

.action-button:disabled,
.icon-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.button-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.selector-proxy {
  position: absolute;
  inset: 0;
}

@media (max-width: 780px) {
  .modal {
    width: min(95vw, 680px);
    padding: 14px;
  }

  .provider-section-header,
  .detail-header {
    flex-direction: column;
  }

  .provider-shell {
    grid-template-columns: 1fr;
    min-height: 0;
    max-height: none;
  }

  .provider-preset-grid {
    grid-template-columns: 1fr;
  }

  .provider-list-region {
    max-height: 190px;
  }

  .provider-detail-region {
    min-height: 420px;
  }

  .field-grid {
    grid-template-columns: 1fr;
  }

  .detail-actions {
    justify-content: stretch;
  }

  .delete-confirmation {
    flex-direction: column;
    align-items: flex-start;
  }

  .detail-actions .action-button {
    flex: 1 1 160px;
  }
}

@media (max-width: 560px) {
  .setting-row {
    align-items: flex-start;
  }

  .provider-section {
    padding: 12px;
  }

  .provider-list-item-top,
  .preview-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .provider-preview-region {
    max-height: 240px;
  }
}
</style>

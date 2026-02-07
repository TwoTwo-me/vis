<template>
  <aside class="side-panel" :class="{ 'is-collapsed': collapsed }">
    <button
      type="button"
      class="side-toggle"
      :aria-expanded="String(!collapsed)"
      :aria-label="collapsed ? 'Expand side panel' : 'Collapse side panel'"
      @click="emit('toggle-collapse')"
    >
      {{ collapsed ? '<' : '>' }}
    </button>
    <div v-if="!collapsed" class="side-body">
      <div class="side-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="side-tab"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="emit('change-tab', tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>
      <TodoList v-if="activeTab === 'todo'" :sessions="todoSessions" />
      <TreeView
        v-else
        :root-nodes="treeNodes"
        :expanded-paths="expandedTreePaths"
        :selected-path="selectedTreePath"
        :is-loading="treeLoading"
        :error="treeError"
        :status-by-path="treeStatusByPath"
        @toggle-dir="(path) => emit('toggle-dir', path)"
        @select-file="(path) => emit('select-file', path)"
        @open-diff="(path) => emit('open-diff', path)"
        @open-file="(path) => emit('open-file', path)"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { toRefs } from 'vue';
import TodoList from './TodoList.vue';
import TreeView, { type TreeNode } from './TreeView.vue';

type TodoItem = {
  id: string;
  content: string;
  status: string;
  priority: string;
};

type TodoPanelSession = {
  sessionId: string;
  title: string;
  isSubagent: boolean;
  todos: TodoItem[];
  loading: boolean;
  error?: string;
};

type TreeStatus = 'added' | 'modified' | 'deleted';

const props = defineProps<{
  collapsed: boolean;
  activeTab: 'todo' | 'tree';
  todoSessions: TodoPanelSession[];
  treeNodes: TreeNode[];
  expandedTreePaths: string[];
  selectedTreePath?: string;
  treeLoading: boolean;
  treeError?: string;
  treeStatusByPath: Record<string, TreeStatus>;
}>();

const emit = defineEmits<{
  (event: 'toggle-collapse'): void;
  (event: 'change-tab', value: 'todo' | 'tree'): void;
  (event: 'toggle-dir', path: string): void;
  (event: 'select-file', path: string): void;
  (event: 'open-diff', path: string): void;
  (event: 'open-file', path: string): void;
}>();

const tabs = [
  { id: 'todo' as const, label: 'TODO' },
  { id: 'tree' as const, label: 'TREE' },
];

const {
  collapsed,
  activeTab,
  todoSessions,
  treeNodes,
  expandedTreePaths,
  selectedTreePath,
  treeLoading,
  treeError,
  treeStatusByPath,
} = toRefs(props);
</script>

<style scoped>
.side-panel {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: row;
  border: 1px solid #334155;
  border-radius: 12px;
  background-clip: padding-box;
  background: rgba(12, 18, 30, 0.95);
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.35);
  overflow: hidden;
}

.side-toggle {
  width: 30px;
  border: 0;
  border-right: 1px solid rgba(100, 116, 139, 0.45);
  background: rgba(30, 41, 59, 0.92);
  color: #cbd5e1;
  cursor: pointer;
  font-size: 14px;
}

.side-toggle:hover {
  background: rgba(51, 65, 85, 0.95);
}

.side-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.side-tabs {
  display: flex;
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.42);
}

.side-tab {
  flex: 1;
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.7);
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  padding: 5px 0;
  cursor: pointer;
}

.side-tab.is-active {
  background: rgba(30, 64, 175, 0.45);
  color: #e2e8f0;
  border-color: rgba(96, 165, 250, 0.6);
}

.side-panel.is-collapsed {
  border-color: rgba(100, 116, 139, 0.45);
}

.side-panel.is-collapsed .side-toggle {
  width: 100%;
  border-right: 0;
}
</style>

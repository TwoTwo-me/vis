import { computed, ref, type Ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { createSessionKey, parseSessionKey } from '../utils/sessionKey';
import { waitForState } from '../utils/waitForState';

type CreateSessionFn = (projectId: string) => Promise<{ id: string; projectId: string }>;

function getProjectSessionIds(project: ProjectState): string[] {
  const ids: string[] = [];
  Object.values(project.sandboxes).forEach((sandbox) => {
    ids.push(...sandbox.rootSessions);
  });
  return Array.from(new Set(ids));
}

function findMostRecentSession(
  projects: Record<string, ProjectState>,
): { projectId: string; sessionId: string } | null {
  let best: { projectId: string; sessionId: string; time: number } | null = null;

  for (const [projectId, project] of Object.entries(projects)) {
    for (const sandbox of Object.values(project.sandboxes)) {
      for (const session of Object.values(sandbox.sessions)) {
        if (session.parentID) continue;
        if (session.timeArchived) continue;
        const time = session.timeUpdated ?? session.timeCreated ?? 0;
        if (!best || time > best.time) {
          best = { projectId, sessionId: session.id, time };
        }
      }
    }
  }

  return best;
}

export function useSessionSelection(
  projects: Ref<Record<string, ProjectState>>,
  createSessionFn: CreateSessionFn,
) {
  const selectedKey = ref<string>('');

  const projectMap = computed(() => projects.value);

  const selectedProjectId = computed(() => parseSessionKey(selectedKey.value)?.projectId ?? '');
  const selectedSessionId = computed(() => parseSessionKey(selectedKey.value)?.sessionId ?? '');
  const project = computed(() => {
    const parsed = parseSessionKey(selectedKey.value);
    if (!parsed) return undefined;
    return projectMap.value[parsed.projectId];
  });

  const activeDirectory = computed(() => {
    const parsed = parseSessionKey(selectedKey.value);
    if (!parsed) return '';
    const currentProject = projectMap.value[parsed.projectId];
    const sessionId = parsed.sessionId;
    if (!currentProject || !sessionId) return currentProject?.worktree ?? '';
    for (const sandbox of Object.values(currentProject.sandboxes)) {
      if (sandbox.sessions[sessionId]) return sandbox.directory;
    }
    return currentProject.worktree;
  });

  const projectDirectory = computed(() => project.value?.worktree ?? '');

  async function ensureSession(projectIdHint?: string): Promise<string> {
    const map = projectMap.value;
    const currentKey = parseSessionKey(selectedKey.value);
    let projectId = projectIdHint?.trim() || currentKey?.projectId || '';

    if (!projectId || !map[projectId]) {
      const recent = findMostRecentSession(map);
      if (recent) {
        const key = createSessionKey(recent.projectId, recent.sessionId);
        if (!key) {
          throw new Error('Failed to build session key from most recent session.');
        }
        selectedKey.value = key;
        return key;
      }
      projectId = Object.keys(map)[0] ?? 'global';
    }

    if (!projectId) {
      throw new Error('No available project for selection.');
    }

    const targetProject = map[projectId];
    const ids = getProjectSessionIds(targetProject);
    if (ids.length > 0) {
      const key = createSessionKey(projectId, ids[0] ?? '');
      if (!key) {
        throw new Error('Failed to build session key from existing session.');
      }
      selectedKey.value = key;
      return key;
    }

    const created = await createSessionFn(projectId);
    const key = createSessionKey(created.projectId || projectId, created.id);
    if (!key) {
      throw new Error('Failed to build session key for created session.');
    }
    selectedKey.value = key;
    return key;
  }

  async function switchSession(projectId: string, sessionId: string) {
    const nextProjectId = projectId.trim();
    const nextSessionId = sessionId.trim();
    if (!nextProjectId || !nextSessionId) {
      await ensureSession(nextProjectId);
      return;
    }

    await waitForState(
      () => projectMap.value,
      (projects) => {
        const nextProject = projects[nextProjectId];
        if (!nextProject) return false;
        return Object.values(nextProject.sandboxes).some((sandbox) =>
          Boolean(sandbox.sessions[nextSessionId]),
        );
      },
    );

    selectedKey.value = createSessionKey(nextProjectId, nextSessionId);
  }

  async function initialize() {
    if (selectedKey.value && parseSessionKey(selectedKey.value)) return selectedKey.value;
    return ensureSession();
  }

  return {
    selectedKey,
    selectedProjectId,
    selectedSessionId,
    project,
    activeDirectory,
    projectDirectory,
    switchSession,
    ensureSession,
    initialize,
  };
}

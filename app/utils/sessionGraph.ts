export type SessionGraphSession = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
  };
};

type SessionStatusType = 'busy' | 'idle' | 'retry';

type SessionNode = {
  key: string;
  sessionID: string;
  projectID: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  timeCreated?: number;
  timeUpdated?: number;
  retention: 'persistent' | 'ephemeral';
  lastSeenAt: number;
  lastActiveAt?: number;
};

type UpsertOptions = {
  projectIDHint?: string;
  directoryHint?: string;
  retention?: 'persistent' | 'ephemeral';
};

type RootQuery = {
  projectID?: string;
  directory?: string;
};

function normalizeDirectory(value?: string) {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\/+$/, '');
  return normalized || '/';
}

function buildSessionKey(projectID: string, sessionID: string) {
  return `${projectID}:${sessionID}`;
}

function sortByUpdatedDesc(a: SessionNode, b: SessionNode) {
  return (b.timeUpdated ?? b.timeCreated ?? 0) - (a.timeUpdated ?? a.timeCreated ?? 0);
}

export function createSessionGraphStore() {
  const nodesByKey = new Map<string, SessionNode>();
  const keysBySessionID = new Map<string, Set<string>>();
  const directoryByProjectID = new Map<string, string>();
  const projectIDByDirectory = new Map<string, string>();
  const statusByKey = new Map<string, SessionStatusType>();
  let version = 0;

  function bump() {
    version += 1;
  }

  function indexNode(node: SessionNode) {
    let keySet = keysBySessionID.get(node.sessionID);
    if (!keySet) {
      keySet = new Set<string>();
      keysBySessionID.set(node.sessionID, keySet);
    }
    keySet.add(node.key);

    const normalizedDirectory = normalizeDirectory(node.directory);
    if (normalizedDirectory && node.projectID) {
      setProjectDirectory(node.projectID, normalizedDirectory);
    }
  }

  function removeNodeIndex(node: SessionNode) {
    const keySet = keysBySessionID.get(node.sessionID);
    if (keySet) {
      keySet.delete(node.key);
      if (keySet.size === 0) keysBySessionID.delete(node.sessionID);
    }
    statusByKey.delete(node.key);
  }

  function setProjectDirectory(projectID: string, directory: string) {
    const norm = normalizeDirectory(directory);
    if (!projectID || !norm) return;
    const existing = projectIDByDirectory.get(norm);
    if (existing === projectID) return; // no change
    // Cleanup old mappings
    if (existing) {
      const oldDir = directoryByProjectID.get(existing);
      if (oldDir === norm) directoryByProjectID.delete(existing);
    }
    const oldDir = directoryByProjectID.get(projectID);
    if (oldDir && oldDir !== norm) {
      projectIDByDirectory.delete(oldDir);
    }
    projectIDByDirectory.set(norm, projectID);
    directoryByProjectID.set(projectID, norm);
    bump();
  }

  function resolveProjectIDForDirectory(directory?: string) {
    const norm = normalizeDirectory(directory);
    if (!norm) return '';
    return projectIDByDirectory.get(norm) ?? '';
  }

  function resolveNodeKey(sessionID: string, projectID?: string) {
    const keys = keysBySessionID.get(sessionID);
    if (!keys || keys.size === 0) return '';
    if (projectID) {
      const exactKey = buildSessionKey(projectID, sessionID);
      if (keys.has(exactKey)) return exactKey;
    }
    let newest: SessionNode | undefined;
    keys.forEach((key) => {
      const node = nodesByKey.get(key);
      if (!node) return;
      if (!newest || sortByUpdatedDesc(node, newest) < 0) newest = node;
    });
    return newest?.key ?? '';
  }

  function upsertSession(info: SessionGraphSession, options: UpsertOptions = {}) {
    if (!info?.id) return false;
    const existingKey = resolveNodeKey(info.id, info.projectID || options.projectIDHint);
    const existing = existingKey ? nodesByKey.get(existingKey) : undefined;
    const projectID =
      (info.projectID && info.projectID.trim()) ||
      (options.projectIDHint && options.projectIDHint.trim()) ||
      existing?.projectID ||
      '';
    if (!projectID) return false;

    const key = buildSessionKey(projectID, info.id);
    const previous = nodesByKey.get(key);
    const retention =
      options.retention ??
      previous?.retention ??
      (typeof info.parentID === 'string' && info.parentID ? 'ephemeral' : 'persistent');
    const directory =
      normalizeDirectory(info.directory) || normalizeDirectory(options.directoryHint) || previous?.directory;
    const next: SessionNode = {
      key,
      sessionID: info.id,
      projectID,
      parentID: info.parentID ?? previous?.parentID,
      title: info.title ?? previous?.title,
      slug: info.slug ?? previous?.slug,
      directory,
      timeCreated: info.time?.created ?? previous?.timeCreated,
      timeUpdated: info.time?.updated ?? previous?.timeUpdated,
      retention,
      lastSeenAt: Date.now(),
      lastActiveAt: previous?.lastActiveAt,
    };

    if (existing && existing.key !== key) {
      nodesByKey.delete(existing.key);
      removeNodeIndex(existing);
    }
    nodesByKey.set(key, next);
    indexNode(next);
    bump();
    return true;
  }

  function upsertSessions(list: SessionGraphSession[], options: UpsertOptions = {}) {
    let changed = false;
    list.forEach((item) => {
      if (upsertSession(item, options)) changed = true;
    });
    return changed;
  }

  function removeSession(sessionID: string, projectID?: string) {
    if (!sessionID) return false;
    const keys = keysBySessionID.get(sessionID);
    if (!keys || keys.size === 0) return false;
    const targets = projectID ? [buildSessionKey(projectID, sessionID)] : Array.from(keys);
    let changed = false;
    targets.forEach((key) => {
      const node = nodesByKey.get(key);
      if (!node) return;
      nodesByKey.delete(key);
      removeNodeIndex(node);
      changed = true;
    });
    if (changed) bump();
    return changed;
  }

  function setStatus(sessionID: string, status: SessionStatusType, projectID?: string) {
    const key = resolveNodeKey(sessionID, projectID);
    if (!key) return false;
    if (statusByKey.get(key) === status) return false;
    statusByKey.set(key, status);
    const node = nodesByKey.get(key);
    if (node && (status === 'busy' || status === 'retry')) {
      node.lastActiveAt = Date.now();
      node.lastSeenAt = Date.now();
    }
    bump();
    return true;
  }

  function syncStatusesForProject(projectID: string, entries: [string, SessionStatusType][]) {
    if (!projectID) return false;
    const busyKeys = new Set<string>();
    let changed = false;
    entries.forEach(([sessionID, status]) => {
      const key = resolveNodeKey(sessionID, projectID);
      if (!key) return;
      busyKeys.add(key);
      if (statusByKey.get(key) !== status) {
        statusByKey.set(key, status);
        changed = true;
      }
      const node = nodesByKey.get(key);
      if (node && (status === 'busy' || status === 'retry')) node.lastActiveAt = Date.now();
    });
    const prefix = `${projectID}:`;
    statusByKey.forEach((status, key) => {
      if (!key.startsWith(prefix)) return;
      if (busyKeys.has(key)) return;
      if (status === 'busy' || status === 'retry') {
        statusByKey.set(key, 'idle');
        changed = true;
      }
    });
    if (changed) bump();
    return changed;
  }

  function getSession(sessionID: string, projectID?: string): SessionGraphSession | undefined {
    const key = resolveNodeKey(sessionID, projectID);
    if (!key) return undefined;
    const node = nodesByKey.get(key);
    if (!node) return undefined;
    return {
      id: node.sessionID,
      projectID: node.projectID,
      parentID: node.parentID,
      title: node.title,
      slug: node.slug,
      directory: node.directory,
      time: {
        created: node.timeCreated,
        updated: node.timeUpdated,
      },
    };
  }

  function getProjectIDForSession(sessionID: string, preferredProjectID?: string) {
    const key = resolveNodeKey(sessionID, preferredProjectID);
    if (!key) return '';
    return nodesByKey.get(key)?.projectID ?? '';
  }

  function getRootSessions(query: RootQuery = {}) {
    const normalizedDirectory = normalizeDirectory(query.directory);
    const list = Array.from(nodesByKey.values())
      .filter((node) => !node.parentID)
      .filter((node) => (query.projectID ? node.projectID === query.projectID : true))
      .filter((node) => {
        if (!normalizedDirectory) return true;
        const nodeDirectory = normalizeDirectory(node.directory);
        if (!nodeDirectory) return false;
        return nodeDirectory === normalizedDirectory;
      })
      .sort(sortByUpdatedDesc)
      .map((node) => ({
        id: node.sessionID,
        projectID: node.projectID,
        parentID: node.parentID,
        title: node.title,
        slug: node.slug,
        directory: node.directory,
        time: {
          created: node.timeCreated,
          updated: node.timeUpdated,
        },
      }));
    return list;
  }

  function getParentMap(projectID?: string) {
    const map = new Map<string, string | undefined>();
    nodesByKey.forEach((node) => {
      if (projectID && node.projectID !== projectID) return;
      map.set(node.sessionID, node.parentID);
    });
    return map;
  }

  function getDirectoriesForProject(projectID: string) {
    const dir = directoryByProjectID.get(projectID);
    return dir ? [dir] : [];
  }

  function listActiveSessionKeys(projectID?: string) {
    const result: string[] = [];
    statusByKey.forEach((status, key) => {
      if (status !== 'busy' && status !== 'retry') return;
      if (projectID && !key.startsWith(`${projectID}:`)) return;
      result.push(key);
    });
    return result;
  }

  function listActiveSessions(projectID?: string) {
    return listActiveSessionKeys(projectID)
      .map((key) => nodesByKey.get(key))
      .filter((node): node is SessionNode => Boolean(node))
      .map((node) => ({
        id: node.sessionID,
        projectID: node.projectID,
        parentID: node.parentID,
        directory: node.directory,
        title: node.title,
        slug: node.slug,
        time: {
          created: node.timeCreated,
          updated: node.timeUpdated,
        },
      }));
  }

  function pruneEphemeralChildren(ttlMs: number, keepSessionIDs = new Set<string>()) {
    const now = Date.now();
    let changed = false;
    nodesByKey.forEach((node, key) => {
      if (node.retention !== 'ephemeral') return;
      if (!node.parentID) return;
      if (keepSessionIDs.has(node.sessionID)) return;
      const status = statusByKey.get(key);
      if (status === 'busy' || status === 'retry') return;
      const lastActiveAt = node.lastActiveAt ?? node.timeUpdated ?? node.timeCreated ?? node.lastSeenAt;
      if (now - lastActiveAt < ttlMs) return;
      nodesByKey.delete(key);
      removeNodeIndex(node);
      changed = true;
    });
    if (changed) bump();
    return changed;
  }

  function getKnownSessionIDs(): Set<string> {
    return new Set(keysBySessionID.keys());
  }

  function dump() {
    const nodes: Array<{
      key: string;
      sessionID: string;
      projectID: string;
      parentID?: string;
      title?: string;
      slug?: string;
      directory?: string;
      retention: string;
      status: string;
      timeCreated?: number;
      timeUpdated?: number;
      lastSeenAt: number;
      lastActiveAt?: number;
    }> = [];
    nodesByKey.forEach((node, key) => {
      nodes.push({
        key,
        sessionID: node.sessionID,
        projectID: node.projectID,
        parentID: node.parentID,
        title: node.title,
        slug: node.slug,
        directory: node.directory,
        retention: node.retention,
        status: statusByKey.get(key) ?? 'unknown',
        timeCreated: node.timeCreated,
        timeUpdated: node.timeUpdated,
        lastSeenAt: node.lastSeenAt,
        lastActiveAt: node.lastActiveAt,
      });
    });

    const directories: Record<string, string> = {};
    directoryByProjectID.forEach((dir, projectID) => {
      directories[projectID] = dir;
    });

    const projectsByDir: Record<string, string> = {};
    projectIDByDirectory.forEach((projectID, dir) => {
      projectsByDir[dir] = projectID;
    });

    return {
      version,
      nodeCount: nodesByKey.size,
      sessionCount: keysBySessionID.size,
      nodes,
      directoryByProjectID: directories,
      projectIDByDirectory: projectsByDir,
    };
  }

  return {
    getVersion: () => version,
    setProjectDirectory,
    resolveProjectIDForDirectory,
    getDirectoriesForProject,
    upsertSession,
    upsertSessions,
    removeSession,
    setStatus,
    syncStatusesForProject,
    getSession,
    getProjectIDForSession,
    getRootSessions,
    getParentMap,
    listActiveSessionKeys,
    listActiveSessions,
    pruneEphemeralChildren,
    getKnownSessionIDs,
    dump,
  };
}

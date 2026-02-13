import { computed, onUnmounted, readonly, shallowReactive } from 'vue';
import type {
  Message,
  MessageAttachment,
  MessageDiffEntry,
  MessageStatus,
  MessageUsage,
} from '../types/message';
import type {
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
  TextPart,
} from '../types/sse';
import type { SessionScope } from './useGlobalEvents';

type AssistantMessageInfo = Extract<MessageUpdatedPacket['info'], { role: 'assistant' }>;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRole(value: unknown): Message['role'] | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

function asStatus(value: unknown): MessageStatus | undefined {
  return value === 'streaming' || value === 'complete' || value === 'error' ? value : undefined;
}

function normalizeTokens(value: unknown): MessageUsage['tokens'] | undefined {
  const rec = toRecord(value);
  if (!rec) return undefined;
  const input = asNumber(rec.input);
  const output = asNumber(rec.output);
  const reasoning = asNumber(rec.reasoning);
  if (input === undefined || output === undefined || reasoning === undefined) return undefined;
  const cacheRec = toRecord(rec.cache);
  const cacheRead = asNumber(cacheRec?.read);
  const cacheWrite = asNumber(cacheRec?.write);
  return {
    input,
    output,
    reasoning,
    cache:
      cacheRead === undefined || cacheWrite === undefined
        ? undefined
        : { read: cacheRead, write: cacheWrite },
  };
}

function normalizeUsage(value: unknown): MessageUsage | undefined {
  const rec = toRecord(value);
  const tokens = normalizeTokens(rec?.tokens);
  if (!tokens) return undefined;
  return {
    tokens,
    cost: asNumber(rec?.cost),
    providerId: asString(rec?.providerId),
    modelId: asString(rec?.modelId),
    contextPercent:
      rec?.contextPercent === null ? null : (asNumber(rec?.contextPercent) ?? undefined),
  };
}

function normalizeUsageFromMessage(info: MessageUpdatedPacket['info']): MessageUsage | undefined {
  if (info.role !== 'assistant') return undefined;
  const tokens = normalizeTokens(info.tokens);
  if (!tokens) return undefined;
  return {
    tokens,
    cost: asNumber(info.cost),
    providerId: asString(info.providerID),
    modelId: asString(info.modelID),
  };
}

function normalizeMessageError(
  value: AssistantMessageInfo['error'] | undefined,
): Message['error'] | undefined {
  if (!value) return undefined;
  const message = asString(toRecord(value.data)?.message) ?? '';
  return { name: value.name, message };
}

function normalizeAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: MessageAttachment[] = [];
  for (let index = 0; index < value.length; index++) {
    const rec = toRecord(value[index]);
    if (!rec) continue;
    const url = asString(rec.url);
    if (!url) continue;
    const id = asString(rec.id) ?? `attachment:${index}:${url}`;
    const mime = asString(rec.mime) ?? asString(rec.mediaType) ?? 'application/octet-stream';
    const filename = asString(rec.filename) ?? asString(rec.name) ?? `attachment-${index + 1}`;
    result.push({ id, url, mime, filename });
  }
  return result.length > 0 ? result : undefined;
}

function normalizeDiffs(value: unknown): MessageDiffEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: MessageDiffEntry[] = [];
  for (const item of value) {
    const rec = toRecord(item);
    if (!rec) continue;
    const file = asString(rec.file) ?? asString(rec.path);
    if (!file) continue;
    result.push({
      file,
      diff: asString(rec.diff) ?? '',
      before: asString(rec.before),
      after: asString(rec.after),
    });
  }
  return result.length > 0 ? result : undefined;
}

function byTimeThenId(a: Message, b: Message): number {
  const aTime = a.time ?? 0;
  const bTime = b.time ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.id.localeCompare(b.id);
}

function resolveMessageStatus(info: MessageUpdatedPacket['info'], current?: MessageStatus): MessageStatus {
  if (info.role === 'user') return 'complete';
  if (info.error || info.finish === 'error') return 'error';
  if (info.time.completed !== undefined || info.finish) return 'complete';
  return current === 'complete' ? 'complete' : 'streaming';
}

function resolveStreamedPartText(previous: string, packet: MessagePartUpdatedPacket, part: TextPart): string {
  if (typeof packet.delta === 'string' && packet.delta.length > 0) {
    return previous + packet.delta;
  }
  return part.text;
}

export function useMessages(scope: SessionScope) {
  const messages = shallowReactive(new Map<string, Message>());
  const messagePartsById = new Map<string, Map<string, string>>();
  const messagePartOrderById = new Map<string, string[]>();

  function get(id: string): Message | undefined {
    return messages.get(id);
  }

  function setMessage(id: string, updates: Partial<Message>) {
    const existing = messages.get(id);
    if (existing) {
      messages.set(id, { ...existing, ...updates, id });
      return;
    }
    const role = updates.role ?? 'assistant';
    const sessionId = updates.sessionId;
    if (!sessionId) return;
    messages.set(id, {
      id,
      sessionId,
      role,
      content: updates.content ?? '',
      status: updates.status ?? 'streaming',
      parentId: updates.parentId,
      agent: updates.agent,
      model: updates.model,
      providerId: updates.providerId,
      modelId: updates.modelId,
      variant: updates.variant,
      time: updates.time,
      usage: updates.usage,
      attachments: updates.attachments,
      diffs: updates.diffs,
      error: updates.error ?? null,
      classification: updates.classification,
    });
  }

  function resolveStreamingContent(id: string, partId: string, content: string): string {
    const parts = messagePartsById.get(id) ?? new Map<string, string>();
    parts.set(partId, content);
    messagePartsById.set(id, parts);
    const order = messagePartOrderById.get(id) ?? [];
    if (!order.includes(partId)) order.push(partId);
    messagePartOrderById.set(id, order);
    return order.map((key) => parts.get(key) ?? '').join('');
  }

  function handleMessagePartUpdated(packet: MessagePartUpdatedPacket) {
    if (packet.part.type !== 'text') return;
    const part = packet.part;
    const messageId = part.messageID;
    const partId = part.id;
    const previous = messagePartsById.get(messageId)?.get(partId) ?? '';
    const partText = resolveStreamedPartText(previous, packet, part);
    const content = resolveStreamingContent(messageId, partId, partText);
    const existing = messages.get(messageId);
    setMessage(messageId, {
      sessionId: part.sessionID,
      role: existing?.role,
      content,
      status: existing?.status === 'error' ? 'error' : 'streaming',
      time: existing?.time,
    });
  }

  function handleMessageUpdated(packet: MessageUpdatedPacket) {
    const info = packet.info;
    const id = info.id;
    const existing = messages.get(id);
    const usage = normalizeUsageFromMessage(info);
    const error = normalizeMessageError(info.role === 'assistant' ? info.error : undefined);
    const status = resolveMessageStatus(info, existing?.status);

    setMessage(id, {
      sessionId: info.sessionID,
      role: info.role,
      parentId: info.role === 'assistant' ? info.parentID : undefined,
      content: existing?.content ?? '',
      status,
      agent: asString(info.agent),
      providerId:
        info.role === 'assistant'
          ? asString(info.providerID)
          : asString(toRecord(info.model)?.providerID),
      modelId:
        info.role === 'assistant' ? asString(info.modelID) : asString(toRecord(info.model)?.modelID),
      variant: asString(info.variant),
      time: asNumber(info.time.created),
      usage,
      diffs: info.role === 'user' ? normalizeDiffs(info.summary?.diffs) : undefined,
      error: error ?? (status === 'error' ? { name: 'Error', message: '' } : null),
    });
  }

  function getChildren(parentId: string): Message[] {
    return [...messages.values()].filter((msg) => msg.parentId === parentId).sort(byTimeThenId);
  }

  function getThread(rootId: string): Message[] {
    const root = messages.get(rootId);
    if (!root) return [];
    const result: Message[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      const message = messages.get(current);
      if (!message) continue;
      result.push(message);
      const children = getChildren(current);
      for (const child of children) queue.push(child.id);
    }
    return result.sort(byTimeThenId);
  }

  function getFinalAnswer(rootId: string): Message | undefined {
    const thread = getThread(rootId);
    const assistants = thread.filter((msg) => msg.role === 'assistant').sort(byTimeThenId);
    return assistants[assistants.length - 1];
  }

  function loadHistory(entries: unknown[]) {
    for (const entry of entries) {
      const rec = toRecord(entry);
      if (!rec) continue;
      const id = asString(rec.id);
      const sessionId = asString(rec.sessionId) ?? asString(rec.sessionID);
      if (!id || !sessionId) continue;
      setMessage(id, {
        sessionId,
        parentId: asString(rec.parentId) ?? asString(rec.parentID),
        role: asRole(rec.role) ?? 'assistant',
        content: asString(rec.content) ?? asString(rec.text) ?? '',
        status: asStatus(rec.status) ?? 'complete',
        time: asNumber(rec.time) ?? asNumber(rec.messageTime),
        usage: normalizeUsage(rec.usage),
        attachments: normalizeAttachments(rec.attachments),
        diffs: normalizeDiffs(rec.diffs),
      });
    }
  }

  function reset() {
    messages.clear();
    messagePartsById.clear();
    messagePartOrderById.clear();
  }

  const unsubscribers = [
    scope.on('message.part.updated', handleMessagePartUpdated),
    scope.on('message.updated', handleMessageUpdated),
  ];

  function dispose() {
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  onUnmounted(dispose);

  const roots = computed(() => {
    return [...messages.values()]
      .filter((msg) => !msg.parentId || !messages.has(msg.parentId))
      .sort(byTimeThenId);
  });

  const streaming = computed(() => {
    return [...messages.values()].filter((msg) => msg.status === 'streaming').sort(byTimeThenId);
  });

  return {
    messages: readonly(messages),
    roots,
    getChildren,
    getThread,
    getFinalAnswer,
    get,
    streaming,
    loadHistory,
    reset,
    dispose,
  };
}

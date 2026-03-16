export type ActiveMention = {
  start: number;
  end: number;
  text: string;
  query: string;
};

function clampCaret(text: string, caret: number) {
  if (!Number.isFinite(caret)) return text.length;
  if (caret < 0) return 0;
  if (caret > text.length) return text.length;
  return Math.trunc(caret);
}

function readSegmentStart(text: string, caret: number) {
  let index = caret;
  while (index > 0 && !/\s/.test(text[index - 1] ?? '')) index -= 1;
  return index;
}

function readSegmentEnd(text: string, caret: number) {
  let index = caret;
  while (index < text.length && !/\s/.test(text[index] ?? '')) index += 1;
  return index;
}

export function extractActiveMention(text: string, caret: number): ActiveMention | null {
  const safeCaret = clampCaret(text, caret);
  const start = readSegmentStart(text, safeCaret);
  const end = readSegmentEnd(text, safeCaret);
  const token = text.slice(start, end);
  if (!token.startsWith('@')) return null;
  if (token.length < 1) return null;
  return {
    start,
    end,
    text: token,
    query: token.slice(1),
  };
}

function scoreMatch(value: string, query: string) {
  if (!query) return 0;
  const normalizedValue = value.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedValue === normalizedQuery) return 0;
  if (normalizedValue.startsWith(normalizedQuery)) return 1;
  if (normalizedValue.includes(normalizedQuery)) return 2;
  return Number.POSITIVE_INFINITY;
}

function sortByMatch<T extends string>(values: T[], query: string) {
  return values
    .map((value) => ({
      value,
      score: scoreMatch(value, query),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.value.length !== right.value.length) return left.value.length - right.value.length;
      return left.value.localeCompare(right.value);
    })
    .map((entry) => entry.value);
}

export function rankAgentMentionCandidates(agentOptions: Array<{ id: string }>, query: string) {
  return sortByMatch(
    agentOptions.map((option) => option.id),
    query,
  ).slice(0, 10);
}

export function rankFileMentionCandidates(files: string[], query: string) {
  return sortByMatch(
    files.filter((path) => !/\s/.test(path)),
    query,
  ).slice(0, 10);
}

export function buildMentionReplacement(kind: 'agent' | 'file', value: string) {
  void kind;
  return `@${value} `;
}

export function shouldUseFileOnlyMode(query: string) {
  return query.includes('/') || query.includes('.');
}

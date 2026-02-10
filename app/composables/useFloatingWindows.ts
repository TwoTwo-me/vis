import { ref, computed, onUnmounted, type Component, type Ref } from 'vue';
import { renderWorkerHtml, type RenderRequest } from '../utils/workerRenderer';

export interface FloatingWindowEntry {
  key: string;
  component?: Component;
  props?: Record<string, unknown>;
  content?: string;
  lang?: string;
  title?: string;
  status?: 'running' | 'completed' | 'error';
  resolvedHtml: string;
  isReady: boolean;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex: number;
  closable: boolean;
  resizable: boolean;
  scroll: 'follow' | 'force' | 'manual' | 'none';
  color?: string;
  time: number;
  expiresAt: number;
  beforeOpen?: () => Promise<void>;
  afterOpen?: (el: HTMLElement) => void;
  beforeClose?: (el: HTMLElement) => Promise<void>;
  afterClose?: () => void;
  onResize?: (width: number, height: number) => void;
}

const DEFAULT_OPTS: Partial<FloatingWindowEntry> = {
  closable: false,
  resizable: false,
  scroll: 'force',
  x: 100,
  y: 100,
  width: 600,
  height: 400,
};

let zIndexCounter = 100;

function nextZIndex(): number {
  return ++zIndexCounter;
}

function getRandomPosition(): { x: number; y: number } {
  const maxX = Math.max(200, window.innerWidth - 700);
  const maxY = Math.max(100, window.innerHeight - 500);
  return {
    x: Math.floor(Math.random() * maxX) + 50,
    y: Math.floor(Math.random() * maxY) + 50,
  };
}

export function useFloatingWindows() {
  const entriesMap = new Map<string, FloatingWindowEntry>();
  const entries = computed(() => [...entriesMap.values()].filter(e => e.isReady));

  // GC timer
  const gcInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entriesMap) {
      if (entry.expiresAt < now) {
        close(key);
      }
    }
  }, 1000);

  onUnmounted(() => {
    clearInterval(gcInterval);
  });

  async function open(key: string, opts: Partial<FloatingWindowEntry>): Promise<void> {
    const existing = entriesMap.get(key);
    
    // Merge with defaults and existing
    const merged: FloatingWindowEntry = {
      ...DEFAULT_OPTS,
      ...existing,
      ...opts,
      key,
      time: Date.now(),
      zIndex: opts.zIndex ?? nextZIndex(),
    } as FloatingWindowEntry;

    // Set initial position if new
    if (!existing && !opts.x && !opts.y) {
      const pos = getRandomPosition();
      merged.x = pos.x;
      merged.y = pos.y;
    }

    // Execute beforeOpen hook
    if (merged.beforeOpen) {
      await merged.beforeOpen();
    }

    // Content resolution
    if (typeof merged.content === 'function') {
      // Async content function
      try {
        merged.resolvedHtml = await (merged.content as () => Promise<string>)();
        merged.isReady = true;
      } catch (e) {
        merged.resolvedHtml = String(e);
        merged.isReady = true;
      }
    } else if (merged.content && merged.lang) {
      // String content with lang - render via worker
      try {
        merged.resolvedHtml = await renderWorkerHtml({
          code: merged.content,
          lang: merged.lang,
          theme: 'dark', // TODO: get from app state
        });
        merged.isReady = true;
      } catch (e) {
        merged.resolvedHtml = `<pre>${merged.content}</pre>`;
        merged.isReady = true;
      }
    } else if (merged.content) {
      // Raw HTML content
      merged.resolvedHtml = merged.content;
      merged.isReady = true;
    } else {
      // No content - component handles display
      merged.resolvedHtml = '';
      merged.isReady = true;
    }

    entriesMap.set(key, merged);

    // Execute afterOpen hook
    if (merged.afterOpen) {
      // Defer to next tick to ensure DOM is ready
      setTimeout(() => {
        const el = document.querySelector(`[data-floating-key="${key}"]`);
        if (el) merged.afterOpen!(el as HTMLElement);
      }, 0);
    }
  }

  function updateOptions(key: string, partialOpts: Partial<FloatingWindowEntry>): void {
    const existing = entriesMap.get(key);
    if (!existing) return;

    entriesMap.set(key, {
      ...existing,
      ...partialOpts,
      key,
    });
  }

  async function setContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    entry.content = text;
    entry.lang = lang;

    if (lang) {
      entry.resolvedHtml = await renderWorkerHtml({
        code: text,
        lang,
        theme: 'dark',
      });
    } else {
      entry.resolvedHtml = text;
    }
  }

  async function appendContent(key: string, text: string, lang?: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    const newContent = (entry.content || '') + text;
    entry.content = newContent;

    if (lang || entry.lang) {
      entry.resolvedHtml = await renderWorkerHtml({
        code: newContent,
        lang: lang || entry.lang!,
        theme: 'dark',
      });
    } else {
      entry.resolvedHtml = newContent;
    }
  }

  function setTitle(key: string, title: string): void {
    const entry = entriesMap.get(key);
    if (entry) entry.title = title;
  }

  function setStatus(key: string, status: 'running' | 'completed' | 'error'): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.status = status;
      // Status-only optimization: if content hasn't changed, just update status
      if (status === 'completed' || status === 'error') {
        entry.expiresAt = Date.now() + 30000; // 30s TTL for completed/error
      }
    }
  }

  function bringToFront(key: string): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.zIndex = nextZIndex();
    }
  }

  function extend(key: string, ms: number): void {
    const entry = entriesMap.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + ms;
    }
  }

  async function close(key: string): Promise<void> {
    const entry = entriesMap.get(key);
    if (!entry) return;

    if (entry.beforeClose) {
      const el = document.querySelector(`[data-floating-key="${key}"]`);
      await entry.beforeClose(el as HTMLElement);
    }

    entriesMap.delete(key);

    if (entry.afterClose) {
      entry.afterClose();
    }
  }

  function closeAll(): void {
    for (const key of entriesMap.keys()) {
      close(key);
    }
  }

  function has(key: string): boolean {
    return entriesMap.has(key);
  }

  function get(key: string): FloatingWindowEntry | undefined {
    return entriesMap.get(key);
  }

  return {
    entries,
    open,
    updateOptions,
    setContent,
    appendContent,
    setTitle,
    setStatus,
    bringToFront,
    extend,
    close,
    closeAll,
    has,
    get,
  };
}

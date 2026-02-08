import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

const api = new Hono();
const UPSTREAM_EVENTS_URL = 'http://localhost:4096/event';

function removeClient(client: SSEStreamingApi) {
  clients.delete(client);
}

const clients = new Set<SSEStreamingApi>();
let isUpstreamRunning = false;

api.post('/post', async (c) => {
  const body = await c.req.json();
  const payloadText = typeof body === 'string' ? body : JSON.stringify(body);

  clients.forEach(async (client) => {
    try {
      await client.writeSSE({
        event: 'message',
        data: payloadText,
      });
    } catch {
      removeClient(client);
    }
  });

  return c.json({ status: 'OK' });
});

function createEventStream(c: Parameters<typeof streamSSE>[0]) {
  startUpstreamBridge();
  return streamSSE(
    c,
    async (stream) => {
      clients.add(stream);
      while (!stream.closed && !stream.aborted) {
        await stream.sleep(10 * 1000);
      }

      removeClient(stream);
    },
    async (_err, stream) => {
      removeClient(stream);
    },
  );
}

api.get('/events', (c) => {
  return createEventStream(c);
});

function broadcastUpstreamEvent(
  event: string | undefined,
  data: string,
  id?: string,
  retry?: string,
) {
  clients.forEach(async (client) => {
    try {
      await client.writeSSE({
        event: event ?? 'message',
        data,
        id,
        retry: retry ? Number(retry) : undefined,
      });
    } catch {
      removeClient(client);
    }
  });
}

type ParsedSseEvent = {
  event?: string;
  data: string;
  id?: string;
  retry?: string;
};

function parseSseChunk(chunk: string) {
  const lines = chunk.split('\n');
  const event: ParsedSseEvent = { data: '' };

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const index = line.indexOf(':');
    const field = index === -1 ? line : line.slice(0, index);
    const value = index === -1 ? '' : line.slice(index + 1).replace(/^\s+/, '');

    if (field === 'event') event.event = value;
    if (field === 'data') event.data = event.data ? `${event.data}\n${value}` : value;
    if (field === 'id') event.id = value;
    if (field === 'retry') event.retry = value;
  }

  if (!event.data) return null;
  return event;
}

async function connectUpstream(signal: AbortSignal) {
  const response = await fetch(UPSTREAM_EVENTS_URL, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`upstream error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const raw = buffer.slice(0, separatorIndex).replace(/\r/g, '');
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseSseChunk(raw);
      if (event) {
        let logged = event.data;
        try {
          logged = JSON.stringify(JSON.parse(event.data));
        } catch {
          logged = event.data;
        }
        console.log(logged);
        broadcastUpstreamEvent(event.event, event.data, event.id, event.retry);
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}

function startUpstreamBridge() {
  if (isUpstreamRunning) return;
  isUpstreamRunning = true;

  let attempt = 0;
  const baseDelay = 1000;
  const maxDelay = 10000;

  const run = async () => {
    while (true) {
      try {
        const controller = new AbortController();
        await connectUpstream(controller.signal);
        attempt = 0;
      } catch {
        attempt += 1;
        const delay = Math.min(maxDelay, baseDelay * Math.max(1, attempt));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  void run();
}

const app = new Hono();
app.route('/api', api);

export default app;

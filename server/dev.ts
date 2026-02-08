import { serveStatic } from '@hono/node-server/serve-static';
import app from './main';
import { fileURLToPath } from 'node:url';

app.use('/*', serveStatic({ root: fileURLToPath(import.meta.resolve('../app')) }));

export default app;

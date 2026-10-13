import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCloudApp } from './backend/src/cloud.js';

const app = new Hono();
app.route('/', createCloudApp());
app.get('*', async c => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/download/')) {
    return c.json({ error: 'Not found.' }, 404);
  }
  return c.html(await readFile(join(process.cwd(), 'public/index.html'), 'utf8'));
});
export default app;

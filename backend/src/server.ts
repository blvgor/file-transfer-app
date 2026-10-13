import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(process.env.UPLOADS_DIR || join(root, 'backend/uploads'));
const port = Number(process.env.PORT || 3000);
const maxFileSize = Number(process.env.MAX_FILE_SIZE || 10 * 1024 ** 3);
const retentionDays = Number(process.env.RETENTION_DAYS || 7);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxFileSize) ||
    maxFileSize < 1 || !Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('Invalid server configuration');
const { app, storage } = await createApp({
  directory, maxFileSize, retentionMs: retentionDays * 86400000,
  origins: (process.env.FRONTEND_URL || 'http://localhost:5173,http://127.0.0.1:5173').split(',').filter(Boolean),
});
const staticRoot = join(root, 'frontend/dist');
const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' };
app.get('*', async c => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/download/')) return c.notFound();
  const target = c.req.path.startsWith('/assets/') ? resolve(staticRoot, '.' + c.req.path) : join(staticRoot, 'index.html');
  if (!target.startsWith(staticRoot + '/')) return c.notFound();
  try {
    const content = await readFile(target);
    c.header('Content-Type', mime[extname(target)] || 'application/octet-stream');
    return c.body(Uint8Array.from(content).buffer as ArrayBuffer);
  } catch { return c.text('Build the frontend first: npm run build', 503); }
});
await storage.cleanup();
const cleanup = setInterval(() => storage.cleanup().catch(error => console.error('Cleanup failed:', error.message)), 6 * 3600000);
cleanup.unref();
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST || '127.0.0.1' }, information => {
  console.log(`File Transfer: http://${process.env.HOST || '127.0.0.1'}:${information.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(cleanup);
  server.close(() => process.exit(0));
});

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { nanoid } from 'nanoid';
import { Storage, validId } from './storage.js';

type Options = { directory: string; maxFileSize?: number; retentionMs?: number; origins?: string[] };
class TooLarge extends Error {}

export async function createApp(options: Options) {
  const maxFileSize = options.maxFileSize ?? 10 * 1024 ** 3;
  const storage = new Storage(options.directory, options.retentionMs ?? 7 * 86400000);
  await storage.init();
  const app = new Hono();
  const origins = options.origins ?? [];
  app.use('*', cors({
    origin: origin => origins.includes(origin) ? origin : '',
    allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Filename', 'Range'],
    exposeHeaders: ['Content-Disposition', 'Content-Range', 'Content-Length'],
  }));
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.get('/health', c => c.json({ status: 'ok', maxFileSize, retentionDays: storage.retentionMs / 86400000 }));

  app.post('/upload', async c => {
    let filename: string;
    try {
      filename = basename(decodeURIComponent(c.req.header('x-filename') ?? '').replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f]/g, '').trim();
    } catch { return c.json({ error: 'Invalid filename' }, 400); }
    if (!filename || filename.length > 200 || filename === '.' || filename === '..') {
      return c.json({ error: 'Filename required (up to 200 characters)' }, 400);
    }
    const declared = c.req.header('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxFileSize)) {
      return c.json({ error: 'File exceeds the configured size limit' }, 413);
    }
    const body = c.req.raw.body;
    if (!body && declared !== '0') return c.json({ error: 'No file data' }, 400);
    const id = nanoid(16);
    let size = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maxFileSize ? new TooLarge() : null, chunk);
    }});
    try {
      const source = body ? Readable.fromWeb(body as import('node:stream/web').ReadableStream) : Readable.from([]);
      await pipeline(source, counter, createWriteStream(storage.path(id), { flags: 'wx', mode: 0o600 }));
      await storage.save({ id, filename, size, uploadDate: Date.now() });
      return c.json({ id, filename, size, url: `/${id}/${encodeURIComponent(filename)}` });
    } catch (error) {
      await storage.remove(id);
      if (error instanceof TooLarge) return c.json({ error: 'File exceeds the configured size limit' }, 413);
      console.error('Upload failed:', (error as Error).message);
      return c.json({ error: 'Upload failed' }, 500);
    }
  });

  app.get('/api/file/:id', async c => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'File not found or expired' }, 404);
    const metadata = await storage.get(id);
    if (!metadata) return c.json({ error: 'File not found or expired' }, 404);
    return c.json(metadata);
  });

  app.get('/download/:id/:filename', async c => {
    const id = c.req.param('id');
    const metadata = await storage.get(id);
    if (!metadata || c.req.param('filename') !== metadata.filename) {
      return c.json({ error: 'File not found or expired' }, 404);
    }
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Type', 'application/octet-stream');
    const fallback = metadata.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(metadata.filename).replace(/[!'()*]/g,
      character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    c.header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    c.header('Accept-Ranges', 'bytes');
    let start = 0, end = metadata.size - 1;
    const range = c.req.header('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]) || metadata.size === 0) {
        c.header('Content-Range', `bytes */${metadata.size}`);
        return c.body(null, 416);
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, metadata.size - suffix);
        if (suffix === 0) start = metadata.size;
      } else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), end);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= metadata.size) {
        c.header('Content-Range', `bytes */${metadata.size}`);
        return c.body(null, 416);
      }
      c.header('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
      c.status(206);
    }
    c.header('Content-Length', String(metadata.size === 0 ? 0 : end - start + 1));
    if (metadata.size === 0) return c.body(null);
    const body = Readable.toWeb(createReadStream(storage.path(id), { start, end }));
    return c.body(body as ReadableStream);
  });
  app.onError((error, c) => {
    console.error('Request failed:', error.message);
    return c.json({ error: 'Request failed' }, 500);
  });
  return { app, storage };
}

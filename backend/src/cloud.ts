import { Hono } from 'hono';
import { head, list, del, issueSignedToken, presignUrl, BlobNotFoundError } from '@vercel/blob';
import { nanoid } from 'nanoid';

export const TRANSFER_PREFIX = 'transfers/v1/';
export const CLOUD_MAX_BYTES = 25 * 1024 ** 2;
export const CLOUD_RETENTION_MS = 7 * 86400000;
const ID = /^([a-z0-9]{8,11})_([A-Za-z0-9_-]{22})$/;

type Dependencies = {
  head: typeof head; list: typeof list; del: typeof del;
  issueSignedToken: typeof issueSignedToken; presignUrl: typeof presignUrl;
};
type Options = { dependencies?: Dependencies; now?: () => number; cronSecret?: string };

export function validFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !/[\x00-\x1f\x7f/\\]/.test(value) && value !== '.' && value !== '..' && value.trim() === value;
}
export function expiresAt(id: string) {
  const match = ID.exec(id);
  return match ? parseInt(match[1], 36) : 0;
}
export function transferPath(id: string, filename: string) {
  return `${TRANSFER_PREFIX}${id}/${filename}`;
}

export function createCloudApp(options: Options = {}) {
  const blob = options.dependencies ?? { head, list, del, issueSignedToken, presignUrl };
  const now = options.now ?? Date.now;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.get('/health', c => c.json({ status: 'ok', uploadMode: 'signed',
    maxFileSize: CLOUD_MAX_BYTES, retentionDays: CLOUD_RETENTION_MS / 86400000 }));

  app.post('/api/prepare', async c => {
    const origin = c.req.header('origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'Start the transfer from this website.' }, 403);
    }
    if (Number(c.req.header('content-length') || 0) > 4096) return c.json({ error: 'Invalid request.' }, 413);
    let input: { filename?: unknown; size?: unknown };
    try { input = await c.req.json(); } catch { return c.json({ error: 'Invalid request.' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'Invalid request.' }, 400);
    if (!validFilename(input.filename)) return c.json({ error: 'Use a filename of up to 200 characters, without slashes.' }, 400);
    if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > CLOUD_MAX_BYTES) {
      return c.json({ error: 'Choose a file between 1 byte and 25 MB.' }, 413);
    }
    const expiry = now() + CLOUD_RETENTION_MS;
    const id = `${expiry.toString(36)}_${nanoid(22)}`;
    const pathname = transferPath(id, input.filename);
    const validUntil = now() + 10 * 60000;
    const constraints = { pathname, operations: ['put' as const], validUntil,
      allowedContentTypes: ['application/octet-stream'], maximumSizeInBytes: input.size };
    const token = await blob.issueSignedToken(constraints);
    const { presignedUrl } = await blob.presignUrl(token, { operation: 'put', access: 'private',
      pathname, validUntil, allowedContentTypes: constraints.allowedContentTypes,
      maximumSizeInBytes: input.size, addRandomSuffix: false, allowOverwrite: false,
      cacheControlMaxAge: 60 });
    return c.json({ id, filename: input.filename, size: input.size, expiresAt: expiry,
      url: `/${id}/${encodeURIComponent(input.filename)}`, uploadUrl: presignedUrl });
  });

  async function metadata(id: string, filename: string | undefined) {
    const expiry = expiresAt(id);
    if (!validFilename(filename) || expiry <= now() || expiry > now() + CLOUD_RETENTION_MS + 60000) return null;
    try {
      const object = await blob.head(transferPath(id, filename));
      return { id, filename, size: object.size, uploadDate: object.uploadedAt.getTime(),
        expiresAt: expiry, url: `/${id}/${encodeURIComponent(filename)}` };
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }
  app.get('/api/file/:id', async c => {
    const file = await metadata(c.req.param('id'), c.req.query('filename'));
    return file ? c.json(file) : c.json({ error: 'File not found or expired.' }, 404);
  });
  app.get('/download/:id/:filename', async c => {
    const file = await metadata(c.req.param('id'), c.req.param('filename'));
    if (!file) return c.json({ error: 'File not found or expired.' }, 404);
    const pathname = transferPath(file.id, file.filename);
    const validUntil = Math.min(file.expiresAt, now() + 5 * 60000);
    const token = await blob.issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await blob.presignUrl(token, { pathname, operation: 'get', access: 'private', validUntil });
    const download = new URL(presignedUrl);
    download.searchParams.set('download', '1');
    return c.redirect(download.toString(), 302);
  });
  app.get('/api/cleanup', async c => {
    const secret = options.cronSecret ?? process.env.CRON_SECRET;
    if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ error: 'Unauthorized.' }, 401);
    let cursor: string | undefined;
    let removed = 0;
    do {
      const page = await blob.list({ prefix: TRANSFER_PREFIX, limit: 1000, cursor });
      const expired = page.blobs.filter(object => {
        if (!object.pathname.startsWith(TRANSFER_PREFIX)) return false;
        const id = object.pathname.slice(TRANSFER_PREFIX.length).split('/')[0];
        return expiresAt(id) > 0 && expiresAt(id) <= now();
      });
      if (expired.length) { await blob.del(expired.map(object => object.pathname)); removed += expired.length; }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return c.json({ removed });
  });
  app.onError((error, c) => {
    console.error('Blob operation failed:', error.name);
    return c.json({ error: 'The transfer service is temporarily unavailable. Please try again later.' }, 503);
  });
  return app;
}

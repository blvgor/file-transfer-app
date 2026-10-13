import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobNotFoundError } from '@vercel/blob';
import { createCloudApp, transferPath, CLOUD_MAX_BYTES, CLOUD_RETENTION_MS } from '../backend/dist/cloud.js';

const now = 1791890000000;
const active = `${(now + CLOUD_RETENTION_MS).toString(36)}_abcdefghijklmnopqrstuv`;
const expired = `${(now - 1).toString(36)}_abcdefghijklmnopqrstuv`;
function fixture() {
  const issued = [], signed = [], deleted = [], objects = new Map();
  const dependencies = {
    async head(pathname) {
      if (!objects.has(pathname)) throw new BlobNotFoundError();
      return objects.get(pathname);
    },
    async issueSignedToken(options) { issued.push(options); return { delegationToken: 'test', clientSigningToken: 'test', validUntil: options.validUntil }; },
    async presignUrl(_token, options) { signed.push(options); return { presignedUrl: 'https://files.example/'+encodeURIComponent(options.pathname) }; },
    async list() { return { blobs: Array.from(objects, ([pathname, data]) => ({ pathname, ...data })), hasMore: false }; },
    async del(paths) { deleted.push(...paths); },
  };
  const app = createCloudApp({ dependencies, now: () => now, cronSecret: 'test-only-cron' });
  return { app, dependencies, objects, issued, signed, deleted };
}
const prepare = (app, value, headers = {}) => app.request('/api/prepare', { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });

test('Upload authorisation is scoped to one immutable file, its declared size and ten minutes', async () => {
  const f = fixture();
  const response = await prepare(f.app, { filename: 'проверка файла.txt', size: 6 * 1024 ** 2 });
  assert.equal(response.status, 200);
  const transfer = await response.json();
  assert.equal(transfer.filename, 'проверка файла.txt');
  assert.equal(transfer.expiresAt, now + CLOUD_RETENTION_MS);
  assert.ok(transfer.url.endsWith(encodeURIComponent(transfer.filename)));
  assert.equal(f.issued[0].pathname, transferPath(transfer.id, transfer.filename));
  assert.deepEqual(f.issued[0].operations, ['put']);
  assert.equal(f.issued[0].maximumSizeInBytes, 6 * 1024 ** 2);
  assert.equal(f.issued[0].validUntil, now + 600000);
  assert.equal(f.signed[0].allowOverwrite, false);
  assert.equal(f.signed[0].access, 'private');
  assert.equal(JSON.stringify(transfer).includes('SigningToken'), false);
});

test('Invalid sizes, traversal filenames, malformed JSON and cross-site upload requests are rejected', async () => {
  const f = fixture();
  for (const size of [0, -1, 1.5, '4', CLOUD_MAX_BYTES + 1]) {
    assert.equal((await prepare(f.app, { filename: 'test.txt', size })).status, 413);
  }
  for (const filename of ['', '../file.txt', 'a\\b.txt', 'a\0.txt', ' x.txt', 'a'.repeat(201)]) {
    assert.equal((await prepare(f.app, { filename, size: 1 })).status, 400);
  }
  assert.equal((await prepare(f.app, null)).status, 400);
  assert.equal((await f.app.request('/api/prepare', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await prepare(f.app, { filename: 'x.txt', size: 1 }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await prepare(f.app, { filename: 'x.txt', size: 1 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(f.issued.length, 0);
});

test('Only an existing unexpired file can produce metadata or a short-lived private download', async () => {
  const f = fixture(), filename = 'report.txt';
  f.objects.set(transferPath(active, filename), { size: 123, uploadedAt: new Date(now) });
  const url = `/api/file/${active}?filename=${filename}`;
  const response = await f.app.request(url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).size, 123);
  assert.equal((await f.app.request(`/download/${active}/${filename}`)).status, 302);
  assert.deepEqual(f.issued[0].operations, ['get']);
  assert.equal(f.issued[0].validUntil, now + 300000);
  assert.equal(f.signed[0].pathname, transferPath(active, filename));
  for (const url of [`/api/file/${active}?filename=other.txt`, `/api/file/${expired}?filename=${filename}`,
    `/api/file/invalid?filename=${filename}`, `/download/${expired}/${filename}`]) {
    assert.equal((await f.app.request(url)).status, 404);
  }
  assert.equal(f.issued.length, 1);
});

test('Daily cleanup requires its secret and deletes only expired files in this application namespace', async () => {
  const f = fixture();
  f.objects.set(transferPath(expired, 'old.txt'), { size: 1 });
  f.objects.set(transferPath(active, 'current.txt'), { size: 1 });
  f.objects.set('legacy/personal.txt', { size: 1 });
  f.objects.set('transfers/v1/malformed/keep.txt', { size: 1 });
  assert.equal((await f.app.request('/api/cleanup')).status, 401);
  assert.equal(f.deleted.length, 0);
  const response = await f.app.request('/api/cleanup', { headers: { Authorization: 'Bearer test-only-cron' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 1 });
  assert.deepEqual(f.deleted, [transferPath(expired, 'old.txt')]);
});

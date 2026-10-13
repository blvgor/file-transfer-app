import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../backend/dist/index.js';

test('file transfer: Unicode, binary, ranges, restart, limits and expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-transfer-test-'));
  try {
    let { app, storage } = await createApp({ directory, maxFileSize: 1024, origins: ['http://localhost:5173'] });
    const bytes = Uint8Array.from([0, 1, 2, 3, 128, 255, 10, 13]);
    const name = 'пример файла.bin';
    const upload = await app.request('/upload', { method: 'POST', headers: {
      'x-filename': encodeURIComponent(name), origin: 'http://localhost:5173',
    }, body: bytes });
    assert.equal(upload.status, 200);
    assert.equal(upload.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const metadata = await upload.json();
    assert.match(metadata.id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(metadata.filename, name);
    assert.equal(metadata.size, bytes.length);
    assert.equal((await app.request(`/api/file/${metadata.id}`)).status, 200);
    const url = `/download/${metadata.id}/${encodeURIComponent(name)}`;
    let response = await app.request(url);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
    response = await app.request(url, { headers: { range: 'bytes=1-3' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 1-3/8');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(1, 4));
    response = await app.request(url, { headers: { range: 'bytes=-2' } });
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(-2));
    for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'invalid']) {
      assert.equal((await app.request(url, { headers: { range } })).status, 416);
    }
    assert.equal((await app.request(`/download/${metadata.id}/wrong.bin`)).status, 404);
    ({ app, storage } = await createApp({ directory, maxFileSize: 1024 }));
    assert.equal((await app.request(`/api/file/${metadata.id}`)).status, 200, 'metadata survives a new server instance');
    assert.deepEqual(new Uint8Array(await (await app.request(url)).arrayBuffer()), bytes);
    const before = await readdir(directory);
    assert.equal((await app.request('/upload', { method: 'POST', headers: { 'x-filename': 'large.bin' }, body: new Uint8Array(1025) })).status, 413);
    assert.deepEqual(await readdir(directory), before, 'oversized partial upload removed');
    assert.equal((await app.request('/upload', { method: 'POST', body: bytes })).status, 400);
    const empty = await app.request('/upload', { method: 'POST', headers: { 'x-filename': 'empty.txt', 'content-length': '0' } });
    assert.equal(empty.status, 200);
    const emptyInfo = await empty.json();
    assert.equal((await app.request(`/download/${emptyInfo.id}/empty.txt`)).status, 200);
    assert.equal((await app.request(`/download/${emptyInfo.id}/empty.txt`, { headers: { range: 'bytes=0-' } })).status, 416);
    const specialId = '______------____';
    await writeFile(storage.path(specialId), bytes);
    await storage.save({ id: specialId, filename: name, size: bytes.length, uploadDate: Date.now() });
    assert.equal((await app.request(`/api/file/${specialId}`)).status, 200, 'URL-safe _/- IDs remain downloadable');
    const path = join(directory, `${metadata.id}.json`);
    const expired = JSON.parse(await readFile(path, 'utf8'));
    expired.uploadDate = Date.now() - 8 * 86400000;
    await writeFile(path, JSON.stringify(expired));
    assert.equal((await app.request(url)).status, 404);
    assert.ok(!(await readdir(directory)).includes(`${metadata.id}.bin`));
    const orphan = join(directory, 'aaaaaaaaaaaaaaaa.bin');
    await writeFile(orphan, bytes);
    const old = new Date(Date.now() - 8 * 86400000);
    await utimes(orphan, old, old);
    await storage.cleanup();
    assert.ok(!(await readdir(directory)).includes('aaaaaaaaaaaaaaaa.bin'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

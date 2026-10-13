import test from 'node:test';
import assert from 'node:assert/strict';
import { presignUrl } from '@vercel/blob';

test('The real Blob SDK preserves UTF-8 scoped paths and still rejects a different path', async () => {
  const pathname = 'transfers/v1/test/проверка файла #+.bin';
  const validUntil = Date.now() + 600000;
  const scope = { pathname, operations: ['put'], validUntil, maximumSizeInBytes: 16,
    allowedContentTypes: ['application/octet-stream'] };
  // A local format fixture; the storage service would reject its signature.
  const token = { delegationToken: Buffer.from(JSON.stringify(scope)).toString('base64url') + '.fixture',
    clientSigningToken: 'local-format-fixture-not-a-provider-token' };
  const options = { operation: 'put', access: 'private', pathname, validUntil,
    maximumSizeInBytes: 16, allowedContentTypes: scope.allowedContentTypes,
    addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 };
  const { presignedUrl } = await presignUrl(token, options);
  assert.equal(new URL(presignedUrl).searchParams.get('pathname'), pathname);
  await assert.rejects(presignUrl(token, { ...options, pathname: 'transfers/v1/test/other.bin' }), /does not match/);
});

test('Private download URLs preserve special characters as a pathname, with no fragment', async () => {
  const pathname = 'transfers/v1/test/проверка файла #+%?.bin';
  const validUntil = Date.now() + 600000;
  const scope = { pathname, operations: ['get'], validUntil, storeId: 'fixturestore' };
  const token = { delegationToken: Buffer.from(JSON.stringify(scope)).toString('base64url') + '.fixture',
    clientSigningToken: 'local-format-fixture-not-a-provider-token' };
  const { presignedUrl } = await presignUrl(token, { operation: 'get', access: 'private', pathname, validUntil });
  const url = new URL(presignedUrl);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), pathname);
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['vercel-blob-delegation', 'vercel-blob-signature']);
});

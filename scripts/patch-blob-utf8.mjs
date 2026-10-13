import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Blob 2.8.1 decodes JSON token payloads as Latin-1 when Node exposes atob.
// Decode those bytes as UTF-8 without changing signatures or global APIs.
// Its CDN URL builder also leaves #, ? and % unescaped inside filenames.
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('@vercel/blob'));
const pkg = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'));
if (pkg.version !== '2.8.1') throw new Error('Review the Blob UTF-8 fix before changing SDK version.');
const before = 'if (typeof atob === "function") {\n    return atob(base64);\n  }';
const after = 'if (typeof atob === "function") {\n    return new TextDecoder().decode(Uint8Array.from(atob(base64), character => character.charCodeAt(0)));\n  }';
let fixed = 0;
let urlsFixed = 0;
const urlBefore = 'function constructBlobUrl(storeId, pathname, access) {\n  return `https://${storeId}.${access}.blob.vercel-storage.com/${pathname}`;\n}';
const urlAfter = 'function constructBlobUrl(storeId, pathname, access) {\n  const encodedPath = pathname.split("/").map(segment => encodeURIComponent(segment)).join("/");\n  return `https://${storeId}.${access}.blob.vercel-storage.com/${encodedPath}`;\n}';
for (const file of await readdir(dist)) {
  if (!/^chunk-.*\.(?:js|cjs)$/.test(file)) continue;
  const path = join(dist, file);
  let source = await readFile(path, 'utf8');
  const start = source.indexOf('function base64UrlDecodeToString(segment)');
  if (start < 0) continue;
  const end = source.indexOf('function tryDecodePayload(', start);
  if (end < 0) throw new Error('Unexpected Blob decoder boundary; review the fix.');
  const decoder = source.slice(start, end);
  if (!decoder.includes(after)) {
    if (!decoder.includes(before) || decoder.split(before).length !== 2) throw new Error('Unexpected Blob token decoder; review the fix.');
    source = source.slice(0, start) + decoder.replace(before, after) + source.slice(end);
  }
  fixed++;
  if (!source.includes(urlAfter)) {
    if (source.split(urlBefore).length !== 2) throw new Error('Unexpected Blob CDN URL builder; review the fix.');
    source = source.replace(urlBefore, urlAfter);
  }
  urlsFixed++;
  await writeFile(path, source);
}
if (fixed !== 2 || urlsFixed !== 2) throw new Error('Both ESM and CommonJS Blob filename fixes must be checked.');
console.log('Blob 2.8.1: UTF-8 token decoding and encoded CDN paths checked.');

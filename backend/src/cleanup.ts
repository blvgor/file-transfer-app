import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from './storage.js';
const directory = resolve(process.env.UPLOADS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../uploads'));
const days = Number(process.env.RETENTION_DAYS || 7);
if (!Number.isFinite(days) || days <= 0) throw new Error('Invalid retention period');
await new Storage(directory, days * 86400000).cleanup();
console.log('Expired uploads removed.');

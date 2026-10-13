import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Metadata = { id: string; filename: string; size: number; uploadDate: number };
export const validId = (id: string) => /^[A-Za-z0-9_-]{16}$/.test(id);

export class Storage {
  constructor(readonly directory: string, readonly retentionMs: number) {}
  path(id: string) { return join(this.directory, `${id}.bin`); }
  async init() { await mkdir(this.directory, { recursive: true }); }
  async save(metadata: Metadata) {
    const temporary = join(this.directory, `${metadata.id}.json.tmp`);
    await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(this.directory, `${metadata.id}.json`));
  }
  async remove(id: string) {
    await Promise.all(['.bin', '.json', '.json.tmp'].map(extension =>
      unlink(join(this.directory, id + extension)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      })));
  }
  async get(id: string): Promise<Metadata | null> {
    if (!validId(id)) return null;
    try {
      const metadata: Metadata = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
      if (metadata.id !== id || typeof metadata.filename !== 'string' ||
          !Number.isFinite(metadata.size) || !Number.isFinite(metadata.uploadDate)) return null;
      if (Date.now() - metadata.uploadDate >= this.retentionMs) {
        await this.remove(id);
        return null;
      }
      if ((await stat(this.path(id))).size !== metadata.size) return null;
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async cleanup() {
    await this.init();
    for (const filename of await readdir(this.directory)) {
      if (!/^[A-Za-z0-9_-]{16}\.(?:bin|json|json\.tmp)$/.test(filename)) continue;
      const id = filename.slice(0, 16);
      try {
        const information = await stat(join(this.directory, filename));
        if (Date.now() - information.mtimeMs >= this.retentionMs) await this.remove(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

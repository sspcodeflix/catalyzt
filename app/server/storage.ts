/**
 * Where original uploads live. SQLite keeps the metadata and the extracted text; the bytes go
 * through this small interface so a shared store can replace the local disk later without
 * touching callers. Keys are "<application>/<id>" and never contain path separators from users.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/;

/** Files under one directory on the server's persistent disk (HORIZON_FILES_DIR). */
export class LocalBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private pathOf(key: string) {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    return join(this.root, key);
  }

  async put(key: string, data: Buffer) {
    const p = this.pathOf(key);
    mkdirSync(dirname(p), { recursive: true });
    // Write beside, then rename: a crash never leaves a half-written file under the final name.
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data);
    writeFileSync(p, readFileSync(tmp));
    rmSync(tmp, { force: true });
  }

  async get(key: string) {
    const p = this.pathOf(key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  async delete(key: string) {
    rmSync(this.pathOf(key), { force: true });
  }
}

/** Keeps blobs in memory; for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.blobs.set(key, Buffer.from(data));
  }
  async get(key: string) {
    return this.blobs.get(key) ?? null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

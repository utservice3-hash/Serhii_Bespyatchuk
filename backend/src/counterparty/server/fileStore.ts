/**
 * Де лежать файли: документи до запитів (виписки, договори…) і PDF-досьє YouControl.
 * За замовчуванням — тека на диску сервера (CP_FILES_DIR). Є S3 / інше сховище — реалізуйте FileStore і передайте в роутер.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export interface FileStore {
  /** Зберегти байти → ключ, за яким їх потім віддати. */
  put(bytes: Uint8Array, hint: { name: string; mime: string }): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
}

export function dirFileStore(dir: string): FileStore {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error('bad key');      // ключ не виходить за теку
    return p;
  };
  return {
    async put(bytes) {
      const d = new Date();
      const key = join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), randomUUID());
      await mkdir(join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0')), { recursive: true });
      await writeFile(pathOf(key), bytes);
      return key.split(sep).join('/');
    },
    async get(key) {
      try { return new Uint8Array(await readFile(pathOf(key))); } catch { return null; }
    },
  };
}

/** Для тестів і макета: у пам'яті. */
export function memoryFileStore(): FileStore {
  const m = new Map<string, Uint8Array>();
  return {
    async put(bytes) { const k = randomUUID(); m.set(k, bytes); return k; },
    async get(key) { return m.get(key) || null; },
  };
}

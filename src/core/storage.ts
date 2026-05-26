// pattern: imperative-shell
// JSON file storage with per-key write serialization.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";

export interface Storage {
  /** Read a JSON file by relative key. Returns `fallback` if missing. */
  read<T>(key: string, fallback: T): Promise<T>;
  /** Write a JSON file by relative key (atomic). */
  write<T>(key: string, value: T): Promise<void>;
  /** Update a JSON file by reading, transforming, and writing under a per-key lock. */
  update<T>(key: string, fallback: T, fn: (current: T) => T | Promise<T>): Promise<T>;
  /** Resolve a relative key to an absolute filesystem path (used by modules for sidecar dirs). */
  pathOf(key: string): string;
}

const KEY_PATTERN = /^[\w./-]+$/;

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`storage: invalid key ${JSON.stringify(key)}`);
  }
  if (key.includes("..")) {
    throw new Error(`storage: key may not contain "..": ${JSON.stringify(key)}`);
  }
}

export function createStorage(projectDir: string): Storage {
  const root = resolve(projectDir);
  const locks = new Map<string, Promise<unknown>>();

  function pathOf(key: string): string {
    validateKey(key);
    const full = normalize(join(root, key));
    if (!full.startsWith(root)) {
      throw new Error(`storage: key escapes project dir: ${key}`);
    }
    return full;
  }

  async function readRaw<T>(key: string, fallback: T): Promise<T> {
    const path = pathOf(key);
    try {
      const text = await readFile(path, "utf8");
      return JSON.parse(text) as T;
    } catch (err) {
      if (isNotFound(err)) return fallback;
      throw err;
    }
  }

  async function writeRaw<T>(key: string, value: T): Promise<void> {
    const path = pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      key,
      next.finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      }),
    );
    return next;
  }

  return {
    read: readRaw,
    write: (key, value) => withLock(key, () => writeRaw(key, value)),
    update: async (key, fallback, fn) =>
      withLock(key, async () => {
        const current = await readRaw(key, fallback);
        const next = await fn(current);
        await writeRaw(key, next);
        return next;
      }),
    pathOf,
  };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

const SCOPE_SEGMENT = /^[\w.-]{1,128}$/;

/**
 * Wrap a Storage with an automatic key prefix so writes/reads land under
 * a per-participant namespace. Used by the kernel to provide
 * ToolInvocation.participantStorage and ModuleContext.storageFor(id) —
 * the answer to the F11 finding (Thousand-Foot Critical): tools shouldn't
 * have to remember to filter by uploader id; the storage should do it.
 *
 * Reading or writing any key on the scoped wrapper is equivalent to
 * accessing `participants/<id>/<key>` on the underlying storage.
 */
export function createScopedStorage(base: Storage, scopeId: string): Storage {
  if (!SCOPE_SEGMENT.test(scopeId)) {
    throw new Error(`storage: invalid scope id ${JSON.stringify(scopeId)}`);
  }
  const prefix = `participants/${scopeId}/`;
  const wrap = (key: string): string => `${prefix}${key}`;
  return {
    read: (key, fallback) => base.read(wrap(key), fallback),
    write: (key, value) => base.write(wrap(key), value),
    update: (key, fallback, fn) => base.update(wrap(key), fallback, fn),
    pathOf: (key) => base.pathOf(wrap(key)),
  };
}

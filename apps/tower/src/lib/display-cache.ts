import { createOwnerStorage } from "./browser-storage";
import type { BrowserOwner } from "./browser-owner";

/** Same-tab display continuity across verified runtime generations. Session,
 * principal and workspace stay in the key; storage refusal leaves memory alone. */
export function createDisplayCache<T>(owner: BrowserOwner, storage: Storage | undefined,
  assertActive: () => void, assertReadable: () => void, name: string,
  accepts: (value: unknown) => value is T) {
  const owned = createOwnerStorage({ ...owner, clientGeneration: 0 }, storage, assertActive, assertReadable);
  return {
    read(): T | undefined {
      const raw = owned.read(name);
      if (raw === null) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        if (accepts(value)) return value;
      } catch { /* Corrupt bytes cannot supply a display reading. */ }
      owned.forget(name);
      return undefined;
    },
    write(value: T) {
      if (accepts(value)) owned.write(name, JSON.stringify(value));
      else owned.forget(name);
    },
  };
}

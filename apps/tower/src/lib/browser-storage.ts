import { browserOwnerKey, captureBrowserOwner } from './browser-owner';

// What one browser remembers for the desk, under the product's name. Every
// key is namespaced `noticeos:` so it cannot collide with anything else the
// origin stores. Storage can refuse (private mode, a locked-down profile): every call here
// swallows that and answers as if nothing were stored.

/** The namespace every key the desk stores carries. */
export const STORAGE_PREFIX = "noticeos:";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The key `name` is stored under. */
export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

/** The value stored for `name`, or null. */
export function readStored(storage: KeyValueStorage | null | undefined, name: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(storageKey(name));
  } catch {
    return null;
  }
}

/** Forget `name`. */
export function forgetStored(storage: KeyValueStorage | null | undefined, name: string): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(name));
  } catch {
    // Nothing stored is nothing to forget.
  }
}

/** Owner preferences never import the origin's standalone values. Device
 * theme keeps using the existing unscoped functions. A frozen owner may still
 * render its preferences; mutation and final retirement remain separate. */
export function createOwnerStorage(identity: unknown, storage: KeyValueStorage | null | undefined,
  assertActive: () => void = () => {}, assertReadable = assertActive) {
  const ownerKey = browserOwnerKey(captureBrowserOwner(identity));
  const key = (name: string) => `${STORAGE_PREFIX}owner:${JSON.stringify([ownerKey, name])}`;
  return Object.freeze({
    read(name: string): string | null {
      assertReadable();
      try { return storage?.getItem(key(name)) ?? null; } catch { return null; }
    },
    write(name: string, value: string): void {
      assertActive();
      try { storage?.setItem(key(name), value); } catch { /* Storage refusal leaves no preference. */ }
    },
    forget(name: string): void {
      assertActive();
      try { storage?.removeItem(key(name)); } catch { /* Nothing stored is nothing to forget. */ }
    },
  });
}

import { browserOwnerKey, captureBrowserOwner } from './browser-owner';

// What one browser remembers for the desk, under the product's name. Every
// key is namespaced `noticeos:` so it cannot collide with anything else the
// origin stores. A read falls back once to the older `reindex-os:` key and
// moves the value to the new one, and forgetting a value forgets both.
// Storage can refuse (private mode, a locked-down profile): every call here
// swallows that and answers as if nothing were stored.

/** The namespace every key the desk stores carries. */
export const STORAGE_PREFIX = "noticeos:";
/** The namespace the same keys carried before the rename. */
export const LEGACY_STORAGE_PREFIX = "reindex-os:";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The key `name` is stored under. */
export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

/**
 * The value stored for `name`, or null. A value found only under the
 * pre-rename key is moved to the new key on the way out, so the next read (and
 * every write) sees one key.
 */
export function readStored(storage: KeyValueStorage | null | undefined, name: string): string | null {
  if (!storage) return null;
  try {
    const current = storage.getItem(storageKey(name));
    if (current !== null) return current;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}${name}`;
    const legacy = storage.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      storage.setItem(storageKey(name), legacy);
      storage.removeItem(legacyKey);
    } catch {
      // A storage that reads but will not write keeps answering from the old key.
    }
    return legacy;
  } catch {
    return null;
  }
}

/** Forget `name` under both its keys, so an old value cannot come back. */
export function forgetStored(storage: KeyValueStorage | null | undefined, name: string): void {
  if (!storage) return;
  try {
    storage.removeItem(storageKey(name));
    storage.removeItem(`${LEGACY_STORAGE_PREFIX}${name}`);
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

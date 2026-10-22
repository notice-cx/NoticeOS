// This must run before matcher/React setup or test collection: a broken storage
// environment otherwise turns cleanup errors into duplicate DOMs later on.
export function assertBrowserStorage(): void {
  try {
    for (const name of ["localStorage", "sessionStorage"] as const) {
      const storage = globalThis[name];
      if (!(storage instanceof Storage)) throw new Error(`${name} is not jsdom Storage`);
      const key = "noticeos:test-storage-probe";
      const previous = storage.getItem(key);
      try {
        storage.setItem(key, "ready");
        if (storage.getItem(key) !== "ready") throw new Error(`${name} does not retain values`);
      } finally {
        if (previous === null) storage.removeItem(key);
        else storage.setItem(key, previous);
      }
    }
  } catch (cause) {
    throw new Error("Tower tests require usable jsdom localStorage and sessionStorage; run with the Tower Vitest worker configuration (--no-experimental-webstorage).", { cause });
  }
}

if (typeof document !== "undefined") assertBrowserStorage();

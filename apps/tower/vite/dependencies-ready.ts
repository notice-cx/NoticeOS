// Every page's libraries come from one build of Vite's dependency cache.
//
// A restarted dev server starts transforming the open tabs' modules while it
// is still being created, and Vite reads that cache only once the new server
// listens. Against an empty cache those modules' imports count as new
// libraries, Vite rebuilds the cache from them alone, dropping every library
// they did not import, and a page can load React from two builds ("Invalid
// hook call", and no screen drawn). Reading the cache as soon as the server
// exists, and holding every request and client transform until it is read,
// closes that gap.

import type { Connect, Plugin, ViteDevServer } from "vite";

export function dependenciesReady(): Plugin {
  let ready: Promise<void> = Promise.resolve();
  return {
    name: "noticeos-dependencies-ready",
    apply: "serve",
    // First of the `pre` plugins, so no other middleware answers before it.
    enforce: "pre",
    configureServer(server) {
      ready = settled(readDependencies(server));
      server.middlewares.use(holdUntil(ready));
    },
    async transform() {
      if (this.environment.name === "client") await ready;
      return undefined;
    },
  };
}

/** Starts the client optimizer's cache read now. Vite calls the same `init`
 * when the server listens; the optimizer runs it once. */
function readDependencies(server: ViteDevServer): Promise<void> {
  const optimizer = server.environments.client?.depsOptimizer;
  return optimizer ? optimizer.init() : Promise.resolve();
}

/** A failed read is Vite's to report; nothing waits on it. */
function settled(read: Promise<unknown>): Promise<void> {
  return read.then(
    () => undefined,
    () => undefined,
  );
}

/** Passes each request on once `ready` settles. */
export function holdUntil(ready: Promise<unknown>): Connect.NextHandleFunction {
  const done = settled(ready);
  return (_req, _res, next) => {
    void done.then(() => next());
  };
}

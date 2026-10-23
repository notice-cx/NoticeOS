// Miniflare from a wrangler install, taking options in Miniflare 4's shape:
// one Worker's options at the top level, or `workers`, each with `script`,
// `bindings`, `serviceBindings` and the rest. Miniflare 5 takes another shape
// and converts this one with convertV4MiniflareOptions, as wrangler does. Its
// renames: the runtime's output goes to `handleStructuredLogs` (not
// `handleRuntimeStdio`), and persisted state sits under
// `resourcePersistencePath` (not `defaultPersistRoot`), in the same folders.

type Options = Record<string, unknown>;
interface MiniflareModule {
  Miniflare: new (options: Options) => { setOptions(options: Options): Promise<void> };
  Log: new (level: number) => unknown;
  convertV4MiniflareOptions(options: Options): Options;
}

/** `load` requires from the wrangler package whose Miniflare runs. */
export function v4Miniflare<Runtime>(load: (id: string) => unknown): {
  Miniflare: new (options: Options) => Runtime; Log: new (level: number) => unknown;
} {
  const miniflare = load('miniflare') as MiniflareModule;
  const convert = (options: Options) => miniflare.convertV4MiniflareOptions(options);
  class V4Miniflare extends miniflare.Miniflare {
    constructor(options: Options) { super(convert(options)); }
    override setOptions(options: Options) { return super.setOptions(convert(options)); }
  }
  return { Miniflare: V4Miniflare as unknown as new (options: Options) => Runtime, Log: miniflare.Log };
}

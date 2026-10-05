// `with { type: 'json' }` is REQUIRED HERE and nowhere else in the repo, and
// the difference is which tool reads the file (bead `ro-rcny`). Vite, wrangler's
// esbuild and vitest all inline a JSON import and need no attribute — which is
// why `apps/tower/vite.config.ts` imports this same file without one. This
// module is different because `packages/contract` is the one workspace whose
// build EMITS JavaScript, and tsc copies the specifier through verbatim: the
// emitted module is plain Node ESM, where a JSON import without the attribute
// is an ERR_IMPORT_ATTRIBUTE_MISSING at load time rather than a build error.
// `scripts/contract-dist.test.mjs` loads every emitted module under Node so
// that stays a red gate instead of a note.
import constants from '../../../config/constants.json' with { type: 'json' };
import { parseOsTimeZone } from './time-zone-setting.js';

/**
 * The operator's clock AS COMPILED: `config/constants.json` `os_time_zone` from
 * the checkout this bundle was built from.
 *
 * IT IS CONFIGURATION, NOT A CONSTANT (bead ro-py40). It used to be a string
 * literal here, which meant a self-hoster in another timezone edited a
 * TypeScript file in a package they do not otherwise touch. It now comes from
 * `config/constants.json` `os_time_zone`, the machine-readable seed both
 * Workers already import ([`config/constants.README.md`]), and `/settings`
 * saves it through the ordinary write lane (D18).
 *
 * AND IT IS ONLY THE FALLBACK (bead ro-ujb9.88). Since D22 the saved value
 * lives in the config store and a Settings save changes it without a rebuild,
 * so nothing reads days in this constant directly any more: every reader
 * resolves `savedOsTimeZone(storedConstants, OS_TIME_ZONE)`
 * (`./time-zone-setting.ts`) — the store's answer when it has one, this when it
 * does not. The ingest passes it as that fallback; the Tower's own fallback is
 * the same file injected by `vite.config.ts` (`__OS_TIME_ZONE__`).
 *
 * Validation and the store-first read live in `./time-zone-setting.ts`, which
 * imports no config, so browser code never loads this module.
 */
export const OS_TIME_ZONE: string = parseOsTimeZone(constants.os_time_zone);

// `with { type: 'json' }` is required here: this package's build emits plain
// Node ESM and tsc copies the specifier through verbatim, so without the
// attribute the emitted module fails at load time with
// ERR_IMPORT_ATTRIBUTE_MISSING. Bundlers inline the import and need none.
import constants from '../../../config/constants.json' with { type: 'json' };
import { parseOsTimeZone } from './time-zone-setting.js';

/**
 * The operator's clock as compiled: `config/constants.json` `os_time_zone`
 * from the checkout this bundle was built from. Only the fallback: the saved
 * value lives in the config store, and every reader resolves
 * `savedOsTimeZone(storedConstants, OS_TIME_ZONE)` (`./time-zone-setting.ts`,
 * which imports no config, so browser code never loads this module).
 */
export const OS_TIME_ZONE: string = parseOsTimeZone(constants.os_time_zone);

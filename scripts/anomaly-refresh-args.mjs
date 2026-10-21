export const ANOMALY_REFRESH_USAGE = 'Usage: pnpm os:refresh-anomalies -- --asset <id> [--apply <preview-token>]';

/** Check the full command before selecting an installation or reading a token. */
export function anomalyRefreshArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] === '--asset' ? 'asset' : args[i] === '--apply' ? 'apply' : null;
    if (!key || options[key] !== undefined || typeof args[i + 1] !== 'string') throw new Error(ANOMALY_REFRESH_USAGE);
    options[key] = args[i + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/u.test(options.asset ?? '')
    || options.apply !== undefined && !/^\d{13}\.[a-f0-9]{64}$/u.test(options.apply)) throw new Error(ANOMALY_REFRESH_USAGE);
  return options;
}

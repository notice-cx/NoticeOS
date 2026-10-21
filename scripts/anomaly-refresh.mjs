#!/usr/bin/env node
// Preview or apply current count-alert re-evaluation from stored reports, without provider calls.
//   pnpm os:refresh-anomalies -- --asset <id> [--apply <preview-token>]
// Preview prints the bounded plan and its ten-minute token; apply rechecks the
// stored inputs and preserves report history, freshness and operator decisions.
import { ANOMALY_REFRESH_USAGE, anomalyRefreshArgs } from './anomaly-refresh-args.mjs';
import { DEFAULT_DOOR, doorUrl, localDoorFetch, operatorToken } from './ingest-door.mjs';
import { invokedDirectly } from './invoked-directly.mjs';

export async function main(argv = process.argv.slice(2), { token = operatorToken, fetchImpl = localDoorFetch, door = DEFAULT_DOOR,
  out = process.stdout, err = process.stderr } = {}) {
  const args = argv.filter((arg) => arg !== '--');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { out.write(`${ANOMALY_REFRESH_USAGE}\n`); return 0; }
  let options;
  try { options = anomalyRefreshArgs(args); }
  catch { err.write(`${ANOMALY_REFRESH_USAGE}\n`); return 2; }
  try {
    const response = await fetchImpl(doorUrl(door, '/api/anomaly-refresh'), { method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(options), signal: AbortSignal.timeout(120_000) });
    const body = await response.json();
    if (!response.ok) {
      const code = typeof body?.error === 'string' && /^[a-z_]{1,64}$/u.test(body.error) ? body.error : 'request_failed';
      err.write(`Anomaly refresh refused: ${code}. Preview again before applying.\n`); return 1;
    }
    out.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  } catch {
    err.write('Anomaly refresh did not return a confirmed result. Retry the same apply token, or preview current state.\n');
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();

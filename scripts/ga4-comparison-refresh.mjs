#!/usr/bin/env node
// Read every GA4 property's last-week activity comparison now, instead of at its next hourly attempt.
//   pnpm os:refresh-comparison
// Each site makes the two Core report requests the hourly read makes. The
// result is stored and shown on the Wall as a scheduled read's is; a site whose
// read is refused prints the code naming the failed check.
import { DEFAULT_DOOR, doorUrl, localDoorFetch, operatorToken } from './ingest-door.mjs';
import { invokedDirectly } from './invoked-directly.mjs';

export const COMPARISON_REFRESH_USAGE = 'Usage: pnpm os:refresh-comparison';
const SAFE_CODE = /^[a-z0-9_-]{1,96}$/u;

/** One line per site, in the order the ingest read them. */
export function comparisonRefreshLines(sites) {
  if (!sites.length) return ['No site has a GA4 property to read.'];
  return sites.map(site => site.ok
    ? `${site.asset}: comparison stored`
    : `${site.asset}: refused (${SAFE_CODE.test(site.code ?? '') ? site.code : 'unknown'})`);
}

export async function main(argv = process.argv.slice(2), { token = operatorToken, fetchImpl = localDoorFetch, door = DEFAULT_DOOR,
  out = process.stdout, err = process.stderr } = {}) {
  const args = argv.filter((arg) => arg !== '--');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { out.write(`${COMPARISON_REFRESH_USAGE}\n`); return 0; }
  if (args.length) { err.write(`${COMPARISON_REFRESH_USAGE}\n`); return 2; }
  try {
    const response = await fetchImpl(doorUrl(door, '/api/ga4-comparison-refresh'), { method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(120_000) });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body?.sites)) {
      const code = typeof body?.error === 'string' && SAFE_CODE.test(body.error) ? body.error : 'request_failed';
      err.write(`Comparison refresh refused: ${code}.\n`); return 1;
    }
    out.write(`${comparisonRefreshLines(body.sites).join('\n')}\n`);
    return body.sites.every(site => site.ok) ? 0 : 1;
  } catch {
    err.write('Comparison refresh did not return a result. pnpm os:logs -- noticeos shows why.\n');
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();

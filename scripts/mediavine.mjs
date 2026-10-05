#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const USAGE = `Usage:
  pnpm mediavine status --asset example.com
  pnpm mediavine sites
  pnpm mediavine sync --asset example.com [--start YYYY-MM-DD --end YYYY-MM-DD]

Options: --url <NoticeOS URL> (default http://127.0.0.1:5173)
Connect Mediavine and start its sites in NoticeOS first. Output is JSON. Sync uses
NoticeOS's saved session, request limits and revenue store.
`;

export function parseArgs(argv) {
  const args = argv.filter(arg => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const command = args.shift();
  if (!['status', 'sites', 'sync'].includes(command)) throw new Error('Choose status, sites or sync. Use --help for examples.');
  const options = { command, url: 'http://127.0.0.1:5173' };
  while (args.length) {
    const flag = args.shift();
    if (!['--asset', '--start', '--end', '--url'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    options[flag.slice(2)] = value;
  }
  const base = new URL(options.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('--url must be a NoticeOS origin, without credentials or a path.');
  if (command !== 'sites' && !options.asset) throw new Error('--asset is required.');
  if ((options.start || options.end) && command !== 'sync') throw new Error('Dates are only valid for sync.');
  if (!!options.start !== !!options.end) throw new Error('Supply both --start and --end.');
  return options;
}

export async function run(options, fetcher = fetch) {
  const url = new URL(`/api/integrations/mediavine/${options.command}`, options.url);
  if (options.command === 'status') url.searchParams.set('asset', options.asset);
  // `sites` is the connect panel's own listing (bead ro-ujb9.96.7.6).
  const method = options.command === 'sync' ? 'POST' : 'GET';
  const response = await fetcher(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { origin: url.origin, 'content-type': 'application/json', accept: 'application/json' },
    ...(options.command === 'sync' ? { body: JSON.stringify({ asset: options.asset, start: options.start, end: options.end }) } : {}),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`NoticeOS did not return JSON (HTTP ${response.status}). Check its URL and access settings.`); }
  if (options.command === 'sites') {
    if (!response.ok || typeof result?.discovery !== 'object' || result.discovery === null) throw new Error(`NoticeOS refused the request (HTTP ${response.status}).`);
    if (result.discovery.ok !== true) throw new Error(`Mediavine's sites could not be read: ${result.discovery.reason}.`);
    return result.discovery.sites;
  }
  if (!response.ok || result?.ok !== true) throw new Error(result?.message ?? `NoticeOS refused the request (HTTP ${response.status}).`);
  return result.value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(options.help ? USAGE : JSON.stringify(await run(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mediavine command failed.');
    process.exitCode = 1;
  }
}

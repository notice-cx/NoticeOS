#!/usr/bin/env node
// The installation's MCP server over stdio: `pnpm os:mcp` (or the folder's
// `noticeos mcp`) runs it inside the app container, for an agent on this
// machine that cannot reach the Tower's own /api/mcp, as when the Tower
// listens on the network. The endpoint is standalone-mcp.mts's.
//
//   --actor <name>  Who the task projects record for this agent's changes (default: agent).
//
// stdout carries MCP messages only; anything else goes to stderr.
import { DATABASE_URL, readDevSecretBindings } from './dev-secrets.mjs';
import { MCP_PATH } from './hosted-mcp.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { serveMcpStdio } from './mcp-stdio.mjs';
import { SECRET_FILES } from './runner/config.mjs';
import { ACTOR_HEADER, openStandaloneMcp, STANDALONE_MCP_ORIGIN } from './standalone-mcp.mjs';

const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HELP = 'Usage: local-mcp.mjs [--actor <name>]';

export function parseOptions(argv) {
  if (argv.length === 0) return { actor: 'agent' };
  if (argv.length === 2 && argv[0] === '--actor' && ACTOR.test(argv[1])) return { actor: argv[1] };
  throw new Error(`${HELP}\nAn actor is 1–128 of A–Z a–z 0–9 . _ : / - starting with a letter or digit.`);
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, err = process.stderr,
  secretFiles = SECRET_FILES } = {}) {
  let options;
  try { options = parseOptions(argv); } catch (error) { err.write(`${error.message}\n`); return 2; }
  let mcp;
  try {
    const { bindings } = await readDevSecretBindings(secretFiles);
    mcp = await openStandaloneMcp({ databaseUrl: bindings[DATABASE_URL] });
  } catch (error) {
    err.write(`NoticeOS MCP could not reach the installation's database: ${error.message}\n`);
    return 1;
  }
  try {
    err.write(`NoticeOS MCP: serving this installation's tasks and reports as ${options.actor}.\n`);
    await serveMcpStdio(mcp.handle, { input, output, url: STANDALONE_MCP_ORIGIN + MCP_PATH, headers: { [ACTOR_HEADER]: options.actor } });
    return 0;
  } finally {
    await mcp.close();
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();

/** MCP's stdio transport in front of an MCP POST handler (mcp-protocol.mts):
 * each line read is one JSON-RPC message, posted to the handler as the HTTP
 * transport carries it, and each answer is written as one line. A stdio
 * client sends no headers, so the routing headers a 2026-07-28 message needs
 * are taken from the message itself. Messages are answered concurrently, each
 * with its own id; nothing but answers is ever written.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

export interface McpStdioOptions {
  readonly input: Readable;
  readonly output: Writable;
  /** The URL each message is posted to: the handler's own route. */
  readonly url: string;
}

/** The headers the HTTP transport would carry for this message. */
function headersFor(line: string): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  let message: { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } };
  try { message = JSON.parse(line) as typeof message; } catch { return headers; }
  const version = message?.params?._meta?.[META_VERSION];
  if (typeof version !== 'string' || typeof message.method !== 'string') return headers;
  headers.set('mcp-protocol-version', version);
  headers.set('mcp-method', message.method);
  const name = message.params?.name;
  if (message.method === 'tools/call' && typeof name === 'string') {
    headers.set('mcp-name', /^[\x20-\x7e]*$/u.test(name) ? name : `=?base64?${Buffer.from(name).toString('base64')}?=`);
  }
  return headers;
}

/** Serves until `input` ends and every answer is written. */
export async function serveMcpStdio(handle: (request: Request) => Promise<Response>, options: McpStdioOptions): Promise<void> {
  const { input, output, url } = options;
  const pending = new Set<Promise<void>>();
  const answer = async (line: string) => {
    let text: string;
    try {
      const response = await handle(new Request(url, { method: 'POST', headers: headersFor(line), body: line }));
      text = response.status === 202 ? '' : (await response.text()).trim();
    } catch {
      let id: unknown = null;
      try { id = (JSON.parse(line) as { id?: unknown }).id ?? null; } catch { /* Unparseable: answered with no id. */ }
      text = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'the server failed; see its log' } });
    }
    if (text) output.write(`${text}\n`);
  };
  for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
    const line = raw.trim();
    if (!line) continue;
    const done: Promise<void> = answer(line).finally(() => { pending.delete(done); });
    pending.add(done);
  }
  await Promise.all(pending);
}

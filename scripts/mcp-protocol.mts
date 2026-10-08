/** The Model Context Protocol over one POST route, in both of its eras: the
 * 2026-07-28 revision, where every request describes itself (a protocol
 * version and the client's capabilities in `params._meta`, routing headers
 * that must agree with the body, `server/discover` in place of a handshake),
 * and the initialize-based revisions before it. The hosted task endpoint
 * (hosted-task-mcp) and the Tower's `/api/mcp` (apps/tower/worker/mcp-route)
 * share it (epic ro-cvl9); each supplies its own tools and admission.
 *
 * Stateless in both eras: no session id is issued, nothing is streamed, and a
 * GET is refused. A request is modern exactly when its `_meta` names a
 * protocol version; anything else is answered as the version its
 * MCP-Protocol-Version header names, or 2025-03-26 when it names none.
 */
import { jsonContentType, readBoundedJsonText } from './bounded-json-body.mjs';

export const MCP_MODERN_VERSIONS: readonly string[] = Object.freeze(['2026-07-28']);
export const MCP_LEGACY_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
export const MCP_ERRORS = Object.freeze({
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603,
  headerMismatch: -32020, unsupportedVersion: -32022,
});
/** How long a client may reuse what server/discover and tools/list return. */
const LIST_TTL_MS = 300_000;
const DEFAULT_BODY_BYTES = 64 * 1024;

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
export interface McpServer {
  readonly info: Readonly<{ name: string; version: string }>;
  readonly instructions?: string;
  readonly tools: readonly McpTool[];
  /** Runs a listed tool. Throw McpToolError for an answer the model should
   * read; anything else is a fault and is never echoed. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface McpServeOptions {
  /** The only browser origin allowed to call; by default the request's own. */
  readonly origin?: string;
  readonly maxBytes?: number;
  /** Sees the parsed body before any method runs and may answer instead. */
  readonly screen?: (body: unknown) => Response | null;
  /** Sees each request's message before its method runs and may answer
   * instead: the place an endpoint asks for a scope the call needs. */
  readonly authorize?: (message: McpMessage) => Response | null;
}
/** A tool's own refusal, returned to the model as an error result it can read. */
export class McpToolError extends Error {
  override name = 'McpToolError';
}
/** A JSON-RPC message refused before any method runs. */
export class McpRefused extends Error {
  override name = 'McpRefused';
  constructor(readonly code: number, message: string, readonly status: number,
    readonly id: string | number | null = null, readonly data?: unknown) { super(message); }
}
export interface McpMessage {
  /** Absent for a notification. */
  readonly id?: string | number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The 2026-07-28 era's marker: the version named in `params._meta`. */
  readonly version: string | null;
}

type Row = Record<string, unknown>;
function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function malformed(): never { throw new SyntaxError('malformed'); }

/** JSON with no duplicate keys and bounded depth and size: a hidden duplicate
 * cannot make two readers of one request disagree. */
export function strictJson(text: string, maxNodes = 16_384, maxDepth = 16): unknown {
  let at = 0, nodes = 0;
  const space = () => { while (at < text.length && ' \t\r\n'.includes(text[at]!)) at++; };
  const token = (pattern: RegExp): string => {
    pattern.lastIndex = at; const found = pattern.exec(text); if (!found) malformed();
    at = pattern.lastIndex; return found[0];
  };
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy;
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
  const value = (depth: number): unknown => {
    if (depth > maxDepth || ++nodes > maxNodes) malformed();
    space();
    const next = text[at];
    if (next === '{') {
      // Ordinary objects, which every structured clone and Worker RPC carries;
      // defineProperty keeps a "__proto__" key an own field, never a prototype.
      at++; const result: Row = {}; space();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        space(); const key = JSON.parse(token(STRING)) as string;
        if (Object.hasOwn(result, key)) malformed();
        space(); if (text[at++] !== ':') malformed();
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); space();
        if (text[at] === ',') { at++; continue; }
        if (text[at++] !== '}') malformed(); return result;
      }
    }
    if (next === '[') {
      at++; const result: unknown[] = []; space();
      if (text[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space();
        if (text[at] === ',') { at++; continue; }
        if (text[at++] !== ']') malformed(); return result;
      }
    }
    if (next === '"') return JSON.parse(token(STRING)) as string;
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return literal; }
    }
    return Number(token(NUMBER));
  };
  const result = value(0); space();
  if (at !== text.length) malformed();
  return result;
}

/** Each method's params; a method not named here is parsed but unknown. */
const PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  initialize: ['protocolVersion', 'capabilities', 'clientInfo', '_meta'],
  ping: ['_meta'],
  'server/discover': ['_meta'],
  'tools/list': ['cursor', '_meta'],
  'tools/call': ['name', 'arguments', '_meta'],
  'notifications/initialized': ['_meta'],
  'notifications/cancelled': ['requestId', 'reason', '_meta'],
});
export const MCP_METHODS: readonly string[] = Object.freeze(Object.keys(PARAMS));

/** The shape every reader of an MCP body agrees on, the Tower's request
 * classifier included: one JSON-RPC 2.0 message, never a batch, with a
 * non-null id, and only the params its method defines. */
function invalid(message: string): never { throw new McpRefused(MCP_ERRORS.invalidRequest, message, 400); }
export function parseMcpMessage(value: unknown): McpMessage {
  if (Array.isArray(value)) invalid('batches are not supported');
  if (!isRow(value) || Object.keys(value).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))
    || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method || value.method.length > 128) {
    invalid('expected one JSON-RPC 2.0 message');
  }
  const { id, method } = value as { id: unknown; method: string };
  if (id !== undefined && !(typeof id === 'string' && id.length <= 512) && !Number.isSafeInteger(id)) {
    invalid('a request id is a string or an integer');
  }
  const replyId = (id ?? null) as string | number | null;
  const params: unknown = value.params === undefined ? Object.freeze({}) : value.params;
  function refuse(message: string): never { throw new McpRefused(MCP_ERRORS.invalidParams, message, 400, replyId); }
  if (!isRow(params)) refuse('params must be an object');
  const allowed = PARAMS[method];
  if (allowed && Object.keys(params).some(key => !allowed.includes(key))) refuse(`${method} takes only ${allowed.join(', ')}`);
  const meta = params._meta;
  if (meta !== undefined && (!isRow(meta) || Object.keys(meta).length > 32)) refuse('_meta must be an object');
  const version: unknown = isRow(meta) ? meta[META_VERSION] : undefined;
  if (version !== undefined && (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(version))) refuse(`${META_VERSION} must be a version`);
  if (method === 'tools/call') {
    if (typeof params.name !== 'string' || !params.name || params.name.length > 128) refuse('tools/call needs a tool name');
    if (params.arguments !== undefined && !isRow(params.arguments)) refuse('tool arguments must be an object');
  }
  return Object.freeze({ ...(id === undefined ? {} : { id: id as string | number }), method, params,
    version: typeof version === 'string' ? version : null });
}

// ─── Replies ──────────────────────────────────────────────────────────────────
function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function rpcError(id: string | number | null, code: number, message: string, status = 200, data?: unknown,
  headers: Record<string, string> = {}): Response {
  return reply({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status, headers);
}
function refusal(error: McpRefused): Response {
  return rpcError(error.id, error.code, error.message, error.status, error.data);
}
/** A 2026-07-28 header may carry a non-ASCII value as =?base64?…?=. */
function headerText(value: string | null): string | null {
  const encoded = value === null ? null : /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/iu.exec(value);
  if (!encoded) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(encoded[1]!), char => char.charCodeAt(0)));
  } catch { return null; }
}

async function toolCall(server: McpServer, message: McpMessage, complete: (result: Row) => Row): Promise<Response> {
  const id = message.id!, name = message.params.name as string;
  if (!server.tools.some(tool => tool.name === name)) return rpcError(id, MCP_ERRORS.invalidParams, `no tool named ${name}`);
  let value: unknown;
  try {
    value = await server.call(name, (message.params.arguments ?? {}) as Row);
  } catch (error) {
    if (error instanceof McpToolError) {
      return reply({ jsonrpc: '2.0', id, result: complete({ content: [{ type: 'text', text: error.message }], isError: true }) });
    }
    // A fault's message can carry storage or binding internals, and a model
    // would repeat them: only the tool's name is logged or returned.
    console.error('MCP tool failed', server.info.name, name);
    return rpcError(id, MCP_ERRORS.internal, `tool ${name} failed; see the server log`);
  }
  return reply({ jsonrpc: '2.0', id, result: complete({ content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isRow(value) ? { structuredContent: value } : {}) }) });
}
function toolList(server: McpServer): Row[] {
  return server.tools.map(({ name, description, inputSchema, annotations }) =>
    ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
}

/** 2026-07-28: every request names its version and capabilities, and its
 * routing headers must agree with its body. */
async function modern(request: Request, server: McpServer, message: McpMessage): Promise<Response> {
  const id = message.id!, version = message.version;
  const meta = message.params._meta as Row | undefined;
  if (version === null || !isRow(meta?.[META_CAPABILITIES])) {
    return rpcError(id, MCP_ERRORS.invalidParams, `requests carry ${META_VERSION} and ${META_CAPABILITIES} in _meta`, 400);
  }
  if (!MCP_MODERN_VERSIONS.includes(version)) {
    return rpcError(id, MCP_ERRORS.unsupportedVersion, 'unsupported protocol version', 400,
      { supported: MCP_MODERN_VERSIONS, requested: version });
  }
  const headers = request.headers;
  if (headers.get('mcp-protocol-version') !== version || headers.get('mcp-method') !== message.method
    || message.method === 'tools/call' && headerText(headers.get('mcp-name')) !== message.params.name) {
    return rpcError(id, MCP_ERRORS.headerMismatch, 'the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers must match the body', 400);
  }
  const complete = (result: Row): Row => ({ resultType: 'complete', ...result, _meta: { [META_SERVER]: server.info } });
  const result = (value: Row) => reply({ jsonrpc: '2.0', id, result: complete(value) });
  switch (message.method) {
    case 'server/discover':
      return result({ supportedVersions: MCP_MODERN_VERSIONS, capabilities: { tools: {} },
        ...(server.instructions ? { instructions: server.instructions } : {}), ttlMs: LIST_TTL_MS, cacheScope: 'public' });
    case 'ping':
      return result({});
    case 'tools/list':
      if (message.params.cursor !== undefined) return rpcError(id, MCP_ERRORS.invalidParams, 'unknown cursor');
      return result({ tools: toolList(server), ttlMs: LIST_TTL_MS, cacheScope: 'public' });
    case 'tools/call':
      return toolCall(server, message, complete);
    default:
      return rpcError(id, MCP_ERRORS.methodNotFound, `no method ${message.method}`, 404);
  }
}

/** The initialize-based revisions; the version is negotiated once and named
 * in a header afterwards. */
async function legacy(request: Request, server: McpServer, message: McpMessage): Promise<Response> {
  const id = message.id!;
  const result = (value: Row) => reply({ jsonrpc: '2.0', id, result: value });
  if (message.method === 'initialize') {
    const requested = message.params.protocolVersion;
    if (typeof requested !== 'string') return rpcError(id, MCP_ERRORS.invalidParams, 'initialize needs a protocolVersion');
    return result({ protocolVersion: MCP_LEGACY_VERSIONS.includes(requested) ? requested : MCP_LEGACY_VERSIONS[0],
      capabilities: { tools: {} }, serverInfo: server.info, ...(server.instructions ? { instructions: server.instructions } : {}) });
  }
  const header = request.headers.get('mcp-protocol-version');
  if (message.method === 'server/discover' || header !== null && MCP_MODERN_VERSIONS.includes(header)) {
    return rpcError(id, MCP_ERRORS.invalidParams, `requests carry ${META_VERSION} and ${META_CAPABILITIES} in _meta`, 400);
  }
  if (header !== null && !MCP_LEGACY_VERSIONS.includes(header)) {
    return rpcError(id, MCP_ERRORS.unsupportedVersion, 'unsupported protocol version', 400,
      { supported: [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS], requested: header });
  }
  switch (message.method) {
    case 'ping':
      return result({});
    case 'tools/list':
      if (message.params.cursor !== undefined) return rpcError(id, MCP_ERRORS.invalidParams, 'unknown cursor');
      return result({ tools: toolList(server) });
    case 'tools/call':
      return toolCall(server, message, value => value);
    default:
      return rpcError(id, MCP_ERRORS.methodNotFound, `no method ${message.method}`);
  }
}

/** One MCP POST, either era. The caller has already chosen the route and
 * established whatever admission its tools need. */
export async function serveMcp(request: Request, server: McpServer, options: McpServeOptions = {}): Promise<Response> {
  if (request.method !== 'POST') return rpcError(null, MCP_ERRORS.invalidRequest, 'MCP requests are POST', 405, undefined, { allow: 'POST' });
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== (options.origin ?? new URL(request.url).origin)) {
    return rpcError(null, MCP_ERRORS.invalidRequest, 'origin refused', 403);
  }
  if (!jsonContentType(request.headers)) return rpcError(null, MCP_ERRORS.invalidRequest, 'MCP requests are application/json', 415);
  const maxBytes = options.maxBytes ?? DEFAULT_BODY_BYTES;
  let body: unknown;
  try {
    body = strictJson(await readBoundedJsonText(request, maxBytes), Math.ceil(maxBytes / 4));
  } catch {
    return rpcError(null, MCP_ERRORS.parse, 'the body is not one bounded JSON-RPC message', 400);
  }
  const screened = options.screen?.(body);
  if (screened) return screened;
  let message: McpMessage;
  try { message = parseMcpMessage(body); } catch (error) {
    if (error instanceof McpRefused) return refusal(error);
    throw error;
  }
  // A notification carries no id and receives no response body.
  if (message.id === undefined) return new Response(null, { status: 202 });
  const refused = options.authorize?.(message);
  if (refused) return refused;
  return message.version !== null ? modern(request, server, message) : legacy(request, server, message);
}

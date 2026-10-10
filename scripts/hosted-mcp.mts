/** NoticeOS's one MCP endpoint in a hosted or demo deployment:
 * one connection and one sign-in for every feature in every workspace its
 * person belongs to. The task tools run here over the shared task operations;
 * the read-model tools run in the Tower Worker, and this endpoint forwards
 * each such call there under the same token. Every tool but list_workspaces
 * names its workspace, and admission checks the person's membership and role
 * there on each call, so a token reaches exactly what its person currently
 * may, workspace by workspace.
 *
 * Hosted, every request carries an agent access token (agent-access.mts); one
 * without gets a 401 naming where to sign in, and a call outside the token's
 * scopes a 403 naming the scope. The demo takes no credential and reads only.
 */
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { McpToolError, serveMcp, type McpMessage, type McpServer, type McpTool } from './mcp-protocol.mjs';
import { AGENT_RESOURCE_PATH, AGENT_SCOPES, bearerChallenge, bearerToken, scopesSatisfy } from './agent-access.mjs';
import { TASK_MCP_TOOLS } from './hosted-task-mcp.mjs';
import { READ_MODEL_TOOLS } from './read-model-tools.mjs';
import type { HostedTaskOperations } from './hosted-task-operations.mjs';

export const MCP_PATH = AGENT_RESOURCE_PATH;
/** Marks this endpoint's own forwarded call to the Worker's read-model tools,
 * so a front door passes it through rather than answering it again. Routing
 * only: the Worker admits the forwarded call like any other. */
export const READ_MODELS_HEADER = 'x-noticeos-mcp-part';
const SERVER_INFO = Object.freeze({ name: 'noticeos', version: '1.0.0' });
const INSTRUCTIONS = 'NoticeOS tasks and property reports across your workspaces. Start with list_workspaces; every other tool takes a workspace from it. Changes take an idempotency_key: reuse it when retrying.';
const BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export interface HostedMcpWorkspace {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly role: 'owner' | 'operator' | 'viewer';
  readonly status: 'active' | 'provisioning' | 'suspended';
}
export interface HostedMcpOptions {
  readonly profile: 'hosted' | 'demo';
  readonly trustedOrigin: string;
  readonly demoWorkspaceId?: string;
  readonly operations: HostedTaskOperations;
  /** Hosted only, and required there: the request's verified token, and its
   * person's workspaces. Admission verifies again, per workspace, per call. */
  readonly agents?: {
    verify(request: Request): Promise<{ readonly scopes: readonly string[] } | null>;
    workspaces(request: Request): Promise<readonly HostedMcpWorkspace[] | null>;
  };
  /** Sends one read-model MCP call to the Tower Worker. Without it, only the
   * task tools are offered. */
  readonly readModels?: (request: Request) => Promise<Response>;
}

const WORKSPACE = Object.freeze({ type: 'string', description: 'The workspaceId from list_workspaces.' });
/** Every tool but list_workspaces names its workspace. */
function inWorkspace<T extends McpTool>(tool: T): T {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
  return Object.freeze({ ...tool, inputSchema: Object.freeze({ ...schema,
    properties: { workspace: WORKSPACE, ...(schema.properties ?? {}) }, required: ['workspace', ...(schema.required ?? [])] }) });
}
const LIST_WORKSPACES: McpTool = Object.freeze({ name: 'list_workspaces',
  description: 'List the workspaces you can use here, with your role and what this connection may do in each.',
  inputSchema: Object.freeze({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  annotations: Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false }) });
const TASK_TOOLS = TASK_MCP_TOOLS.map(inWorkspace);
const READ_TOOLS = READ_MODEL_TOOLS.map(tool => inWorkspace({ ...tool,
  annotations: Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false }) }));
/** The scopes a call needs; list_workspaces needs only a valid token. */
function scopesFor(name: string): readonly string[] {
  const task = TASK_MCP_TOOLS.find(tool => tool.name === name);
  if (task) return [task.annotations.readOnlyHint === false ? 'tasks:write' : 'tasks:read'];
  return READ_MODEL_TOOLS.some(tool => tool.name === name) ? ['evidence:read'] : [];
}
/** What a token may do in a workspace: its scopes, bounded by the role. */
function access(scopes: readonly string[], workspace: HostedMcpWorkspace): string[] {
  if (workspace.status !== 'active') return [];
  return scopes.filter(scope => Object.hasOwn(AGENT_SCOPES, scope)
    && (workspace.role !== 'viewer' || AGENT_SCOPES[scope]!.every(action => action.endsWith('.read'))));
}

export function createHostedMcp(options: HostedMcpOptions): (original: Request) => Promise<Response> {
  const origin = createBrowserRequestPolicy(options.trustedOrigin).origin;
  const { profile, operations, agents, readModels } = options;
  if (!['hosted', 'demo'].includes(profile) || !operations || typeof operations.write !== 'function'
    || readModels !== undefined && typeof readModels !== 'function') throw new Error('MCP configuration refused');
  const demo = profile === 'demo' && typeof options.demoWorkspaceId === 'string' && UUID.test(options.demoWorkspaceId)
    ? options.demoWorkspaceId : undefined;
  if (profile === 'demo' && (!demo || agents !== undefined)
    || profile === 'hosted' && (options.demoWorkspaceId !== undefined || !agents
      || typeof agents.verify !== 'function' || typeof agents.workspaces !== 'function')) throw new Error('MCP configuration refused');
  const tools: readonly McpTool[] = Object.freeze([LIST_WORKSPACES, ...TASK_TOOLS, ...(readModels ? READ_TOOLS : [])]);
  const invalid = (message: string) => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } },
    { status: 400, headers: { 'cache-control': 'no-store' } });
  const refused = () => new McpToolError('refused: this workspace, project or task is not available to you, or the change was not accepted');

  /** One read-model call, as the Worker's own MCP endpoint answers it. */
  async function readModel(original: Request, name: string, workspaceId: string, args: Record<string, unknown>): Promise<unknown> {
    const authorization = original.headers.get('authorization');
    const forwarded = new Request(origin + MCP_PATH, { method: 'POST', signal: original.signal, headers: {
      'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', [READ_MODELS_HEADER]: 'read-models',
      [WORKSPACE_SELECTION_HEADER]: workspaceId, ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const response = await readModels!(forwarded);
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw refused(); }
    const reply = await response.json() as { result?: { isError?: boolean; content?: { text?: unknown }[]; structuredContent?: unknown };
      error?: { code?: unknown; message?: unknown } };
    if (reply.result?.isError) {
      const text = reply.result.content?.[0]?.text;
      throw new McpToolError(typeof text === 'string' ? text : 'the read model refused this call');
    }
    if (reply.error) {
      if (reply.error.code === -32602 && typeof reply.error.message === 'string') throw new McpToolError(`invalid arguments: ${reply.error.message}`);
      throw new Error('Read-model call failed.');
    }
    return reply.result?.structuredContent;
  }

  return async original => {
    let url: URL;
    try { url = new URL(original.url); } catch { return invalid('invalid request'); }
    if (url.origin !== origin || url.pathname !== MCP_PATH || url.search || url.hash || url.username || url.password) {
      return invalid('invalid request');
    }
    const bearer = bearerToken(original.headers);
    let scopes: readonly string[] | null = null;
    if (agents) {
      if (bearer === null || bearer === false) return bearerChallenge(origin, bearer === false ? { error: 'invalid_token' } : undefined);
      let token: Awaited<ReturnType<typeof agents.verify>>;
      try { token = await agents.verify(original); } catch { token = null; }
      if (!token) return bearerChallenge(origin, { error: 'invalid_token' });
      scopes = token.scopes;
    } else if (bearer !== null) return invalid('the demo takes no credentials');
    // The parsed body is not forwarded: admission reads only request metadata.
    const proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: original.signal });
    const server: McpServer = { info: SERVER_INFO, instructions: INSTRUCTIONS, tools, async call(name, args) {
      if (name === 'list_workspaces') {
        if (Object.keys(args).length) throw new McpToolError('invalid arguments: list_workspaces takes none');
        if (!agents) return { workspaces: [{ workspaceId: demo, name: 'Demo', role: 'viewer', status: 'active', access: ['tasks:read', 'evidence:read'] }] };
        const workspaces = await agents.workspaces(original).catch(() => null);
        if (!workspaces) throw refused();
        return { workspaces: workspaces.map(workspace => ({ workspaceId: workspace.workspaceId, name: workspace.displayName,
          role: workspace.role, status: workspace.status, access: access(scopes!, workspace) })) };
      }
      const { workspace, ...rest } = args;
      if (typeof workspace !== 'string' || !UUID.test(workspace) || (demo && workspace !== demo)) {
        throw new McpToolError('invalid arguments: workspace (a workspaceId from list_workspaces)');
      }
      const task = TASK_MCP_TOOLS.find(tool => tool.name === name);
      try {
        return task ? await task.run({ proof, workspaceId: workspace, operations }, rest) : await readModel(original, name, workspace, rest);
      } catch (error) {
        if (error instanceof McpToolError) throw error;
        // Admission, project selection and command refusals share one answer:
        // which of them refused is not the caller's to learn.
        throw refused();
      }
    } };
    const authorize = scopes === null ? undefined : (message: McpMessage) => {
      if (message.method !== 'tools/call') return null;
      const needed = scopesFor(String(message.params.name));
      return scopesSatisfy(scopes!, needed) ? null : bearerChallenge(origin, { error: 'insufficient_scope', scopes: needed });
    };
    return serveMcp(original, server, { origin, maxBytes: BODY_BYTES, ...(authorize ? { authorize } : {}) });
  };
}

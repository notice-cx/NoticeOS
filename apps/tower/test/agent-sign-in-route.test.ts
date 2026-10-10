// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import worker, { type TowerEnv } from '../worker/index';
import { handleAgentSignInRequest, isAgentSignInPath } from '../worker/agent-sign-in-route';
import type { AgentSignIn, AgentSignInOptions } from '@noticeos/postgres/agent-sign-in';
import type { AuthEntryBindings } from '../worker/auth-route';
import type { CallContext } from '@noticeos/postgres';

// Agent sign-in's Tower entry: which paths reach the authorization server,
// with what, and the 401 an agent gets at /api/mcp before it has signed in.
// The protocol itself is proved by scripts/postgres-agent-sign-in.test.mjs.

const origin = 'https://tower.example.test';
const env: AuthEntryBindings = {
  NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
  NOTICEOS_IDENTITY_DATABASE_URL: 'postgresql://noticeos_identity@localhost/synthetic',
  NOTICEOS_IDENTITY_SESSION_SECRET: randomBytes(48).toString('base64url'),
  NOTICEOS_IDENTITY_EDGE: 'cloudflare',
};
function edge(request: Request): Request {
  Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
  return request;
}

describe('agent sign-in at the Tower', () => {
  it('sends discovery, the OAuth routes and the page calls to the authorization server, with the edge peer', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/api/mcp',
      '/.well-known/oauth-authorization-server/api/auth', '/api/auth/oauth2/authorize', '/api/auth/oauth2/token',
      '/api/auth/oauth2/register', '/api/auth/oauth2/revoke', '/api/auth/jwks', '/api/agent-access/request', '/api/agent-access/approve']) {
      expect(isAgentSignInPath(path), path).toBe(true);
    }
    for (const path of ['/api/auth/oauth2/consent', '/api/auth/sign-in/email-otp', '/.well-known/openid-configuration', '/api/mcp',
      '/.well-known/oauth-protected-resource/api/tasks/mcp']) {
      expect(isAgentSignInPath(path), path).toBe(false);
    }
    const opened: AgentSignInOptions[] = []; let closed = 0;
    const open = (options: AgentSignInOptions): AgentSignIn => {
      opened.push(options);
      return { handle: async () => Response.json({ ok: true }), close: async () => { closed++; } };
    };
    const request = edge(new Request(`${origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.22' } }));
    expect((await handleAgentSignInRequest(request, env, open)).status).toBe(200);
    expect([opened[0]?.peerAddress, opened[0]?.trustedOrigin, closed]).toEqual(['192.0.2.22', origin, 1]);
    // Without the declared edge peer, or outside the hosted profile, nothing opens.
    expect((await handleAgentSignInRequest(new Request(`${origin}/api/auth/oauth2/token`, { method: 'POST' }), env, open)).status).toBe(403);
    expect((await handleAgentSignInRequest(request, { ...env, NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, open)).status).toBe(404);
    expect(opened).toHaveLength(1);
  });

  it('answers an MCP request with no credential with a 401 naming where to sign in', async () => {
    const response = await worker.fetch(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env as unknown as TowerEnv, {} as CallContext);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write evidence:read"`);
    const malformed = await worker.fetch(new Request(`${origin}/api/mcp`, { method: 'POST', headers: { authorization: 'Basic abc' } }),
      env as unknown as TowerEnv, {} as CallContext);
    expect(malformed.status).toBe(401);
    expect(malformed.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token"/u);
  });
});

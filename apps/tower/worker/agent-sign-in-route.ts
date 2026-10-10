// Agent sign-in's authorization server: the discovery
// documents, the maintained OAuth provider's fixed routes and the agent access
// page's two calls. Hosted only; the rate limits key on the Cloudflare edge
// peer, as email-code sign-in does. The protocol lives in
// packages/postgres/src/agent-sign-in.mts.
import { openAgentSignIn, isAgentSignInPath, type AgentSignIn, type AgentSignInOptions } from '@noticeos/postgres/agent-sign-in';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { workspaceEntryOrigin, workspaceProfile } from '../../../scripts/workspace-entry.mjs';
import { edgePeer, type AuthEntryBindings } from './auth-route';

export { isAgentSignInPath };
const HEADERS = { 'cache-control': 'no-store' };

export async function handleAgentSignInRequest(request: Request, env: AuthEntryBindings,
  open: (options: AgentSignInOptions) => AgentSignIn = openAgentSignIn): Promise<Response> {
  let signIn: AgentSignIn | undefined;
  try {
    if (workspaceProfile(env) !== 'hosted' || !(request instanceof Request)) {
      return Response.json({ error: 'not_found' }, { status: 404, headers: HEADERS });
    }
    const connectionString = env[PRODUCT_ENV.identityDatabase.name];
    const sessionSecret = env[PRODUCT_ENV.identitySecret.name];
    if (typeof connectionString !== 'string' || typeof sessionSecret !== 'string') throw new Error('Agent sign-in unavailable');
    signIn = open({ connectionString, sessionSecret, trustedOrigin: workspaceEntryOrigin(env), peerAddress: edgePeer(request, env) });
    const answer = await signIn.handle(request);
    await signIn.close(); signIn = undefined;
    return answer ?? Response.json({ error: 'not_found' }, { status: 404, headers: HEADERS });
  } catch {
    return Response.json({ error: 'refused' }, { status: 403, headers: HEADERS });
  } finally {
    if (signIn) { try { await signIn.close(); } catch { /* already refused */ } }
  }
}

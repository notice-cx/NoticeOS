// Disposable runtime proof only; never an application entry or public route.
import { openIdentity } from '../packages/postgres/src/identity.mjs';
export default {
  async fetch(request, env) {
    const identity = await openIdentity({ connectionString: env.FIXTURE_CONNECTION, trustedOrigin: env.FIXTURE_ORIGIN, sessionSecret: env.FIXTURE_SECRET });
    try {
      const workspaceId = new URL(request.url).searchParams.get('workspace');
      // Fixture-only direct fact read; product callers first admit the selected
      // workspace and never expose an arbitrary UUID roster endpoint.
      const facts = new URL(request.url).searchParams.get('actors') === '1'
        ? await identity.workspaceActors(workspaceId)
        : workspaceId === null ? await identity.session(request.headers) : await identity.membership(request.headers, workspaceId);
      return Response.json(facts);
    } finally { await identity.close(); }
  },
};

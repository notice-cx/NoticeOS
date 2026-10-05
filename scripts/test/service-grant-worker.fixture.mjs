import { openWorkspaceServiceGrant } from '../../packages/postgres/src/service-grant.mjs';
import { createWorkspaceAdmission } from '../workspace-admission.mjs';

export default {
  async fetch(request, env) {
    const reader = openWorkspaceServiceGrant({ connectionString: env.FIXTURE_CONNECTION,
      principalId: env.FIXTURE_SERVICE, workspaceId: env.FIXTURE_WORKSPACE });
    const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('owned-test-service'),
      authority: () => reader.facts() });
    const url = new URL(request.url);
    try {
      const result = await admission.withAdmission(url.searchParams.get('action'), {
        requestedWorkspaceId: url.searchParams.get('workspace') ?? env.FIXTURE_WORKSPACE,
        correlationId: 'same-generated-occurrence',
      }, request, async context => {
        admission.assertContext(context, context.action);
        return { workspaceId: context.workspaceId, principalId: context.principalId,
          principalKind: context.principalKind, action: context.action };
      });
      return Response.json(result);
    } catch { return Response.json({ refused: true }, { status: 403 }); }
    finally { await reader.close(); }
  },
};

// Synthetic composition only: the released writers and central admission are
// exercised before their separate production HTTP/RPC entry leaf is enabled.
import { openIdentity } from '../../packages/postgres/src/identity.mjs';
import { openWorkspaceStore } from '../../packages/postgres/src/store.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from '../browser-request-policy.mjs';
import { createWorkspaceAdmission } from '../workspace-admission.mjs';
import { createAsset, writeAssetColumn, moveAsset } from '../../workers/ingest/src/asset-state.ts';
import { writeAnnotation } from '../../workers/ingest/src/annotations.ts';
import { recordDecision, clearDecision } from '../../apps/tower/worker/decision-actions.ts';
import { applyFlagAction } from '../../apps/tower/worker/flag-actions.ts';

const actions = Object.freeze({ create: 'assets.write', column: 'assets.write', move: 'assets.write',
  decision: 'findings.write', clear: 'findings.write', flag: 'findings.write', annotation: 'annotations.write' });
export default {
  async fetch(original, env) {
    let identity, store;
    try {
      const policy = createBrowserRequestPolicy(env.ORIGIN);
      policy.assertEffect(original);
      const workspaceId = original.headers.get(WORKSPACE_SELECTION_HEADER);
      const proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: original.signal });
      const input = await original.json();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'input,operation'
        || !Object.hasOwn(actions, input.operation)) throw new Error('Fixture input refused');
      identity = await openIdentity({ connectionString: env.IDENTITY_URL, sessionSecret: env.SECRET, trustedOrigin: env.ORIGIN });
      const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: env.ORIGIN,
        membership: (headers, selected) => identity.admissionMembership(headers, selected) });
      return await admission.withAdmission(actions[input.operation], { requestedWorkspaceId: workspaceId, correlationId: 'audit-fixture' }, proof, async first => {
        // This optional service is owned by the fixture and can revoke current
        // membership between the two real observations. It supplies no facts.
        if (env.BEFORE_EFFECT) await env.BEFORE_EFFECT.fetch(new Request('https://owned-fixture.test/'));
        return admission.withAdmission(actions[input.operation], { requestedWorkspaceId: workspaceId, correlationId: first.correlationId }, proof, async current => {
          if (first.principalId !== current.principalId || first.sessionId !== current.sessionId) throw new Error('Fixture owner changed');
          admission.assertContext(current, actions[input.operation]);
          const actor = Object.freeze({ workspaceId: current.workspaceId, principalId: current.principalId, sessionId: current.sessionId });
          store = openWorkspaceStore(env.APP_URL, { workspaceId: current.workspaceId });
          const runtime = { STORE: store }, value = input.input, now = Date.now();
          let result;
          switch (input.operation) {
            case 'create': result = await createAsset(runtime, value, now, actor); break;
            case 'column': result = await writeAssetColumn(runtime, value, now, actor); break;
            case 'move': result = await moveAsset(runtime, value, now, actor); break;
            case 'annotation': result = await writeAnnotation(runtime, value, now, actor); break;
            case 'decision': result = await recordDecision(store, value.asset, value.decision, new Date(now).toISOString(), actor); break;
            case 'clear': result = await clearDecision(store, value.asset, value.kind, value.key, actor); break;
            case 'flag':
              if (!['acknowledge', 'resolve', 'snooze', 'unsnooze'].includes(value.action)) throw new Error('Protected tune refused');
              result = await applyFlagAction(store, value.id, value.action, new Date(now).toISOString(), value.until ?? null, null, actor); break;
          }
          return Response.json(result);
        });
      });
    } catch { return Response.json({ refused: true }, { status: 403 }); }
    finally { await store?.close(); await identity?.close(); }
  },
};

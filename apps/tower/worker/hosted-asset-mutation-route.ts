import type { CallContext } from '@noticeos/postgres';
import type { MutationActor } from '@noticeos/postgres/mutation-audit';
import { assetMutationRequest } from '../../../scripts/workspace-operations.mjs';
import { withWorkspaceEntry } from '../../../scripts/workspace-entry.mjs';
import { handleCreateAssetRequest, type AssetLifecycleWriter } from './asset-lifecycle-route';
import { handleAssetColumnRequest, type AssetColumnWriter } from './asset-column-route';
import { handleAssetOrderRequest, type AssetOrderWriter } from './asset-order-route';
import { handleAnnotationRequest, type AnnotationWriter } from './annotation-route';
import { handleDecisionsRequest } from './decision-route';
import { handleFlagRequest } from './flag-route';
import { snapshotRpcData } from './rpc-data';

/** Only the reviewed existing asset/finding writes enter this dispatcher.
 * The standalone dispatcher, watch assignment and threshold writes stay out.
 * Each RPC receiver independently admits this original immutable message. */
export async function handleHostedAssetMutation(request: Request,
  env: { INGEST: AssetLifecycleWriter & AssetColumnWriter & AssetOrderWriter & AnnotationWriter },
  ctx: CallContext): Promise<Response | null> {
  const selected = assetMutationRequest(request);
  if (!selected) return null;
  try {
    const proof = request.clone(), message = proof.clone(), url = new URL(proof.url);
    return await withWorkspaceEntry(env, proof, async call => {
      let receiverFailed = false;
      const ingest: AssetLifecycleWriter & AssetColumnWriter & AssetOrderWriter & AnnotationWriter = {
        async moveAsset(input) {
          try { return await snapshotRpcData(env.INGEST.moveAsset(input, proof.clone())); }
          catch (error) { receiverFailed = true; throw error; }
        },
        async createAsset(input) {
          try { return await snapshotRpcData(env.INGEST.createAsset(input, proof.clone())); }
          catch (error) { receiverFailed = true; throw error; }
        },
        async readAssetState(asset) {
          try { return await snapshotRpcData(env.INGEST.readAssetState(asset, proof.clone())); }
          catch (error) { receiverFailed = true; throw error; }
        },
        async writeAssetColumn(input) {
          try { return await snapshotRpcData(env.INGEST.writeAssetColumn(input, proof.clone())); }
          catch (error) { receiverFailed = true; throw error; }
        },
        async createAnnotation(input) {
          try { return await snapshotRpcData(env.INGEST.createAnnotation(input, proof.clone())); }
          catch (error) { receiverFailed = true; throw error; }
        },
      };
      let response: Response;
      if (selected.kind === 'create') response = await handleCreateAssetRequest(message, url, ingest);
      else if (selected.kind === 'column') response = await handleAssetColumnRequest(message, url, ingest, selected.asset);
      else if (selected.kind === 'order') response = await handleAssetOrderRequest(message, url, ingest, selected.asset);
      else if (selected.kind === 'annotation') response = await handleAnnotationRequest(message, url, ingest, selected.asset);
      else {
        const context = call.context;
        if (context.principalKind !== 'person' || !context.sessionId) throw new Error('Mutation refused.');
        const actor: MutationActor = Object.freeze({ workspaceId: context.workspaceId,
          principalId: context.principalId, sessionId: context.sessionId });
        response = await call.withStore(ctx, store => selected.kind === 'decision'
          ? handleDecisionsRequest(message, url, store, selected.asset, new Date().toISOString(), actor)
          : handleFlagRequest(message, url, store, selected.number, new Date().toISOString(), actor));
      }
      if (receiverFailed) throw new Error('Workspace receiver refused.');
      // Never expose internal SQL/connection details from a failed hosted write.
      return response.status >= 500
        ? Response.json({ error: 'workspace_mutation_unavailable' }, { status: 503 }) : response;
    });
  } catch {
    return Response.json({ error: 'workspace_entry_unavailable' }, { status: 403 });
  }
}

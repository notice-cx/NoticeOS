import type { WorkspaceStore } from '@noticeos/postgres';
import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';
import { DEMO_ACTIVITY_DEFINITION, demoActivityPrefix } from '../../../scripts/demo-activity-definition.mjs';
import { hostedJobDefinitionHash } from '../../../scripts/hosted-job-definition.mjs';
import { DEMO_PRESENTATION_PATH, decodeDemoPresentation } from '../shared/demo-presentation';
import { JSON_HEADERS } from './http';

export interface DemoPresentationBindings {
  NOTICEOS_DEMO_ACTIVITY_SERVICE_ID?: string;
  NOTICEOS_DEMO_SCENARIO_HASH?: string;
}
const unknown = () => Response.json({ generatedAt: null, through: null }, { headers: JSON_HEADERS });
/** Only the already-admitted fixed demo store enters here. The identity store
 * and browser selectors cannot supply operational journal capabilities. */
export async function handleDemoPresentationRead(request: Request, store: WorkspaceStore,
  env: DemoPresentationBindings): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DEMO_PRESENTATION_PATH) return null;
  if (request.method !== 'GET' || request.body !== null || url.search || url.hash) {
    return Response.json({ error: 'invalid_demo_read' }, { status: 400, headers: JSON_HEADERS });
  }
  const bindings = env as Record<string, unknown>;
  const serviceId = bindings[PRODUCT_ENV.demoActivityService.name];
  const hash = bindings[PRODUCT_ENV.demoScenarioHash.name];
  if (typeof serviceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(serviceId)
    || typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) return unknown();
  const prefix = demoActivityPrefix(hash);
  const definitionHash = hostedJobDefinitionHash(DEMO_ACTIVITY_DEFINITION.version, DEMO_ACTIVITY_DEFINITION.steps);
  const facts = await store.read(async tx => {
    const rows = await tx.query(`SELECT a.finished_at,j.occurrence
      FROM noticeos.hosted_job_occurrences j JOIN noticeos.hosted_job_attempts a
        USING(workspace_id,lane,occurrence,attempt)
      WHERE j.workspace_id=$1::uuid AND j.service_id=$2::uuid AND j.lane=$3
        AND j.definition_hash=$4 AND left(j.occurrence,length($5))=$5
        AND j.state='succeeded' AND a.state='succeeded' AND a.finished_at IS NOT NULL
      ORDER BY a.finished_at DESC,j.occurrence DESC LIMIT 1`,
    [tx.workspaceId, serviceId, DEMO_ACTIVITY_DEFINITION.key, definitionHash, prefix]);
    if (!rows[0]) return { generatedAt: null, through: null };
    const row = rows[0];
    return decodeDemoPresentation({ generatedAt: new Date(String(row.finished_at)).toISOString(),
      through: String(row.occurrence).slice(prefix.length) });
  });
  return Response.json(facts, { headers: JSON_HEADERS });
}

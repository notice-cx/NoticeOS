import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { openWorkspaceStore, type CallContext, type Transaction } from '@noticeos/postgres';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../../scripts/browser-request-policy.mjs';
import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import { workspaceEntryOrigin, workspaceProfile } from '../../../../scripts/workspace-entry.mjs';
import { SITE_REPORT_INTAKE_PATH, localSiteReportsEnabled, type siteReportGrantRequest } from '../../../../scripts/workspace-operations.mjs';
import { bearer } from '../auth.js';
import { hasSiteReportVerifier, saveSiteReportVerifier, siteReportVerifier } from '../credentials.js';
import { ingestAuthorizedPulse } from '../db.js';
import { zodIssues } from '../responses.js';

const TOKEN = /^noticeos_site_v1\.([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/u;
const MAX_BYTES = 256 * 1024;
const absentVerifier = '0'.repeat(64);
const headers = { 'cache-control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const denied = () => json({ error: 'unauthorized' }, 401);
const unavailable = () => json({ error: 'not_found' }, 404);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

async function reportAsset(tx: Transaction, asset: string): Promise<{ writable: boolean } | null> {
  const [row] = await tx.query<{ writable: boolean }>(`SELECT a.status <> 'retired' AS writable
    FROM noticeos.assets a JOIN noticeos.workspaces w USING (workspace_id)
    WHERE a.asset_id=$1 AND NOT a.is_os AND w.status='active'`, [asset]);
  return row ?? null;
}

// Intake and replacement take the same asset lock before reading the grant.
async function holdReportGrant(tx: Transaction, asset: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    ['noticeos.site-report', tx.workspaceId, asset].join('\n'),
  ]);
}

export async function handleSiteReportGrant(env: IngestEnv, route: NonNullable<ReturnType<typeof siteReportGrantRequest>>,
  mayEdit: boolean): Promise<Response> {
  const { STORE } = env;
  if (route.method === 'GET') return STORE.read(async tx => {
    const asset = await reportAsset(tx, route.asset);
    if (!asset) return unavailable();
    return json({ issued: await hasSiteReportVerifier(tx, route.asset), mayIssue: mayEdit && asset.writable, mayRevoke: mayEdit });
  });
  if (!mayEdit) return json({ error: 'forbidden' }, 403);
  return STORE.write(async tx => {
    await holdReportGrant(tx, route.asset);
    const asset = await reportAsset(tx, route.asset);
    if (!asset) return unavailable();
    if (route.method === 'DELETE') {
      await saveSiteReportVerifier(tx, env, route.asset, null);
      return new Response(null, { status: 204, headers });
    }
    if (!asset.writable) return json({ error: 'report_token_unavailable' }, 409);
    const token = 'noticeos_site_v1.' + tx.workspaceId + '.' + randomBytes(32).toString('base64url');
    await saveSiteReportVerifier(tx, env, route.asset, digest(token));
    return json({ token }, 201);
  });
}

export async function handleHostedSiteReport(request: Request, env: IngestEnv, ctx: CallContext): Promise<Response> {
  const url = new URL(request.url);
  if (workspaceProfile(env) !== 'hosted' || !localSiteReportsEnabled(env)
    || url.origin !== workspaceEntryOrigin(env) || url.pathname !== SITE_REPORT_INTAKE_PATH || request.url !== url.origin + SITE_REPORT_INTAKE_PATH
    || request.method !== 'POST') return unavailable();
  if (['cookie', 'origin', WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER].some(name => request.headers.has(name))) return denied();
  const token = bearer(request);
  const workspaceId = token ? TOKEN.exec(token)?.[1] : undefined;
  if (!token || !workspaceId) return denied();
  let body: unknown;
  try { body = JSON.parse(await readBoundedJsonText(request, MAX_BYTES)); }
  catch { return json({ error: 'bad_request' }, 400); }
  const asset = (body as { asset?: unknown } | null)?.asset;
  if (typeof asset !== 'string' || asset.length === 0 || asset.length > 253 || /[\s/\\\u0000-\u001f\u007f]/u.test(asset)) return denied();
  const connectionString = (env as { NOTICEOS_WORKSPACE_DATABASE_URL?: string }).NOTICEOS_WORKSPACE_DATABASE_URL;
  if (!connectionString) return json({ error: 'site_report_unavailable' }, 503);
  const store = openWorkspaceStore(connectionString, { workspaceId, maxConnections: 1 });
  try {
    const received = await ingestAuthorizedPulse(store, body, async tx => {
      await holdReportGrant(tx, asset);
      const target = await reportAsset(tx, asset);
      const verifier = target?.writable ? await siteReportVerifier(tx, env, asset) : null;
      const matches = timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(verifier ?? absentVerifier, 'hex'));
      return verifier !== null && matches;
    });
    if (received === null) return denied();
    if (!received.ok) return json({ error: 'unprocessable_entity', issues: zodIssues(received.error) }, 422);
    return json({ ok: true, ...received.result }, 201);
  } catch { return json({ error: 'site_report_unavailable' }, 503); }
  finally { ctx.waitUntil(store.close()); }
}

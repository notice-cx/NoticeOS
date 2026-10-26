/** Standalone journey management uses the Tower's typed HTTP resource.
 * Saving changes definitions only; collection runs on its existing schedule. */
import { journeyDefinitionsRefusal } from '../packages/contract/src/journeys.mjs';
import { WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { McpToolError, type McpTool } from './mcp-protocol.mjs';

type Args = Record<string, unknown>;
export interface JourneyToolContext {
  readonly proof: Request;
  readonly workspaceId: string;
  readonly transport: (request: Request) => Promise<Response>;
}
export interface JourneyTool extends McpTool {
  run(context: JourneyToolContext, args: Args): Promise<unknown>;
}
const ID = { type: 'string', minLength: 1, maxLength: 60, pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' };
const LABEL = { type: 'string', minLength: 1, maxLength: 60 };
const EVENT = { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z][A-Za-z0-9_]*$' };
const ASSET = { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  description: 'The asset id, for example example.com.' };
function schema(properties: Args, required: readonly string[]): Args {
  return { type: 'object', properties, required, additionalProperties: false };
}
const PARAMETER = schema({ name: EVENT, value: { type: 'string', minLength: 1, maxLength: 100 } }, ['name', 'value']);
const ALTERNATIVE = schema({ eventName: EVENT,
  pagePath: { type: 'string', minLength: 1, maxLength: 1000, pattern: '^/[^?#]*$', description: 'Exact page path; omit to accept this event on any page.' },
  parameters: { type: 'array', maxItems: 4, items: PARAMETER } }, ['eventName']);
const STEP = schema({ id: ID, label: LABEL,
  alternatives: { type: 'array', minItems: 1, maxItems: 8, items: ALTERNATIVE, description: 'Accept any one of these exact event conditions.' },
  withinSeconds: { type: 'integer', minimum: 1, maximum: 7776000, description: 'Maximum elapsed seconds after the previous step; omit on the first step. This does not require the same session.' } },
['id', 'label', 'alternatives']);
const LEGACY_JOURNEY = schema({ id: ID, label: LABEL, goal: { type: 'string', minLength: 1, maxLength: 120 },
  kind: { type: 'string', enum: ['funnel', 'exploration'] }, status: { type: 'string', enum: ['active', 'planned'] },
  steps: { type: 'array', minItems: 2, maxItems: 10, items: STEP } }, ['id', 'label', 'goal', 'kind', 'status', 'steps']);
const FIRST_PARTY_JOURNEY = schema({ id: ID, label: LABEL, goal: { type: 'string', minLength: 1, maxLength: 120 },
  kind: { type: 'string', enum: ['exploration'] }, source: { type: 'string', enum: ['first-party'] },
  reportingLagDays: { type: 'integer', minimum: 1, maximum: 14, description: 'Complete-report delay in days; defaults to one.' },
  status: { type: 'string', enum: ['active', 'planned'] }, steps: { type: 'array', maxItems: 0 } },
['id', 'label', 'goal', 'kind', 'source', 'status', 'steps']);
const JOURNEY = { anyOf: [LEGACY_JOURNEY, FIRST_PARTY_JOURNEY] };
function refuse(message: string): never { throw new McpToolError(message); }
function only(args: Args, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(`invalid arguments: unknown ${unknown.join(', ')}`);
}
function assetOf(args: Args): string {
  if (typeof args.asset !== 'string' || args.asset.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(args.asset)) {
    refuse('invalid arguments: asset (the asset id, for example example.com)');
  }
  return args.asset;
}
async function send(context: JourneyToolContext, path: string, body?: Args): Promise<unknown> {
  const headers = new Headers({ [WORKSPACE_SELECTION_HEADER]: context.workspaceId });
  for (const [name, value] of context.proof.headers) {
    if (name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-')) headers.set(name, value);
  }
  const actor = context.proof.headers.get('x-noticeos-actor');
  if (actor !== null) headers.set('x-noticeos-actor', actor);
  if (body) headers.set('content-type', 'application/json');
  let response: Response, payload: unknown;
  try {
    response = await context.transport(new Request(new URL(path, context.proof.url), {
      method: body ? 'PUT' : 'GET', headers, signal: context.proof.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    payload = await response.json();
  }
  catch { refuse('unavailable: journey management did not return a valid response; use get_journeys before retrying a save'); }
  if (!response.ok) {
    const value = payload !== null && typeof payload === 'object' ? payload as Args : {};
    const detail = typeof value.detail === 'string' ? value.detail : typeof value.error === 'string' ? value.error : 'journey management refused this call';
    refuse(`${response.status === 409 ? 'conflict' : response.status >= 500 ? 'unavailable' : 'refused'}: ${detail}`);
  }
  return payload;
}
export const JOURNEY_MCP_TOOLS: readonly JourneyTool[] = Object.freeze([
  { name: 'get_journeys',
    description: 'Read an asset’s journey definitions and edit tokens. Active GA4 funnels are collected daily; planned journeys are not collected. This reads saved settings and makes no provider request.',
    inputSchema: schema({ asset: ASSET }, ['asset']),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async run(context: JourneyToolContext, args: Args) {
      only(args, ['asset']);
      return send(context, `/api/assets/${encodeURIComponent(assetOf(args))}/journeys`);
    } },
  { name: 'save_journey',
    description: 'Create or replace a GA4 journey using exact events, page paths and event parameters, or a first-party session exploration with source first-party and an empty steps list. Use edit_token null to create, or the current token from get_journeys to update. Repeating the same desired state is unchanged. Active GA4 funnels are collected daily; planned journeys are not collected. Saving does not fetch provider data. Set dry_run true to validate without saving.',
    inputSchema: schema({ asset: ASSET, journey: JOURNEY,
      edit_token: { type: ['string', 'null'], minLength: 1, maxLength: 256, description: 'null for creation, otherwise the edit token returned by get_journeys.' },
      dry_run: { type: 'boolean' } }, ['asset', 'journey', 'edit_token']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    async run(context: JourneyToolContext, args: Args) {
      only(args, ['asset', 'journey', 'edit_token', 'dry_run']);
      const asset = assetOf(args);
      const journey = args.journey;
      if (journey === null || typeof journey !== 'object' || Array.isArray(journey)) refuse('invalid arguments: journey');
      const definition = journey as Args;
      only(definition, ['id', 'label', 'goal', 'kind', 'source', 'reportingLagDays', 'status', 'steps']);
      const invalid = journeyDefinitionsRefusal([{ ...definition, version: 1 }]);
      if (invalid) refuse(`invalid arguments: ${invalid}`);
      if (!Object.hasOwn(args, 'edit_token') || args.edit_token !== null
          && (typeof args.edit_token !== 'string' || !args.edit_token.trim() || args.edit_token.length > 256)) {
        refuse('invalid arguments: edit_token (null to create, or the token from get_journeys)');
      }
      if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') refuse('invalid arguments: dry_run must be boolean');
      return send(context, `/api/assets/${encodeURIComponent(asset)}/journeys/${encodeURIComponent(definition.id as string)}`,
        { journey: definition, edit_token: args.edit_token, ...(args.dry_run === undefined ? {} : { dry_run: args.dry_run }) });
    } },
]);

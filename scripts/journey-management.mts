import { createHash } from 'node:crypto';
import { journeyDefinitionId, journeyDefinitionsRefusal, type JourneyDefinition } from '../packages/contract/src/journeys.mjs';
import { CONFIG_REGISTERS, resolveContainer } from './config-registers.mjs';

export interface JourneyReply { status: number; body: Record<string, unknown> }
export interface JourneyDocument { version: number; body: unknown }
export interface JourneyRead { known: boolean; document: JourneyDocument | null }
export interface JourneySource {
  read(asset: string): Promise<JourneyRead>;
  apply(input: { ops: unknown[]; slug: string; expectVersions: Record<string, number | null> }): Promise<JourneyReply>;
}
export type JourneyManagementSource = JourneySource;
export interface JourneyInput {
  journey: Omit<JourneyDefinition, 'version'>;
  edit_token: string | null;
  dry_run?: boolean;
}
export interface JourneyManagement {
  get(asset: string): Promise<JourneyReply>;
  save(asset: string, input: unknown): Promise<JourneyReply>;
}
type State = { version: number; holderExists: boolean; listExists: boolean; definitions: JourneyDefinition[]; declaredEventNames: string[]; eventNames: string[] };
const register = CONFIG_REGISTERS.journeys;
const COLLECTION = Object.freeze({ source: 'ga4', schedule: 'daily', immediateFetch: false,
  detail: 'Active funnels are collected by the daily GA4 collection. Saving does not fetch data.' });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const token = (definition: JourneyDefinition): string => createHash('sha256').update(canonical(definition)).digest('hex');
const reply = (status: number, error: string, detail: string): JourneyReply => ({ status, body: { error, detail } });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function view(asset: string, state: State): Record<string, unknown> {
  return { asset, documentVersion: state.version,
    journeys: state.definitions.map(definition => ({ definition: clone(definition), edit_token: token(definition) })),
    eventNames: [...state.eventNames], eventNamesSource: 'saved-configuration', collection: COLLECTION };
}
function stateOf(document: JourneyDocument): State | null {
  if (!Number.isSafeInteger(document.version) || document.version < 1 || !record(document.body) || !record(document.body.assets)) return null;
  return { version: document.version, holderExists: false, listExists: false, definitions: [], declaredEventNames: [], eventNames: [] };
}
function parseState(document: JourneyDocument, asset: string): State | null {
  const state = stateOf(document);
  if (!state) return null;
  const assets = (document.body as { assets: Record<string, unknown> }).assets;
  state.holderExists = Object.hasOwn(assets, asset);
  if (!state.holderExists) return state;
  const holder = assets[asset];
  if (!record(holder)) return null;
  state.listExists = Object.hasOwn(holder, 'journeys');
  if (state.listExists) {
    if (journeyDefinitionsRefusal(holder.journeys) !== null) return null;
    state.definitions = clone(holder.journeys as JourneyDefinition[]);
  }
  const events = new Set<string>();
  if (holder.valueEvents !== undefined) {
    if (!Array.isArray(holder.valueEvents) || !holder.valueEvents.every(event => typeof event === 'string')) return null;
    for (const event of holder.valueEvents as string[]) events.add(event);
  }
  if (holder.productUseStages !== undefined) {
    if (!Array.isArray(holder.productUseStages) || !holder.productUseStages.every(stage => record(stage) && typeof stage.eventName === 'string')) return null;
    for (const stage of holder.productUseStages as { eventName: string }[]) events.add(stage.eventName);
  }
  state.declaredEventNames = [...events];
  state.eventNames = [...new Set([...events, ...state.definitions.flatMap(definition => definition.steps.flatMap(step => step.alternatives.map(alternative => alternative.eventName)))])].sort();
  return state;
}
function parseInput(input: unknown): JourneyInput | null {
  if (!record(input) || Object.keys(input).some(key => !['journey', 'edit_token', 'dry_run'].includes(key))
    || !Object.hasOwn(input, 'journey') || !Object.hasOwn(input, 'edit_token')
    || !(input.edit_token === null || typeof input.edit_token === 'string' && /^[a-f0-9]{64}$/.test(input.edit_token))
    || input.dry_run !== undefined && typeof input.dry_run !== 'boolean'
    || !record(input.journey) || Object.hasOwn(input.journey, 'version')
    || journeyDefinitionsRefusal([{ ...input.journey, version: 1 }]) !== null) return null;
  return clone(input) as unknown as JourneyInput;
}

/** The source owns transport and admission; this operation owns guarded config changes. */
export function createJourneyManagement(source: JourneySource): JourneyManagement {
  async function read(asset: string): Promise<State | JourneyReply> {
    if (typeof asset !== 'string' || asset.length === 0 || asset.trim() !== asset) return reply(400, 'invalid_asset', 'Supply an asset id.');
    let result: JourneyRead;
    try { result = await source.read(asset); }
    catch { return reply(503, 'store_unavailable', 'Journey settings are unavailable.'); }
    if (!result.known) return reply(404, 'asset_not_found', 'This asset does not exist.');
    if (result.document === null) return reply(503, 'store_unavailable', 'Journey settings have not been acknowledged by the configuration store.');
    return parseState(result.document, asset) ?? reply(503, 'invalid_stored_config', 'Stored journey settings are invalid; no changes were made.');
  }
  return {
    async get(asset) {
      const state = await read(asset);
      return 'status' in state ? state : { status: 200, body: view(asset, state) };
    },
    async save(asset, input) {
      const parsed = parseInput(input);
      if (!parsed) return reply(422, 'invalid_journey', 'Supply journey, edit_token, and an optional boolean dry_run; version is managed automatically.');
      const state = await read(asset);
      if ('status' in state) return state;
      const previous = state.definitions.find(definition => definition.id === parsed.journey.id);
      const desired = { ...parsed.journey, version: previous?.version ?? 1 };
      if (previous && canonical(previous) === canonical(desired)) {
        return { status: 200, body: { ...view(asset, state), definition: clone(previous), edit_token: token(previous), unchanged: true, dry_run: parsed.dry_run === true } };
      }
      if (previous ? parsed.edit_token !== token(previous) : parsed.edit_token !== null) {
        return reply(409, 'edit_conflict', 'The journey changed. Read its current definition before saving.');
      }
      if (previous && journeyDefinitionId(desired) !== journeyDefinitionId(previous)) desired.version++;
      const definitions = previous
        ? state.definitions.map(definition => definition.id === desired.id ? desired : definition)
        : [...state.definitions, desired];
      const refusal = journeyDefinitionsRefusal(definitions);
      if (refusal !== null) return reply(422, 'invalid_journey', refusal);
      const pointer = resolveContainer(register, { asset });
      const op = !state.holderExists
        ? { kind: 'file-json-insert', file: register.file, pointer: pointer.slice(0, pointer.lastIndexOf('/')), value: { journeys: definitions } }
        : !state.listExists
          ? { kind: 'file-json-insert', file: register.file, pointer, value: definitions }
          : { kind: 'file-json-set', file: register.file, pointer, expect: state.definitions, value: definitions };
      const nextState = { ...state, definitions, eventNames: [...new Set([...state.declaredEventNames, ...definitions.flatMap(definition => definition.steps.flatMap(step => step.alternatives.map(alternative => alternative.eventName)))])].sort() };
      const outcome = { ...view(asset, nextState), definition: clone(desired), edit_token: token(desired), unchanged: false, created: !previous, dry_run: parsed.dry_run === true };
      if (parsed.dry_run) return { status: 200, body: { ...outcome, ops: [op], expectVersions: { [register.file]: state.version } } };
      let applied: JourneyReply;
      try { applied = await source.apply({ ops: [op], slug: `journey-${desired.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/g, '')}`, expectVersions: { [register.file]: state.version } }); }
      catch { return reply(503, 'save_unconfirmed', 'Save not confirmed. Read the current journey before retrying the same request.'); }
      if (applied.status < 200 || applied.status >= 300) return applied;
      return { status: applied.status, body: { ...applied.body, ...outcome, documentVersion: state.version + 1 } };
    },
  };
}

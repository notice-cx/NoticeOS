import type { SettingsPayload } from '@shared/settings';
import type { ConfigWritability, ConfigSaveResult } from './api';
import type { MoveAssetResult } from '@noticeos/contract';
import { TOWER_CONFIG_FILES } from '@noticeos/contract/configuration';
import { CONFIG_KNOBS } from '@shared/config-registers';
import { validateWallLayout } from '@shared/wall-layout';
import {
  responseRecord as record, responseString as string, responseNumber as number, responseInteger as integer,
  responseBoolean as boolean, responseNullable as nullable, responseList as list, responseEnum as oneOf,
  responseInstant as instant, responseZone as zone,
  responseFields as fields, invalidResponse,
} from './response-value';

const strings = list(string);
const configFile = (value: unknown) => string(value) && (Object.values(TOWER_CONFIG_FILES) as string[]).includes(value);
const unique = (value: unknown, key: string) => Array.isArray(value)
  && new Set(value.map(row => record(row) ? row[key] : row)).size === value.length;
const dictionary = (check: (value: unknown) => boolean) => (value: unknown) => record(value) && Object.values(value).every(check);
const json = (value: unknown, depth = 0): boolean => depth < 64 && (value === null || string(value) || number(value) || boolean(value)
  || Array.isArray(value) && value.every(item => json(item, depth + 1)) || record(value) && Object.values(value).every(item => json(item, depth + 1)));
const pointer = (value: unknown) => string(value) && /^(?:\/(?:[^~]|~[01])*)*$/u.test(value);

export function decodeAssetOrder(value: unknown, asset: string): Extract<MoveAssetResult, { ok: true }> {
  if (!fields(value, { ok: ok => ok === true, asset: id => id === asset,
    order: ids => strings(ids) && Array.isArray(ids) && ids.includes(asset) && new Set(ids).size === ids.length,
    revision: token => string(token) && /^[a-f0-9]{64}$/u.test(token), undoTo: nullable(string),
  }) || value.undoTo !== null && (!(value.order as string[]).includes(value.undoTo as string) || value.undoTo === asset)) {
    throw new Error('Save outcome unknown — refresh before retrying.');
  }
  return value as unknown as Extract<MoveAssetResult, { ok: true }>;
}
function dashboard(value: unknown): boolean {
  return fields(value, {}, {
    countdown: item => fields(item, { emoji: string, label: string, targetAt: instant }),
    wall: item => fields(item, { layout: layout => validateWallLayout(layout).ok,
      history: list(entry => fields(entry, { savedAt: instant, reason: string, layout: layout => validateWallLayout(layout).ok })) },
    { retired: retired => fields(retired, { saved: () => true, replaced: boolean }) }),
    refused: item => fields(item, {}, {
      wall: refusal => fields(refusal, { saved: () => true, reason: string }),
      countdown: refusal => fields(refusal, { saved: () => true, reason: string }),
    }),
  });
}
function schedules(value: unknown): boolean {
  return value === null || dictionary(item => fields(item, { enabled: boolean, cron: string }, { timezone: zone }))(value);
}

/** Keep saved values and absences verbatim: no normalized edit guards. */
export function decodeSettings(value: unknown): SettingsPayload {
  if (!fields(value, {
    generatedAt: instant,
    clock: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.constants, timeZone: zone, chosen: boolean }),
    dashboard,
    budget: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.constants,
      knobs: list(knob => fields(knob, { key: string, pointer, label: string, jargon: string, value: number, unit: oneOf(['usd', 'usd_per_min', 'number']) })) }),
    alertRules: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.constants,
      knobs: list(knob => fields(knob, { key: string, label: string, jargon: string, value: string, explain: string,
        owner: owner => owner === TOWER_CONFIG_FILES.constants, pointer, raw: raw => number(raw) || string(raw) })) }),
    collection: item => fields(item, {
      knobs: list(knob => fields(knob, { key: key => string(key) && Object.hasOwn(CONFIG_KNOBS, key), value: json })),
      pullAssets: list(row => fields(row, { asset: string, url: string, enabled: boolean })),
      pullOwner: owner => owner === TOWER_CONFIG_FILES.pull, schedules,
    }),
    sources: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.integrations,
      rows: list(row => fields(row, { id: string, label: string }, { scope: oneOf(['property', 'portfolio', 'both']),
        layer: oneOf(['os', 'provider', 'property']), credential: oneOf(['shared', 'per-property']), docRef: string })) }),
    entities: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.entities,
      rows: list(row => fields(row, { slug: string, name: string }, { form: string, jurisdiction: string, assets: strings })) }),
    taskHub: item => fields(item, { owner: owner => owner === TOWER_CONFIG_FILES.beads,
      spokes: list(row => fields(row, { asset: string, prefix: string, database: string }, { repo: string })),
      hub: nullable(hub => fields(hub, { host: string, port: port => integer(port) && port > 0 && port <= 65535,
        user: string, dataDir: string }, { initCommand: string })),
    }),
  })) invalidResponse('Settings');
  return value as unknown as SettingsPayload;
}

export function decodeConfigWritable(value: unknown): ConfigWritability {
  const sources = (item: unknown) => record(item) && Object.entries(item).every(([file, source]) => configFile(file) && oneOf(['store', 'file'])(source));
  if (!fields(value, { writable: boolean, reason: nullable(string) }, {
    sources,
    versions: item => record(item) && Object.entries(item).every(([file, version]) => configFile(file) && nullable(integer)(version)),
    store: item => fields(item, { ready: boolean, reason: nullable(string) }), unseeded: list(configFile),
  })) invalidResponse('Settings availability');
  // The local lane omits source facts. This empty map explicitly means unknown.
  return { writable: value.writable as boolean, reason: value.reason as string | null,
    sources: Object.hasOwn(value, 'sources') ? value.sources as ConfigWritability['sources'] : {} };
}

export function decodeConfigSave(value: unknown, expected: number, files: readonly string[]): ConfigSaveResult {
  if (!fields(value, { applied: applied => integer(applied) && applied === expected, archive: nullable(string), commit: nullable(string) }, {
    exported: boolean,
    documents: item => list(doc => fields(doc, { file: file => string(file) && files.includes(file),
      version: version => integer(version) && version > 0 }))(item) && unique(item, 'file'),
  })) throw new Error('Save outcome unknown — refresh before retrying.');
  return { applied: value.applied as number, archive: value.archive as string | null, commit: value.commit as string | null,
    ...(Object.hasOwn(value, 'exported') ? { exported: value.exported as boolean } : {}) };
}

export { decodeIntegrationProviders } from './integration-response';

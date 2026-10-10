// The PostHog archive contract, shared by the collector and every reader.
//
// One archive per (asset, family, window end): an archived page whose
// `response` is the body below, which the collector validates before anything
// is archived. Window grain, not day grain: unique people and percentiles do
// not add across days, so every family but `web-daily` is one row per thing
// over the whole window. A row that is not present was not observed: absent
// is never zero.

import { z } from 'zod';
import {
  POSTHOG_FUNNEL_LIMITS,
  POSTHOG_HOSTS,
  POSTHOG_PROJECT_ID_SOURCE,
  posthogFunnelsRefusal,
  type PosthogFunnel,
  type PosthogFunnelStep,
  type PosthogHost,
} from './configuration.mjs';
// The families and each row's fields are declared once, in a portable module
// the plain-Node flattener imports too; the row schemas below are checked
// against it field for field.
import {
  POSTHOG_FAMILIES,
  POSTHOG_FAMILY_ROWS,
  type PosthogFamily,
  type PosthogFamilyField,
} from './posthog-families.mjs';

export {
  POSTHOG_FAMILIES,
  POSTHOG_FAMILY_ROWS,
  POSTHOG_FUNNEL_LIMITS,
  POSTHOG_HOSTS,
  POSTHOG_PROJECT_ID_SOURCE,
  posthogFunnelsRefusal,
  type PosthogFamily,
  type PosthogFamilyField,
  type PosthogFunnel,
  type PosthogFunnelStep,
  type PosthogHost,
};

/** The data-source (lane) id, the provider id and the manifest integration. */
export const POSTHOG_LANE_ID = 'posthog' as const;

/** Trailing window, in whole days ending on the window end, for the daily run. */
export const POSTHOG_WINDOW_DAYS: Readonly<Record<PosthogFamily, number>> = {
  'web-daily': 28,
  events: 14,
  exceptions: 14,
  rageclicks: 14,
  'web-vitals': 14,
  funnels: 7,
};

/** Row bound per family. Funnels are bounded by the configured steps instead
 * (at most 10 funnels of 10 steps). */
export const POSTHOG_ROW_LIMITS: Readonly<Record<PosthogFamily, number>> = {
  'web-daily': 28,
  events: 500,
  exceptions: 100,
  rageclicks: 100,
  'web-vitals': 300,
  funnels: POSTHOG_FUNNEL_LIMITS.maxFunnels * POSTHOG_FUNNEL_LIMITS.maxSteps,
};

/** Web vitals keep the top paths by measurement count, then every device and
 * OS segment of those paths. */
export const POSTHOG_WEB_VITALS_TOP_PATHS = 20;
/** Exception messages are cut to this many characters before archiving. */
export const POSTHOG_MESSAGE_MAX = 200;
/** Rage-click element text is cut to this many characters. */
export const POSTHOG_ELEMENT_TEXT_MAX = 80;

const isoDate = z.iso.date();
const count = z.number().int().nonnegative();
/** A percentile, or null when that metric had no measurements. */
const percentile = z.number().nonnegative().nullable();

/**
 * A row schema's shape for one family: exactly the fields
 * `POSTHOG_FAMILY_ROWS` names for it. Each shape below `satisfies` this, so a
 * field the list does not name, or one it names that the shape lacks, fails
 * `tsc` rather than reaching an archive or the flattened CSV. Field ORDER is
 * checked by the contract test.
 */
export type PosthogRowShape<F extends PosthogFamily> = Record<PosthogFamilyField<F>, z.ZodType>;

export const posthogWebDailyRowSchema = z.strictObject({
  date: isoDate,
  pageviews: count,
  /** Unique people within that day. */
  people: count,
  sessions: count,
} satisfies PosthogRowShape<'web-daily'>);

export const posthogEventsRowSchema = z.strictObject({
  event: z.string().min(1),
  count,
  people: count,
  /** First and last day the event was seen, inside the window. */
  firstSeen: isoDate,
  lastSeen: isoDate,
} satisfies PosthogRowShape<'events'>);

export const posthogExceptionsRowSchema = z.strictObject({
  /** Exception type (TypeError), or null when PostHog recorded none. */
  type: z.string().nullable(),
  /** Message cut to 200 characters, or null when PostHog recorded none. */
  message: z.string().max(POSTHOG_MESSAGE_MAX).nullable(),
  count,
  people: count,
  sessions: count,
  /** The most occurrences of this group in one session. */
  maxPerSession: count,
  /** True when any occurrence carried a stack frame naming a source file. */
  hasSourceFile: z.boolean(),
  topPath: z.string().nullable(),
  topBrowser: z.string().nullable(),
} satisfies PosthogRowShape<'exceptions'>);

export const posthogRageclicksRowSchema = z.strictObject({
  path: z.string().nullable(),
  /** Element tag (input, button, label), or null when unknown. */
  tag: z.string().nullable(),
  /** Element text cut to 80 characters, or null when none. */
  text: z.string().max(POSTHOG_ELEMENT_TEXT_MAX).nullable(),
  /** The element's name attribute, else its id, else null. */
  attr: z.string().nullable(),
  clicks: count,
  people: count,
  desktopClicks: count,
  mobileClicks: count,
  tabletClicks: count,
  /** Unique people with a $pageview on that path in the window. */
  pagePeople: count,
} satisfies PosthogRowShape<'rageclicks'>);

export const posthogWebVitalsRowSchema = z.strictObject({
  path: z.string().nullable(),
  /** Desktop, Mobile or Tablet as PostHog records it, or null. */
  device: z.string().nullable(),
  os: z.string().nullable(),
  /** Milliseconds. */
  lcpP75: percentile,
  /** Milliseconds. */
  inpP75: percentile,
  /** Unitless layout-shift score. */
  clsP75: percentile,
  /** Milliseconds. */
  fcpP75: percentile,
  measurements: count,
} satisfies PosthogRowShape<'web-vitals'>);

export const posthogFunnelsRowSchema = z.strictObject({
  funnelId: z.string().min(1),
  name: z.string().min(1),
  /** 1-based step number. */
  step: z.number().int().min(1),
  event: z.string().min(1),
  /** The path the step is pinned to, or null when it is not pinned. */
  path: z.string().nullable(),
  /** Unique people who reached this step in order within the window. */
  people: count,
} satisfies PosthogRowShape<'funnels'>);

export type PosthogWebDailyRow = z.infer<typeof posthogWebDailyRowSchema>;
export type PosthogEventsRow = z.infer<typeof posthogEventsRowSchema>;
export type PosthogExceptionsRow = z.infer<typeof posthogExceptionsRowSchema>;
export type PosthogRageclicksRow = z.infer<typeof posthogRageclicksRowSchema>;
export type PosthogWebVitalsRow = z.infer<typeof posthogWebVitalsRowSchema>;
export type PosthogFunnelsRow = z.infer<typeof posthogFunnelsRowSchema>;

/** The row schema of each family, for a reader that has the family name. */
export const POSTHOG_ROW_SCHEMAS = {
  'web-daily': posthogWebDailyRowSchema,
  events: posthogEventsRowSchema,
  exceptions: posthogExceptionsRowSchema,
  rageclicks: posthogRageclicksRowSchema,
  'web-vitals': posthogWebVitalsRowSchema,
  funnels: posthogFunnelsRowSchema,
} as const satisfies Record<PosthogFamily, z.ZodType>;

export interface PosthogRowsByFamily {
  'web-daily': PosthogWebDailyRow;
  events: PosthogEventsRow;
  exceptions: PosthogExceptionsRow;
  rageclicks: PosthogRageclicksRow;
  'web-vitals': PosthogWebVitalsRow;
  funnels: PosthogFunnelsRow;
}

const windowSchema = z
  .strictObject({ start: isoDate, end: isoDate })
  .refine((window) => window.start <= window.end, {
    message: 'window.start must not be after window.end',
  });

function bodySchema<F extends PosthogFamily>(family: F) {
  return z.strictObject({
    provider: z.literal('posthog'),
    family: z.literal(family),
    asset: z.string().min(1),
    host: z.enum(POSTHOG_HOSTS),
    projectId: z.string().regex(new RegExp(POSTHOG_PROJECT_ID_SOURCE)),
    /** The PostHog project's timezone, or null if PostHog did not say. */
    projectTimeZone: z.string().min(1).nullable(),
    /** Inclusive calendar dates in the project's timezone. */
    window: windowSchema,
    collectedAt: z.iso.datetime({ offset: true }),
    rowLimit: z.number().int().positive(),
    /** True when the row limit was reached, so more rows existed. */
    truncated: z.boolean(),
    rows: z.array(POSTHOG_ROW_SCHEMAS[family]),
  });
}

/** One PostHog archive body, discriminated on `family`. */
export const posthogArchiveBodySchema = z
  .discriminatedUnion('family', [
    bodySchema('web-daily'),
    bodySchema('events'),
    bodySchema('exceptions'),
    bodySchema('rageclicks'),
    bodySchema('web-vitals'),
    bodySchema('funnels'),
  ])
  .refine((body) => body.rows.length <= body.rowLimit, {
    message: 'rows must not exceed rowLimit',
  });

export type PosthogArchiveBody = z.infer<typeof posthogArchiveBodySchema>;

/** A body for one family, typed by that family's rows. */
export interface PosthogArchiveBodyOf<F extends PosthogFamily> {
  provider: 'posthog';
  family: F;
  asset: string;
  host: PosthogHost;
  projectId: string;
  projectTimeZone: string | null;
  window: { start: string; end: string };
  collectedAt: string;
  rowLimit: number;
  truncated: boolean;
  rows: PosthogRowsByFamily[F][];
}

/** `posthog-web-daily`, the name a person types on `signals:collect`. */
export function posthogFamilyTag(family: PosthogFamily): string {
  return `${POSTHOG_LANE_ID}-${family}`;
}

/** The family a `posthog-<family>` tag names, or null. */
export function posthogFamilyFromTag(tag: string): PosthogFamily | null {
  const prefix = `${POSTHOG_LANE_ID}-`;
  if (!tag.startsWith(prefix)) return null;
  const family = tag.slice(prefix.length);
  return (POSTHOG_FAMILIES as readonly string[]).includes(family) ? (family as PosthogFamily) : null;
}

/** One asset's PostHog settings, as `config/integrations.json` holds them under
 * `assets.<asset>.posthog`. */
export interface PosthogAssetSettings {
  host: PosthogHost;
  projectId: string;
  funnels: PosthogFunnel[];
}

/** Why an asset's PostHog settings cannot be used, or the settings. A missing
 * host or project id is a skip with a reason, never a guess. */
export type PosthogAssetSettingsRead =
  | { ok: true; settings: PosthogAssetSettings }
  | { ok: false; reason: 'mapping_missing' | 'mapping_invalid'; detail: string };

export function readPosthogAssetSettings(entry: unknown): PosthogAssetSettingsRead {
  const record =
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const host = record.host;
  const projectId = record.projectId;
  if (host === undefined || host === null || host === '' || projectId === undefined || projectId === null || projectId === '') {
    const missing = [
      host === undefined || host === null || host === '' ? 'host' : null,
      projectId === undefined || projectId === null || projectId === '' ? 'projectId' : null,
    ].filter((name): name is string => name !== null);
    return {
      ok: false,
      reason: 'mapping_missing',
      detail: `PostHog ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set on this asset's Sources tab.`,
    };
  }
  if (typeof host !== 'string' || !(POSTHOG_HOSTS as readonly string[]).includes(host)) {
    return { ok: false, reason: 'mapping_invalid', detail: `PostHog host must be one of ${POSTHOG_HOSTS.join(', ')}.` };
  }
  if (typeof projectId !== 'string' || !new RegExp(POSTHOG_PROJECT_ID_SOURCE).test(projectId)) {
    return { ok: false, reason: 'mapping_invalid', detail: 'PostHog project id must be digits only.' };
  }
  const funnels = record.funnels ?? [];
  const refusal = posthogFunnelsRefusal(funnels);
  if (refusal !== null) return { ok: false, reason: 'mapping_invalid', detail: refusal };
  return {
    ok: true,
    settings: { host: host as PosthogHost, projectId, funnels: funnels as PosthogFunnel[] },
  };
}

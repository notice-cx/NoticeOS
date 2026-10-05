// The executive snapshot's `product` block, read back out of a stored payload
// (beads ro-ghis.2 / ro-ghis.3).
//
// Same contract as every other block `parseExecutiveSnapshot` reads: the payload
// is JSON written by a separate process (`scripts/signal-insights.mjs`), so
// nothing here may throw, and every field is PICKED across by name rather than
// spread — a key this parser has not reviewed never reaches the browser.
//
// DEGRADATION IS PER ROW. A funnel, a segment, an exception or a rage cluster
// that does not parse costs exactly itself; a part whose frame is unreadable is
// null (the section then says "not collected" for that part, which is the honest
// reading of an answer nobody can read). The block as a whole is null only when
// it is absent or not an object: a snapshot written before PostHog existed, or
// an asset nobody collects PostHog for.

import type {
  ProductCheck,
  ProductCheckState,
  ProductDay,
  ProductException,
  ProductExceptions,
  ProductFamilyReading,
  ProductFunnel,
  ProductFunnelDrop,
  ProductFunnelStep,
  ProductOnceEvent,
  ProductRageClicks,
  ProductRageCluster,
  ProductSnapshot,
  ProductVitalLine,
  ProductVitalSegment,
  ProductVitals,
  ProductWebDaily,
  WebVitalRating,
} from "./asset-detail";

type Json = Record<string, unknown>;

/** The most rows of each kind the section can show; a producer that has gone
 * wrong cannot make the browser draw a thousand funnels. */
const LIMITS = { days: 120, funnels: 10, steps: 10, segments: 24, exceptions: 10, clusters: 10, onceEvents: 10, checks: 10, families: 10 };

function obj(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A value that must be a number or explicitly null. `undefined` is read as
 * null too: JSON drops nothing, but a hand-built fixture might. */
function nullableFinite(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const parsed = finite(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rows<T>(value: unknown, parse: (row: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parse)
    .filter((row): row is T => row !== null)
    .slice(0, limit);
}

const RATINGS: readonly WebVitalRating[] = ["good", "needs-improvement", "poor"];
const CHECK_STATES: readonly ProductCheckState[] = ["fired", "clear", "not-enough-data", "not-collected"];

function rating(value: unknown): WebVitalRating | null {
  return RATINGS.includes(value as WebVitalRating) ? (value as WebVitalRating) : null;
}

function windowOf(raw: Json): { windowStart: string; windowEnd: string } | null {
  const windowStart = str(raw.windowStart);
  const windowEnd = str(raw.windowEnd);
  return windowStart && windowEnd && windowStart <= windowEnd ? { windowStart, windowEnd } : null;
}

function parseFamily(value: unknown): ProductFamilyReading | null {
  const raw = obj(value);
  if (!raw) return null;
  const family = str(raw.family);
  const reportDate = str(raw.reportDate);
  const window = windowOf(raw);
  const count = finite(raw.rows);
  if (!family || !reportDate || !window || count === null || typeof raw.truncated !== "boolean") return null;
  return { family, reportDate, ...window, rows: count, truncated: raw.truncated };
}

function parseDay(value: unknown): ProductDay | null {
  const raw = obj(value);
  const date = str(raw?.date);
  if (!raw || !date) return null;
  const people = nullableFinite(raw.people);
  const pageviews = nullableFinite(raw.pageviews);
  const sessions = nullableFinite(raw.sessions);
  if (!people.ok || !pageviews.ok || !sessions.ok) return null;
  return { date, people: people.value, pageviews: pageviews.value, sessions: sessions.value };
}

function parseWebDaily(value: unknown): ProductWebDaily | null {
  const raw = obj(value);
  if (!raw) return null;
  const window = windowOf(raw);
  const reportDate = str(raw.reportDate);
  const days = rows(raw.days, parseDay, LIMITS.days);
  if (!window || !reportDate || days.length === 0) return null;
  return { ...window, reportDate, days };
}

function parseStep(value: unknown): ProductFunnelStep | null {
  const raw = obj(value);
  if (!raw) return null;
  const step = finite(raw.step);
  const event = str(raw.event);
  const people = finite(raw.people);
  if (step === null || !event || people === null) return null;
  return { step, event, path: nullableString(raw.path), people };
}

function parseDrop(value: unknown): ProductFunnelDrop | null {
  const raw = obj(value);
  if (!raw) return null;
  const fromStep = finite(raw.fromStep);
  const toStep = finite(raw.toStep);
  const lostPeople = finite(raw.lostPeople);
  const stepConversion = finite(raw.stepConversion);
  if (fromStep === null || toStep === null || lostPeople === null || stepConversion === null) return null;
  return { fromStep, toStep, lostPeople, stepConversion };
}

function parsePrior(value: unknown): ProductFunnel["prior"] {
  const raw = obj(value);
  if (!raw) return null;
  const window = windowOf(raw);
  const conversion = nullableFinite(raw.conversion);
  const stepConversion = nullableFinite(raw.stepConversion);
  if (!window || !conversion.ok || !stepConversion.ok) return null;
  return { ...window, conversion: conversion.value, stepConversion: stepConversion.value };
}

function parseFunnel(value: unknown): ProductFunnel | null {
  const raw = obj(value);
  if (!raw) return null;
  const id = str(raw.id);
  const name = str(raw.name);
  const window = windowOf(raw);
  const steps = rows(raw.steps, parseStep, LIMITS.steps).sort((left, right) => left.step - right.step);
  const conversion = nullableFinite(raw.conversion);
  // A funnel whose steps did not survive is not a funnel with no steps.
  if (!id || !name || !window || steps.length === 0 || !conversion.ok) return null;
  return {
    id,
    name,
    ...window,
    steps,
    conversion: conversion.value,
    largestDrop: parseDrop(raw.largestDrop),
    prior: parsePrior(raw.prior),
  };
}

function parseLine(value: unknown): ProductVitalLine | null {
  const raw = obj(value);
  const good = finite(raw?.good);
  const poor = finite(raw?.poor);
  return good !== null && poor !== null ? { good, poor } : null;
}

function parseSegment(value: unknown): ProductVitalSegment | null {
  const raw = obj(value);
  if (!raw) return null;
  const path = str(raw.path);
  const measurements = finite(raw.measurements);
  const lcp = nullableFinite(raw.lcpP75);
  const inp = nullableFinite(raw.inpP75);
  const cls = nullableFinite(raw.clsP75);
  if (!path || measurements === null || !lcp.ok || !inp.ok || !cls.ok) return null;
  return {
    path,
    device: nullableString(raw.device),
    os: nullableString(raw.os),
    measurements,
    lcpP75: lcp.value,
    inpP75: inp.value,
    clsP75: cls.value,
    // A rating without its value would be a verdict about nothing.
    lcpRating: lcp.value === null ? null : rating(raw.lcpRating),
    inpRating: inp.value === null ? null : rating(raw.inpRating),
    clsRating: cls.value === null ? null : rating(raw.clsRating),
  };
}

function parseVitals(value: unknown): ProductVitals | null {
  const raw = obj(value);
  if (!raw) return null;
  const window = windowOf(raw);
  const reportDate = str(raw.reportDate);
  const minMeasurements = finite(raw.minMeasurements);
  const lines = obj(raw.lines);
  const lcp = parseLine(lines?.lcp);
  const inp = parseLine(lines?.inp);
  const cls = parseLine(lines?.cls);
  const unmeasured = finite(raw.unmeasuredSegments);
  if (!window || !reportDate || minMeasurements === null || !lcp || !inp || !cls || unmeasured === null) return null;
  return {
    ...window,
    reportDate,
    minMeasurements,
    lines: { lcp, inp, cls },
    segments: rows(raw.segments, parseSegment, LIMITS.segments),
    unmeasuredSegments: unmeasured,
  };
}

function parseException(value: unknown): ProductException | null {
  const raw = obj(value);
  if (!raw) return null;
  const count = finite(raw.count);
  const people = finite(raw.people);
  const sessions = nullableFinite(raw.sessions);
  const maxPerSession = nullableFinite(raw.maxPerSession);
  if (count === null || people === null || !sessions.ok || !maxPerSession.ok) return null;
  return {
    type: nullableString(raw.type),
    message: nullableString(raw.message),
    count,
    people,
    sessions: sessions.value,
    maxPerSession: maxPerSession.value,
    hasSourceFile: typeof raw.hasSourceFile === "boolean" ? raw.hasSourceFile : null,
    topPath: nullableString(raw.topPath),
    topBrowser: nullableString(raw.topBrowser),
  };
}

function parseExceptions(value: unknown): ProductExceptions | null {
  const raw = obj(value);
  if (!raw) return null;
  const window = windowOf(raw);
  const reportDate = str(raw.reportDate);
  const total = finite(raw.total);
  if (!window || !reportDate || total === null || typeof raw.truncated !== "boolean") return null;
  const noiseRow = parseException(raw.noise);
  const noiseShare = finite(obj(raw.noise)?.share);
  return {
    ...window,
    reportDate,
    total,
    truncated: raw.truncated,
    noise: noiseRow && noiseShare !== null ? { ...noiseRow, share: noiseShare } : null,
    top: rows(raw.top, parseException, LIMITS.exceptions),
  };
}

function parseCluster(value: unknown): ProductRageCluster | null {
  const raw = obj(value);
  if (!raw) return null;
  const path = str(raw.path);
  const element = str(raw.element);
  const clicks = finite(raw.clicks);
  const people = finite(raw.people);
  const pagePeople = finite(raw.pagePeople);
  const share = finite(raw.share);
  const desktopShare = nullableFinite(raw.desktopShare);
  if (!path || !element || clicks === null || people === null || pagePeople === null || share === null || !desktopShare.ok) {
    return null;
  }
  return {
    path,
    tag: nullableString(raw.tag),
    text: nullableString(raw.text),
    attr: nullableString(raw.attr),
    element,
    clicks,
    people,
    pagePeople,
    share,
    desktopShare: desktopShare.value,
  };
}

function parseRageClicks(value: unknown): ProductRageClicks | null {
  const raw = obj(value);
  if (!raw) return null;
  const window = windowOf(raw);
  const reportDate = str(raw.reportDate);
  const shareLine = finite(raw.shareLine);
  if (!window || !reportDate || shareLine === null) return null;
  return { ...window, reportDate, shareLine, clusters: rows(raw.clusters, parseCluster, LIMITS.clusters) };
}

function parseOnceEvent(value: unknown): ProductOnceEvent | null {
  const raw = obj(value);
  const event = str(raw?.event);
  const count = finite(raw?.count);
  const people = finite(raw?.people);
  const perPerson = finite(raw?.perPerson);
  if (!event || count === null || people === null || perPerson === null) return null;
  return { event, count, people, perPerson };
}

function parseCheck(value: unknown): ProductCheck | null {
  const raw = obj(value);
  const key = str(raw?.key);
  const label = str(raw?.label);
  const detail = typeof raw?.detail === "string" ? raw.detail : null;
  const state = raw?.state;
  if (!key || !label || detail === null || !CHECK_STATES.includes(state as ProductCheckState)) return null;
  return { key, label, state: state as ProductCheckState, detail };
}

export function parseProductSnapshot(value: unknown): ProductSnapshot | null {
  const raw = obj(value);
  if (!raw || raw.source !== "posthog") return null;
  const observedAt = str(raw.observedAt);
  if (!observedAt) return null;
  return {
    source: "posthog",
    observedAt,
    collectedAt: nullableString(raw.collectedAt),
    families: rows(raw.families, parseFamily, LIMITS.families),
    webDaily: parseWebDaily(raw.webDaily),
    funnels: rows(raw.funnels, parseFunnel, LIMITS.funnels),
    vitals: parseVitals(raw.vitals),
    exceptions: parseExceptions(raw.exceptions),
    rageClicks: parseRageClicks(raw.rageClicks),
    onceEvents: rows(raw.onceEvents, parseOnceEvent, LIMITS.onceEvents),
    checks: rows(raw.checks, parseCheck, LIMITS.checks),
    caveat: typeof raw.caveat === "string" ? raw.caveat : "",
  };
}

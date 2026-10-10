// The connect panel's vocabulary. The status a connection wears everywhere is
// `connection-status.ts`; Checking lives in the panel alone, because it lasts
// one call.

import type { ConnectVerdict, IntegrationProvider } from "@noticeos/contract";
import { acceptedAs, integrationProvider } from "@noticeos/contract/integrations";

/** Does this provider connect in the one panel (the contract declares a kind)? */
export function connectsInPanel(provider: Pick<IntegrationProvider, "connect">): boolean {
  return provider.connect !== undefined;
}

/** Where a site's unconnected source gets connected: the one panel, opened for
 * this site, for a provider that connects there; the provider's own page
 * otherwise. */
export function connectHref(provider: string, asset: string): string {
  const spec = integrationProvider(provider);
  return spec && connectsInPanel(spec)
    ? `/integrations?connect=${provider}&asset=${encodeURIComponent(asset)}`
    : `/integrations?provider=${provider}`;
}

/** A source whose provider is not connected, and which a provider connects:
 * its one action is Connect. */
export function connectable(reading: { kind: string; provider: string | null }): boolean {
  return reading.kind === "not-connected" && reading.provider !== null && integrationProvider(reading.provider) !== null;
}

/**
 * The source a site connects first: the first connectable one, free before
 * paid, then by name. Both the Data sources primary Connect and Home's
 * first-run guide use it, so the two never point at different sources.
 */
export function firstToConnect<T extends { kind: string; provider: string | null; label: string }>(
  readings: readonly T[],
): T | null {
  const paid = (reading: T) => Number(reading.provider !== null && integrationProvider(reading.provider)?.meter?.window === "portfolio-month");
  return [...readings].filter(connectable).sort((a, b) => paid(a) - paid(b) || a.label.localeCompare(b.label))[0] ?? null;
}

/** A provider's short name: "Google Analytics (GA4)" → "Google Analytics". */
export function providerName(provider: Pick<IntegrationProvider, "label">): string {
  return provider.label.split(" (")[0] ?? provider.label;
}

/**
 * What this connection's secret is called, in the words its own form uses: the
 * one typed field ("API key", "webhook URL"), or "login" where the provider
 * issues two values. Null for a provider nothing is typed for.
 */
export function secretNoun(provider: Pick<IntegrationProvider, "fields"> & Partial<Pick<IntegrationProvider, "connect">>): string | null {
  const typed = provider.fields.filter((field) => field.managed !== true);
  if (typed.length === 0) return null;
  const secrets = typed.filter((field) => field.secret);
  if (typed.length > 1 && provider.connect?.credential === 'api-key' && secrets.length === 1) {
    const label = secrets[0]!.label;
    return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  }
  if (typed.length > 1) return "login";
  const label = typed[0]!.label;
  // "API key" keeps its capitals; "Project tokens" reads "project tokens".
  return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** What replacing that secret is called on the connection: "Replace API key". */
export function replaceLabel(provider: Pick<IntegrationProvider, "fields"> & Partial<Pick<IntegrationProvider, "connect">>): string | null {
  const noun = secretNoun(provider);
  return noun === null ? null : `Replace ${noun}`;
}

// --- a list of named feeds (calendar feeds) -----------------------------------

/** One feed as the panel's rows hold it: its name (optional) and its URL. */
export interface FeedRow {
  name: string;
  url: string;
}

/** The rows a `url-list` field's panel value holds; one empty row to start. */
export function feedRows(value: string): FeedRow[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((row) => ({
        name: typeof row?.name === "string" ? row.name : "",
        url: typeof row?.url === "string" ? row.url : "",
      }));
    }
  } catch {
    // An empty or cleared value is one empty row.
  }
  return [{ name: "", url: "" }];
}

/** The rows as `parseUrlList`'s lines — `name = url`, or the URL alone when
 * unnamed — so the one parser decides what the store receives. */
export function feedLines(rows: readonly FeedRow[]): string {
  return rows
    .filter((row) => row.url.trim() !== "")
    .map((row) => (row.name.trim() === "" ? row.url.trim() : `${row.name.trim()} = ${row.url.trim()}`))
    .join("\n");
}

// --- the panel ---------------------------------------------------------------

/** Where the panel is: entering details, waiting on the provider, or holding
 * its answer. */
export type ConnectPhase =
  | { phase: "editing" }
  | { phase: "checking" }
  | { phase: "answered"; answer: ConnectVerdict };

/** What the panel says when the provider did not accept — the provider's
 * refusal, or its silence, in plain words. Never the provider's own text,
 * which could carry anything. */
export function refusalLine(
  provider: Pick<IntegrationProvider, "label" | "fields" | "connect">,
  verdict: "refused" | "unreachable",
): string {
  const name = providerName(provider);
  if (verdict === "unreachable") return `${name} did not answer`;
  const typed = provider.fields.filter((field) => field.managed !== true).length;
  // Named for what was given, as the accepted chip is: an address is not a key.
  return `${name} refused ${typed > 1 ? "these details" : acceptedAs(provider) === "url" ? "this URL" : "this key"}`;
}

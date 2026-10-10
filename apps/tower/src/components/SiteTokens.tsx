import { ExternalLink, Loader2, Play, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { CollectNowResult, IntegrationProvider } from "@noticeos/contract";
import type { ConnectionKind } from "@shared/connection-status";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** One site the provider's tokens are pasted for. */
export interface SiteTokenRow {
  id: string;
  label: string;
  domain: string | null;
  /** A token is stored for it. */
  held: boolean;
}

export interface SiteTokensProps {
  provider: IntegrationProvider;
  sites: readonly SiteTokenRow[];
  /** The connection model's status for a site holding a token. */
  statusOf: (asset: string) => ConnectionKind | null;
  /** The provider's calls left today for one site (its meter), or null when
   * the OS cannot count them. */
  remaining: (asset: string) => number | null;
  /** Calls a site is allowed per day (Clarity: 10). */
  cap: number;
  /** Save one site's token; rejects with the refusal to show under its row. */
  onSave: (asset: string, token: string) => Promise<void>;
  /** Run the export now for these sites. */
  onRun: (assets: string[]) => Promise<CollectNowResult | null>;
  /** False while this install cannot store a credential. */
  canSave?: boolean;
}

type RowState = { state: "idle" } | { state: "saving" } | { state: "refused"; message: string };

/** A change this long at once is a token arriving whole (a paste), not typing. */
const WHOLE_TOKEN = 16;

/**
 * The connect panel's body for a provider that issues one token per project
 * and offers no free call to prove it (Clarity). Pasting a site's token saves
 * it at once; a stored token is never shown back. The proof is the export,
 * which spends a metered call, so it runs only on an explicit Run now.
 */
export function SiteTokens({ provider, sites, statusOf, remaining, cap, onSave, onRun, canSave = true }: SiteTokensProps) {
  const field = provider.fields.find((entry) => entry.kind === "asset-map" && entry.managed !== true) ?? null;
  const headingId = useId();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<CollectNowResult | null>(null);
  const inFlight = useRef(new Set<string>());

  const runnable = sites.filter((site) => site.held && (remaining(site.id) ?? cap) > 0).map((site) => site.id);
  // The fewest calls any runnable site has left: what the press can promise.
  const left = runnable.reduce((fewest, id) => Math.min(fewest, remaining(id) ?? cap), cap);

  async function save(asset: string, raw: string) {
    const token = raw.trim();
    if (token === "" || inFlight.current.has(asset) || !canSave) return;
    inFlight.current.add(asset);
    setRows((current) => ({ ...current, [asset]: { state: "saving" } }));
    try {
      await onSave(asset, token);
      setRows((current) => ({ ...current, [asset]: { state: "idle" } }));
    } catch (error) {
      setRows((current) => ({ ...current, [asset]: { state: "refused", message: error instanceof Error && error.message ? error.message : "Not saved · try again" } }));
    } finally {
      // Saved or refused, the token leaves the screen: cleared for the next paste.
      setValues((current) => ({ ...current, [asset]: "" }));
      inFlight.current.delete(asset);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4" data-site-tokens={provider.id}>
      <div className="flex items-baseline gap-3">
        <span id={headingId} className="text-sm font-medium">{field?.label ?? "Tokens"}</span>
        {field?.link ? (
          <a
            href={field.link.url}
            target="_blank"
            rel="noreferrer"
            className="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground max-sm:min-h-11"
          >
            {field.link.label}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>
      {sites.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-site-tokens-empty>No sites yet</p>
      ) : (
        <ul aria-labelledby={headingId} className="overflow-hidden rounded-xl border border-border">
          {sites.map((site) => {
            const row = rows[site.id] ?? { state: "idle" };
            const status = site.held ? statusOf(site.id) : null;
            const inputId = `${headingId}-${site.id}`;
            return (
              <li key={site.id} className="flex flex-col gap-2 border-t border-border px-4 py-3 first:border-t-0" data-site-token-row={site.id} data-site-token-held={site.held ? "" : undefined}>
                <div className="flex min-h-7 items-center gap-3">
                  <PropertyFavicon domain={site.domain ?? site.id} displayName={site.label} />
                  <label htmlFor={inputId} className="min-w-0 flex-1 truncate font-medium">{site.label}</label>
                  {row.state === "saving" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-save-state="saving">
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                      Saving
                    </span>
                  ) : status ? (
                    <IntegrationStateChip state={status} subject={`site:${provider.id}:${site.id}`} />
                  ) : null}
                </div>
                <input
                  id={inputId}
                  type="password"
                  value={values[site.id] ?? ""}
                  placeholder={site.held ? "Replace token" : "Paste token"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canSave || row.state === "saving"}
                  aria-invalid={row.state === "refused" ? true : undefined}
                  data-site-token-input={site.id}
                  // Saved the moment it is pasted: a token arrives whole (a
                  // paste, or a password manager), and that is the decision.
                  // Typed characters wait for Enter or leaving the field.
                  onChange={(event) => {
                    const next = event.target.value;
                    const before = values[site.id] ?? "";
                    setValues((current) => ({ ...current, [site.id]: next }));
                    if (next.length - before.length >= WHOLE_TOKEN) void save(site.id, next);
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === "Enter") void save(site.id, event.currentTarget.value);
                  }}
                  onBlur={(event) => void save(site.id, event.currentTarget.value)}
                  className={cn(fieldClass, "h-10 w-full px-3 font-mono", row.state === "refused" ? "border-error" : null)}
                />
                {row.state === "refused" ? (
                  <p className="flex items-center gap-1.5 text-xs text-error" data-site-token-refused={site.id}>
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                    {row.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {ran !== null && !ran.ok ? (
        <p className="flex items-center gap-2 text-sm text-warn" data-collect-refusal={ran.error}>
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {ran.error === "paused" ? "Schedule paused" : ran.error === "in-flight" ? "Already collecting · try again soon" : "Nothing to collect"}
        </p>
      ) : null}
      {/* What the press spends is on the press: one of the day's calls per site. */}
      <Button
        type="button"
        variant="outline"
        className="mt-auto w-full tabular-nums"
        disabled={runnable.length === 0 || running}
        onClick={() => {
          setRunning(true);
          void onRun(runnable).then(setRan, () => setRan(null)).finally(() => setRunning(false));
        }}
        data-site-tokens-run
      >
        {running ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play aria-hidden />}
        {`Run now · 1 of ${left === cap ? cap : `${left} left`}`}
      </Button>
    </div>
  );
}

export default SiteTokens;

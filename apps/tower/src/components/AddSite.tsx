import { useDemoReadonly } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleSlash, Loader2, Plus, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  assetIdFromDomain,
  domainIssue,
  planWrites,
  siteDraft,
  siteNameFromDomain,
  validateDraft,
  type FieldIssue,
  type PlannedWrites,
} from "@shared/asset-wizard";
import { RESTORE_HASH } from "@shared/asset-detail-views";
import type { AssetStatusValue } from "@shared/changeset";
import { EmptyState } from "@/components/EmptyState";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button, type ButtonProps } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass, pillControlClass } from "@/components/ui/pill";
import { Sheet } from "@/components/ui/sheet";
import { warnConfigExport } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';
import { useSettings } from "@/hooks/useSettings";
import { useSettled, useSiteName } from "@/hooks/useSiteName";
import { useWall } from "@/hooks/useWall";
import { createAssetOperations, type IncompleteSetup } from "@/lib/asset-operations";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** Where the name on the screen came from — said as a source, never as a
 * sentence: the site's own name, or the domain's words. */
export type SiteNameSource = "site" | "domain";

export interface AddSitePanelProps {
  domain: string;
  onDomainChange: (domain: string) => void;
  /** The site as it will be saved, once the domain can be one: its id, its
   * inferred name and where the name came from. null while it cannot. */
  preview: { id: string; name: string; source: SiteNameSource; mark: string | null } | null;
  prelaunch: boolean;
  onPrelaunchChange: (prelaunch: boolean) => void;
  /** The domain's refusal, beside the field — "Already added" carries the id
   * of the asset to open instead. */
  issue: FieldIssue | null;
  /** The site `issue.existing` names is archived: its link opens it at
   * Restore, the way back (bead `ro-ujb9.76.4.5`). */
  existingArchived?: boolean;
  /** Why Add cannot run on this install right now, as the install says it. */
  blocked: string | null;
  /** Add pressed and not answered yet. */
  adding: boolean;
  /** The last Add did not land, in the server's own words. */
  failed: string | null;
  onSubmit: () => void;
  onClose: () => void;
  /** The row landed and its setup did not: the one state that is neither
   * success nor failure, with the way to finish it. */
  incomplete?: { state: IncompleteSetup; retrying: boolean; canRetry: boolean; onRetry: () => void } | null;
  /** `inline` draws the same panel in place, for the component gallery. */
  presentation?: "sheet" | "inline";
}

/**
 * ADD A SITE IN ONE SCREEN (bead `ro-ujb9.96.7.5`, epic `ro-ujb9.96.7`).
 *
 * The domain is the only question. The name is read off it at once and
 * replaced by the site's own name when the site answers; the icon is the site's
 * favicon, or its initial where none can be fetched — neither ever holds Add
 * up. One optional press says the site has not launched yet. Add writes the
 * asset through the same two writes the five-step wizard made (`planWrites`,
 * `lib/asset-operations.ts`) and lands on the new asset's Data sources, where
 * each source has its one Connect.
 *
 * Refusals are states beside the field — "Already added" with the way to the
 * one that is, "Not a domain" — shown once there is something to refuse: the
 * duplicate at once, a malformed domain only after Add is pressed, so a field
 * being typed into does not turn red.
 *
 * Registry justification: the add-asset wizard (`Wizard`) was the only way to
 * add an asset, and it was seven screens; nothing asked one question over the
 * page and landed on the answer.
 */
export function AddSitePanel({
  domain,
  onDomainChange,
  preview,
  prelaunch,
  onPrelaunchChange,
  issue,
  existingArchived = false,
  blocked,
  adding,
  failed,
  onSubmit,
  onClose,
  incomplete = null,
  presentation = "sheet",
}: AddSitePanelProps) {
  const titleId = useId();
  const fieldId = useId();
  const header = (
    <h2 id={titleId} className="m-0 text-base font-semibold leading-tight">
      Add a site
    </h2>
  );

  const body = incomplete ? (
    <IncompleteBody {...incomplete} />
  ) : (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Domain
        </label>
        <input
          id={fieldId}
          value={domain}
          disabled={adding}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="example.com"
          data-autofocus=""
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? `${fieldId}-issue` : undefined}
          onChange={(event) => onDomainChange(event.target.value)}
          className={cn(fieldClass, "h-10 w-full px-3 font-mono", issue ? "border-error" : null)}
        />
        {issue ? (
          <p id={`${fieldId}-issue`} className="m-0 flex flex-wrap items-center gap-x-2 text-xs text-error" data-add-site-issue={issue.existing ? "exists" : "invalid"}>
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {issue.message}
            {issue.existing ? (
              <Link
                to={`/assets/${encodeURIComponent(issue.existing)}${existingArchived ? `/settings${RESTORE_HASH}` : ""}`}
                className="inline-flex items-center font-medium text-foreground underline underline-offset-4 max-sm:min-h-11"
              >
                Open {issue.existing}
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      {preview ? (
        <p className="m-0 flex min-w-0 items-center gap-2.5" data-add-site-preview={preview.id}>
          <SiteMark id={preview.mark} name={preview.name} />
          <span className="min-w-0 truncate text-[15px] font-medium text-foreground" data-add-site-name>
            {preview.name}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground" data-add-site-source={preview.source}>
            {preview.source === "site" ? "from the site" : "from the domain"}
          </span>
        </p>
      ) : null}

      {blocked || failed ? (
        <p className="m-0 flex items-center gap-2 text-sm text-error" aria-live="polite" data-add-site-state={blocked ? "blocked" : "failed"}>
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {blocked ?? failed}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {/* Offered as soon as anything is typed: a malformed domain is refused
            when Add is pressed, beside the field, never by an Add that is
            silently unavailable. */}
        <Button type="submit" disabled={adding || blocked !== null || domain.trim() === "" || issue !== null} data-add-site-submit>
          {adding ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {adding ? "Adding" : "Add site"}
        </Button>
        <button
          type="button"
          aria-pressed={prelaunch}
          disabled={adding}
          onClick={() => onPrelaunchChange(!prelaunch)}
          className={cn(pillChoiceClass, pillChoiceStateClass(prelaunch), "ms-auto inline-flex items-center gap-1.5")}
          data-add-site-prelaunch
        >
          {prelaunch ? <Check className="size-3.5" aria-hidden /> : null}
          Not launched yet
        </button>
      </div>
    </form>
  );

  if (presentation === "inline") {
    return (
      <section
        aria-labelledby={titleId}
        className="flex w-full max-w-[440px] flex-col gap-4 rounded-[14px] border border-border bg-card p-5"
        data-add-site=""
      >
        <header className="flex items-center">{header}</header>
        {body}
      </section>
    );
  }
  return (
    <Sheet placement="center" labelledBy={titleId} onClose={onClose} header={header} data={{ "data-add-site": "" }}>
      {body}
    </Sheet>
  );
}

/** The site's icon: its favicon once the domain has settled, its initial in
 * the meantime and wherever no favicon answers. */
function SiteMark({ id, name }: { id: string | null; name: string }) {
  return (
    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-xs font-semibold text-foreground">
      {id ? (
        <PropertyFavicon domain={id} displayName={name} className="size-4 text-xs text-foreground" />
      ) : (
        name.trim().charAt(0).toUpperCase() || "?"
      )}
    </span>
  );
}

/** Added, setup not saved: what landed, what did not, and the one way on. */
function IncompleteBody({
  state,
  retrying,
  canRetry,
  onRetry,
}: {
  state: IncompleteSetup;
  retrying: boolean;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-add-site-state="incomplete">
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
        <li className="flex items-center gap-2" data-status-for={`asset:${state.id}`}>
          <Check className="size-4 shrink-0 text-connected" aria-hidden />
          <span className="font-mono">{state.id}</span>
          <span className="text-muted-foreground">added</span>
        </li>
        <li className="flex items-start gap-2" data-status-for={`asset-setup:${state.id}`}>
          <CircleSlash className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span>Setup not saved</span>
            <span className="text-xs text-muted-foreground">{state.reason}</span>
          </span>
        </li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={retrying || !canRetry} onClick={onRetry}>
          {retrying ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {retrying ? "Saving setup" : "Retry setup"}
        </Button>
        <Button asChild variant="outline">
          <Link to={`/assets/${encodeURIComponent(state.id)}/sources`}>Open {state.id}</Link>
        </Button>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className={cn("cursor-pointer py-2 font-medium", pillControlClass)}>Technical details</summary>
        <pre className="my-2 max-h-56 overflow-auto rounded-md border border-border bg-background p-3 text-xs">{state.changeset}</pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void copyText(state.changeset).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy setup changes"}
        </Button>
      </details>
    </div>
  );
}

/**
 * Add a site, wired: the portfolio's ids for the duplicate check, the source
 * catalog and entities the write composes from, the install's writability, the
 * site's own name, and the create path. Lands on the new asset's Data sources.
 */
export function AddSiteSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const wall = useWall();
  const settings = useSettings();
  const writable = useConfigWritable();
  const api = useTowerApi();
  const [operations] = useState(() => createAssetOperations(api));

  const [domain, setDomain] = useState("");
  const [prelaunch, setPrelaunch] = useState(false);
  const [tried, setTried] = useState(false);
  const [rejected, setRejected] = useState<(FieldIssue & { existingStatus?: AssetStatusValue }) | null>(null);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState<IncompleteSetup | null>(null);
  /** The plan the last Add sent. A retry re-sends exactly it — the operation
   * session holds the acknowledged copy, so nothing here can widen it. */
  const [sent, setSent] = useState<PlannedWrites | null>(null);
  /** Add pressed before the source catalog loaded: sent once it has. */
  const [queued, setQueued] = useState(false);
  const addRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (queued && settings.data !== undefined) void addRef.current();
  }, [queued, settings.data]);
  // A catalog that fails to load cancels the kept press: `blocked` says why.
  useEffect(() => {
    if (queued && settings.isError) setQueued(false);
  }, [queued, settings.isError]);

  const id = assetIdFromDomain(domain);
  const existingIds = (wall.data?.assets ?? []).map((asset) => asset.id);
  const archivedIds = new Set((wall.data?.assets ?? []).filter((asset) => asset.status === "retired").map((asset) => asset.id));
  const local = domainIssue(domain, { existingIds });
  const issue = rejected ?? (local && (local.existing || tried) ? local : null);
  const usable = id.length > 0 && local === null;
  const siteName = useSiteName(usable ? id : null);
  const name = siteName ?? siteNameFromDomain(domain);
  const settledId = useSettled(usable ? id : null, 400);
  const blocked = !writable.writable
    ? (writable.reason ?? "This install cannot save setup right now")
    : settings.isError
      ? "Data sources unavailable · try again"
      : null;

  function finish(plan: { id: string; row: { displayName: string } }, result: Parameters<typeof warnConfigExport>[0]) {
    warnConfigExport(result);
    void queryClient.invalidateQueries({ queryKey: ["wall"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    // The new asset's own page, under its name, is the confirmation — no toast
    // saying so as well, over the Connect the operator presses next. Landing
    // there unmounts whichever page held this sheet.
    navigate(`/assets/${encodeURIComponent(plan.id)}/sources`);
  }

  async function add() {
    setTried(true);
    setFailed(null);
    if (!usable || blocked !== null) return;
    // The source catalog is what the new asset's data sources are written from;
    // adding before it has loaded would write an asset with none. A press that
    // arrives first is kept, shown as Adding, and sent the moment it loads —
    // never dropped, which would leave an Add that silently did nothing.
    if (settings.data === undefined) {
      setQueued(true);
      return;
    }
    setQueued(false);
    const draft = siteDraft({ domain, displayName: name, prelaunch });
    const first = validateDraft(draft, { existingIds })[0];
    if (first) {
      setRejected(first);
      return;
    }
    const plan = planWrites(draft, settings.data.sources.rows, settings.data.entities?.rows ?? []);
    setSent(plan);
    setAdding(true);
    const outcome = await operations.create(plan);
    if (outcome.kind === "busy") return;
    setAdding(false);
    if (outcome.kind === "rejected") {
      setRejected({ field: outcome.field, message: outcome.message, existing: outcome.existing, existingStatus: outcome.existingStatus });
    } else if (outcome.kind === "failed") {
      setFailed(outcome.message);
    } else if (outcome.kind === "setup-needed") {
      setIncomplete(outcome.report);
    } else {
      finish(outcome.plan, outcome.result);
    }
  }

  addRef.current = add;

  async function retry() {
    if (sent === null) return;
    setAdding(true);
    // The operation session holds the acknowledged plan: a retry sends only its
    // setup, never a second asset (`lib/asset-operations.ts`).
    const outcome = await operations.create(sent);
    if (outcome.kind === "busy") return;
    setAdding(false);
    if (outcome.kind === "setup-needed") setIncomplete(outcome.report);
    else if (outcome.kind === "created") finish(outcome.plan, outcome.result);
    else if (outcome.kind === "failed") setIncomplete((current) => (current ? { ...current, reason: outcome.message } : current));
  }

  return (
    <AddSitePanel
      domain={domain}
      onDomainChange={(value) => {
        setDomain(value);
        setRejected(null);
        setFailed(null);
      }}
      preview={usable && name.length > 0 ? { id, name, source: siteName ? "site" : "domain", mark: settledId === id ? id : null } : null}
      prelaunch={prelaunch}
      onPrelaunchChange={setPrelaunch}
      issue={issue}
      existingArchived={rejected?.existingStatus !== undefined
        ? rejected.existingStatus === "retired"
        : issue?.existing !== undefined && archivedIds.has(issue.existing)}
      blocked={blocked}
      adding={adding || queued}
      failed={failed}
      onSubmit={() => void add()}
      onClose={onClose}
      incomplete={incomplete ? { state: incomplete, retrying: adding, canRetry: writable.writable, onRetry: () => void retry() } : null}
    />
  );
}

/**
 * The way in: a button that opens Add a site over the page it is on, so adding
 * a site is never a page of its own. Takes the Button's own props, so each
 * surface draws it in its own weight.
 */
export function AddSiteButton({ children, ...props }: Omit<ButtonProps, "onClick" | "type"> & { children?: ReactNode }) {
  const demoReadonly = useDemoReadonly();
  const [open, setOpen] = useState(false);
  const readOnly = demoReadonly;
  return (
    <>
      <Button type="button" {...props} disabled={readOnly || props.disabled} title={readOnly ? DEMO_READ_ONLY : props.title} onClick={() => { if (!readOnly) setOpen(true); }} data-add-site-open>
        {children ?? "Add a site"}
      </Button>
      {open && !readOnly ? <AddSiteSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * AN EMPTY SITE LIST IS A DOOR (bead `ro-ujb9.96.6.18`, D30): "No sites yet"
 * and Add a site beside it, for a list whose page has no Add a site of its own.
 * It used to say the first site "arrives with its seed row and its nightly
 * report" — how a site reached the store before Add a site existed, and a
 * sentence with no next action. A page whose header already offers Add a site
 * (Sites) shows the bare "No sites yet" and lets that button be the one.
 */
export function NoSitesYet() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-no-sites>
      <EmptyState title="No sites yet" />
      <AddSiteButton size="sm">
        <Plus aria-hidden /> Add a site
      </AddSiteButton>
    </div>
  );
}

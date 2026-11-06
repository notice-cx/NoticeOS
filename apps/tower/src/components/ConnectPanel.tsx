import { LOCAL_MODEL_OUTPUT_TOKENS, MIN_LOCAL_MODEL_OUTPUT_TOKENS, MAX_LOCAL_MODEL_OUTPUT_TOKENS, parseLocalModelOutputTokens } from '@noticeos/contract/local-model-settings';
import { Check, ExternalLink, KeyRound, Loader2, Plus, Send, TriangleAlert, WifiOff } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ConnectFacts, ConnectVerdict, IntegrationField, IntegrationProvider } from "@noticeos/contract";
import { connectionFailureLabel, exactUsd } from "@noticeos/contract/integrations";
import { acceptedAs } from "@noticeos/contract/integrations";
import { connectionLabel } from "@shared/connection-status";
import { feedLines, feedRows, providerName, refusalLine, secretNoun, type ConnectPhase } from "@shared/connect-panel";
import { parseUrlList } from "@shared/integrations-page";
import { siteNoun } from "@shared/site-noun";
import { ConnectionActions, type ConnectionSite } from "@/components/ConnectionActions";
import { IntegrationLogo } from "@/components/IntegrationLogo";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { ApiError, discoverModelProvider } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The provider's accepted answer, as the panel's next step receives it. */
export type AcceptedVerdict = Extract<ConnectVerdict, { verdict: "accepted" }>;

/** What the panel connects: a credential provider, or any other connection
 * drawn the same way, such as a task source whose `setup` body has no fields
 * of its own. The panel reads only these parts. */
export type ConnectSubject = Pick<IntegrationProvider, "label" | "fields" | "connect"> &
  Partial<Pick<IntegrationProvider, "test">> & { id: string };

export interface ConnectPanelProps {
  provider: ConnectSubject;
  /** Send the entered details; the ingest asks the provider before storing.
   * Absent for a subject whose `setup` body is all it asks (a task source). */
  onConnect?: (fields: Record<string, string>) => Promise<ConnectVerdict>;
  onClose: () => void;
  /** False when this install cannot store a credential yet (no key, no table):
   * Connect and Replace stop. Why is said once per screen — the page's banner
   * on /integrations, else `blocked`. */
  canConnect?: boolean;
  /** Why Connect is off, drawn at the top of the panel (`ConnectBlockers`).
   * Only where the page behind does not already say it. */
  blocked?: ReactNode;
  /** What follows an accepted key, inside the panel (`SitePicker`), which
   * then owns the panel's footer. `answer` is null when the panel opened on an
   * already-connected provider. Absent: the panel offers Done. */
  next?: (answer: AcceptedVerdict | null, close: () => void) => ReactNode;
  /** `sites` opens a connected provider straight on `next`; `replace` opens
   * its key form and ends on the provider's answer. */
  opened?: "form" | "sites" | "replace";
  /** The header's status in place of the key's answer, drawn by the caller,
   * or `null` once the next step's rows carry each site's status. */
  status?: ReactNode | null;
  /** `inline` draws the same panel in place, for the component gallery. */
  presentation?: "sheet" | "inline";
  /** The body in place of the key form, for a provider connected by signing
   * in on its own consent screen. The sign-in leaves the page and comes back
   * to this panel on the account's sites. */
  setup?: ReactNode;
  /** Replace and Disconnect for a connected provider. A replacement key is
   * kept only once the provider accepts it, so the old one collects until
   * then; Disconnect asks once, naming the sites that stop. */
  manage?: ConnectPanelManage;
  /** What the connection carries, above its fields (`WhatLands`). */
  carries?: ReactNode;
  /** The sync frequency on the connection, drawn by the caller and shown only
   * on a connected provider's own view, never while a key is being replaced or
   * a disconnect confirmed. */
  schedule?: ReactNode;
}

/** A connected provider's actions in the panel (`ConnectionActions`). */
export interface ConnectPanelManage {
  /** The sites that stop collecting if it is disconnected. */
  stops: readonly ConnectionSite[];
  onDisconnect: () => Promise<void>;
  /** Its key is failing: Replace leads. */
  failing?: boolean;
}

/**
 * Connect a provider in one panel. The ingest shows the entered details to
 * the provider first and stores them only if accepted, so the panel never
 * shows a green state ahead of the answer. Nothing is shown back: fields open
 * empty, a refused secret is cleared for the next paste, and an accepted one
 * leaves the screen with the form.
 */
export function ConnectPanel({
  provider,
  onConnect,
  onClose,
  canConnect = true,
  blocked,
  next,
  opened = "form",
  status,
  presentation = "sheet",
  manage,
  setup,
  carries,
  schedule,
}: ConnectPanelProps) {
  const titleId = useId();
  const modelProvider = provider.id === "local-model";
  const [models, setModels] = useState<string[]>([]);
  const [modelState, setModelState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [modelError, setModelError] = useState("");
  const modelRequest = useRef<AbortController | null>(null);
  useEffect(() => () => modelRequest.current?.abort(), []);

  function clearModels() {
    modelRequest.current?.abort();
    modelRequest.current = null;
    setModels([]);
    setModelState("idle");
    setModelError("");
  }

  async function loadModels() {
    modelRequest.current?.abort();
    const request = new AbortController();
    modelRequest.current = request;
    setModels([]);
    setValues((current) => ({ ...current, LOCAL_MODEL_ID: "" }));
    setModelState("loading");
    setModelError("");
    try {
      const result = await discoverModelProvider({
        LOCAL_MODEL_BASE_URL: values.LOCAL_MODEL_BASE_URL?.trim() ?? "",
        LOCAL_MODEL_API_TOKEN: values.LOCAL_MODEL_API_TOKEN?.trim() ?? "",
      }, request.signal);
      if (request.signal.aborted) return;
      if (!result.ok) {
        setModelError(connectionFailureLabel(result.failure));
        setModelState("failed");
        return;
      }
      setModels(result.models);
      setModelState("loaded");
      if (result.models.length === 1) setValues((current) => ({ ...current, LOCAL_MODEL_ID: result.models[0]! }));
    } catch {
      if (request.signal.aborted) return;
      setModelError("Could not load models. Try again.");
      setModelState("failed");
    }
  }
  const fields = provider.fields.filter((field) => field.managed !== true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<ConnectPhase>({ phase: "editing" });
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // Opened on a connected provider, the panel shows its sites until Replace
  // asks for the key form; opened on the form (a new or failing key, or a
  // replacement asked for elsewhere), the form is the panel.
  // A connection with no site list (Discord, the calendar feeds) opens on its
  // status and actions alone, and Replace asks for the form.
  const [replacing, setReplacing] = useState(opened !== "sites" || (!next && !manage));
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const answer = phase.phase === "answered" ? phase.answer : null;
  const accepted = answer?.verdict === "accepted" ? answer : null;
  const checking = phase.phase === "checking";
  // Every field the panel shows is needed, unless the provider marks some
  // required and the rest optional; a provider with two ways in (PostHog's
  // account key or its older per-site keys) shows only the one it asks for.
  const needed = fields.some((field) => field.required) ? fields.filter((field) => field.required) : fields;
  const complete = needed.every((field) => filled(field, values[field.name] ?? ""))
    && (!modelProvider || (modelState === "loaded" && models.includes(values.LOCAL_MODEL_ID ?? "") && parseLocalModelOutputTokens(values[LOCAL_MODEL_OUTPUT_TOKENS]) !== null));
  // A replaced key changes no site: once accepted the panel is done.
  const rotated = opened !== "form";

  // Replace pressed: the form has just appeared, so its key field takes focus.
  useEffect(() => {
    if (replacing && opened === "sites") form.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [replacing, opened]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || checking || !canConnect || !onConnect) return;
    setFieldError(null);
    setFailed(false);
    // What the store receives: each typed value, a feed list as the map its
    // one parser makes (refused on the field before anything leaves).
    const sent: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name] ?? "";
      if (!filled(field, value)) continue;
      if (field.kind !== "url-list") {
        sent[field.name] = modelProvider && field.name === "LOCAL_MODEL_ID" ? value : value.trim();
        continue;
      }
      const parsed = parseUrlList(feedLines(feedRows(value)));
      if (!parsed.ok) {
        setFieldError({ field: field.name, message: parsed.error });
        return;
      }
      sent[field.name] = parsed.value;
    }
    setPhase({ phase: "checking" });
    try {
      const verdict = await onConnect(sent);
      setPhase({ phase: "answered", answer: verdict });
      if (verdict.verdict === "accepted") {
        setValues({});
      } else if (verdict.verdict === "refused") {
        if (modelProvider) clearModels();
        // A refused secret is not kept on screen: clear it for the next paste.
        setValues((current) => Object.fromEntries(
          Object.entries(current).filter(([name]) => !fields.find((field) => field.name === name)?.secret),
        ));
        // Focus returns to the cleared secret: a password, or a URL that is
        // itself the secret (a webhook, a feed).
        requestAnimationFrame(() => (
          form.current?.querySelector<HTMLInputElement>("input[type=password]")
          ?? form.current?.querySelector<HTMLInputElement>("[aria-invalid], input[type=text]")
        )?.focus());
      }
    } catch (error) {
      setPhase({ phase: "editing" });
      if (error instanceof ApiError && error.field && fields.some((field) => field.name === error.field)) {
        setFieldError({ field: error.field, message: error.message });
      } else {
        setFailed(true);
      }
    }
  }

  const header = (
    <>
      <IntegrationLogo provider={provider.id} size="small" />
      <h2 id={titleId} className="min-w-0 text-base font-semibold leading-tight">
        {providerName(provider)}
      </h2>
      {status === null ? null : accepted ? (
        // The provider's answer is marked where it is shown, so it is visible
        // whichever facts follow it — a replaced key's answer included.
        <span className="ms-auto inline-flex" data-status-for={`integration:${provider.id}`} data-connect-state="accepted">
          {/* The region that answered is part of the answer: found, never
              asked for. Named for what was given: a key, a sign-in, an address. */}
          <StateChip
            label={accepted.facts.region
              ? `${connectionLabel("key-accepted", acceptedAs(provider))} · ${accepted.facts.region.toUpperCase()}`
              : connectionLabel("key-accepted", acceptedAs(provider))}
            tone="connected"
            glyph={<Check className="size-3" />}
            subject={`integration:${provider.id}`}
          />
        </span>
      ) : status !== undefined ? (
        <span className="ms-auto inline-flex">{status}</span>
      ) : null}
    </>
  );

  // The connection's own actions sit under its status until a new key's
  // answer takes the panel over.
  const actions = manage && !accepted ? (
    <ConnectionActions
      name={providerName(provider)}
      secret={secretNoun(provider)}
      // A token pasted per site is replaced on its row; a sign-in is made again.
      onReplace={opened === "sites" && provider.connect?.kind === "key" ? () => {
        setReplacing((open) => !open);
        setPhase({ phase: "editing" });
        setFieldError(null);
        setFailed(false);
      } : undefined}
      replacing={replacing}
      replaceDisabled={!canConnect || checking}
      failing={manage.failing}
      stops={manage.stops}
      onDisconnect={manage.onDisconnect}
      onConfirming={setConfirming}
    />
  ) : null;

  // The connection's schedule belongs to its own view: not to a fresh key's
  // answer, a replacement or a disconnect being confirmed.
  const when = manage && schedule && !accepted && !replacing && !confirming ? (
    <div data-connection-schedule>{schedule}</div>
  ) : null;

  const body = confirming ? null : !replacing ? (
    next ? next(null, onClose) : null
  ) : accepted ? (
    <>
      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden" data-connect-facts>
        {/* With the site list following, the list IS the sites: only the
            facts it cannot show (DataForSEO's credit) stay here. */}
        <AcceptedFacts provider={provider} facts={next && !rotated ? { ...accepted.facts, sites: undefined, projects: undefined, databases: undefined } : accepted.facts} />
      </div>
      {next && !rotated ? next(accepted, onClose) : (
        // Focus follows the answer: the form it was in has just gone.
        <Button type="button" className="mt-auto w-full" onClick={onClose} autoFocus={presentation === "sheet"}>
          Done
        </Button>
      )}
    </>
  ) : setup !== undefined ? (
    setup
  ) : (
    <form ref={form} onSubmit={submit} className="flex flex-1 flex-col gap-4" noValidate>
      {fields.filter((field) => !modelProvider || field.name !== "LOCAL_MODEL_ID").map((field, index) => (
        <KeyField
          key={field.name}
          field={field}
          value={values[field.name] ?? ""}
          disabled={checking}
          autoFocus={index === 0}
          error={modelProvider && field.name === LOCAL_MODEL_OUTPUT_TOKENS && parseLocalModelOutputTokens(values[field.name]) === null ? `Use a whole number from ${MIN_LOCAL_MODEL_OUTPUT_TOKENS.toLocaleString('en-US')} to ${MAX_LOCAL_MODEL_OUTPUT_TOKENS.toLocaleString('en-US')}.` : fieldError?.field === field.name ? fieldError.message : null}
          onChange={(value) => {
            const changesInventory = modelProvider && ["LOCAL_MODEL_BASE_URL", "LOCAL_MODEL_API_TOKEN"].includes(field.name);
            if (changesInventory) clearModels();
            setValues((current) => ({ ...current, ...(changesInventory ? { LOCAL_MODEL_ID: "" } : {}), [field.name]: value }));
            if (fieldError?.field === field.name) setFieldError(null);
          }}
        />
      ))}
      {modelProvider ? <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" disabled={checking || !canConnect || modelState === "loading" || !values.LOCAL_MODEL_BASE_URL?.trim()}
          onClick={() => void loadModels()}>
          {modelState === "loading" ? "Loading models" : modelState === "failed" ? "Retry loading models" : "Load models"}
        </Button>
        {models.length > 0 ? <>
          <label htmlFor={`${titleId}-model`} className="text-sm font-medium">Model *</label>
          <select id={`${titleId}-model`} required className={cn(fieldClass, "h-10 w-full px-3")}
            disabled={checking} value={values.LOCAL_MODEL_ID ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, LOCAL_MODEL_ID: event.target.value }))}>
            <option value="">Choose a model</option>
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </> : null}
        <div aria-live="polite">
          {modelState === "loaded" && models.length === 0 ? <p className="text-sm text-muted-foreground">No models found. Check the server’s available models, then load again.</p> : null}
          {modelError ? <p className="text-sm text-error">{modelError}</p> : null}
        </div>
      </div> : null}
      <div aria-live="polite">
        {answer && answer.verdict !== "accepted" ? (
          <p
            className={cn("flex items-center gap-2 text-sm", answer.verdict === "refused" ? "text-error" : "text-muted-foreground")}
            data-connect-state={answer.verdict}
          >
            {answer.verdict === "refused" ? <TriangleAlert className="size-4 shrink-0" aria-hidden /> : <WifiOff className="size-4 shrink-0" aria-hidden />}
            {refusalLine(provider, answer.verdict, answer.failure)}
          </p>
        ) : failed ? (
          <p className="flex items-center gap-2 text-sm text-error" data-connect-state="failed">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            Not saved · try again
          </p>
        ) : null}
      </div>
      {/* A press with a side effect says so before it is made. */}
      {provider.test?.cost === "side-effect" ? (
        <span className="mt-auto inline-flex" data-connect-cost="side-effect">
          <StateChip tone="neutral" label="Posts a test message" glyph={<Send className="size-3" />} subject={`integration:${provider.id}`} />
        </span>
      ) : null}
      <Button
        type="submit"
        className={cn("w-full", provider.test?.cost === "side-effect" ? null : "mt-auto")}
        disabled={!complete || checking || !canConnect}
        data-connect-submit
      >
        {checking ? (
          <>
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
            Checking
          </>
        ) : (
          "Connect"
        )}
      </Button>
    </form>
  );

  if (presentation === "inline") {
    return (
      <section
        aria-labelledby={titleId}
        className="flex min-h-80 w-full max-w-[430px] flex-col gap-5 rounded-xl border border-border bg-card p-5"
        data-connect-panel={provider.id}
      >
        <header className="flex min-w-0 items-center gap-3">{header}</header>
        {blocked}
        {actions}
        {when}
        {confirming ? null : carries}
        {body}
      </section>
    );
  }
  return (
    <Sheet labelledBy={titleId} onClose={onClose} header={header} data={{ "data-connect-panel": provider.id }}>
      {blocked}
      {actions}
      {when}
      {confirming ? null : carries}
      {body}
    </Sheet>
  );
}

/** One field the provider issued, with where to get it beside the label. */
function KeyField({
  field,
  value,
  disabled,
  autoFocus,
  error,
  onChange,
}: {
  field: IntegrationField;
  value: string;
  disabled: boolean;
  autoFocus: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const id = useId();
  if (field.kind === "url-list") {
    return <FeedListField field={field} value={value} disabled={disabled} autoFocus={autoFocus} error={error} onChange={onChange} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {field.label}
        </label>
        {field.required ? <span aria-hidden="true" className="-ms-2 text-sm">*</span> : null}
        {field.link ? (
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
      {/* The access the key must carry, as chips. */}
      {field.grants && field.grants.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={`${field.label} access`} data-field-grants={field.name}>
          {field.grants.map((grant) => (
            <li key={grant}>
              <StateChip tone="neutral" label={grant} glyph={<KeyRound className="size-3" />} subject={`access:${field.name}`} />
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={id}
        // Masked only where it is a password: a webhook address is read back
        // against Discord's own screen, and a mask hides the typo that 404s.
        type={field.kind === "password" ? "password" : field.name === LOCAL_MODEL_OUTPUT_TOKENS ? "number" : "text"}
        {...(field.name === LOCAL_MODEL_OUTPUT_TOKENS ? { inputMode: 'numeric' as const, min: MIN_LOCAL_MODEL_OUTPUT_TOKENS, max: MAX_LOCAL_MODEL_OUTPUT_TOKENS, step: '1' } : {})}
        value={value}
        placeholder={field.placeholder}
        aria-describedby={field.description ? `${id}-description` : undefined}
        disabled={disabled}
        required={field.required}
        autoComplete="off"
        spellCheck={false}
        {...(autoFocus ? { "data-autofocus": "" } : {})}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(fieldClass, "h-10 w-full px-3 font-mono", error ? "border-error" : null)}
      />
      {field.description ? <p id={`${id}-description`} className="text-xs text-muted-foreground">{field.description}</p> : null}
      {error ? <p className="text-xs text-error">{error}</p> : null}
    </div>
  );
}

/** Does this field hold a value to send? A feed list needs one feed's URL. */
function filled(field: IntegrationField, value: string): boolean {
  return field.kind === "url-list"
    ? feedRows(value).some((row) => row.url.trim() !== "")
    : value.trim() !== "";
}

/** A list of named feeds, one row each, with Add feed. An unnamed feed is
 * named by its position, as `parseUrlList` names it. */
function FeedListField({
  field,
  value,
  disabled,
  autoFocus,
  error,
  onChange,
}: {
  field: IntegrationField;
  value: string;
  disabled: boolean;
  autoFocus: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const rows = feedRows(value);
  const [namePlaceholder, urlPlaceholder] = (field.placeholder ?? "").includes(" = ")
    ? (field.placeholder ?? "").split(" = ", 2)
    : ["", field.placeholder ?? ""];
  const set = (index: number, patch: Partial<(typeof rows)[number]>) =>
    onChange(JSON.stringify(rows.map((row, at) => (at === index ? { ...row, ...patch } : row))));
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5" data-feed-list={field.name}>
      <div className="flex items-baseline gap-3">
        <span id={id} className="text-sm font-medium">{field.label}</span>
        {field.link ? (
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
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2" data-feed-row={index + 1}>
          <input
            type="text"
            value={row.name}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder={namePlaceholder}
            aria-label={`Name, feed ${index + 1}`}
            onChange={(event) => set(index, { name: event.target.value })}
            className={cn(fieldClass, "h-10 w-24 shrink-0 px-3")}
          />
          <input
            type="text"
            value={row.url}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder={urlPlaceholder}
            aria-label={`URL, feed ${index + 1}`}
            aria-invalid={error ? true : undefined}
            {...(autoFocus && index === 0 ? { "data-autofocus": "" } : {})}
            onChange={(event) => set(index, { url: event.target.value })}
            className={cn(fieldClass, "h-10 min-w-0 flex-1 px-3 font-mono text-xs", error ? "border-error" : null)}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange(JSON.stringify([...rows, { name: "", url: "" }]))}
      >
        <Plus aria-hidden />
        Add feed
      </Button>
      {error ? <p className="text-xs text-error">{error}</p> : null}
    </div>
  );
}

/** What the accepted answer proved, drawn as the number it is. */
function AcceptedFacts({ provider, facts }: { provider: ConnectSubject; facts: ConnectFacts }) {
  const rows: { value: string; label: string; extra?: ReactNode }[] = [];
  if (facts.sites !== undefined) {
    rows.push({
      value: String(facts.sites),
      label: siteNoun(facts.sites),
      extra: facts.sites === 0 && provider.connect?.addSite ? (
        <Button asChild variant="outline" size="sm" className="ms-auto">
          <a href={provider.connect.addSite.url} target="_blank" rel="noreferrer">
            {provider.connect.addSite.label}
            <ExternalLink aria-hidden />
          </a>
        </Button>
      ) : undefined,
    });
  }
  if (facts.feeds !== undefined) {
    rows.push({ value: String(facts.feeds), label: facts.feeds === 1 ? "feed" : "feeds" });
  }
  if (facts.databases !== undefined) {
    rows.push({ value: String(facts.databases), label: facts.databases === 1 ? "database" : "databases" });
  }
  const credit = exactUsd(facts.creditUsd);
  if (credit !== null) {
    rows.push({ value: formatUsd(credit, { cents: true }), label: "credit" });
  }
  if (facts.projects !== undefined) {
    rows.push({ value: String(facts.projects), label: facts.projects === 1 ? "project" : "projects" });
  }
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <p key={row.label} className="flex items-baseline gap-2" data-connect-fact={row.label}>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">{row.value}</span>
          <span className="text-sm text-muted-foreground">{row.label}</span>
          {row.extra}
        </p>
      ))}
    </>
  );
}

export default ConnectPanel;

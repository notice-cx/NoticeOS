import {
  CalendarClock,
  CalendarX2,
  Check,
  CircleDashed,
  ExternalLink,
  FileKey2,
  Loader2,
  LogIn,
  Send,
  Terminal,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  NOTIFICATION_LANE,
  connectionState,
  credentialAssetRows,
  credentialBalance,
  credentialExpiry,
  meterRemaining,
  type ConnectionState,
  type CredentialAssetRow,
  type CredentialBalanceReading,
  type CredentialExpiryReading,
  type CredentialProbe,
  type CredentialPropertyMapUse,
  type IntegrationExpiry,
  type IntegrationField,
  type IntegrationMeter,
  type IntegrationProviderStatus,
  type LegacyAssetBinding,
  type ProbeCost,
  type ProbeResult,
  type ProviderMeterReading,
} from "@shared/integrations-page";
import { acceptedAs, exactUsd, probeOutcomeLabel } from "@noticeos/contract/integrations";
import { siteNoun } from "@shared/site-noun";
import { ENV_MIGRATE_COMMAND, type EnvImportBlock } from "@shared/env-import";
import { ageMs, formatAge } from "@shared/freshness";
import { connectionStatus, type ConnectionStatus } from "@shared/connection-status";
import { providerName, secretNoun } from "@shared/connect-panel";
import { ConnectionActions } from "@/components/ConnectionActions";
import { CopyCommand } from "@/components/CopyCommand";
import { WhatLands } from "@/components/WhatLands";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Meter } from "@/components/Meter";
import { InfoTooltip } from "@/components/InfoTooltip";
import { IntegrationLogo } from "@/components/IntegrationLogo";
import { ConnectionFacts, IntegrationStateChip } from "@/components/IntegrationStateChip";
import { StateChip, type StateTone, type StatusSubject } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fieldClass } from "@/components/ui/field";
import { formatPeriodMonth, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { ProviderCredentialForm, ProviderLink } from "@/components/provider-card/ProviderCredentialForm";
import { GoogleSignIn, StepNumber, type ProviderOAuthPanel } from "@/components/provider-card/GoogleSignIn";
import { GoogleStartPress } from './provider-card/GoogleStartPress';
import { messageOf } from "@/components/provider-card/errors";

export type { ProviderOAuthPanel } from "@/components/provider-card/GoogleSignIn";

/** The command that moves the operator's existing `.dev.secrets.json` into the
 * store in one go, so nobody retypes a service-account JSON they already have.
 * Since `ro-vu8d.7` it is the FALLBACK: where the OS is running the same move is
 * a button, and this is what a deployed build shows instead — one constant, so
 * the button and the fallback cannot disagree about what the other way is. */
export const SECRETS_IMPORT_COMMAND = "pnpm dev:secrets:import";

/**
 * The Import half of the Legacy env explainer (bead `ro-vu8d.7`).
 *
 * A PROP rather than a hook call inside the card, for the same reason the Google
 * sign-in panel is: this component renders in the gallery and in tests, where
 * there is no dev server to ask, and a card that fetches on its own could not be
 * shown in a state on purpose. The route asks once and hands the answer down.
 *
 * `importable: false` is also what an unanswered question looks like — the card
 * then shows the command, which is true everywhere.
 */
export interface ProviderEnvImport {
  importable: boolean;
  /** Why not, when the deployment cannot, as the code the card draws. Null
   * while the answer is unknown. */
  reason: EnvImportBlock | null;
  /** Runs the import for the WHOLE secrets file and refreshes the page's read.
   * Rejects with a sentence the card shows beside the button. */
  onImport: () => Promise<void>;
}

/** One asset this credential serves, with the identity the favicon needs. The
 * payload carries ids only; the page resolves them against the asset directory
 * and passes what it found. */
export interface ProviderCardAsset {
  id: string;
  displayName: string;
  /** null when the directory does not know this id — the link still works. */
  domain: string | null;
}

export interface ProviderCardProps {
  status: IntegrationProviderStatus;
  /** Resolved identities for `status.assets`, in the payload's order. */
  assets: ProviderCardAsset[];
  nowMs: number;
  /** False when this deployment cannot store a credential at all — no
   * `credentials` table, or no `CREDENTIALS_KEY`. Connect is disabled and the
   * card says nothing more: the page's banner states why, once, with the
   * command that clears it (beads `ro-ujb9.96.6.19`, `ro-ujb9.204`).
   * Disconnect stays live, because forgetting a credential nobody can read any
   * more is exactly when you need to. */
  canConnect?: boolean;
  /** Presentation capability: stored reads remain available, operations do not. */
  readOnly?: boolean;
  onConnect: (fields: Record<string, string>) => Promise<void>;
  onTest: () => Promise<CredentialProbe>;
  onDisconnect: () => Promise<void>;
  /**
   * Record when this credential stops working, or `null` for *it does not*
   * (bead `ro-vu8d.8`). Absent on a card whose provider declares
   * `expiry.known === "never"` — there is nothing there to date, and the card
   * says so in the provider's own sentence instead.
   */
  onSetExpiry?: (expiresAt: string | null) => Promise<void>;
  /** Google only. See `ProviderOAuthPanel`. */
  oauth?: ProviderOAuthPanel;
  /** Legacy env cards only. See `ProviderEnvImport`. Absent means the card was
   * not told, and it shows the command. */
  envImport?: ProviderEnvImport;
  /** Focused integration setup; the default keeps the complete reference card.
   * A guided card shows no status of its own: its page's header carries the
   * connection's one status (bead `ro-ujb9.96.7.3`). */
  guided?: boolean;
  /** The connection's one status (`@shared/connection-status`). Without it the
   * card reads what the credential alone proves, never ahead of it. */
  connection?: ConnectionStatus;
  /**
   * Replace the secret somewhere that asks the provider before keeping it —
   * the connect panel, for a provider that connects there (bead
   * `ro-ujb9.96.7.10`). Absent: Replace opens this card's own form.
   */
  onReplace?: () => void;
  className?: string;
}

/** What a scope means, in the operator's words rather than the schema's. */
const SCOPE_NOTE: Record<string, string> = {
  shared: "One account covers every site.",
  "per-asset": "Entered once per site.",
};

/**
 * One provider: what state its credential is in, which assets it serves, and
 * the three things an operator can do to it — connect, test, disconnect (bead
 * `ro-vu8d.2`, doc 14 flow C).
 *
 * NOTHING IS EVER ECHOED BACK. The API returns field names and timestamps only,
 * so after a save the card shows *set*, never the value — and Reconnect opens
 * empty inputs rather than pre-filled ones, because a pre-filled password field
 * is a claim that the browser knows the password.
 *
 * DISCONNECT IS THE ONE CONFIRM HERE. D18's rule is undo over confirm, and
 * Connect follows it. Disconnect cannot: there is nothing to undo back TO — the
 * plaintext is gone the moment the row is deleted — and it silently stops every
 * lane the credential powers, which is the case doc 14 principle 5 sends to
 * principle 1 instead. So it names the sites that stop and asks once
 * (`ConnectionActions`, bead `ro-ujb9.96.7.10`) — beside Replace, at the top of
 * the card, on every step: the connection's actions live on the connection.
 */
export function ProviderCard({
  status,
  assets,
  nowMs,
  canConnect = true,
  readOnly = false,
  onConnect,
  onTest,
  onDisconnect,
  onSetExpiry,
  oauth,
  envImport,
  guided = false,
  connection,
  onReplace,
  className,
}: ProviderCardProps) {
  const { provider, credential } = status;
  const state = connectionState(credential);
  const shown = connection ?? connectionStatus(provider.id, credential, []);
  const connected = state !== "not-connected";
  const expiry = credentialExpiry(credential.metadata, nowMs);
  // WHICH ASSETS THIS CREDENTIAL SERVES — derived ONCE, in the contract, and
  // read by both the list below and the per-asset form (bead `ro-vu8d.9`). The
  // catalog says who declares this provider and the store says who has a key;
  // pairing them up twice is how a card ends up claiming coverage the form
  // disagrees with.
  const rows = credentialAssetRows(status);
  const identities = new Map(assets.map((asset) => [asset.id, asset]));
  // The last figure DataForSEO reported about its own prepaid account, aged
  // here rather than in the meter block so one derivation serves the card
  // (bead `ro-qpas`). Null means nothing has been seen yet, which is a sentence
  // the card prints rather than a line it hides.
  const balance = credentialBalance(credential.metadata, nowMs);

  const [step, setStep] = useState<
    "connect" | "assets" | "verify" | "settings"
  >(connected && state !== "legacy-env" ? "verify" : "connect");
  // The steps are their names: the pressed step in the nav IS the heading of
  // what follows, so no subtitle restates it (bead `ro-ujb9.96.6.1`).
  const setupSteps = [
    { id: "connect", label: "Connect" },
    { id: "assets", label: "Choose sites" },
    { id: "verify", label: "Verify" },
    { id: "settings", label: "Settings" },
  ] as const;
  const visible = (section: typeof step) => !guided || step === section;
  const [formOpen, setFormOpen] = useState(false);
  const [probe, setProbe] = useState<CredentialProbe | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const googleConnection = oauth && !readOnly ? <GoogleSignIn panel={oauth} canConnect={canConnect} failing={state === "failing"} /> : null;

  return (
    <Card className={className} data-provider-card={provider.id}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="flex items-center gap-3 text-sm font-semibold normal-case tracking-normal text-foreground">
            {!guided && <IntegrationLogo provider={provider.id} size="small" />}
            {guided ? "Connection setup" : provider.label}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {guided ? null : (
              <>
                <IntegrationStateChip state={shown.kind} accepted={acceptedAs(provider, credential.auth)} subject={`integration:${provider.id}`} />
                <ConnectionFacts status={shown} subject={`integration:${provider.id}`} />
              </>
            )}
            {/* A DATED QUALIFIER BESIDE the state, never a fifth state (bead
                `ro-vu8d.8`). The chip on the left answers *does this work now*;
                this one answers *until when*. They are two facts, so under doc
                14's one-representation rule they get two renderings — and
                folding them into one would mean either a Connected card that
                cannot mention Friday or an "Expiring" state that cannot say the
                credential is working today. Once it actually stops, the left
                chip already turns Failing off the collector's own evidence. */}
            {connected && expiry.state !== "unstated" ? (
              <ExpiryChip expiry={expiry} subject={`integration:${provider.id}`} />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {provider.scope === "shared"
              ? "Shared account"
              : provider.scope === "per-asset"
                ? "Per-site credentials"
                : provider.scope}
            <InfoTooltip label={`About ${provider.label} account scope`}>
              {SCOPE_NOTE[provider.scope] ?? provider.scope}
            </InfoTooltip>
          </span>
          <a
            href={`https://github.com/reindex-os/reindex-os/blob/main/${provider.docRef}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
          >
            Setup guide
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* THE CONNECTION'S OWN ACTIONS, above every step (bead
            `ro-ujb9.96.7.10`): replacing its secret and removing it are things
            done TO the connection, so they sit where it is, not behind a
            Settings step. */}
        {connected && !readOnly ? (
          <ConnectionActions
            name={providerName(provider)}
            secret={credential.auth === "oauth" ? null : secretNoun(provider)}
            onReplace={onReplace ?? (() => setFormOpen((open) => !open))}
            replacing={onReplace ? false : formOpen}
            replaceDisabled={!canConnect}
            failing={state === "failing"}
            stops={rows.map((row) => {
              const identity = identities.get(row.id);
              return { id: row.id, label: identity?.displayName ?? row.id, domain: identity?.domain ?? row.id };
            })}
            revokesGrant={credential.auth === "oauth"}
            onDisconnect={onDisconnect}
          />
        ) : null}
        {connected && formOpen && !onReplace && !readOnly ? (
          <ProviderCredentialForm
            providerId={provider.id}
            fields={provider.fields}
            assetRows={rows}
            onCancel={() => setFormOpen(false)}
            onSubmit={async (values) => {
              await onConnect(values);
              setFormOpen(false);
              // The stored result is a new fact; the probe on screen described
              // the credential that was just replaced.
              setProbe(null);
              setTestError(null);
            }}
          />
        ) : null}
        {guided && (
          <>
            <nav
              aria-label="Integration setup"
              className="grid grid-cols-2 gap-2 border-b border-border pb-4 sm:grid-cols-4"
            >
              {setupSteps.map((item, index) => (
                <Button
                  key={item.id}
                  type="button"
                  variant={step === item.id ? "outline" : "ghost"}
                  className={cn("justify-start gap-2", step === item.id && "bg-accent-soft text-primary")}
                  aria-pressed={step === item.id}
                  onClick={() => setStep(item.id)}
                >
                  <span
                    aria-hidden
                    className="grid size-5 shrink-0 place-items-center rounded-full border border-current/25 text-xs tabular-nums"
                  >
                    {index + 1}
                  </span>
                  {item.label}
                </Button>
              ))}
            </nav>
          </>
        )}
        {(visible("verify") || state === "failing" || probe?.ok === false || testError !== null) && (
          <Verdict
            state={state}
            credential={credential}
            probe={probe}
            testError={testError}
            nowMs={nowMs}
            fix={(result) => (
              <ProbeFixPress
                result={result}
                providerId={provider.id}
                secret={secretNoun(provider)}
                onReplace={readOnly ? undefined : onReplace}
                signInHref={readOnly ? null : oauth?.startHref ?? null}
                onSignIn={readOnly ? undefined : oauth?.onStart}
                signingIn={oauth?.starting}
              />
            )}
          />
        )}

        {visible("verify") && (
          <Provenance credential={credential} nowMs={nowMs} />
        )}
        {guided && visible("verify") && (
          <Link
            to="/health"
            className="self-start text-sm underline underline-offset-4"
          >
            View collection health
          </Link>
        )}
        {guided && visible("assets") && rows.length === 0 && (
          <p className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground" data-no-assets>
            {provider.lanes.includes(NOTIFICATION_LANE) || provider.id === "calendar" ? (
              <StateChip tone="neutral" label="Whole workspace" subject={`sites:${provider.id}`} />
            ) : (
              <>
                <StateChip tone="na" label="No sites yet" subject="portfolio:sites" />
                <Link to="/assets" className="inline-flex min-h-11 items-center underline underline-offset-4">
                  View sites
                </Link>
              </>
            )}
          </p>
        )}

        {visible("settings") && connected ? (
          <ExpiryLine
            expiry={expiry}
            declared={provider.expiry}
            onSetExpiry={readOnly ? undefined : onSetExpiry}
            canConnect={canConnect}
          />
        ) : null}

        {visible("assets") && rows.length > 0 ? (
          <ServedAssets
            rows={rows}
            identities={identities}
            perAsset={provider.scope === "per-asset"}
            expanded={guided}
          />
        ) : null}

        {/* WHAT IS LEFT OF THE BUDGET (beads `ro-vu8d.25`, `ro-qpas`) — today's
            calls, or this month's dollars — only where the provider declares a
            meter and only once there is a credential that could spend it. */}
        {visible("settings") && connected && provider.meter && status.meter ? (
          <MeterNote
            meter={provider.meter}
            reading={status.meter}
            rows={rows}
            identities={identities}
            balance={balance}
          />
        ) : null}

        {/* Only once there IS a credential: the section is about what this one
            still has to carry, and a card that has nothing stored is answering
            an earlier question (bead `ro-90mr`). */}
        {visible("assets") && connected && credential.propertyMap ? (
          <PropertyMapNote map={credential.propertyMap} />
        ) : null}

        {visible("connect") && googleConnection ? (
          guided && connected && credential.auth !== "oauth" ?
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Switch to Google sign-in</summary>
              <div className="mt-3">{googleConnection}</div>
            </details> : googleConnection
        ) : null}

        {/* WHAT THIS CREDENTIAL IS FOR, and it is now TRUE (bead `ro-vu8d.23`).
            The catalog row promised a digest, approvals and kill-switch
            confirmations from 2026-07-06 while nothing in the OS sent anything
            at all. It says what the sender sends because both read one
            declaration (`NOTIFIED_CONDITIONS`), and it is shown before the
            press as well as after — what a channel will carry is the question
            somebody is answering when they decide whether to connect it. */}
        {visible("connect") && provider.lanes.includes(NOTIFICATION_LANE) ? (
          <WhatLands connected={connected} />
        ) : null}

        {visible("connect") && credential.source === "env" && !readOnly ? (
          <LegacyEnvExplainer
            panel={envImport}
            legacyBinding={
              provider.fields.find(
                (field) => field.legacyAssetBinding !== undefined,
              )?.legacyAssetBinding
            }
            identities={identities}
          />
        ) : null}

        {visible("connect") && credential.source === "store" ? (
          <StoredFields
            fields={provider.fields}
            present={credential.fields}
            missing={credential.missingFields}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2 empty:hidden">
          {/* A connected credential is replaced from the connection's own
              actions above; this is the first connect. On a failing key the
              fix still leads (bead `ro-vu8d.14`): Replace is the primary there. */}
          {visible("connect") && !connected && (!guided || !formOpen) && (
            <Button
              type="button"
              size="sm"
              disabled={!canConnect || readOnly}
              onClick={() => setFormOpen((open) => !open)}
              data-connect-toggle
            >
              Connect…
            </Button>
          )}
          {visible("verify") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!connected || testing || readOnly}
              onClick={() => {
                if (readOnly) return;
                setTestError(null);
                setTesting(true);
                void (async () => {
                  try {
                    setProbe(await onTest());
                  } catch (err) {
                    setProbe(null);
                    setTestError(
                      err instanceof Error
                        ? err.message
                        : "The test could not run.",
                    );
                  } finally {
                    setTesting(false);
                  }
                })();
              }}
              data-test-connection
              data-test-cost={provider.test.cost}
            >
              {testing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {TEST_BUTTON[provider.test.cost].busy}
                </>
              ) : (
                <>
                  {provider.test.cost === "side-effect" ? <Send className="size-3.5" aria-hidden /> : null}
                  {TEST_BUTTON[provider.test.cost].label}
                </>
              )}
            </Button>
          )}
        </div>

        {visible("connect") && formOpen && !connected && !readOnly ? (
          <ProviderCredentialForm
            providerId={provider.id}
            fields={provider.fields}
            assetRows={rows}
            onCancel={() => setFormOpen(false)}
            onSubmit={async (values) => {
              await onConnect(values);
              setFormOpen(false);
              // A first connect goes on to its sites; a replacement is done
              // where it was made (above), because it changes no site.
              if (guided) setStep("assets");
              setProbe(null);
              setTestError(null);
            }}
          />
        ) : null}
        {guided && step === "connect" && !formOpen && (
          <Button
            variant="outline"
            className="self-start"
            onClick={() => setStep("assets")}
          >
            Continue to sites
          </Button>
        )}
        {guided && step === "assets" && (
          <Button
            variant="outline"
            className="self-start"
            onClick={() => setStep("verify")}
          >
            Continue to verification
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Did it work, and when — one row, one answer (doc 14's one-representation
 * rule).
 *
 * Three sources feed it, in this order: a test the operator just ran, the
 * stored error when the credential is failing, and the stored last success
 * otherwise. They are the same fact arriving from different distances, so they
 * share one slot rather than stacking three verdicts down the card.
 */
function Verdict({
  state,
  credential,
  probe,
  testError,
  nowMs,
  fix,
}: {
  state: ConnectionState;
  credential: IntegrationProviderStatus["credential"];
  probe: CredentialProbe | null;
  testError: string | null;
  nowMs: number;
  /** The result's one press, drawn with what the card knows (bead
   * `ro-ujb9.96.6.19`). */
  fix: (result: ProbeResult) => ReactNode;
}) {
  if (testError) {
    return (
      <VerdictLine tone="bad" at={null} nowMs={nowMs} testId="probe-result">
        {testError}
      </VerdictLine>
    );
  }
  if (probe) {
    // An ingest from before the structured result still says whether it
    // worked; its sentence is not drawn.
    const result: ProbeResult = probe.result ?? { outcome: probe.ok ? "answered" : "refused" };
    return (
      <VerdictLine
        tone={probe.ok ? (result.outcome === "not-checked" ? "unknown" : "ok") : result.outcome === "not-checked" ? "unknown" : "bad"}
        at={probe.checkedAt}
        nowMs={nowMs}
        testId="probe-result"
      >
        <ProbeResultValues result={result}>{fix(result)}</ProbeResultValues>
      </VerdictLine>
    );
  }
  if (state === "failing" && credential.lastError) {
    return (
      <VerdictLine tone="bad" at={credential.lastUsedAt} nowMs={nowMs} testId="stored-verdict">
        {credential.lastError}
      </VerdictLine>
    );
  }
  if (state !== "not-connected" && credential.lastOkAt) {
    return (
      <VerdictLine tone="ok" at={credential.lastOkAt} nowMs={nowMs} testId="stored-verdict">
        This credential worked.
      </VerdictLine>
    );
  }
  if (state !== "not-connected") {
    // A credential that is stored and has never been used. This is the state a
    // card is in the SECOND after Save, because a PUT resets the outcome
    // columns — what an old key proved says nothing about the new one — and it
    // is a designed answer rather than a blank slot (doc 14 principle 2): the
    // hollow ring says *no reading yet*, and Test connection is right there.
    return (
      <VerdictLine tone="unknown" at={null} nowMs={nowMs} testId="stored-verdict">
        Not tested yet.
      </VerdictLine>
    );
  }
  return null;
}

/**
 * A CONNECTION TEST'S RESULT AS VALUES (bead `ro-ujb9.96.6.19`): the outcome,
 * what the answer counted, and the parts that failed by the operator's own
 * names — never the ingest's sentence. Every value is a chip or a number, so
 * the line reads at a glance whatever the provider.
 */
function ProbeResultValues({ result, children }: { result: ProbeResult; children?: ReactNode }) {
  const facts = result.facts ?? {};
  const values: { key: string; label: string; mono?: boolean }[] = [];
  if (result.status !== undefined) values.push({ key: "status", label: `HTTP ${result.status}` });
  if (facts.sites !== undefined) values.push({ key: "sites", label: `${facts.sites} ${siteNoun(facts.sites)}` });
  if (facts.databases !== undefined) values.push({ key: "databases", label: `${facts.databases} ${facts.databases === 1 ? "database" : "databases"}` });
  if (facts.projects !== undefined) values.push({ key: "projects", label: `${facts.projects} ${facts.projects === 1 ? "project" : "projects"}` });
  if (facts.region !== undefined) values.push({ key: "region", label: facts.region.toUpperCase() });
  if (facts.feedsTotal !== undefined) values.push({ key: "feeds", label: `${facts.feeds ?? 0} of ${facts.feedsTotal} feeds` });
  if (facts.tokens !== undefined) values.push({ key: "tokens", label: `${facts.tokens} ${facts.tokens === 1 ? "token" : "tokens"}` });
  const credit = exactUsd(facts.creditUsd);
  if (credit !== null) values.push({ key: "credit", label: `${formatUsd(credit, { cents: true })} credit` });
  if (facts.ga4Unmapped) values.push({ key: "ga4", label: "GA4 not mapped" });
  if (facts.account !== undefined) values.push({ key: "account", label: facts.account, mono: true });
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5" data-probe-outcome={result.outcome}>
      <span className="font-medium">{probeOutcomeLabel(result.outcome)}</span>
      {values.map((value) => (
        <span key={value.key} className={cn("tabular-nums text-muted-foreground", value.mono ? "min-w-0 break-all font-mono text-xs" : "text-xs")} data-probe-fact={value.key}>
          {value.label}
        </span>
      ))}
      {(result.failing ?? []).map((part) => (
        <StateChip key={`failing-${part}`} tone="critical" label={part} subject={`check:${part}`} />
      ))}
      {(result.unchecked ?? []).map((part) => (
        <StateChip key={`unchecked-${part}`} tone="na" label={part} dot="hollow" subject={`check:${part}`} />
      ))}
      {children}
    </span>
  );
}

/** Where Google lets a property's owner give access to another account. */
const GRANT_PAGE: Record<"Search Console" | "Google Analytics", string> = {
  "Search Console": "https://search.google.com/search-console/users",
  "Google Analytics": "https://analytics.google.com/analytics/web/#/admin",
};

/**
 * THE ONE PRESS THAT CLEARS A RESULT (bead `ro-ujb9.96.6.19`), in place of
 * the sentence that used to spell the fix out: Replace the key, sign in
 * again, give the robot its role on Google's own access page, map the sites
 * on their rows, or Run now where only the collection proves a token.
 */
function ProbeFixPress({
  result,
  providerId,
  secret,
  onReplace,
  signInHref,
  onSignIn,
  signingIn,
}: {
  result: ProbeResult;
  providerId: string;
  secret: string | null;
  onReplace?: () => void;
  signInHref: string | null;
  onSignIn?: () => void;
  signingIn?: boolean;
}) {
  const fix = result.fix;
  if (!fix) return null;
  const link = "inline-flex min-h-8 items-center gap-1 text-xs font-medium text-foreground underline underline-offset-4 max-sm:min-h-11";
  if (fix.kind === "replace") {
    return onReplace && secret ? (
      <Button type="button" size="sm" variant="outline" onClick={onReplace} data-probe-fix="replace">
        Replace {secret}
      </Button>
    ) : null;
  }
  if (fix.kind === "sign-in") {
    return signInHref ? (
      <GoogleStartPress href={signInHref} onStart={onSignIn} starting={signingIn} className={link} data-probe-fix="sign-in">
        <LogIn className="size-3.5" aria-hidden />
        Sign in with Google
      </GoogleStartPress>
    ) : null;
  }
  if (fix.kind === "grant") {
    return (
      <a href={GRANT_PAGE[fix.product]} target="_blank" rel="noreferrer" className={link} data-probe-fix="grant">
        Add as {fix.role}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }
  if (fix.kind === "map") {
    return (
      <>
        {fix.sites.slice(0, 3).map((site) => (
          <Link key={site} to={`/assets/${encodeURIComponent(site)}/sources`} className={link} data-probe-fix="map">
            Map {site}
          </Link>
        ))}
      </>
    );
  }
  if (fix.kind === "wait") return <StateChip tone="na" label="Try again in a minute" dot="hollow" subject={`integration:${providerId}`} />;
  if (fix.kind === "run-now") {
    return (
      <Link to={`/integrations?connect=${providerId}`} className={link} data-probe-fix="run-now">
        Run now
      </Link>
    );
  }
  return null;
}

/** Glyph, sentence, time — in that order, so the verdict is read before it is
 * parsed. The time is relative with the exact stamp on hover (doc 14
 * principle 7); an absent time simply is not drawn, rather than becoming a
 * dash (doc 14 rule 6). `unknown` is muted and takes no color from the
 * connectivity scale: *nobody has checked* is not a health reading. */
const VERDICT_TONE = {
  ok: { icon: Check, ink: "text-connected" },
  bad: { icon: TriangleAlert, ink: "text-error" },
  unknown: { icon: CircleDashed, ink: "text-muted-foreground" },
} as const;

function VerdictLine({
  tone,
  at,
  nowMs,
  children,
  testId,
}: {
  tone: keyof typeof VERDICT_TONE;
  at: string | null;
  nowMs: number;
  children: ReactNode;
  testId: string;
}) {
  const age = ageMs(nowMs, at);
  const { icon: Icon, ink } = VERDICT_TONE[tone];
  return (
    <p
      className={cn("flex items-start gap-2 text-sm leading-snug", ink)}
      data-verdict={testId}
      data-verdict-ok={tone === "ok" ? "true" : tone === "bad" ? "false" : "unknown"}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      {/* The sentence takes the reading's own weight: a verdict is foreground,
          "nobody has checked" recedes with its glyph. */}
      <span className={cn("min-w-0", tone === "unknown" ? ink : "text-foreground")}>
        {children}
        {age !== null && at ? (
          <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={at}>
            {formatAge(age)} ago
          </span>
        ) : null}
      </span>
    </p>
  );
}

/** Where this credential came from and when a collector last reached for it.
 * Provenance, not health — the verdict above already said whether it worked. */
function Provenance({
  credential,
  nowMs,
}: {
  credential: IntegrationProviderStatus["credential"];
  nowMs: number;
}) {
  const used = ageMs(nowMs, credential.lastUsedAt);
  const stored = ageMs(nowMs, credential.updatedAt);
  if (used === null && stored === null) return null;
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground" data-provenance>
      {stored !== null && credential.updatedAt ? (
        <span title={credential.updatedAt}>
          Stored <span className="tabular-nums text-foreground">{formatAge(stored)}</span> ago
        </span>
      ) : null}
      {used !== null && credential.lastUsedAt ? (
        <span title={credential.lastUsedAt}>
          Last used <span className="tabular-nums text-foreground">{formatAge(used)}</span> ago
        </span>
      ) : null}
    </p>
  );
}

/**
 * The countdown (bead `ro-vu8d.8`, doc 14 flow C step 4).
 *
 * WARN-TONED ONLY INSIDE THE WINDOW. A date fourteen months out is provenance,
 * not attention, and an amber chip on it would send the operator to fix
 * something that will not need fixing this year — the same mistake *Legacy env*
 * deliberately avoids two chips to the left. So the ramp has exactly three
 * steps: muted while it is far off, `caution` inside `T-14d`, `critical` once
 * the date has passed. No new token, no fourth severity.
 *
 * IT COUNTS, IT DOES NOT DATE. "in 6 days" is the fact an operator acts on;
 * the exact instant is on hover, which is doc 14 principle 7's own rule for
 * every other time on this desk. Days are FLOORED, so the chip reads 0 days
 * only on the final day rather than rounding up to 1 and going quiet a day
 * early. Composes `StateChip` — the registry has the chip, this is the
 * vocabulary — rather than adding a rival pill (doc 14).
 */
function ExpiryChip({ expiry, subject }: { expiry: CredentialExpiryReading; subject: StatusSubject }) {
  const tone: StateTone =
    expiry.state === "expired" ? "critical" : expiry.state === "warn" ? "caution" : "na";
  const days = expiry.daysRemaining ?? 0;
  const label =
    expiry.state === "expired"
      ? "Expired"
      : days === 0
        ? "Expires today"
        : `Expires in ${days}d`;
  return (
    <StateChip
      label={<span className="tabular-nums">{label}</span>}
      tone={tone}
      subject={subject}
      glyph={
        expiry.state === "expired" ? (
          <CalendarX2 className="size-3" />
        ) : (
          <CalendarClock className="size-3" />
        )
      }
      title={
        expiry.expiresAt
          ? `${expiry.state === "expired" ? "Expired" : "Expires"} ${expiry.expiresAt}${
              expiry.source === "operator" ? " — the date you recorded" : ""
            }`
          : undefined
      }
      className={expiry.state === "ok" ? "font-normal" : undefined}
    />
  );
}

/**
 * When the credential stops working, as ONE VALUE with its actions beside it
 * (beads `ro-vu8d.8`, `ro-ujb9.96.6.1`) — GitHub's token *Expiration* field,
 * not a paragraph about why.
 *
 * NEVER INVENT A DATE, in three shapes:
 *
 *  - `never` — the provider states no lifetime, so the value is "No expiry
 *    date" and there is nothing to edit. doc 14 flow C step 4 asks for a
 *    warning at T-14d; a form that only ever collected a guess would be a
 *    warning built on one.
 *  - `operator` — nobody but the operator knows, so the value is their date,
 *    or "No expiry date" with Record an expiry… beside it.
 *  - `flow` — the connection recorded it. Google is the only one: its Testing
 *    consent screen lapses a grant after seven days, so the date carries the
 *    provider's own fix (Publish app ↗) and the one-press correction — after
 *    which `carriedExpiry` in the ingest keeps the operator's answer through
 *    every later sign-in.
 */
function ExpiryLine({
  expiry,
  declared,
  onSetExpiry,
  canConnect,
}: {
  expiry: CredentialExpiryReading;
  declared: IntegrationExpiry;
  onSetExpiry?: (expiresAt: string | null) => Promise<void>;
  canConnect: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = useId();

  const editable = declared.known !== "never" && onSetExpiry !== undefined;
  const date = expiry.expiresAt?.slice(0, 10) ?? null;

  function submit(expiresAt: string | null) {
    if (!onSetExpiry) return;
    setSaving(true);
    setFailure(null);
    void (async () => {
      try {
        await onSetExpiry(expiresAt);
        setEditing(false);
        setDraft("");
      } catch (err) {
        setFailure(messageOf(err));
      } finally {
        setSaving(false);
      }
    })();
  }

  return (
    <div className="flex flex-col gap-1" data-expiry={expiry.state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          Expiry
        </span>
        <span
          className="tabular-nums text-foreground"
          title={expiry.expiresAt ?? undefined}
          data-expiry-value
        >
          {date ?? "No expiry date"}
        </span>
        {date !== null && declared.fix ? <ProviderLink link={declared.fix} /> : null}
        {editable && !editing ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canConnect || saving}
              data-expiry-edit
              onClick={() => {
                setFailure(null);
                setDraft(date ?? "");
                setEditing(true);
              }}
            >
              {date ? "Change the expiry…" : "Record an expiry…"}
            </Button>
            {/* The one-press correction for the assumption above. It writes a
                DELIBERATE null rather than clearing a field: "this does not
                expire" is an answer, and the store stamps it `operator` so the
                next sign-in cannot put the seven-day countdown back. */}
            {expiry.state !== "unstated" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canConnect || saving}
                data-expiry-clear
                onClick={() => submit(null)}
              >
                {declared.known === "flow" ? "It does not expire" : "Remove the date"}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {editable && editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-foreground">Expires on</span>
            <input
              id={id}
              type="date"
              value={draft}
              disabled={saving}
              data-expiry-input
              onChange={(event) => setDraft(event.target.value)}
              className={cn(fieldClass, "w-44 tabular-nums")}
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={saving || draft === ""}
            data-expiry-save
            // A bare `YYYY-MM-DD` parses as UTC midnight, which is the instant
            // the credential is treated as gone. Erring EARLY is the correct
            // side: a warning that fires a few hours before the provider stops
            // accepting the key costs nothing, and one that fires after costs
            // the outage this whole feature exists to prevent.
            onClick={() => submit(`${draft}T00:00:00.000Z`)}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {failure ? (
        <span className="text-xs text-error" data-expiry-failure>
          {failure}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What pressing Test does, said by the BUTTON rather than a sentence under it
 * (beads `ro-vu8d.18`, `ro-ujb9.96.6.1`) — Grafana's contact-point test is
 * "Send test notification" for the same reason.
 *
 * A free read-only call is what "Test connection" is assumed to be, so it
 * keeps that label. Discord's test POSTS into the operator's channel, so its
 * button says it sends a message and wears the send glyph. Clarity's calls
 * nobody — the only free check is which sites hold a token — so its button is
 * named for that check.
 */
const TEST_BUTTON: Record<ProbeCost, { label: string; busy: string }> = {
  free: { label: "Test connection", busy: "Testing…" },
  "side-effect": { label: "Send test message", busy: "Sending…" },
  none: { label: "Check keys", busy: "Checking…" },
};

/**
 * Which assets this one credential serves — favicons, because the operator
 * knows their portfolio by its icons, each linking to where that asset's own
 * wiring is edited.
 *
 * A PER-ASSET CREDENTIAL TURNS THE SAME LIST INTO A CHECKLIST (bead
 * `ro-vu8d.9`). For a shared credential the list answers *what breaks if this
 * is wrong*; for a per-asset one it also has to answer *which of them is
 * actually covered*, because partial coverage is the normal state — Clarity
 * issues a token per project and an operator collects them one at a time.
 * That is a mark on each row, not a second list: they are the same assets, and
 * two lists would be the card disagreeing with itself.
 */
function ServedAssets({
  rows,
  identities,
  perAsset,
  expanded = false,
}: {
  rows: CredentialAssetRow[];
  identities: Map<string, ProviderCardAsset>;
  perAsset: boolean;
  expanded?: boolean;
}) {
  const held = rows.filter((row) => row.held).length;
  return (
    <div className={expanded ? "space-y-3" : "flex flex-wrap items-center gap-x-3 gap-y-1"} data-served-assets>
      <span className="text-xs text-muted-foreground">
        {perAsset
          ? `${held} of ${rows.length} ${rows.length === 1 ? "site has" : "sites have"} a key`
          : rows.length === 1
            ? "Used by"
            : `Used by ${rows.length} sites`}
      </span>
      <ul className={expanded ? "grid gap-2 sm:grid-cols-2" : "flex flex-wrap items-center gap-x-3 gap-y-1"}>
        {rows.map((row) => {
          const asset =
            identities.get(row.id) ?? { id: row.id, displayName: row.id, domain: null };
          return (
            <li
              key={row.id}
              className="flex items-center gap-1.5"
              data-served-asset={row.id}
              data-asset-key={perAsset ? (row.held ? "set" : "missing") : undefined}
            >
              {perAsset ? (
                row.held ? (
                  <Check className="size-3 shrink-0 text-connected" aria-hidden />
                ) : (
                  // A dash, not a red mark: an asset with no key yet is work
                  // outstanding, not a fault — the same reason Legacy env is
                  // not amber.
                  <span aria-hidden className="h-px w-3 shrink-0 bg-muted-foreground" />
                )
              ) : null}
              <Link
                to={`/assets/${encodeURIComponent(asset.id)}/sources`}
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs underline-offset-4 hover:underline",
                  expanded && "min-h-12 flex-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm hover:bg-muted/50",
                  perAsset && !row.held ? "text-muted-foreground" : "text-foreground",
                )}
                title={
                  perAsset
                    ? `${asset.displayName} — ${row.held ? "a key is stored" : "no key stored yet"}`
                    : `${asset.displayName} — data sources`
                }
              >
                {asset.domain ? (
                  <PropertyFavicon domain={asset.domain} displayName={asset.displayName} className="size-4" />
                ) : null}
                {asset.displayName}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One budget line: what the ceiling belongs to, how much of it is left, and
 * the bar. Built for whichever window the provider meters, so the two shapes
 * share one rendering rather than one card growing two. */
interface BudgetLine {
  /** Stable per line — an asset id, or the word for a portfolio-wide ceiling. */
  key: string;
  label: string;
  /** Where the ceiling is set, when the operator owns it (the data budget in
   * Settings) — the label links there instead of a sentence saying so. */
  href?: string;
  /** The state a spent-out ceiling puts the provider in, with when it lifts
   * ("Paused until Oct 1") — the fail-closed rule as a chip, not a paragraph. */
  paused?: string;
  /** "7 of 10 calls left today", "$23.88 of $25 left in Sep". */
  left: string;
  /** What the bar draws, and what a screen reader is told it drew. */
  spent: number;
  cap: number;
  ariaLabel: string;
  /** The remaining figure as a plain number, for the DOM hook a test asserts
   * on — a formatted string would make "nothing left" unmatchable. */
  remaining: number;
}

/**
 * HOW MUCH OF THE BUDGET IS LEFT (beads `ro-vu8d.25`, `ro-qpas`).
 *
 * doc 14 flow C step 3 asked for this the day it was written — "Clarity: 7/10
 * calls left today", so the operator never wonders why a data source paused —
 * and until now the cards explained their caps in PROSE instead, which is what
 * the OS says when it cannot show a number.
 *
 * IT IS COUNTED, NEVER ASKED. Both figures come from the manifest rows this OS
 * wrote (its report runs, the same rows the metered spend summary reads), so
 * reading either meter costs nothing — the whole point on a provider whose cap
 * is ten calls a day and whose Test button already refuses to spend one, and on
 * a prepaid provider whose credit an operator could otherwise only see by
 * pressing that button.
 *
 * TWO WINDOWS, ONE LINE SHAPE. Clarity's ceiling is calls PER ASSET PER DAY, so
 * it draws one line per asset: a portfolio total would be a number nothing
 * enforces and would hide the one asset that ran out, and only assets holding a
 * key are listed, because a full bar beside an asset that cannot spend reads as
 * budget it does not have. DataForSEO's ceiling is dollars PORTFOLIO-WIDE PER
 * MONTH, so it draws exactly one line: repeating the shape per asset would say
 * the same thing five times against a cap none of them individually has — the
 * same argument the Health page's spend summary makes about its own split.
 *
 * WHAT THE DATAFORSEO LINE IS NOT is the credit sitting on the DataForSEO
 * account, and that credit now has a line of its own BESIDE the bar rather than
 * inside it (bead `ro-qpas`). The two are different in kind: the cap is a
 * ceiling this OS enforces and can count, the credit is the vendor's own figure
 * and is only ever seen when DataForSEO volunteers it. So it is drawn as a
 * dated sighting — the amount, then how long ago it was seen — and never as a
 * bar, because a bar reads as a live measurement. Nothing seen yet says so in
 * words instead of leaving the row out, which would read as an account with no
 * credit on it.
 *
 * `Meter` is the registry's spend-vs-cap bar, unchanged — the shape is
 * one value against a ceiling, which is exactly what it draws. Neutral until it
 * is gone: a month that used its budget is not a fault, and the amber the
 * component already reserves for over-cap is the only colour here.
 */
function MeterNote({
  meter,
  reading,
  rows,
  identities,
  balance,
}: {
  meter: IntegrationMeter;
  reading: ProviderMeterReading;
  rows: CredentialAssetRow[];
  identities: Map<string, ProviderCardAsset>;
  /** The last sighting of the provider's own prepaid account, or null when the
   * OS has never seen one. */
  balance: CredentialBalanceReading | null;
}) {
  const lines = budgetLines(meter, reading, rows, identities);
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-provider-meter={meter.countedFrom}>
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li
            key={line.key}
            className="flex items-center gap-2 text-xs"
            data-meter-line={line.key}
            data-meter-left={line.remaining}
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {line.href ? (
                <Link to={line.href} className="underline decoration-dotted underline-offset-4 hover:text-foreground" data-meter-cap-link>
                  {line.label}
                </Link>
              ) : (
                line.label
              )}
            </span>
            {line.paused ? <StateChip tone="caution" label={line.paused} subject={`budget:${line.key}`} className="shrink-0" /> : null}
            <span className="shrink-0 tabular-nums text-foreground">{line.left}</span>
            {reading.window === "portfolio-month" ? <UnknownPriceCount count={reading.unknownPrices} /> : null}
            <Meter
              value={line.spent}
              max={line.cap}
              className="w-16 shrink-0"
              ariaLabel={line.ariaLabel}
            />
          </li>
        ))}
      </ul>
      {/* THE OTHER NUMBER, on the provider that has one (bead `ro-qpas`). Only
          a prepaid account has a credit to report, and `portfolio-month` is the
          window that belongs to one — Clarity's daily calls are not bought in
          advance, so its card draws nothing here rather than an empty row. */}
      {meter.window === "portfolio-month" ? <AccountCredit balance={balance} /> : null}
    </div>
  );
}

/**
 * The prepaid credit, with its age — or the sentence for an account nobody has
 * read yet (bead `ro-qpas`).
 *
 * DATED OR NOT SHOWN. The amount and "seen 2h ago" are one sentence, because
 * the figure alone would be a claim about right now that this OS cannot make:
 * the credit is the vendor's number, seen only when DataForSEO volunteers it in
 * an answer the OS was already buying. The instant is on hover, like every
 * other time on this desk.
 *
 * NOT A BAR. `Meter` above draws spend against a ceiling this OS enforces; a
 * balance has no ceiling to draw against — an operator can top the account up
 * to any figure — and drawing one would invent a maximum nobody set.
 */
function AccountCredit({ balance }: { balance: CredentialBalanceReading | null }) {
  if (balance === null) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground" data-account-credit="none">
        <span>Account credit</span>
        <span className="text-foreground">—</span>
        <span>not read yet</span>
      </p>
    );
  }
  // STALE IS SAID, NOT LEFT TO ARITHMETIC (bead `ro-vu8d.27`). Past two missed
  // weekly refreshes the age stops being a muted timestamp the operator has to
  // judge and becomes the warn-toned sentence: the figure is still shown —
  // hiding it would invent a "no credit" — but it is the age that carries the
  // meaning now, because the sweep's refresh is silent when it fails and a
  // quietly ageing number is the one an operator must not plan Monday on.
  return (
    <p
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
      data-account-credit={balance.usd}
      data-account-credit-stale={balance.stale ? "" : undefined}
      title={balance.seenAt}
    >
      <span className="text-muted-foreground">Account credit</span>
      <span className={cn("tabular-nums", balance.stale ? "text-muted-foreground" : "text-foreground")}>
        {formatUsd(balance.usd, { cents: true })}
      </span>
      {balance.stale ? (
        <span className="inline-flex items-center gap-1.5 tabular-nums text-muted-foreground">
          seen {formatAge(balance.ageMs)} ago
          <StateChip tone="caution" label="Stale" subject="budget:account-credit" />
        </span>
      ) : (
        <span className="tabular-nums text-muted-foreground">
          seen {formatAge(balance.ageMs)} ago
        </span>
      )}
    </p>
  );
}

/** The calendar month after `period` ('YYYY-MM'), in the same shape. */
function nextPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return period;
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The declaration and the reading turned into lines. A meter and a reading of
 * a different window is a payload that cannot be trusted to mean anything, so
 * it draws nothing rather than guessing which half is right. */
function budgetLines(
  meter: IntegrationMeter,
  reading: ProviderMeterReading,
  rows: CredentialAssetRow[],
  identities: Map<string, ProviderCardAsset>,
): BudgetLine[] {
  if (meter.window === "portfolio-month") {
    if (reading.window !== "portfolio-month" || reading.capUsd <= 0) return [];
    const month = formatPeriodMonth(reading.period);
    const remaining = meterRemaining(reading.capUsd, reading.spentUsd);
    return [
      {
        key: "portfolio",
        label: `Data budget, ${month}`,
        // The cap is the operator's own setting, fails closed, and lifts at
        // the UTC month's turn: the label goes where it is set, and a spent
        // month says when collection resumes.
        href: "/settings#budget",
        paused: remaining <= 0 ? `Paused until ${formatPeriodMonth(nextPeriod(reading.period))} 1` : undefined,
        left: `${formatUsd(remaining, { cents: true })} of ${formatUsd(reading.capUsd)} left`,
        spent: reading.spentUsd,
        cap: reading.capUsd,
        ariaLabel: `Data budget in ${month}: ${formatUsd(reading.spentUsd, { cents: true })} of ${formatUsd(reading.capUsd)} spent`,
        remaining,
      },
    ];
  }
  if (reading.window !== "asset-day") return [];
  const spentBy = new Map(reading.assets.map((entry) => [entry.asset, entry.spent]));
  const plural = meter.perAssetPerDay === 1 ? "" : "s";
  return rows
    .filter((row) => row.held)
    .map((row) => {
      const spent = spentBy.get(row.id) ?? 0;
      const label = identities.get(row.id)?.displayName ?? row.id;
      const remaining = meterRemaining(meter.perAssetPerDay, spent);
      return {
        key: row.id,
        label,
        left: `${remaining} of ${meter.perAssetPerDay} ${meter.unit}${plural} left today`,
        spent,
        cap: meter.perAssetPerDay,
        ariaLabel: `${label}: ${spent} of ${meter.perAssetPerDay} ${meter.unit}${plural} used today`,
        remaining,
      };
    });
}

/**
 * WHETHER THIS CREDENTIAL STILL HAS TO CARRY A PROPERTY MAP (bead `ro-90mr`).
 *
 * The Google credential holds a per-asset GA4 property / Search Console site of
 * its own, and since `ro-vu8d.16` each asset's Sources tab holds the same fact
 * and wins. The collectors let the credential's copy go, per data source, the
 * moment nothing needs it — so the operator has to be able to see WHEN that
 * happened, or the dead ids sit in their credential forever looking load-bearing.
 *
 * TWO SENTENCES, ONE OF THEM TRUE. Unfinished, it names exactly which asset ×
 * data source is still waiting and links each to the tab that fixes it — a count
 * with no names is a card that says "go and look". Finished, it says so and says
 * what the credential is still FOR, because "you can delete something from a
 * secret" is worth being precise about.
 *
 * No tone token either way. This is neither a fault nor connectivity — the two
 * colour systems doc 14 licenses on this card — so it reads as what it is: one
 * more thing the credential does, or one fewer.
 *
 * THE ANSWER ARRIVES FROM THE INGEST (bead `ro-vu8d.22`), on the credential
 * summary rather than beside it: only the ingest can read the account map, so
 * only the ingest can ask the question of the assets the CREDENTIAL names. The
 * Tower used to derive a second answer from `config/integrations.json`, and the
 * two disagreed exactly where it matters — an asset the credential names that
 * the register has no entry for, where the card would have said the ids were
 * safe to delete while a run was still reading them.
 */
function PropertyMapNote({ map }: { map: CredentialPropertyMapUse }) {
  if (!map.needed) {
    return (
      <div
        className="flex items-start gap-2 text-xs text-muted-foreground"
        data-property-map="retired"
      >
        <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">All Google data sources are mapped on their sites.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-property-map="needed">
      <span className="text-xs font-medium text-foreground">
        {map.answersFor.length === 1
          ? "1 data source is not mapped yet"
          : `${map.answersFor.length} data sources are not mapped yet`}
      </span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {map.answersFor.map((ref) => (
          <li key={`${ref.asset}/${ref.id}`}>
            <Link
              to={`/assets/${encodeURIComponent(ref.asset)}/sources`}
              className="text-xs text-foreground underline-offset-4 hover:underline"
            >
              {ref.asset} · {ref.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The credential works, but it lives in the environment file the epic is
 * retiring — so this says what to DO, not what state it is in (the chip above
 * already carries that, doc 14).
 *
 * ONE MOVE, TWO SHAPES. Where the OS is running it is a BUTTON: the dev server
 * has the operator's secrets file beside it and its import lane runs the same
 * function `pnpm dev:secrets:import` runs (bead `ro-vu8d.7`). Wherever that
 * lane does not exist it is the command to copy, labelled with where it runs
 * (a deployed Worker has no file to read), or preceded by the migrate command
 * when this machine has no secrets file yet — the deployment's reason as a
 * code the card draws, never its sentence (bead `ro-ujb9.96.6.1`).
 *
 * THE PRESS MOVES THE WHOLE FILE: the import is one crossing from the env path
 * to the store, and a per-card version would leave the operator pressing the
 * same button on four cards for one outcome.
 */
function LegacyEnvExplainer({
  panel,
  legacyBinding,
  identities,
}: {
  panel?: ProviderEnvImport;
  legacyBinding?: LegacyAssetBinding;
  identities: Map<string, ProviderCardAsset>;
}) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const bound = legacyBinding?.asset ? identities.get(legacyBinding.asset) ?? null : null;
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3"
      data-legacy-env
    >
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <FileKey2 className="size-3.5 shrink-0" aria-hidden />
        <span>In the environment file</span>
        <span aria-hidden>→</span>
        <span className="text-foreground">move to the store</span>
      </p>
      {/* THE OLDER SHAPE, NAMED (bead `ro-vu8d.24`): the one binding still
          carrying a single site's key, and that site. It is why this card can
          read Connected on an install that never wrote the map, and naming it
          is what stops a self-hoster deleting a value that is doing work. No
          input for it: the map is the shape the product teaches, and the move
          above takes it along. Muted: a working older binding is not a fault. */}
      {legacyBinding ? (
        <p
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-legacy-asset-binding={legacyBinding.name}
        >
          <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {legacyBinding.name}
          </code>
          {legacyBinding.asset ? (
            <>
              <span aria-hidden>→</span>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                {bound?.domain ? (
                  <PropertyFavicon domain={bound.domain} displayName={bound.displayName} className="size-4" />
                ) : null}
                {bound?.displayName ?? legacyBinding.asset}
              </span>
            </>
          ) : null}
        </p>
      ) : null}
      {panel?.importable === true ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={importing}
            data-import-env
            onClick={() => {
              setImportError(null);
              setImporting(true);
              panel
                .onImport()
                .catch((err: unknown) => {
                  setImportError(
                    err instanceof Error ? err.message : "The import did not run.",
                  );
                })
                .finally(() => setImporting(false));
            }}
          >
            {importing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            {importing ? "Importing…" : "Import from this machine"}
          </Button>
          {importError !== null ? (
            <span className="text-xs text-error" data-import-error>
              {importError}
            </span>
          ) : null}
        </div>
      ) : (
        <ol className="flex flex-col gap-1.5" data-import-reason={panel?.reason ?? undefined}>
          {panel?.reason === "no-file" ? (
            <li className="flex flex-wrap items-center gap-2">
              <StepNumber n={1} />
              <CopyCommand command={ENV_MIGRATE_COMMAND} mark={{ "data-import-command": "migrate" }} />
            </li>
          ) : null}
          <li className="flex flex-wrap items-center gap-2">
            {panel?.reason === "no-file" ? <StepNumber n={2} /> : null}
            <CopyCommand command={SECRETS_IMPORT_COMMAND} mark={{ "data-import-command": "import" }} />
            {panel?.reason === "elsewhere" ? (
              <StateChip tone="na" label="On the OS machine" glyph={<Terminal className="size-3" />} subject="setup:secrets-import" />
            ) : null}
          </li>
        </ol>
      )}
    </div>
  );
}

/** What the store holds, by NAME — the closest this page ever comes to showing
 * a credential. A missing required field is named too, because a half-entered
 * credential explains a Not connected chip that would otherwise look wrong. */
function StoredFields({
  fields,
  present,
  missing,
}: {
  fields: readonly IntegrationField[];
  present: string[];
  missing: string[];
}) {
  const held = new Set(present);
  const absent = new Set(missing);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1" data-stored-fields>
      {fields.map((field) => {
        const isSet = held.has(field.name);
        return (
          <li
            key={field.name}
            className="flex items-center gap-1.5 text-xs"
            data-stored-field={field.name}
            data-stored-field-state={isSet ? "set" : absent.has(field.name) ? "missing" : "unset"}
          >
            {isSet ? (
              <Check className="size-3 shrink-0 text-connected" aria-hidden />
            ) : (
              <span aria-hidden className="h-px w-3 shrink-0 bg-muted-foreground" />
            )}
            <span className="font-mono text-[11px] text-muted-foreground">{field.label}</span>
            <span className={cn(isSet ? "text-connected" : "text-muted-foreground")}>
              {isSet ? "set" : absent.has(field.name) ? "missing" : "not set"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}


export default ProviderCard;
import { UnknownPriceCount } from "@/components/UnknownPriceCount";

import { useDemoReadonly } from '@/lib/browser-context';
import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { IntegrationProvider } from "@noticeos/contract";
import { acceptedAs } from "@noticeos/contract/integrations";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { GOOGLE_OAUTH_RESULT_PARAM, GOOGLE_OAUTH_START_PATH } from "@noticeos/contract/google-oauth";
import type { IntegrationHealthItem } from "@noticeos/contract/integration-health";
import { connectsInPanel, providerName } from "@shared/connect-panel";
import { connectionStatus, type ConnectionStatus } from "@shared/connection-status";
import { IntegrationHealthPanel } from "@/components/IntegrationHealthPanel";
import { ConnectionFacts, IntegrationStateChip } from "@/components/IntegrationStateChip";
import { INTEGRATION_HEALTH_KEY, useIntegrationHealth } from "@/hooks/useIntegrationHealth";
import {
  connectBlockers,
  connectionState,
  credentialExpiry,
  googleOAuthCardState,
  googleOAuthNotice,
  type IntegrationProviderStatus,
} from "@shared/integrations-page";
import { ProviderConnectPanel, providerPanelOpening, type ProviderPanelOpening } from "@/routes/integrations/ProviderConnectPanel";
import { ConnectBlockers } from "@/components/ConnectBlockers";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import {
  ProviderCard,
  type ProviderCardAsset,
  type ProviderEnvImport,
  type ProviderOAuthPanel,
} from "@/components/ProviderCard";
import { IntegrationLogo } from "@/components/IntegrationLogo";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { Button } from "@/components/ui/button";
import { envImportSummary } from "@shared/env-import";
import { useEnvImportAvailability } from "@/hooks/useEnvImport";
import {
  INTEGRATION_PROVIDERS_KEY,
  useIntegrationProviders,
} from "@/hooks/useIntegrationProviders";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { useGoogleOAuthStart } from '@/hooks/useGoogleOAuthStart';

/**
 * `/integrations`: every provider as one row with one status and one action,
 * grouped by what it is for. A provider that declares a connect kind connects
 * in `ConnectPanel` over this list, through `ProviderConnectPanel`, the same
 * wiring a site's Data sources row opens, and is managed there once
 * connected. The others open their own setup page, which carries the same
 * Replace and Disconnect at its top.
 */
export function IntegrationsRoute() {
  const demoReadonly = useDemoReadonly();
  const toast = useOwnerToast();
  const { importEnvCredentials, deleteProviderCredential, saveProviderCredential, testProviderCredential, saveProviderExpiry } = useTowerApi();
  const api = useTowerApi();
  const googleStart = useGoogleOAuthStart();
  const { data, isError, error, isFetching, refetch } = useIntegrationProviders();
  const queryClient = useQueryClient();
  const readOnly = demoReadonly;
  const now = useNow();
  const monitoring = useIntegrationHealth();
  const [params, setParams] = useSearchParams();
  // The open panel: which provider, whether it opened on the key form, its
  // sites or Replace, and the site it was opened for. A site's Data sources
  // row opens the same panel over that site's page; a link here with ?asset=
  // still lands on it.
  const [connecting, setConnecting] = useState<{ id: string; opened: ProviderPanelOpening; asset: string | null } | null>(null);
  // The sites' own names, from the list the sidebar already reads.
  const wall = useWall();
  const siteNames = new Map((wall.data?.assets ?? []).map((asset) => [asset.id, asset.displayName]));

  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: INTEGRATION_PROVIDERS_KEY }), queryClient.invalidateQueries({ queryKey: INTEGRATION_HEALTH_KEY })]);
  };

  // Two things have to be true before a credential can be stored — a table to
  // put it in and a key to encrypt it with — and either can be false on its
  // own. Derived once here so the banners, the panel and every card agree.
  const blockers = data ? connectBlockers(data) : [];

  // Can the legacy env credentials be moved from here? Asked once for the
  // page: it is a fact about the deployment.
  const envImport = useEnvImportAvailability(!readOnly);
  const importPanel: ProviderEnvImport = {
    importable: envImport.importable,
    reason: envImport.reason,
    onImport: async () => {
      const result = await importEnvCredentials();
      await refresh();
      const line = envImportSummary(result);
      if (result.imported.length > 0) {
        toast.success(line, { icon: <Check className="size-4" /> });
      } else {
        toast.error(line, { icon: <TriangleAlert className="size-4" />, duration: 12_000 });
      }
    },
  };

  // Coming back from Google: the callback is a full-page navigation, so its
  // outcome arrives as a query parameter, lands as a toast, and is cleared so
  // a refresh does not replay it.
  const oauthResult = params.get(GOOGLE_OAUTH_RESULT_PARAM);
  useEffect(() => {
    if (readOnly) return;
    const notice = googleOAuthNotice(oauthResult, window.location.origin);
    if (notice === null) return;
    if (notice.tone === "ok") {
      // Signed in: the connect panel opens on the account's sites with Signed
      // in in its header; no toast says it twice.
      void refresh();
    } else {
      // What happened, and the one press that fixes it as the toast's button.
      const action = notice.action;
      toast.error(notice.message, {
        // One notice per return from Google: an effect that runs twice (React's
        // development double-run) updates this toast instead of stacking a
        // second copy under it.
        id: `google-oauth-${oauthResult}`,
        icon: <TriangleAlert className="size-4" />,
        duration: 12_000,
        ...(action
          ? {
              action: {
                label: action.label,
                onClick: () => {
                  if (action.external) window.open(action.href, "_blank", "noopener,noreferrer");
                  else window.location.assign(action.href);
                },
              },
            }
          : {}),
      });
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(GOOGLE_OAUTH_RESULT_PARAM);
        return next;
      },
      { replace: true },
    );
    // Only the arriving value matters; `refresh` and `setParams` are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthResult]);

  // `google-oauth-app` is a prerequisite the Google card asks for in place,
  // never a row of its own (`companionOf`).
  const cards = (data?.providers ?? []).filter((status) => status.provider.companionOf === undefined);
  const googleApp = data?.providers.find((status) => status.provider.id === "google-oauth-app") ?? null;

  // A link to connect a panel provider, `?connect=<id>` or an older
  // `?provider=<id>` while it is not connected, opens the panel over the list.
  // `?connect=` on a provider that is already connected opens it on its sites,
  // with `?asset=` leading the list.
  const panelTarget = (id: string | null, connectedToo: boolean) => {
    const status = cards.find((card) => card.provider.id === id);
    if (!status || !connectsInPanel(status.provider)) return null;
    const state = connectionState(status.credential);
    return state === "not-connected" || (connectedToo && state !== "failing") ? status : null;
  };
  // `?setup=page` keeps a provider's own page (Google's service-account path).
  const linked = readOnly ? null : panelTarget(params.get("connect"), true) ?? (params.get("setup") === "page" ? null : panelTarget(params.get("provider"), false));
  useEffect(() => {
    if (!linked) return;
    setConnecting({ id: linked.provider.id, opened: providerPanelOpening(linked), asset: params.get("asset") });
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("connect");
        next.delete("provider");
        next.delete("asset");
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked?.provider.id]);

  const selected = linked ? undefined : cards.find((status) => status.provider.id === params.get("provider"));
  const panel = cards.find((status) => status.provider.id === connecting?.id) ?? null;
  const open = (status: IntegrationProviderStatus, opened: ProviderPanelOpening) => {
    if (readOnly) return;
    // A provider whose tokens are pasted per site has no key form: its panel
    // is always the sites.
    setConnecting({ id: status.provider.id, opened: status.provider.connect?.kind === "site-tokens" ? "sites" : opened, asset: null });
  };
  // Disconnect, from the panel or a provider's page: the store forgets it, the
  // page reads the new state, and whatever showed the connection closes.
  const disconnect = async (provider: IntegrationProvider) => {
    await deleteProviderCredential(provider.id);
    await refresh();
    toast.success(`Disconnected — ${providerName(provider)}`);
  };
  const catalogParams = new URLSearchParams(params);
  catalogParams.delete("provider");
  const catalogHref = `/integrations${catalogParams.size ? `?${catalogParams}` : ""}`;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title={
          selected ? (
            <>
              <IntegrationLogo provider={selected.provider.id} size="large" />
              {providerName(selected.provider)}
              <ProviderStatus status={selected} items={monitoring.status.items} />
            </>
          ) : "Integrations"
        }
        breadcrumb={selected ? [{ label: "Integrations", to: catalogHref }] : undefined}
        documentTitle={selected ? providerName(selected.provider) : "Integrations"}
      />
      {isError ? (
        <ReadFailed title="Couldn't load integrations" subject="read:integrations" error={error} retrying={isFetching} onRetry={() => void refetch()} />
      ) : !data ? (
        <div className="grid min-h-[40vh] place-items-center text-muted-foreground">Loading integrations…</div>
      ) : (
        <>
          {/* A state and the one command that clears it. The panel opened over
              this page draws none: this says it. */}
          <ConnectBlockers blockers={blockers} />
          {selected ? (
            <>
              <IntegrationHealthPanel data={monitoring.data} isError={monitoring.isError} nowMs={now} provider={selected.provider.id} />
              <div data-integration-detail>
                <ProviderCard
                  key={selected.provider.id}
                  guided
                  status={selected}
                  assets={assetRefs(selected, siteNames)}
                  nowMs={now}
                  // Why not is the banner's, said once above.
                  canConnect={!readOnly && blockers.length === 0}
                  readOnly={readOnly}
                  oauth={googlePanel(selected, googleApp, refresh, api, toast, googleStart)}
                  envImport={importPanel}
                  className="shadow-none"
                  onConnect={async (fields) => {
                    await saveProviderCredential(selected.provider.id, fields);
                    await refresh();
                    // Saved, not connected: nothing has asked the provider yet.
                    toast.success(`Saved — ${selected.provider.label}`);
                  }}
                  onTest={async () => { const result = await testProviderCredential(selected.provider.id); await refresh(); return result; }}
                  // Only where a date could be true.
                  onSetExpiry={
                    selected.provider.expiry.known === "never"
                      ? undefined
                      : async (expiresAt) => {
                          await saveProviderExpiry(selected.provider.id, expiresAt);
                          await refresh();
                          toast.success(
                            expiresAt === null
                              ? `${selected.provider.label} does not expire`
                              : `Expiry recorded — ${selected.provider.label}`,
                          );
                        }
                  }
                  onDisconnect={() => disconnect(selected.provider)}
                  // A provider that connects in the panel is replaced there,
                  // where the new key is tested before it is kept.
                  onReplace={connectsInPanel(selected.provider) ? () => open(selected, "replace") : undefined}
                />
              </div>
              <Link
                to={catalogHref}
                className="inline-flex min-h-11 items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden /> All integrations
              </Link>
            </>
          ) : cards.length === 0 ? (
            <EmptyState
              title="No integrations are available."
              hint="The provider catalog could not be loaded from this installation."
            />
          ) : (
            <>
            <IntegrationsAnswer cards={cards} items={monitoring.status.items} />
            <section data-surface-hero aria-label="Providers" className="flex flex-col gap-6">
              {GROUPS.map((group) => {
                // What needs you first in its group; the rest in catalog order.
                const members = cards
                  .filter((status) => groupOf(status) === group)
                  .map((status, order) => ({ status, order, needs: needsYou(connectionStatus(status.provider.id, status.credential, monitoring.status.items)) }))
                  .sort((a, b) => Number(b.needs) - Number(a.needs) || a.order - b.order)
                  .map(({ status }) => status);
                if (members.length === 0) return null;
                const headingId = `integrations-${group.replace(/\W+/g, "-").toLowerCase()}`;
                return (
                  <section key={group} aria-labelledby={headingId} className="flex flex-col gap-2">
                    <SectionLabel id={headingId} title={group} />
                    <ul aria-labelledby={headingId} className="overflow-hidden rounded-xl border border-border bg-card">
                      {members.map((status) => (
                        <IntegrationRow
                          key={status.provider.id}
                          status={status}
                          nowMs={now}
                          items={monitoring.status.items}
                          href={`?${withProvider(params, status.provider.id)}`}
                          onOpen={(opened) => open(status, opened)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </section>
            </>
          )}
          {panel && connecting && !readOnly ? (
            <ProviderConnectPanel
              status={panel}
              opened={connecting.opened}
              asset={connecting.asset}
              canConnect={blockers.length === 0}
              items={monitoring.status.items}
              names={siteNames}
              onClose={() => setConnecting(null)}
              onChanged={refresh}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** A connection the operator has to act on: it fails, is overdue, or fails on a site. */
function needsYou(shown: ConnectionStatus): boolean {
  return shown.kind === "failing" || shown.kind === "overdue" || shown.sitesFailing > 0;
}

const CONNECTED = new Set(["working", "key-accepted", "collecting", "overdue", "failing", "unknown", "not-using"]);

/** The page's one answer: which connections need you, else how many are
 * connected. The sentence counts, and names a provider only when it is the
 * problem. */
export function integrationsAnswer(rows: readonly { name: string; shown: ConnectionStatus }[]): {
  answer: string;
  detail?: string;
  mark: "problem" | "none" | "connected";
} {
  const total = rows.length;
  const problems = rows.filter(({ shown }) => needsYou(shown));
  if (problems.length > 0) {
    return {
      answer: problems.length === 1 ? `${problems[0]!.name} needs you` : `${problems.length} of ${total} integrations need you`,
      detail: problems.map(({ name, shown }) => `${name} ${shown.kind === "overdue" ? "overdue" : "failing"}`).join(" · "),
      mark: "problem",
    };
  }
  const connected = rows.filter(({ shown }) => CONNECTED.has(shown.kind)).length;
  if (connected === 0) return { answer: "Nothing connected yet", detail: `${total} integrations to choose from`, mark: "none" };
  return { answer: connected === total ? `All ${total} integrations connected` : `${connected} of ${total} integrations connected`, mark: "connected" };
}

function IntegrationsAnswer({ cards, items }: { cards: readonly IntegrationProviderStatus[]; items: IntegrationHealthItem[] }) {
  const answer = integrationsAnswer(cards.map((status) => ({ name: providerName(status.provider), shown: connectionStatus(status.provider.id, status.credential, items) })));
  return <PageAnswer answer={answer.answer} detail={answer.detail} marks={{ "data-integrations-answer": answer.mark }} />;
}

/** The catalog's groups, in the order a founder looks for them. */
const GROUPS = ["Traffic & search", "Revenue", "Coordination", "Other"] as const;
const GROUP_OF: Record<string, (typeof GROUPS)[number]> = {
  google: "Traffic & search",
  "bing-webmaster": "Traffic & search",
  dataforseo: "Traffic & search",
  posthog: "Traffic & search",
  clarity: "Traffic & search",
  mediavine: "Revenue",
  calendar: "Coordination",
  discord: "Coordination",
};
function groupOf(status: IntegrationProviderStatus): (typeof GROUPS)[number] {
  return GROUP_OF[status.provider.id] ?? "Other";
}

function withProvider(params: URLSearchParams, provider: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("provider", provider);
  return next;
}

/**
 * One provider: logo, name, its one status, and the one thing to do next. The
 * action is the only control: Connect on the key form, Reconnect when the key
 * is failing, Manage on the connection itself. Every other provider opens its
 * own page.
 */
function IntegrationRow({
  status,
  nowMs,
  items,
  href,
  onOpen,
}: {
  status: IntegrationProviderStatus;
  nowMs: number;
  items: IntegrationHealthItem[];
  href: string;
  onOpen: (opened: "form" | "sites") => void;
}) {
  const demoReadonly = useDemoReadonly();
  const name = providerName(status.provider);
  const shown = connectionStatus(status.provider.id, status.credential, items);
  const expiry = credentialExpiry(status.credential.metadata, nowMs);
  const inPanel = connectsInPanel(status.provider);
  const failing = connectionState(status.credential) === "failing";
  const verb = shown.kind === "not-connected" ? "Connect" : inPanel && failing ? "Reconnect" : "Manage";
  const subject: StatusSubject = `integration:${status.provider.id}`;
  return (
    <li
      className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
      data-subject={subject}
      data-integration-tile={status.provider.id}
      data-integration-status={shown.kind}
    >
      <IntegrationLogo provider={status.provider.id} size="small" />
      {/* On a phone the status sits under the name on every row, so the
          column of chips reads down the list at one rhythm. */}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="min-w-0 max-w-full truncate font-medium">{name}</span>
        <span className="flex flex-wrap items-center gap-1.5 sm:ms-auto sm:justify-end">
          {shown.kind !== "not-connected" && (expiry.state === "warn" || expiry.state === "expired") ? (
            <StateChip
              label={expiry.state === "expired" ? "Key expired" : `Expires in ${expiry.daysRemaining}d`}
              tone={expiry.state === "expired" ? "critical" : "caution"}
              subject={subject}
            />
          ) : null}
          <IntegrationStateChip state={shown.kind} accepted={acceptedAs(status.provider, status.credential.auth)} subject={subject} />
          <ConnectionFacts status={shown} subject={subject} />
        </span>
      </div>
      {inPanel && !demoReadonly ? (
        <Button
          type="button"
          size="sm"
          variant={verb === "Reconnect" ? "default" : verb === "Connect" ? "outline" : "ghost"}
          aria-label={`${verb} ${name}`}
          disabled={demoReadonly}
          onClick={() => onOpen(verb === "Manage" ? "sites" : "form")}
        >
          {verb}
        </Button>
      ) : (
        <Button asChild size="sm" variant={verb === "Connect" ? "outline" : "ghost"}>
          <Link to={href} aria-label={`${demoReadonly ? 'View' : verb} ${name}`}>{demoReadonly ? 'View' : verb}</Link>
        </Button>
      )}
    </li>
  );
}

/** A provider's one status beside its name on its own page, with its facts. */
function ProviderStatus({ status, items }: { status: IntegrationProviderStatus; items: IntegrationHealthItem[] }) {
  const shown = connectionStatus(status.provider.id, status.credential, items);
  const subject: StatusSubject = `integration:${status.provider.id}`;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-sm font-normal tracking-normal" data-provider-status={shown.kind}>
      <IntegrationStateChip state={shown.kind} accepted={acceptedAs(status.provider, status.credential.auth)} subject={subject} />
      <ConnectionFacts status={shown} subject={subject} />
    </span>
  );
}

/** The Google card's sign-in half, or nothing at all for the other providers.
 * The origin comes from `window.location`: the redirect URI Google accepts is
 * a fact about the address this browser has the Tower open at. */
function googlePanel(
  status: IntegrationProviderStatus,
  app: IntegrationProviderStatus | null,
  refresh: () => Promise<void>,
  api: import('@/lib/api').TowerApi,
  toast: typeof import('sonner').toast,
  start: ReturnType<typeof useGoogleOAuthStart>,
): ProviderOAuthPanel | undefined {
  const { saveProviderCredential, fetchGoogleProperties } = api;
  if (status.provider.id !== "google" || app === null) return undefined;
  return {
    card: googleOAuthCardState(status, app, window.location.origin),
    app,
    startHref: GOOGLE_OAUTH_START_PATH,
    ...start,
    onSaveApp: async (fields) => {
      await saveProviderCredential(app.provider.id, fields);
      await refresh();
      toast.success("Saved — now sign in with Google");
    },
    onDiscover: () => fetchGoogleProperties(),
  };
}

/**
 * The asset ids this credential serves, as the card's identity rows, named as
 * the sidebar names them (the Wall's site list, already read for it). An
 * asset id IS its domain, which is why it is passed as the domain too.
 */
function assetRefs(status: IntegrationProviderStatus, names: ReadonlyMap<string, string>): ProviderCardAsset[] {
  return status.assets.map((asset) => ({
    id: asset.id,
    displayName: names.get(asset.id) ?? asset.id,
    domain: asset.id,
  }));
}

export default IntegrationsRoute;

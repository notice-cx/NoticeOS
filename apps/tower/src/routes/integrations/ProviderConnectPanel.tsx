import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { TriangleAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { CollectNowResult, IntegrationProvider } from "@noticeos/contract";
import { acceptedAs } from "@noticeos/contract/integrations";
import { useState } from "react";

import type { IntegrationHealthItem } from "@noticeos/contract/integration-health";
import { providerName } from "@shared/connect-panel";
import { connectionCollections } from "@shared/scheduled-jobs";
import { connectionStatus } from "@shared/connection-status";
import { changesetSlug } from "@shared/changeset";
import type { StartPlan } from "@shared/site-discovery";
import { GOOGLE_OAUTH_START_PATH } from "@noticeos/contract/google-oauth";
import { NOTIFICATION_LANE, connectionState, credentialAssetRows, googleOAuthCardState, type ConnectBlocker, type IntegrationProviderStatus } from "@shared/integrations-page";
import { ConnectBlockers } from "@/components/ConnectBlockers";
import { ConnectPanel } from "@/components/ConnectPanel";
import { WhatLands } from "@/components/WhatLands";
import { GoogleSignInSetup } from "@/components/GoogleSignInSetup";
import { useIntegrationProviders } from "@/hooks/useIntegrationProviders";
import { IntegrationStateChip } from "@/components/IntegrationStateChip";
import { SitePicker } from "@/components/SitePicker";
import { SiteTokens } from "@/components/SiteTokens";
import { useConnections } from "@/hooks/useConnections";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useSettings } from "@/hooks/useSettings";
import { ScheduleRows } from "@/routes/workflows/ScheduleEditor";
import { useInlineConfigSave } from "@/hooks/useConfigSave";
import { useConfigSaveDelay } from "@/hooks/config-backed-queries";
import { useGoogleOAuthStart } from '@/hooks/useGoogleOAuthStart';
import { CloudflareD1Panel } from './CloudflareD1Panel';


/** Which view of the panel a provider opens on: its key form, or its sites. */
export type ProviderPanelOpening = "form" | "sites" | "replace";

/** Where a provider's panel opens: on the key form while nothing is stored,
 * on its sites once it is, and always on the sites for a provider whose
 * tokens are pasted per site, which has no key form at all. */
export function providerPanelOpening(status: IntegrationProviderStatus): ProviderPanelOpening {
  if (status.provider.connect?.kind === "site-tokens") return "sites";
  return connectionState(status.credential) === "not-connected" ? "form" : "sites";
}

export interface ProviderConnectPanelProps {
  /** The provider and what the store holds for it (`/api/integrations/providers`). */
  status: IntegrationProviderStatus;
  opened: ProviderPanelOpening;
  /** The site the panel was opened for: it leads the site list. */
  asset: string | null;
  /** False while this install cannot store a credential yet. */
  canConnect: boolean;
  /** Why not, said in the panel; passed only where the page behind has no
   * banner saying it (a site's Data sources). */
  blockers?: readonly ConnectBlocker[];
  /** The monitoring items the connection model reads statuses from. */
  items: IntegrationHealthItem[];
  /** Site id → the name the sidebar shows. */
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  /** Re-read what the panel changed: the providers, the monitoring, and
   * whatever the page behind shows. */
  onChanged: () => Promise<void>;
}

/**
 * One provider's connect panel, wherever it is opened: the Integrations list
 * and a site's Data sources open the same panel over themselves, the key form
 * and the account's sites (`SitePicker`), or a token pasted per site
 * (`SiteTokens`), with the connection's own Replace and Disconnect once there
 * is one. Route wiring, not a component: it binds the registered pieces to
 * the API.
 */
export function ProviderConnectPanel({ status, opened, asset, canConnect, blockers, items, names, onClose, onChanged }: ProviderConnectPanelProps) {
  const toast = useOwnerToast();
  const googleStart = useGoogleOAuthStart();
  const { deleteProviderCredential, connectProviderCredential, saveProviderCredential } = useTowerApi();
  const [started, setStarted] = useState(false);
  const { provider, credential } = status;
  const state = connectionState(credential);
  const shown = connectionStatus(provider.id, credential, items);
  const siteTokens = provider.connect?.kind === "site-tokens";
  // A provider connected by signing in (Google): its OAuth client is a
  // companion credential with no row of its own.
  const signIn = provider.connect?.kind === "sign-in";
  const providers = useIntegrationProviders();
  const app = signIn ? providers.data?.providers.find((entry) => entry.provider.companionOf === provider.id) ?? null : null;
  return (
    <ConnectPanel
      key={provider.id}
      provider={provider}
      canConnect={canConnect}
      blocked={blockers && blockers.length > 0 ? <ConnectBlockers blockers={blockers} /> : undefined}
      opened={opened}
      // Opened on a connected provider, the header wears its status until
      // Start; after Start each site's row carries its own, and the header
      // none — a one-site connection's status would be the same word twice.
      // Tokens pasted per site (Clarity) are always rows carrying their own.
      status={started || siteTokens ? null : state !== "not-connected" ? (
        <IntegrationStateChip state={shown.kind} accepted={acceptedAs(provider, credential.auth)} subject={`integration:${provider.id}`} />
      ) : undefined}
      // The connection's own actions, once there is one: Replace in this
      // panel, Disconnect asked once.
      manage={state !== "not-connected" ? {
        stops: credentialAssetRows(status).map((row) => ({ id: row.id, label: names.get(row.id) ?? row.id, domain: row.id })),
        failing: state === "failing",
        onDisconnect: async () => {
          await deleteProviderCredential(provider.id);
          await onChanged();
          toast.success(`Disconnected — ${providerName(provider)}`);
          onClose();
        },
      } : undefined}
      onClose={onClose}
      // A notification channel says what it carries, and whether it is
      // sending, before and after it is connected.
      carries={provider.lanes.includes(NOTIFICATION_LANE) ? (
        <WhatLands connected={state !== "not-connected"} />
      ) : undefined}
      // When the collections this connection feeds run.
      schedule={state !== "not-connected" && connectionCollections(provider.id).length > 0 ? <ConnectionSchedule provider={provider.id} /> : undefined}
      onConnect={async (fields) => {
        const answer = await connectProviderCredential(provider.id, fields);
        // The row behind reads the new state from the store, never from the panel.
        if (answer.verdict === "accepted") void onChanged();
        return answer;
      }}
      setup={signIn ? (
        <GoogleSignInSetup
          card={googleOAuthCardState(status, app, window.location.origin)}
          // The host's own verified client arrives from the environment; one
          // this installation stores is its own, set up once, in Testing.
          selfHosted={app === null || app.credential.source !== "env"}
          startHref={GOOGLE_OAUTH_START_PATH}
          {...googleStart}
          publish={provider.expiry.known === "flow" ? provider.expiry.fix ?? null : null}
          canConnect={canConnect}
          onSaveClient={async (fields) => {
            await saveProviderCredential(app?.provider.id ?? "google-oauth-app", fields);
            await onChanged();
          }}
        />
      ) : undefined}
      // A connection of the whole installation (Discord, the calendar feeds)
      // ends on the provider's answer: no site list.
      next={provider.id === 'cloudflare' ? answer => (
        <CloudflareD1Panel inventory={answer?.facts.cloudflareD1} names={names} canSave={canConnect} onChanged={onChanged} />
      ) : provider.connect?.sites === false ? undefined : (_answer, close) => siteTokens ? (
        <ProviderSiteTokens status={status} names={names} preselect={asset} canSave={canConnect} items={items} onSaved={onChanged} />
      ) : (
        <ProviderSites provider={provider} preselect={asset} onClose={close} onStarted={() => setStarted(true)} onCollected={onChanged} />
      )}
    />
  );
}

/**
 * When this connection's collections run: the same rows Settings → Data
 * collection draws, for the collections this one feeds
 * (`connectionCollections`). A job two connections feed is the same row on
 * each of their panels; either pick writes the one saved schedule. Nothing
 * until the saved schedules have been read: a row drawn from no reading would
 * be guarded by a value the store never held.
 */
function ConnectionSchedule({ provider }: { provider: string }) {
  const jobs = connectionCollections(provider);
  const { data } = useSettings();
  const { writable } = useConfigWritable();
  if (!data) return null;
  return <ScheduleRows jobs={jobs} overrides={data.collection.schedules} writable={writable} />;
}

/**
 * The connect panel's site list for one provider: the account's sites read
 * once for the panel, Start as the Data sources tab's own save followed by
 * the job step's collection, and each collected site's status from the
 * connection model, Collecting until its result is stored.
 */
function ProviderSites({
  provider,
  preselect,
  onClose,
  onStarted,
  onCollected,
}: {
  provider: IntegrationProvider;
  preselect: string | null;
  onClose: () => void;
  onStarted: () => void;
  onCollected: () => Promise<void>;
}) {
  const toast = useOwnerToast();
  const { fetchProviderSites, collectProviderSites } = useTowerApi();
  // The Data sources tab's own write (`PUT /api/config`, audited in
  // `config_changes`), confirmed by the rows' statuses rather than a toast
  // that would cover the panel's footer; a refusal still says so.
  const save = useInlineConfigSave();
  const saveDelayMs = useConfigSaveDelay();
  // Read once for the panel; nothing refetches it behind the operator's back.
  // One key per panel session: a panel opened again reads the account again,
  // and nothing within one session reads it twice (StrictMode's second mount
  // included, which a zero cache time would break).
  const [session] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sites = useQuery({
    queryKey: ["integration-sites", provider.id, session],
    // No abort signal: a read cancelled by StrictMode's rehearsal unmount would
    // be asked again on the remount — the provider asked twice.
    queryFn: () => fetchProviderSites(provider.id),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
  });
  const { credentials, items } = useConnections();
  const status = connectionStatus(provider.id, credentials?.get(provider.id), items ?? []);

  async function start(plan: StartPlan): Promise<CollectNowResult | "saved" | null> {
    if (plan.ops.length > 0) {
      const saved = await save({ ops: plan.ops, label: `${providerName(provider)} sites`, slug: changesetSlug("connect", provider.id, "sites") });
      if (saved === null) return null;
      // A deployment still on its config FILE restarts the local Worker to
      // read the save; the collection waits for it, as every save's refresh does.
      if (saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
    }
    // Every row was Not using: the save was the press, and there is nothing
    // to collect.
    if (plan.assets.length === 0) {
      await onCollected();
      return "saved";
    }
    let result: CollectNowResult;
    try {
      result = await collectProviderSites(provider.id, plan.assets);
    } catch {
      toast.error("Not started · try again", { icon: <TriangleAlert className="size-4" /> });
      return null;
    }
    await onCollected();
    return result;
  }

  return (
    <SitePicker
      provider={provider}
      payload={sites.data}
      failed={sites.isError}
      onRetry={() => void sites.refetch()}
      preselect={preselect}
      onStart={start}
      onStarted={onStarted}
      siteStatus={(asset) => {
        const site = status.sites.find((entry) => entry.key === asset);
        return site ? { kind: site.kind, site } : null;
      }}
      onClose={onClose}
    />
  );
}

/**
 * The connect panel's body for a provider that issues a token per site: every
 * site it serves, the one the panel was opened for first, each token saved on
 * its row the moment it is pasted, and Run now spending one of each site's
 * daily calls from the provider's own meter.
 */
function ProviderSiteTokens({
  status,
  names,
  preselect,
  canSave,
  items,
  onSaved,
}: {
  status: IntegrationProviderStatus;
  names: ReadonlyMap<string, string>;
  preselect: string | null;
  canSave: boolean;
  items: IntegrationHealthItem[];
  onSaved: () => Promise<void>;
}) {
  const toast = useOwnerToast();
  const { saveSiteToken, collectProviderSites } = useTowerApi();
  const shown = connectionStatus(status.provider.id, status.credential, items);
  const rows = credentialAssetRows(status)
    .map((row) => ({ id: row.id, label: names.get(row.id) ?? row.id, domain: row.id, held: row.held }))
    .sort((a, b) => Number(b.id === preselect) - Number(a.id === preselect));
  const cap = status.provider.meter?.window === "asset-day" ? status.provider.meter.perAssetPerDay : 10;
  const spent = new Map(status.meter?.window === "asset-day" ? status.meter.assets.map((entry) => [entry.asset, entry.spent]) : []);
  return (
    <SiteTokens
      provider={status.provider}
      sites={rows}
      cap={cap}
      canSave={canSave}
      statusOf={(asset) => shown.sites.find((site) => site.key === asset)?.kind ?? null}
      remaining={(asset) => (status.meter === null || status.meter === undefined ? null : Math.max(0, cap - (spent.get(asset) ?? 0)))}
      onSave={async (asset, token) => {
        await saveSiteToken(status.provider.id, asset, token);
        await onSaved();
      }}
      onRun={async (assets) => {
        try {
          const result = await collectProviderSites(status.provider.id, assets);
          await onSaved();
          return result;
        } catch {
          toast.error("Not started · try again", { icon: <TriangleAlert className="size-4" /> });
          return null;
        }
      }}
    />
  );
}

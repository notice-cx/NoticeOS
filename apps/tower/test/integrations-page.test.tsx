import { integrationStatus } from '@shared/integration-status';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialBalance,
  CredentialMetadata,
  CredentialProbe,
  CredentialSummary,
  GooglePropertyDiscovery,
  IntegrationCredentialsPayload,
  IntegrationField,
  IntegrationProvider,
  IntegrationProviderId,
  IntegrationProviderStatus,
  PortfolioMonthMeterReading,
} from "@shared/integrations-page";
import {
  connectionState,
  expiringCredentialSeverity,
  expiringCredentialSummary,
  expiringCredentials,
  googleOAuthCardState,
  googleOAuthNotice,
  parseUrlList,
} from "@shared/integrations-page";
import {
  GOOGLE_OAUTH_START_PATH,
  INTEGRATION_PROVIDERS,
  type ConnectVerdict,
} from "@noticeos/contract";
import { CREDENTIAL_BLOCKER_LEADS } from "@noticeos/contract/integrations";
import {
  type EnvImportAvailability,
  type EnvImportResult,
} from "@shared/env-import";

// The API is mocked: these tests are the proof for the page's half of the
// credential contract.

const api = vi.hoisted(() => ({
  save: vi.fn<(provider: string, fields: Record<string, string>) => Promise<void>>(),
  remove: vi.fn<(provider: string) => Promise<void>>(),
  test: vi.fn<(provider: string) => Promise<CredentialProbe>>(),
  importEnv: vi.fn<() => Promise<EnvImportResult>>(),
  importable: vi.fn<() => Promise<EnvImportAvailability>>(),
  connect: vi.fn<(provider: string, fields: Record<string, string>) => Promise<ConnectVerdict>>(),
  siteToken: vi.fn<(provider: string, asset: string, token: string) => Promise<void>>(),
}));

const payload = vi.hoisted(() => ({
  data: null as IntegrationCredentialsPayload | null,
  health: undefined as import("@noticeos/contract").IntegrationHealthPayload | undefined,
}));

// Only the credential calls and the env-import pair are replaced; every other
// route in `deskRoutes` imports this module too, and a bare factory would
// delete their exports along with the network.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  saveProviderCredential: api.save,
  deleteProviderCredential: api.remove,
  testProviderCredential: api.test,
  importEnvCredentials: api.importEnv,
  fetchEnvImportAvailability: api.importable,
  connectProviderCredential: api.connect,
  saveSiteToken: api.siteToken,
}));

vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({
    data: payload.data,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/useNow", () => ({ useNow: () => NOW }));

import { deskRoutes } from "@/App";
import { NAV_ITEMS, PAGE_ITEMS } from "@/components/nav-items";
import { ProviderCard, SECRETS_IMPORT_COMMAND } from "@/components/ProviderCard";
import HealthRoute from "@/routes/HealthRoute";
import { IntegrationsRoute } from "@/routes/IntegrationsRoute";
import { componentAt } from "./route-table";

beforeEach(() => {
  payload.health = undefined;
  api.save.mockReset();
  api.remove.mockReset();
  api.test.mockReset();
  api.importEnv.mockReset();
  api.connect.mockReset();
  api.siteToken.mockReset();
  // The page asks once whether this deployment can import at all. Unless a
  // test says otherwise the answer is no.
  api.importable.mockReset();
  api.importable.mockResolvedValue({ importable: false, reason: null });
});

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function field(over: Partial<IntegrationField> & { name: string }): IntegrationField {
  return {
    label: over.name,
    secret: true,
    kind: "password",
    required: true,
    ...over,
  };
}

function provider(
  id: IntegrationProviderId,
  fields: IntegrationField[],
  over: Partial<IntegrationProvider> = {},
): IntegrationProvider {
  return {
    id,
    label: id,
    docRef: "docs/11-integrations.md#the-catalog",
    scope: "shared",
    lanes: [id],
    // `never` is the shape of a key with no stated lifetime.
    expiry: { known: "never" },
    // `free` is the shape of a cheap read-only call, the one cost the card
    // deliberately says nothing about.
    test: { cost: "free" },
    fields,
    ...over,
  };
}

function credential(
  id: IntegrationProviderId,
  over: Partial<CredentialSummary> = {},
): CredentialSummary {
  return {
    provider: id,
    source: "none",
    fields: [],
    assetsHeld: [],
    missingFields: [],
    auth: null,
    metadata: null,
    keyVersion: null,
    createdAt: null,
    updatedAt: null,
    lastUsedAt: null,
    lastOkAt: null,
    lastError: null,
    ...over,
  };
}

const DATAFORSEO_FIELDS = [
  field({ name: "DATAFORSEO_LOGIN", label: "Login", secret: false, kind: "text" }),
  field({ name: "DATAFORSEO_PASSWORD", label: "Password", kind: "password" }),
];

function status(
  id: IntegrationProviderId,
  fields: IntegrationField[],
  cred: Partial<CredentialSummary>,
  assets: { id: string; lanes: string[] }[] = [],
  over: Partial<IntegrationProvider> = {},
): IntegrationProviderStatus {
  return {
    provider: provider(id, fields, over),
    credential: credential(id, cred),
    assets,
  };
}

function renderCard(
  s: IntegrationProviderStatus,
  over: Partial<Parameters<typeof ProviderCard>[0]> = {},
) {
  return render(
    <MemoryRouter>
      <ProviderCard
        status={s}
        assets={s.assets.map((a) => ({ id: a.id, displayName: a.id, domain: a.id }))}
        nowMs={NOW}
        onConnect={(fields) => api.save(s.provider.id, fields)}
        onTest={() => api.test(s.provider.id)}
        onDisconnect={() => api.remove(s.provider.id)}
        {...over}
      />
    </MemoryRouter>,
  );
}

/** A payload with both bootstrap facts satisfied, so a test that is not about
 * them does not have to restate them. */
function page(
  providers: IntegrationProviderStatus[],
  over: Partial<IntegrationCredentialsPayload> = {},
): IntegrationCredentialsPayload {
  return {
    generatedAt: new Date(NOW).toISOString(),
    keyPresent: true,
    blockers: [],
    keyReason: null,
    providers,
    ...over,
  };
}

function renderPage(data: IntegrationCredentialsPayload, at = "/integrations") {
  payload.data = data;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <IntegrationsRoute />
        <CurrentAddress />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The address the route leaves the browser at, for the deep-link cases. */
function CurrentAddress() {
  const location = useLocation();
  return <output data-address hidden>{`${location.pathname}${location.search}`}</output>;
}

/** Open a provider's own page through its row's one action. */
function openRow(label: string): HTMLElement {
  const back = screen.queryByRole("link", { name: "All integrations" });
  if (back) fireEvent.click(back);
  const row = screen.getByText(label).closest<HTMLElement>("[data-integration-tile]");
  if (!row) throw new Error(`no integration for ${label}`);
  fireEvent.click(within(row).getByRole("link", { name: new RegExp(`^(Connect|Manage) ${label}$`) }));
  const detail = document.querySelector("[data-integration-detail]");
  if (!(detail instanceof HTMLElement)) throw new Error(`no detail for ${label}`);
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  return detail;
}

describe("/integrations is a page, not an alias", () => {
  it("serves the Integrations page at /integrations and Health at /health", async () => {
    expect(await componentAt(deskRoutes, "/integrations")).toBe(IntegrationsRoute);
    expect(await componentAt(deskRoutes, "/health")).toBe(HealthRoute);
  });

  it("gives each path its own page, and redirects neither", async () => {
    // Each path must hold its own route component: an alias or a `Navigate`
    // would both fail here.
    const integrations = await componentAt(deskRoutes, "/integrations");
    const health = await componentAt(deskRoutes, "/health");
    expect(integrations).not.toBe(health);
    expect(integrations).toBe(IntegrationsRoute);
    expect(health).toBe(HealthRoute);
  });

  it("gives it a nav entry between Health and Settings, with the palette words", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(labels.indexOf("Integrations")).toBe(labels.indexOf("System health") + 1);
    expect(labels.indexOf("Integrations")).toBe(labels.indexOf("Settings") - 1);

    const entry = NAV_ITEMS.find((item) => item.label === "Integrations");
    expect(entry?.to).toBe("/integrations");
    for (const word of ["connect", "credentials", "api key"]) {
      expect(entry?.keywords).toContain(word);
    }
    expect(PAGE_ITEMS.map((item) => item.to)).toContain("/integrations");
  });

  it("stops Health claiming the word Integrations in the palette", () => {
    // One word, one page: leaving `integrations` as a Health keyword would
    // send ⌘K "integrations" to two destinations.
    const health = NAV_ITEMS.find((item) => item.label === "System health");
    expect(health?.keywords ?? []).not.toContain("integrations");
  });
});

describe("what state a credential is in", () => {
  it("derives all four from the summary alone", () => {
    expect(connectionState(credential("dataforseo"))).toBe("not-connected");
    expect(
      connectionState(credential("dataforseo", { source: "store", fields: ["A"] })),
    ).toBe("connected");
    expect(connectionState(credential("google", { source: "env" }))).toBe("legacy-env");
    expect(
      connectionState(
        credential("bing-webmaster", {
          source: "store",
          fields: ["K"],
          lastUsedAt: iso(HOUR),
          lastOkAt: iso(30 * DAY),
          lastError: "rejected",
        }),
      ),
    ).toBe("failing");
  });

  it("does not shout about an error the next success already fixed", () => {
    // `lastError` carries no timestamp of its own, so a stale one has to be
    // read against `lastOkAt`.
    expect(
      connectionState(
        credential("bing-webmaster", {
          source: "store",
          fields: ["K"],
          lastUsedAt: iso(HOUR),
          lastOkAt: iso(HOUR),
          lastError: "rejected last month",
        }),
      ),
    ).toBe("connected");
  });

  it("calls a half-entered store credential not connected, and names what is missing", () => {
    const s = status("dataforseo", DATAFORSEO_FIELDS, {
      source: "store",
      fields: ["DATAFORSEO_LOGIN"],
      missingFields: ["DATAFORSEO_PASSWORD"],
    });
    expect(connectionState(s.credential)).toBe("not-connected");

    renderCard(s);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    const row = document.querySelector('[data-stored-field="DATAFORSEO_PASSWORD"]');
    expect(row).toHaveAttribute("data-stored-field-state", "missing");
  });

  it("renders Connected with the stored fields as set, never as values", () => {
    renderCard(
      status("dataforseo", DATAFORSEO_FIELDS, {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
        updatedAt: iso(3 * DAY),
        lastUsedAt: iso(4 * HOUR),
        lastOkAt: iso(4 * HOUR),
      }),
    );
    expect(screen.getByText("Key accepted")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getAllByText("set")).toHaveLength(2);
    expect(document.querySelector("[data-verdict]")).toHaveAttribute(
      "data-verdict-ok",
      "true",
    );
  });

  /** The one card the import affordance lives on. */
  const legacyEnv = () =>
    status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
      source: "env",
      lastUsedAt: iso(HOUR),
      lastOkAt: iso(HOUR),
    });

  it("renders Legacy env with the import command where the import cannot run, labelled with where it runs", () => {
    // A deployed Worker has no secrets file to read, so the card keeps the
    // command and labels where it runs; the reason is a code the card draws.
    renderCard(legacyEnv(), {
      envImport: {
        importable: false,
        reason: "elsewhere",
        onImport: async () => {},
      },
    });
    expect(screen.getByText("Key accepted")).toBeInTheDocument();
    expect(document.querySelector("[data-legacy-env]")).toHaveTextContent("In the environment file");
    expect(document.querySelector("[data-import-command]")).toHaveTextContent(
      SECRETS_IMPORT_COMMAND,
    );
    expect(document.querySelector('[data-import-reason="elsewhere"]')).toHaveTextContent("On the OS machine");
    expect(document.querySelector("[data-import-env]")).not.toBeInTheDocument();
  });

  it("puts the migrate command first where this machine has no secrets file", () => {
    renderCard(legacyEnv(), { envImport: { importable: false, reason: "no-file", onImport: async () => {} } });
    const commands = [...document.querySelectorAll("[data-import-command]")].map((node) => node.textContent);
    expect(commands).toEqual(["pnpm dev:secrets:migrate", SECRETS_IMPORT_COMMAND]);
  });

  it("offers Import where the OS is running, and the press moves the whole secrets file", async () => {
    const onImport = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    renderCard(legacyEnv(), {
      envImport: { importable: true, reason: null, onImport },
    });

    const button = screen.getByRole("button", { name: /Import from this machine/ });
    fireEvent.click(button);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(document.querySelector("[data-import-command]")).not.toBeInTheDocument();
  });

  it("shows a failed import beside the button instead of pretending it worked", async () => {
    const onImport = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("CREDENTIALS_KEY is not set."));
    renderCard(legacyEnv(), {
      envImport: { importable: true, reason: null, onImport },
    });

    fireEvent.click(screen.getByRole("button", { name: /Import from this machine/ }));
    await waitFor(() =>
      expect(document.querySelector("[data-import-error]")).toHaveTextContent(
        "CREDENTIALS_KEY is not set.",
      ),
    );
    expect(screen.getByRole("button", { name: /Import from this machine/ })).toBeEnabled();
  });

  it("renders Failing with the provider's own reason", () => {
    renderCard(
      status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY" })], {
        source: "store",
        fields: ["BING_WEBMASTER_API_KEY"],
        lastUsedAt: iso(9 * HOUR),
        lastOkAt: iso(31 * DAY),
        lastError: "The API key was rejected.",
      }),
    );
    expect(screen.getByText("Failing")).toBeInTheDocument();
    const verdict = document.querySelector('[data-verdict="stored-verdict"]');
    expect(verdict).toHaveAttribute("data-verdict-ok", "false");
    expect(verdict).toHaveTextContent("The API key was rejected.");
  });

  it("says a freshly stored credential has not been tested yet, rather than nothing", () => {
    // A PUT resets lastUsedAt / lastOkAt / lastError, so this is the state of
    // every card one second after Save.
    renderCard(
      status("dataforseo", DATAFORSEO_FIELDS, {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
        updatedAt: iso(4000),
      }),
    );
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    const verdict = document.querySelector('[data-verdict="stored-verdict"]');
    expect(verdict).toHaveAttribute("data-verdict-ok", "unknown");
    expect(verdict).toHaveTextContent("Not tested yet.");
    expect(document.querySelector("[data-test-connection]")).not.toBeDisabled();
  });

  it("renders Not connected with Connect as its action, and offers no test", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, {}));
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(document.querySelector("[data-what-you-need]")).toBeNull();
    expect(document.querySelector("[data-connect-toggle]")).toHaveTextContent("Connect…");
    expect(document.querySelector("[data-test-connection]")).toBeDisabled();
    expect(document.querySelector("[data-connection-actions]")).toBeNull();
    expect(document.querySelector("[data-disconnect-open]")).toBeNull();
  });

  it("names the assets a shared credential serves, linking to their sources", () => {
    renderCard(
      status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], { source: "env" }, [
        { id: "meals.example", lanes: ["ga4", "gsc"] },
        { id: "nosh.example", lanes: ["gsc"] },
      ]),
    );
    const served = document.querySelector("[data-served-assets]");
    expect(served).toHaveTextContent("Used by 2 sites");
    expect(
      within(served as HTMLElement).getByRole("link", { name: /meals\.example/ }),
    ).toHaveAttribute("href", "/assets/meals.example/sources");
  });

  it("names each data source that is not mapped yet", () => {
    renderCard({
      ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
        source: "env",
      }),
      credential: {
        ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
          source: "env",
        }).credential,
        propertyMap: {
          needed: true,
          answersFor: [
            { asset: "meals.example", id: "ga4", label: "GA4 Data API" },
            { asset: "nosh.example", id: "gsc", label: "Search Console" },
          ],
        },
      },
    });
    const note = document.querySelector('[data-property-map="needed"]');
    expect(note).toHaveTextContent("2 data sources are not mapped yet");
    expect(
      within(note as HTMLElement).getByRole("link", { name: /meals\.example/ }),
    ).toHaveAttribute("href", "/assets/meals.example/sources");
    expect(note).toHaveTextContent("Search Console");
    expect(document.querySelector('[data-property-map="retired"]')).toBeNull();
  });

  it("says the credential no longer answers for any of them once all are saved", () => {
    renderCard({
      ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
        source: "env",
      }),
      credential: {
        ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
          source: "env",
        }).credential,
        propertyMap: { needed: false, answersFor: [] },
      },
    });
    const note = document.querySelector('[data-property-map="retired"]');
    expect(note).toHaveTextContent("All Google data sources are mapped on their sites");
    expect(document.querySelector('[data-property-map="needed"]')).toBeNull();
  });

  it("says nothing about a property map on a provider that has none", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }));
    expect(document.querySelector("[data-property-map]")).toBeNull();
  });

  it("says nothing until there is a credential to say it about", () => {
    renderCard({
      ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
        source: "none",
        missingFields: ["GOOGLE_SIGNAL_ACCOUNTS"],
      }),
      credential: {
        ...status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
          source: "none",
          missingFields: ["GOOGLE_SIGNAL_ACCOUNTS"],
        }).credential,
        propertyMap: {
          needed: true,
          answersFor: [{ asset: "nosh.example", id: "ga4", label: "GA4" }],
        },
      },
    });
    expect(document.querySelector("[data-property-map]")).toBeNull();
  });
});

describe("the notification card says what will land in the channel", () => {
  const discordStatus = () =>
    status(
      "discord",
      [field({ name: "DISCORD_WEBHOOK_URL", kind: "url" })],
      { source: "store", fields: ["DISCORD_WEBHOOK_URL"], lastOkAt: iso(HOUR) },
      [{ id: "root-os", lanes: ["discord-webhooks"] }],
      { lanes: ["discord-webhooks"] },
    );

  it("lists the sender's own declaration, so the card cannot over-promise", () => {
    renderCard(discordStatus());
    const block = document.querySelector("[data-what-lands]");
    expect(block).not.toBeNull();
    expect(
      [...document.querySelectorAll("[data-notified-condition]")].map((el) =>
        el.getAttribute("data-notified-condition"),
      ),
    ).toEqual(["open-error", "source-failing"]);
    expect(block).toHaveTextContent("What NoticeOS sends here");
    expect(document.querySelector("[data-notifications-blocked]")).toBeNull();
    expect(document.querySelector("[data-notifications-command]")).toBeNull();
  });

  it("says nothing of the kind on a provider that carries no notifications", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }));
    expect(document.querySelector("[data-what-lands]")).toBeNull();
  });
});

describe("a metered data source says how much budget is left today", () => {
  const meteredStatus = (
    spent: { asset: string; spent: number }[],
    over: Partial<IntegrationProviderStatus> = {},
  ): IntegrationProviderStatus => ({
    ...status(
      "clarity",
      [field({ name: "CLARITY_TOKENS", kind: "asset-map" })],
      {
        source: "store",
        fields: ["CLARITY_TOKENS"],
        assetsHeld: ["meals.example", "nosh.example"],
        lastOkAt: iso(6 * HOUR),
        lastUsedAt: iso(6 * HOUR),
      },
      [
        { id: "meals.example", lanes: ["clarity"] },
        { id: "nosh.example", lanes: ["clarity"] },
        { id: "fees.example", lanes: ["clarity"] },
      ],
      {
        scope: "per-asset",
        meter: {
          window: "asset-day",
          perAssetPerDay: 10,
          unit: "call",
          countedFrom: "clarity",
        },
      },
    ),
    meter: { window: "asset-day", day: "2026-09-05", assets: spent },
    ...over,
  });

  it("prints what is left per asset, because the cap is per asset", () => {
    renderCard(meteredStatus([{ asset: "meals.example", spent: 3 }]));
    const block = document.querySelector("[data-provider-meter]");
    expect(block).toHaveTextContent("7 of 10 calls left today");
    expect(
      document.querySelector('[data-meter-line="nosh.example"]'),
    ).toHaveTextContent("10 of 10 calls left today");
  });

  it("lists only the assets that hold a key, because only they can spend", () => {
    renderCard(meteredStatus([]));
    // fees.example declares the data source and has no token: a full bar
    // beside it would read as budget it does not have.
    expect(document.querySelector('[data-meter-line="fees.example"]')).toBeNull();
    expect(document.querySelectorAll("[data-meter-line]")).toHaveLength(2);
  });

  it("draws no account-credit line, because a daily call cap is not prepaid", () => {
    // Only a prepaid account has a credit to report.
    renderCard(meteredStatus([{ asset: "meals.example", spent: 3 }]));
    expect(document.querySelector("[data-account-credit]")).toBeNull();
  });

  it("says the day is gone rather than a negative budget", () => {
    renderCard(meteredStatus([{ asset: "meals.example", spent: 12 }]));
    expect(
      document.querySelector('[data-meter-line="meals.example"]'),
    ).toHaveAttribute("data-meter-left", "0");
  });

  it("shows nothing for a provider with no meter, and nothing with no reading", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }));
    expect(document.querySelector("[data-provider-meter]")).toBeNull();
    renderCard(meteredStatus([], { meter: null }));
    expect(document.querySelector("[data-provider-meter]")).toBeNull();
  });
});

describe("the metered provider says how much of the month's cap is left", () => {
  const spendStatus = (
    reading: Partial<PortfolioMonthMeterReading> | null,
    balance: CredentialBalance | null = null,
  ): IntegrationProviderStatus => ({
    ...status(
      "dataforseo",
      DATAFORSEO_FIELDS,
      {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
        lastOkAt: iso(6 * HOUR),
        lastUsedAt: iso(6 * HOUR),
        metadata: {
          account: null,
          scopes: [],
          connectedAt: null,
          expiresAt: null,
          expirySource: null,
          balance,
        },
      },
      [{ id: "meals.example", lanes: ["dataforseo"] }],
      {
        meter: {
          window: "portfolio-month",
          countedFrom: "dataforseo",
        },
      },
    ),
    meter:
      reading === null
        ? null
        : { window: "portfolio-month", period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 25, ...reading },
  });

  it("prints what is left of the portfolio's month, as one line", () => {
    // The cap is portfolio-wide, so it is not repeated per asset.
    renderCard(spendStatus({ spentUsd: 1.122_772, unknownPrices: 0 }));
    const block = document.querySelector("[data-provider-meter]");
    expect(block).toHaveTextContent("$23.88 of $25 left");
    expect(block).toHaveTextContent("Data budget, Sep");
    expect(document.querySelectorAll("[data-meter-line]")).toHaveLength(1);
  });

  it("shows unpriced calls beside known spend without changing the remaining budget", () => {
    const { unmount } = renderCard(spendStatus({ spentUsd: 1, unknownPrices: 3 }));
    expect(document.querySelector("[data-provider-meter]")).toHaveTextContent("$24.00 of $25 left");
    expect(screen.getByTitle("3 unknown prices")).toHaveTextContent("3");
    unmount();
    renderCard(spendStatus({ spentUsd: 1, unknownPrices: 0 }));
    expect(document.querySelector('[title*="unknown price"]')).toBeNull();
  });

  it("links the budget to where it is set, and says when a spent month resumes", () => {
    // The cap is the operator's own setting and fails closed: the label goes
    // to Settings, and a spent-out month wears the pause as a chip.
    const { unmount } = renderCard(spendStatus({ spentUsd: 1, unknownPrices: 0 }));
    expect(document.querySelector("[data-meter-cap-link]")).toHaveAttribute("href", "/settings#budget");
    expect(document.querySelector("[data-provider-meter]")).not.toHaveTextContent("Paused");
    unmount();
    renderCard(spendStatus({ spentUsd: 25, unknownPrices: 0 }));
    expect(document.querySelector("[data-provider-meter]")).toHaveTextContent("Paused until Oct 1");
  });

  it("prints the last-seen account credit with how old it is", () => {
    // The figure is a sighting, not a live reading, so it is never shown undated.
    renderCard(
      spendStatus({ spentUsd: 1, unknownPrices: 0 }, { usd: "18.72", seenAt: iso(2 * HOUR) }),
    );
    const credit = document.querySelector("[data-account-credit]");
    expect(credit).toHaveTextContent("Account credit");
    expect(credit).toHaveTextContent("$18.72");
    expect(credit).toHaveTextContent("seen 2h ago");
    expect(credit).toHaveAttribute("title", iso(2 * HOUR));
    expect(credit).not.toHaveAttribute("data-account-credit-stale");
  });

  it("prints the credit from the provider's own digits, never through a float", () => {
    // $1.005 is $1.01; the float 1.005 is 1.00499…, which rounds to $1.00.
    renderCard(spendStatus({ spentUsd: 1, unknownPrices: 0 }, { usd: "1.005", seenAt: iso(2 * HOUR) }));
    const credit = document.querySelector("[data-account-credit]");
    expect(credit).toHaveTextContent("$1.01");
    expect(credit).toHaveAttribute("data-account-credit", "1.005");
  });

  it("says a sighting is too old to act on after two missed weekly refreshes", () => {
    // The weekly refresh is silent when refused. The figure stays (hiding it
    // would invent "no credit"), but the age carries the meaning.
    renderCard(
      spendStatus({ spentUsd: 1, unknownPrices: 0 }, { usd: "18.72", seenAt: iso(15 * DAY) }),
    );
    const credit = document.querySelector("[data-account-credit]");
    expect(credit).toHaveAttribute("data-account-credit-stale");
    expect(credit).toHaveTextContent("$18.72");
    expect(credit).toHaveTextContent("seen 15d ago");
    expect(credit).toHaveTextContent("Stale");
  });

  it("says plainly when no credit has been seen yet, rather than leaving it out", () => {
    // An absent row would read as an account with no credit on it.
    renderCard(spendStatus({ spentUsd: 1, unknownPrices: 0 }));
    const credit = document.querySelector('[data-account-credit="none"]');
    expect(credit).toHaveTextContent("Account credit");
    expect(credit).toHaveTextContent("not read yet");
  });

  it("drops a sighting the card could only show undated", () => {
    renderCard(spendStatus({ spentUsd: 1, unknownPrices: 0 }, { usd: "18.72", seenAt: "this morning" }));
    expect(document.querySelector('[data-account-credit="none"]')).not.toBeNull();
    expect(document.querySelector("[data-provider-meter]")).not.toHaveTextContent("18.72");
  });


  it("says the month is spent rather than a negative budget", () => {
    renderCard(spendStatus({ spentUsd: 26.4, unknownPrices: 0 }));
    expect(document.querySelector('[data-meter-line="portfolio"]')).toHaveAttribute(
      "data-meter-left",
      "0",
    );
  });

  it("draws nothing without a cap, or without a reading", () => {
    // A cap of zero is a deployment that never set one.
    renderCard(spendStatus({ capUsd: 0 }));
    expect(document.querySelector("[data-provider-meter]")).toBeNull();
    renderCard(spendStatus(null));
    expect(document.querySelector("[data-provider-meter]")).toBeNull();
  });
});

describe("a per-asset credential says which assets it actually covers", () => {
  const clarityStatus = () =>
    status(
      "clarity",
      [field({ name: "CLARITY_TOKENS", kind: "asset-map" })],
      {
        source: "store",
        fields: ["CLARITY_TOKENS"],
        assetsHeld: ["meals.example", "stray.example"],
        lastOkAt: iso(6 * HOUR),
        lastUsedAt: iso(6 * HOUR),
      },
      [
        { id: "meals.example", lanes: ["clarity"] },
        { id: "nosh.example", lanes: ["clarity"] },
      ],
      { scope: "per-asset" },
    );

  it("marks each asset held or waiting, in ONE list rather than two", () => {
    // Partial coverage is the normal state: Clarity issues a token per project.
    renderCard(clarityStatus(), {
      assets: [
        { id: "meals.example", displayName: "meals.example", domain: "meals.example" },
        { id: "nosh.example", displayName: "nosh.example", domain: "nosh.example" },
      ],
    });
    const list = document.querySelector("[data-served-assets]");
    expect(list).toHaveTextContent("2 of 3 sites have a key");
    expect(document.querySelector('[data-served-asset="meals.example"]')).toHaveAttribute(
      "data-asset-key",
      "set",
    );
    expect(document.querySelector('[data-served-asset="nosh.example"]')).toHaveAttribute(
      "data-asset-key",
      "missing",
    );
    // A key stored for an asset nothing maps is named, never hidden: it is a
    // typo or an undeclared data source.
    expect(document.querySelector('[data-served-asset="stray.example"]')).toHaveAttribute(
      "data-asset-key",
      "set",
    );
  });

  it("never marks a shared credential per-asset", () => {
    renderCard(
      status(
        "dataforseo",
        DATAFORSEO_FIELDS,
        { source: "store", fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] },
        [{ id: "meals.example", lanes: ["dataforseo"] }],
      ),
    );
    expect(document.querySelector("[data-served-assets]")).toHaveTextContent("Used by");
    expect(document.querySelector('[data-served-asset="meals.example"]')).not.toHaveAttribute(
      "data-asset-key",
    );
  });

  it("names its Test button for the check it runs, because there is no free Clarity call", () => {
    renderCard({
      provider: INTEGRATION_PROVIDERS.find((p) => p.id === "clarity")!,
      credential: credential("clarity", {
        source: "store",
        fields: ["CLARITY_TOKENS"],
        assetsHeld: ["meals.example"],
      }),
      assets: [{ id: "meals.example", lanes: ["clarity"] }],
    });
    const button = document.querySelector('[data-test-connection][data-test-cost="none"]');
    expect(button).toHaveTextContent("Check keys");
  });
});

describe("the form is generated from the shipped schema", () => {
  it("draws an input for every field an operator can type, and none for the rest", () => {
    // `shared/integrations-page.ts` re-exports the contract rather than
    // mirroring it, so this walks the real catalog: adding a field with no
    // input fails here. A `managed` field is the exception, asserted as one:
    // it is written by a flow, so a text box for it would invite a paste that
    // cannot work.
    expect(INTEGRATION_PROVIDERS.length).toBeGreaterThan(0);
    let managedSeen = 0;

    for (const shipped of INTEGRATION_PROVIDERS) {
      const typed = shipped.fields.filter((f) => f.managed !== true);
      const { unmount } = renderCard({
        provider: shipped,
        credential: credential(shipped.id),
        assets: [],
      });
      fireEvent.click(document.querySelector("[data-connect-toggle]") as HTMLElement);
      const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-provider-link]")].map((a) => a.href);
      for (const f of typed) {
        if (f.link) expect(links, `${shipped.id} should link ${f.name} to where it is issued`).toContain(f.link.url);
      }
      for (const f of shipped.fields) {
        // An `asset-map` field is a group of inputs, one per asset, so it is
        // found by its group.
        const input = document.querySelector(
          `[data-field="${f.name}"], [data-asset-map="${f.name}"]`,
        );
        if (f.managed === true) {
          managedSeen += 1;
          expect(input, `${shipped.id} must not ask anyone to type ${f.name}`).toBeNull();
          continue;
        }
        expect(input, `${shipped.id} is missing an input for ${f.name}`).toBeInTheDocument();
        if (f.secret && f.kind === "password") {
          expect(input).toHaveAttribute("type", "password");
        }
        expect(input).toHaveAttribute("data-field-kind", f.kind);
      }
      unmount();
    }
    expect(managedSeen).toBeGreaterThan(0);
  });
});

describe("the connect form is generated from the field schema", () => {
  /** The form: Connect… for a first connection, the connection's own Replace
   * for a stored one. */
  function openForm(s: IntegrationProviderStatus) {
    renderCard(s);
    fireEvent.click((document.querySelector("[data-connect-toggle]") ?? document.querySelector("[data-connection-replace]")) as HTMLElement);
  }

  it("marks required controls accessibly while leaving nonrequired labels plain", async () => {
    api.save.mockResolvedValue(undefined);
    openForm(status("dataforseo", [
      ...DATAFORSEO_FIELDS,
      field({ name: "ACCOUNT_NOTE", label: "Account note", required: false, kind: "text" }),
    ], {}));
    const login = screen.getByLabelText(/^Login/);
    const password = screen.getByLabelText(/^Password/);
    const note = screen.getByLabelText("Account note");
    expect(login).toBeRequired();
    expect(password).toBeRequired();
    expect(login).toHaveAccessibleName("Login");
    expect(password).toHaveAccessibleName("Password");
    expect(note).not.toBeRequired();
    expect(screen.getByText("Login").textContent).toBe("Login*");
    expect(screen.getByText("Account note").textContent).toBe("Account note");
    expect(screen.queryByText(/\(optional\)/)).toBeNull();
    fireEvent.change(login, { target: { value: "ops@example.com" } });
    fireEvent.change(password, { target: { value: "synthetic-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("dataforseo", {
      DATAFORSEO_LOGIN: "ops@example.com",
      DATAFORSEO_PASSWORD: "synthetic-key",
    }));
  });

  it("marks a required JSON value without requiring its alternative file upload", () => {
    openForm(status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", label: "Account JSON", kind: "json" })], {}));
    expect(screen.getByLabelText(/^Account JSON/)).toBeRequired();
    expect(screen.getByLabelText("or upload the file")).not.toBeRequired();
  });

  it("describes a required key map without making every site's key mandatory", async () => {
    api.save.mockResolvedValue(undefined);
    openForm(status("clarity", [field({ name: "CLARITY_TOKENS", label: "Project tokens", kind: "asset-map" })], {}, [
      { id: "meals.example", lanes: ["clarity"] },
      { id: "nosh.example", lanes: ["clarity"] },
    ], { scope: "per-asset" }));
    const group = screen.getByRole("group", { name: "Project tokens" });
    expect(group).toHaveAccessibleDescription("At least one key is required.");
    const first = screen.getByLabelText("Project tokens — meals.example");
    const second = screen.getByLabelText("Project tokens — nosh.example");
    expect(first).not.toBeRequired();
    expect(second).not.toBeRequired();
    expect(first).toHaveAccessibleDescription("At least one key is required.");
    fireEvent.change(first, { target: { value: "synthetic-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("clarity", {
      CLARITY_TOKENS: '{"meals.example":"synthetic-key"}',
    }));
  });

  it("leaves a nonrequired key map plain and permits an empty map", async () => {
    api.save.mockResolvedValue(undefined);
    openForm(status("clarity", [field({ name: "CLARITY_TOKENS", label: "Project tokens", kind: "asset-map", required: false })], {}, [
      { id: "meals.example", lanes: ["clarity"] },
    ], { scope: "per-asset" }));
    const group = screen.getByRole("group", { name: "Project tokens" });
    expect(group).not.toHaveAccessibleDescription();
    expect(screen.getByText("Project tokens").textContent).toBe("Project tokens");
    expect(screen.getByLabelText("Project tokens — meals.example")).not.toBeRequired();
    expect(screen.queryByText(/\(optional\)/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("clarity", {}));
  });

  it("opens scope help without opening a form, testing, saving or disconnecting", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }));
    expect(screen.getByText("Shared account")).toBeVisible();
    expect(screen.queryByText("One account covers every site.")).toBeNull();
    const help = screen.getByRole("button", { name: "About dataforseo account scope" });
    expect(help.parentElement?.closest("button, a, label")).toBeNull();
    fireEvent.click(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent("One account covers every site.");
    expect(document.querySelector("[data-connect-form]")).toBeNull();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.test).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("masks a password field and leaves a plain text field readable", () => {
    openForm(status("dataforseo", DATAFORSEO_FIELDS, {}));
    expect(document.querySelector('[data-field="DATAFORSEO_LOGIN"]')).toHaveAttribute(
      "type",
      "text",
    );
    expect(document.querySelector('[data-field="DATAFORSEO_PASSWORD"]')).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("gives a json field a textarea and refuses a paste that does not parse", () => {
    openForm(status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {}));
    const input = document.querySelector('[data-field="GOOGLE_SIGNAL_ACCOUNTS"]') as HTMLElement;
    expect(input.tagName).toBe("TEXTAREA");

    fireEvent.change(input, { target: { value: '{"a": 1' } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(
      document.querySelector('[data-field-error="GOOGLE_SIGNAL_ACCOUNTS"]'),
    ).toHaveTextContent("not valid JSON");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("takes a json field from an uploaded file", async () => {
    api.save.mockResolvedValue(undefined);
    openForm(status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {}));
    const upload = document.querySelector(
      '[data-field-upload="GOOGLE_SIGNAL_ACCOUNTS"]',
    ) as HTMLInputElement;
    const file = new File(['{"acct":{"properties":["meals.example"]}}'], "key.json", {
      type: "application/json",
    });
    fireEvent.change(upload, { target: { files: [file] } });

    await waitFor(() =>
      expect(document.querySelector('[data-field="GOOGLE_SIGNAL_ACCOUNTS"]')).toHaveValue(
        '{"acct":{"properties":["meals.example"]}}',
      ),
    );
  });

  it("turns a url-list into the object the store holds, one feed per line", () => {
    expect(
      parseUrlList("work = https://calendar.example/a.ics\nhttps://calendar.example/b.ics"),
    ).toEqual({
      ok: true,
      value: '{"work":"https://calendar.example/a.ics","feed-2":"https://calendar.example/b.ics"}',
    });
    expect(parseUrlList("work = not-a-url")).toEqual({
      ok: false,
      error: "Line 1 is not a feed URL — it must start with https:// or webcal://.",
    });
  });

  it("sends a url-list field as its JSON object", async () => {
    api.save.mockResolvedValue(undefined);
    openForm(status("calendar", [field({ name: "CALENDAR_FEEDS", kind: "url-list" })], {}));
    fireEvent.change(document.querySelector('[data-field="CALENDAR_FEEDS"]') as HTMLElement, {
      target: { value: "work = https://calendar.example/a.ics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith("calendar", {
        CALENDAR_FEEDS: '{"work":"https://calendar.example/a.ics"}',
      }),
    );
  });

  it("refuses a url field that is not an address, and names what one looks like", async () => {
    // The commonest Discord mistake is copying the webhook's ID rather than
    // the address behind Copy Webhook URL, so the refusal has to land before
    // the value leaves the browser.
    api.save.mockResolvedValue(undefined);
    openForm(status("discord", [field({ name: "DISCORD_WEBHOOK_URL", kind: "url" })], {}));
    const input = document.querySelector('[data-field="DISCORD_WEBHOOK_URL"]') as HTMLElement;
    expect(input.tagName).toBe("INPUT");

    fireEvent.change(input, { target: { value: "1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(
      document.querySelector('[data-field-error="DISCORD_WEBHOOK_URL"]'),
    ).toHaveTextContent("starting with https://");
    expect(api.save).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: "https://discord.com/api/webhooks/1/token " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith("discord", {
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token",
      }),
    );
  });

  it("draws one input per asset for a per-asset credential, and sends the whole map", async () => {
    // Clarity issues a token per project, so the form asks per asset. The
    // asset ids are printed, never typed.
    api.save.mockResolvedValue(undefined);
    openForm(
      status(
        "clarity",
        [field({ name: "CLARITY_TOKENS", kind: "asset-map" })],
        { source: "store", fields: ["CLARITY_TOKENS"], assetsHeld: ["meals.example"] },
        [
          { id: "meals.example", lanes: ["clarity"] },
          { id: "nosh.example", lanes: ["clarity"] },
        ],
        { scope: "per-asset" },
      ),
    );
    const mine = document.querySelector(
      '[data-asset-key-input="meals.example"]',
    ) as HTMLInputElement;
    expect(mine).toHaveValue("");
    expect(document.querySelector('[data-asset-key-input="nosh.example"]')).toBeInTheDocument();
    // A save replaces the map rather than merging.
    expect(document.querySelector('[data-asset-map-replaces]')).toHaveTextContent(
      "Blank keys are removed on save",
    );

    fireEvent.change(mine, { target: { value: " mp-token " } });
    fireEvent.change(document.querySelector('[data-asset-key-input="nosh.example"]') as HTMLElement, {
      target: { value: "nom-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith("clarity", {
        CLARITY_TOKENS: '{"meals.example":"mp-token","nosh.example":"nom-token"}',
      }),
    );
  });

  it("refuses a per-asset map with no key in it at all", () => {
    openForm(
      status(
        "clarity",
        [field({ name: "CLARITY_TOKENS", kind: "asset-map" })],
        {},
        [{ id: "meals.example", lanes: ["clarity"] }],
        { scope: "per-asset" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(document.querySelector('[data-field-error="CLARITY_TOKENS"]')).toHaveTextContent(
      "required",
    );
    expect(api.save).not.toHaveBeenCalled();
  });

  it("refuses to submit a required field left blank", () => {
    openForm(status("dataforseo", DATAFORSEO_FIELDS, {}));
    fireEvent.change(document.querySelector('[data-field="DATAFORSEO_LOGIN"]') as HTMLElement, {
      target: { value: "ops@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(
      document.querySelector('[data-field-error="DATAFORSEO_PASSWORD"]'),
    ).toHaveTextContent("required");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("puts a 422's reason under the field the server named", async () => {
    const refusal = Object.assign(new Error("Login must be an email address."), {
      status: 422,
      code: "invalid_credential",
      field: "DATAFORSEO_LOGIN",
    });
    api.save.mockRejectedValue(refusal);
    openForm(status("dataforseo", DATAFORSEO_FIELDS, {}));
    fireEvent.change(document.querySelector('[data-field="DATAFORSEO_LOGIN"]') as HTMLElement, {
      target: { value: "ops" },
    });
    fireEvent.change(document.querySelector('[data-field="DATAFORSEO_PASSWORD"]') as HTMLElement, {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() =>
      expect(
        document.querySelector('[data-field-error="DATAFORSEO_LOGIN"]'),
      ).toHaveTextContent("Login must be an email address."),
    );
  });

  it("opens EMPTY on reconnect and never echoes a stored value", () => {
    openForm(
      status("dataforseo", DATAFORSEO_FIELDS, {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      }),
    );
    expect(document.querySelector('[data-field="DATAFORSEO_LOGIN"]')).toHaveValue("");
    expect(document.querySelector('[data-field="DATAFORSEO_PASSWORD"]')).toHaveValue("");
  });
});

describe("testing a connection", () => {
  const connected = () =>
    status("dataforseo", DATAFORSEO_FIELDS, {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      lastOkAt: iso(4 * HOUR),
      lastUsedAt: iso(4 * HOUR),
    });

  it("shows a spinner, then the probe's own sentence and time", async () => {
    let settle: (probe: CredentialProbe) => void = () => {};
    api.test.mockReturnValue(
      new Promise<CredentialProbe>((resolve) => {
        settle = resolve;
      }),
    );
    renderCard(connected());
    fireEvent.click(document.querySelector("[data-test-connection]") as HTMLElement);

    expect(screen.getByText("Testing…")).toBeInTheDocument();

    settle({
      ok: true,
      message: "Answered · $18.72 credit",
      result: { outcome: "answered", facts: { creditUsd: "18.72" } },
      checkedAt: new Date(NOW - 5000).toISOString(),
    });

    await waitFor(() => {
      const verdict = document.querySelector('[data-verdict="probe-result"]');
      expect(verdict).toHaveAttribute("data-verdict-ok", "true");
      expect(verdict!.querySelector("[data-probe-outcome]")).toHaveAttribute("data-probe-outcome", "answered");
      expect(verdict).toHaveTextContent("Answered");
      expect(verdict!.querySelector('[data-probe-fact="credit"]')).toHaveTextContent("$18.72 credit");
      expect(verdict).toHaveTextContent("5s ago");
    });
  });

  it("renders a failed probe as an answer, not as an error", async () => {
    // ok:false is a 200 by contract: a wrong password is something the
    // provider told us.
    api.test.mockResolvedValue({
      ok: false,
      message: "Refused",
      result: { outcome: "refused", fix: { kind: "replace" } },
      checkedAt: new Date(NOW).toISOString(),
    });
    const onReplace = vi.fn();
    renderCard(connected(), { onReplace });
    fireEvent.click(document.querySelector("[data-test-connection]") as HTMLElement);

    await waitFor(() => {
      const verdict = document.querySelector('[data-verdict="probe-result"]');
      expect(verdict).toHaveAttribute("data-verdict-ok", "false");
      expect(verdict).toHaveTextContent("Refused");
    });
    fireEvent.click(document.querySelector('[data-probe-fix="replace"]') as HTMLElement);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("keeps Test connection for a free probe, and names the message for one that reaches the channel", () => {
    // The press that surprises is named on the button itself, before the press.
    const { unmount } = renderCard(
      status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }),
    );
    expect(document.querySelector('[data-test-connection][data-test-cost="free"]')).toHaveTextContent("Test connection");
    unmount();

    renderCard({
      provider: INTEGRATION_PROVIDERS.find((p) => p.id === "discord")!,
      credential: credential("discord", {
        source: "store",
        fields: ["DISCORD_WEBHOOK_URL"],
      }),
      assets: [],
    });
    const button = document.querySelector('[data-test-connection][data-test-cost="side-effect"]');
    expect(button).toHaveTextContent("Send test message");
  });
});

describe("disconnecting", () => {
  const connected = () =>
    status(
      "dataforseo",
      DATAFORSEO_FIELDS,
      { source: "store", fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] },
      [{ id: "meals.example", lanes: ["dataforseo"] }],
    );

  it("sits on the connection, on every step, and names what stops before anything is removed", () => {
    renderCard(connected(), { guided: true });
    expect(screen.getByRole("button", { name: "Verify" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    const confirm = screen.getByRole("group", { name: "Disconnect dataforseo" });
    expect(within(confirm).getByRole("list", { name: "Sites that stop" })).toHaveTextContent("meals.example");
    expect(document.querySelector("[data-disconnect-effects]")).toHaveTextContent("Login deleted · no undo");
    expect(confirm.querySelector("input")).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Disconnect dataforseo" })).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("runs on the one confirming press", async () => {
    api.remove.mockResolvedValue(undefined);
    renderCard(connected());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect dataforseo" }));

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("dataforseo"));
  });

  it("says so when the removal did not go through, and keeps the question open", async () => {
    api.remove.mockRejectedValue(new Error("nope"));
    renderCard(connected());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect dataforseo" }));
    expect(await screen.findByText("Not disconnected · try again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect dataforseo" })).toBeEnabled();
  });
});

describe("connecting in the panel", () => {
  const KEY_FIELD = field({ name: "BING_WEBMASTER_API_KEY", label: "API key", link: { url: "https://example.test/key", label: "Get a key" } });
  const CONNECT = { connect: { kind: "key" as const, credential: "api-key" as const } };
  const bing = (cred: Partial<CredentialSummary> = {}) => status("bing-webmaster", [KEY_FIELD], cred, [], CONNECT);
  const address = () => document.querySelector("[data-address]")?.textContent;

  it("connects from the row in one panel: paste, Connect, the provider's answer, Done", async () => {
    let answer!: (verdict: ConnectVerdict) => void;
    api.connect.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    renderPage(page([bing(), status("mediavine", [], {})]));

    const row = document.querySelector<HTMLElement>('[data-integration-tile="bing-webmaster"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Connect bing-webmaster" }));
    const dialog = screen.getByRole("dialog", { name: "bing-webmaster" });
    expect(address()).toBe("/integrations");
    expect(document.querySelector("[data-provider-card]")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "SEKRIT-row-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(api.connect).toHaveBeenCalledWith("bing-webmaster", { BING_WEBMASTER_API_KEY: "SEKRIT-row-key" });
    expect(api.save).not.toHaveBeenCalled();
    expect(api.test).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Checking" })).toBeDisabled();
    expect(row).toHaveAttribute("data-integration-status", "not-connected");

    await waitFor(() => expect(answer).toBeTypeOf("function"));
    answer({ verdict: "accepted", checkedAt: new Date(NOW).toISOString(), facts: { sites: 1 } });
    expect(await within(dialog).findByText("Key accepted")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the panel from a link — ?connect= and an older ?provider= alike — and cleans the address", () => {
    renderPage(page([bing()]), "/integrations?connect=bing-webmaster");
    expect(screen.getByRole("dialog", { name: "bing-webmaster" })).toBeInTheDocument();
    expect(address()).toBe("/integrations");
  });

  it("sends an old provider link for an unconnected panel provider to the panel, not the old page", () => {
    renderPage(page([bing()]), "/integrations?provider=bing-webmaster");
    expect(screen.getByRole("dialog", { name: "bing-webmaster" })).toBeInTheDocument();
    expect(document.querySelector("[data-provider-card]")).toBeNull();
  });

  it("offers Reconnect in the panel for a failing key, and Manage once it works", () => {
    renderPage(page([bing({ source: "store", fields: ["BING_WEBMASTER_API_KEY"], lastError: "refused", lastUsedAt: iso(HOUR) })]));
    const row = document.querySelector<HTMLElement>('[data-integration-tile="bing-webmaster"]')!;
    expect(row).toHaveAttribute("data-integration-status", "failing");
    fireEvent.click(within(row).getByRole("button", { name: "Reconnect bing-webmaster" }));
    expect(screen.getByRole("dialog", { name: "bing-webmaster" })).toBeInTheDocument();
  });

  const working = () => bing({ source: "store", fields: ["BING_WEBMASTER_API_KEY"], lastOkAt: iso(HOUR), lastUsedAt: iso(HOUR) });
  function manage() {
    renderPage(page([working()]));
    const row = document.querySelector<HTMLElement>('[data-integration-tile="bing-webmaster"]')!;
    expect(row).toHaveAttribute("data-integration-status", "key-accepted");
    fireEvent.click(within(row).getByRole("button", { name: "Manage bing-webmaster" }));
    return screen.getByRole("dialog", { name: "bing-webmaster" });
  }

  it("opens a connected panel provider's Manage in the panel, with its status, Replace and Disconnect", () => {
    const dialog = manage();
    expect(address()).toBe("/integrations");
    expect(document.querySelector("[data-provider-card]")).toBeNull();
    expect(dialog.querySelector('[data-status-for="integration:bing-webmaster"][data-connection]')).toHaveAttribute("data-connection", "key-accepted");
    expect(within(dialog).getByRole("button", { name: "Replace API key" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("replaces the key in the panel: shown to the provider first, and done on its answer", async () => {
    api.connect.mockResolvedValue({ verdict: "accepted", checkedAt: new Date(NOW).toISOString(), facts: { sites: 2 } });
    const dialog = manage();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace API key" }));
    const key = within(dialog).getByLabelText("API key");
    expect(key).toHaveValue("");
    expect(key).toHaveFocus();
    fireEvent.change(key, { target: { value: "SEKRIT-new-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(api.connect).toHaveBeenCalledWith("bing-webmaster", { BING_WEBMASTER_API_KEY: "SEKRIT-new-key" });
    expect(api.save).not.toHaveBeenCalled();
    await waitFor(() => expect(dialog.querySelector('[data-connect-state="accepted"]')).toHaveTextContent("Key accepted"));
    expect(dialog.querySelector('[data-connect-fact="sites"]')).toHaveTextContent("2");
    expect(dialog.querySelector("[data-site-picker]")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Disconnect" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the old key when the provider refuses the new one", async () => {
    api.connect.mockResolvedValue({ verdict: "refused", checkedAt: new Date(NOW).toISOString() });
    const dialog = manage();
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace API key" }));
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "SEKRIT-typo" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByText("bing-webmaster refused this key")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("API key")).toHaveValue("");
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("disconnects in the panel after one confirmation, then closes it", async () => {
    api.remove.mockResolvedValue(undefined);
    const dialog = manage();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    const confirm = within(dialog).getByRole("group", { name: "Disconnect bing-webmaster" });
    expect(confirm).toHaveTextContent("API key deleted · no undo");
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect bing-webmaster" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("bing-webmaster"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("connects Clarity in the panel: a token pasted on a site's row is saved at once, with no key form", async () => {
    api.siteToken.mockResolvedValue(undefined);
    const tokens = field({ name: "CLARITY_TOKENS", kind: "asset-map", label: "Project tokens" });
    renderPage(page([status("clarity", [tokens], {}, [{ id: "journey.example", lanes: ["clarity"] }], { scope: "per-asset", connect: { kind: "site-tokens", credential: "api-key" } })]));
    const row = document.querySelector<HTMLElement>('[data-integration-tile="clarity"]')!;
    fireEvent.click(within(row).getByRole("button", { name: "Connect clarity" }));
    const dialog = screen.getByRole("dialog", { name: "clarity" });
    expect(dialog.querySelector('[data-site-token-row="journey.example"]')).not.toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Connect" })).toBeNull();
    await act(async () => {
      fireEvent.change(dialog.querySelector('[data-site-token-input="journey.example"]')!, { target: { value: "SEKRIT-clarity-token-0123456789" } });
    });
    expect(api.siteToken).toHaveBeenCalledWith("clarity", "journey.example", "SEKRIT-clarity-token-0123456789");
    expect(api.save).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("replaces a panel provider's key from its own page in the panel, tested", () => {
    renderPage(page([working()]), "/integrations?provider=bing-webmaster");
    expect(document.querySelector('[data-provider-card="bing-webmaster"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    const dialog = screen.getByRole("dialog", { name: "bing-webmaster" });
    expect(within(dialog).getByLabelText("API key")).toHaveValue("");
    expect(document.querySelector("[data-connect-form]")).toBeNull();
  });

  it("will not send anything while the install cannot store a credential", () => {
    renderPage(page([bing()], { keyPresent: false, keyReason: "Set CREDENTIALS_KEY.", blockers: ["key-missing"] }));
    fireEvent.click(screen.getByRole("button", { name: "Connect bing-webmaster" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "SEKRIT-row-key" } });
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(document.querySelector('[data-blocker="key-missing"]')).not.toBeNull();
    // The page's banner says why; the panel over it never says it again.
    expect(document.querySelectorAll("[data-connect-blocked]")).toHaveLength(1);
    expect(dialog.querySelector("[data-connect-blocked]")).toBeNull();
  });
});

describe("the page", () => {
  const stored = () =>
    status("dataforseo", DATAFORSEO_FIELDS, {
      source: "store",
      fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
      lastOkAt: iso(HOUR),
      lastUsedAt: iso(HOUR),
    });

  it("first run: every provider is one row saying Not connected", () => {
    renderPage(
      page([
        status("dataforseo", DATAFORSEO_FIELDS, {}),
        status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY" })], {}),
      ]),
    );

    expect(document.querySelectorAll("[data-integration-tile]")).toHaveLength(2);
    expect(screen.getAllByText(/Not connected/)).toHaveLength(2);
    expect(document.querySelector("[data-integrations-answer]")).toHaveTextContent("Nothing connected yet");
    expect(document.querySelectorAll("[data-provider-card]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-connect-form]")).toHaveLength(0);

    const row = openRow("dataforseo");
    expect(row.querySelectorAll("[data-provider-card]")).toHaveLength(1);
    expect(row.querySelectorAll("[data-connect-toggle]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-provider-card]")).toHaveLength(1);
  });

  /** The audit measures the first screen against a block the page names; here
   * that is the list of providers, grouped by what each is for. */
  it("declares the grouped list as its hero", () => {
    renderPage(
      page([
        status("dataforseo", DATAFORSEO_FIELDS, { source: "store" }),
        status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY" })], {}),
        status("mediavine", [], {}),
      ]),
    );

    const hero = document.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.getAttribute("aria-label")).toBe("Providers");
    const traffic = screen.getByRole("list", { name: "Traffic & search" });
    expect(within(traffic).getAllByRole("listitem").map((row) => row.getAttribute("data-integration-tile")))
      .toEqual(["dataforseo", "bing-webmaster"]);
    expect(within(screen.getByRole("list", { name: "Revenue" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("gives each row a name, one status and one action — no explanation", () => {
    renderPage(page([
      status("dataforseo", DATAFORSEO_FIELDS, { source: "store", fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"], lastOkAt: iso(HOUR), lastUsedAt: iso(HOUR) }),
      status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY" })], {}),
    ]));

    const accepted = document.querySelector<HTMLElement>('[data-integration-tile="dataforseo"]')!;
    expect(accepted).toHaveAttribute("data-integration-status", "key-accepted");
    expect(accepted.textContent).toBe("dataforseoKey acceptedManage");
    const fresh = document.querySelector<HTMLElement>('[data-integration-tile="bing-webmaster"]')!;
    expect(fresh.textContent).toBe("bing-webmasterNot connectedConnect");
    expect(screen.queryByRole("button", { name: /About integration states/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Connection saved|No recorded use|Ready to connect/);
  });

  it("asks once whether this deployment can import, and offers the button on every legacy card", async () => {
    // The question is asked at page level, not per card: it is a fact about
    // the deployment.
    api.importable.mockResolvedValue({ importable: true, reason: null });
    api.importEnv.mockResolvedValue({
      imported: [{ provider: "google", fields: ["GOOGLE_SIGNAL_ACCOUNTS"] }],
      skipped: [],
      failed: [],
    });
    renderPage(
      page([
        status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
          source: "env",
          lastOkAt: iso(HOUR),
        }),
        status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY" })], {
          source: "env",
          lastOkAt: iso(HOUR),
        }),
      ]),
    );

    openRow("google");
    expect(await screen.findByRole("button", { name: /Import from this machine/ })).toBeInTheDocument();
    openRow("bing-webmaster");

    const buttons = await screen.findAllByRole("button", {
      name: /Import from this machine/,
    });
    expect(buttons).toHaveLength(1);
    expect(api.importable).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(api.importEnv).toHaveBeenCalledTimes(1));
  });

  it("shows the missing encryption key once and keeps Disconnect available", () => {
    renderPage(
      page([stored()], {
        keyPresent: false,
        keyReason: "Set CREDENTIALS_KEY to 32 random bytes (openssl rand -base64 32).",
        blockers: ["key-missing"],
      }),
    );
    expect(document.querySelectorAll("[data-connect-blocked]")).toHaveLength(1);
    expect(document.querySelector('[data-blocker="key-missing"] [data-blocker-binding]')).toHaveTextContent("CREDENTIALS_KEY");
    expect(document.querySelector('[data-blocker-command="key-missing"]')).toHaveTextContent("openssl rand -base64 32");

    openRow("dataforseo");
    expect(document.querySelector("[data-connection-replace]")).toBeDisabled();
    expect(document.querySelector("[data-disconnect-open]")).not.toBeDisabled();
  });

  it("says why Connect is off once on a provider's page: the banner, never again on the card", () => {
    renderPage(
      page([status("dataforseo", DATAFORSEO_FIELDS, {})], {
        keyPresent: false,
        keyReason: "Set CREDENTIALS_KEY to 32 random bytes (openssl rand -base64 32).",
        blockers: ["key-missing"],
      }),
      "/integrations?provider=dataforseo&setup=page",
    );
    const detail = document.querySelector<HTMLElement>("[data-integration-detail]");
    expect(detail).not.toBeNull();
    const lead = CREDENTIAL_BLOCKER_LEADS["key-missing"];
    expect(document.body.textContent!.split(lead)).toHaveLength(2);
    expect(detail).not.toHaveTextContent(lead);
    expect(document.querySelectorAll('[data-status-for="setup:key-missing"]')).toHaveLength(1);
    expect(within(detail!).getByRole("button", { name: "Connect…" })).toBeDisabled();
  });

  it("keeps every provider listed while the bootstrap is incomplete", () => {
    // A provider still reading its credential from the environment file is working.
    renderPage(
      page([status("google", [field({ name: "GOOGLE_SIGNAL_ACCOUNTS", kind: "json" })], {
        source: "env",
        lastOkAt: iso(HOUR),
        lastUsedAt: iso(HOUR),
      })], { keyPresent: false, keyReason: "Set CREDENTIALS_KEY.", blockers: ["key-missing"] }),
    );
    expect(document.querySelector('[data-integration-tile="google"]')).toHaveAttribute("data-integration-status", "key-accepted");
    expect(
      openRow("google").querySelectorAll(
        "[data-provider-card]",
      ),
    ).toHaveLength(1);
  });

  it("carries no read-only deployment sentence anywhere — this surface always writes", () => {
    renderPage(page([stored()]));
    openRow("dataforseo");
    // Credentials are store writes, so there is no 501 path and no deployment
    // that renders this read-only.
    expect(document.body.textContent).not.toMatch(/deployment cannot save/i);
    expect(document.querySelector("[data-knob-read-only]")).toBeNull();
    expect(document.querySelector("[data-connection-replace]")).not.toBeDisabled();
    expect(document.querySelector("[data-connect-blocked]")).toBeNull();
  });
});

/** The Google card's second half, in the four states an operator meets it in. */
describe("the Google card offers a sign-in", () => {
  const ORIGIN = "http://127.0.0.1:5173";
  const LAN = "http://192.168.1.20:5173";
  const GOOGLE = INTEGRATION_PROVIDERS.find((p) => p.id === "google")!;
  const APP = INTEGRATION_PROVIDERS.find((p) => p.id === "google-oauth-app")!;

  const discovery: GooglePropertyDiscovery = {
    ok: true,
    message: "2 GA4 properties and 1 Search Console site.",
    checkedAt: new Date(NOW).toISOString(),
    account: "ops@example.test",
    auth: "oauth",
    properties: [
      { lane: "ga4", ref: "412330001", label: "Meal Planner", detail: "Example Ventures" },
      { lane: "gsc", ref: "sc-domain:nosh.example", label: "sc-domain:nosh.example", detail: "siteOwner" },
    ],
  };

  function googleStatus(over: Partial<CredentialSummary> = {}): IntegrationProviderStatus {
    return { provider: GOOGLE, credential: credential("google", over), assets: [] };
  }

  function appStatus(entered: boolean): IntegrationProviderStatus {
    return {
      provider: APP,
      credential: credential(
        "google-oauth-app",
        entered
          ? {
              source: "store",
              fields: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
            }
          : {},
      ),
      assets: [],
    };
  }

  function renderGoogle(
    google: IntegrationProviderStatus,
    app: IntegrationProviderStatus,
    origin = ORIGIN,
    onDiscover: () => Promise<GooglePropertyDiscovery> = async () => discovery,
    onStart?: () => void,
    readOnly = false,
  ) {
    return renderCard(google, {
      readOnly,
      oauth: {
        card: googleOAuthCardState(google, app, origin),
        app,
        startHref: GOOGLE_OAUTH_START_PATH,
        onStart,
        onSaveApp: async (fields) => {
          await api.save(app.provider.id, fields);
        },
        onDiscover,
      },
    });
  }

  it("asks for the console setup first, and offers no button it cannot honour", () => {
    renderGoogle(googleStatus(), appStatus(false));
    const panel = document.querySelector("[data-google-oauth]")!;
    expect(panel).toHaveAttribute("data-google-oauth", "app-missing");
    expect(document.querySelector("[data-oauth-console-steps]")).toBeInTheDocument();
    expect(document.querySelector("[data-oauth-redirect-uri]")).toHaveTextContent(
      "http://127.0.0.1:5173/api/integrations/google/oauth/callback",
    );
    expect(document.querySelector("[data-oauth-start]")).toBeNull();
  });

  it("saves the OAuth client from the contract's own field schema", async () => {
    api.save.mockResolvedValue(undefined);
    renderGoogle(googleStatus(), appStatus(false));
    fireEvent.click(document.querySelector("[data-oauth-app-open]") as HTMLElement);

    const id = document.querySelector('[data-field="GOOGLE_OAUTH_CLIENT_ID"]')!;
    const secret = document.querySelector('[data-field="GOOGLE_OAUTH_CLIENT_SECRET"]')!;
    // The secret is masked; the client id is not, because Google publishes it
    // to every browser that starts a sign-in.
    expect(secret).toHaveAttribute("type", "password");
    expect(id).toHaveAttribute("type", "text");

    fireEvent.change(id, { target: { value: "123-abc.apps.googleusercontent.com" } });
    fireEvent.change(secret, { target: { value: "GOCSPX-xyz" } });
    fireEvent.submit(document.querySelector("[data-connect-form]") as HTMLElement);

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith("google-oauth-app", {
        GOOGLE_OAUTH_CLIENT_ID: "123-abc.apps.googleusercontent.com",
        GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-xyz",
      }),
    );
  });

  it("offers the button once the client is stored, and it is a plain link", () => {
    renderGoogle(googleStatus(), appStatus(true));
    expect(document.querySelector("[data-google-oauth]")).toHaveAttribute(
      "data-google-oauth",
      "ready",
    );
    // A link, not a fetch: the whole flow is a full-page trip to Google's
    // consent screen and back. `asChild` merges the hook onto the anchor itself.
    const start = document.querySelector("[data-oauth-start]")!;
    expect(start.tagName).toBe("A");
    expect(start).toHaveAttribute("href", GOOGLE_OAUTH_START_PATH);
    fireEvent.click(document.querySelector("[data-connect-toggle]") as HTMLElement);
    expect(
      document.querySelector('[data-field="GOOGLE_SIGNAL_ACCOUNTS"]'),
    ).toBeInTheDocument();
  });

  it('hosted ready, reconnect and empty-discovery controls all use the captured start callback', async () => {
    const onStart = vi.fn();
    const ready = renderGoogle(googleStatus(), appStatus(true), ORIGIN, async () => discovery, onStart);
    const start = document.querySelector('[data-oauth-start]')!;
    expect(start.tagName).toBe('BUTTON'); expect(start).not.toHaveAttribute('href'); fireEvent.click(start);
    expect(onStart).toHaveBeenCalledOnce(); ready.unmount();
    renderGoogle(googleStatus({ source: 'store', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'], auth: 'oauth',
      metadata: { account: 'ops@example.test', scopes: [], connectedAt: iso(HOUR), expiresAt: null, expirySource: null } }),
      appStatus(true), ORIGIN, async () => ({ ...discovery, properties: [] }), onStart);
    const restart = document.querySelector('[data-oauth-restart]')!;
    expect(restart.tagName).toBe('BUTTON'); expect(restart).not.toHaveAttribute('href'); fireEvent.click(restart);
    fireEvent.click(document.querySelector('[data-oauth-discover]')!);
    const another = await screen.findByRole('button', { name: 'Sign in as another account' });
    expect(another).not.toHaveAttribute('href'); fireEvent.click(another);
    expect(onStart).toHaveBeenCalledTimes(3);
  });

  it('a hosted Google test-refusal recovery press uses the same captured callback', async () => {
    const onStart = vi.fn();
    api.test.mockResolvedValue({ ok: false, message: 'Sign-in refused', result: { outcome: 'refused', fix: { kind: 'sign-in' } }, checkedAt: new Date(NOW).toISOString() });
    renderGoogle(googleStatus({ source: 'store', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'], auth: 'oauth',
      metadata: { account: 'ops@example.test', scopes: [], connectedAt: iso(HOUR), expiresAt: null, expirySource: null } }),
      appStatus(true), ORIGIN, async () => discovery, onStart);
    fireEvent.click(document.querySelector('[data-test-connection]')!);
    await waitFor(() => expect(document.querySelector('[data-probe-fix="sign-in"]')).toBeInTheDocument());
    const fix = document.querySelector('[data-probe-fix="sign-in"]')!;
    expect(fix.tagName).toBe('BUTTON'); expect(fix).not.toHaveAttribute('href'); fireEvent.click(fix);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('read-only Google cards expose no start or restart even when supplied an operational callback', () => {
    const onStart = vi.fn();
    renderGoogle(googleStatus({ source: 'store', fields: ['GOOGLE_OAUTH_REFRESH_TOKEN'], auth: 'oauth',
      metadata: { account: 'ops@example.test', scopes: [], connectedAt: iso(HOUR), expiresAt: null, expirySource: null } }),
      appStatus(true), ORIGIN, async () => discovery, onStart, true);
    expect(document.querySelector('[data-oauth-start], [data-oauth-restart], [data-probe-fix="sign-in"]')).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("offers the loopback address as one press when Google will not return to this one", () => {
    // `os:up` binds the LAN by default and Google refuses every plain-http
    // address that is not loopback.
    renderGoogle(googleStatus(), appStatus(true), LAN);
    expect(document.querySelector("[data-google-oauth]")).toHaveAttribute(
      "data-google-oauth",
      "redirect-unusable",
    );
    expect(document.querySelector("[data-oauth-redirect-blocked]")).toHaveTextContent("Google won't return to this address");
    expect(document.querySelector("[data-oauth-loopback]")).toHaveAttribute(
      "href",
      "http://127.0.0.1:5173/integrations?connect=google",
    );
    expect(document.querySelector("[data-oauth-start]")).toBeNull();
  });

  it("reports the connection: whose account, and what the grant covers in words", () => {
    renderGoogle(
      googleStatus({
        source: "store",
        fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        auth: "oauth",
        metadata: {
          account: "ops@example.test",
          scopes: [
            "openid",
            "email",
            "https://www.googleapis.com/auth/analytics.readonly",
            "https://www.googleapis.com/auth/webmasters.readonly",
          ],
          connectedAt: iso(6 * HOUR),
          expiresAt: null,
          expirySource: null,
        },
        lastOkAt: iso(HOUR),
      }),
      appStatus(true),
    );
    expect(document.querySelector("[data-google-oauth]")).toHaveAttribute(
      "data-google-oauth",
      "connected",
    );
    expect(document.querySelector("[data-oauth-account]")).toHaveTextContent(
      "Signed in as ops@example.test",
    );
    const scopes = document.querySelector("[data-oauth-scopes]")!;
    expect(scopes).toHaveTextContent("Analytics — read only");
    expect(scopes).toHaveTextContent("Search Console — read only");
    expect(scopes.textContent).not.toContain("googleapis.com");
    expect(document.querySelector("[data-oauth-console-steps]")).toBeNull();
  });

  it("lists what the connected account can see, on demand", async () => {
    renderGoogle(
      googleStatus({
        source: "store",
        fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        auth: "oauth",
        metadata: {
          account: "ops@example.test",
          scopes: [],
          connectedAt: iso(HOUR),
          expiresAt: null,
          expirySource: null,
        },
      }),
      appStatus(true),
    );
    expect(document.querySelector("[data-oauth-discovery]")).toBeNull();
    fireEvent.click(document.querySelector("[data-oauth-discover]") as HTMLElement);

    await waitFor(() =>
      expect(document.querySelector("[data-oauth-discovery]")).toBeInTheDocument(),
    );
    const list = document.querySelector("[data-oauth-discovery]")!;
    expect(list).toHaveTextContent("Meal Planner");
    expect(list).toHaveTextContent("412330001");
    expect(list).toHaveTextContent("sc-domain:nosh.example");
    expect(document.querySelectorAll("[data-discovered]")).toHaveLength(2);
  });

  it("names the account that cannot see anything as the likely mistake", async () => {
    renderGoogle(
      googleStatus({
        source: "store",
        fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        auth: "oauth",
        metadata: {
          account: "personal@example.test",
          scopes: [],
          connectedAt: iso(HOUR),
          expiresAt: null,
          expirySource: null,
        },
      }),
      appStatus(true),
      ORIGIN,
      async () => ({ ...discovery, message: "0 GA4 properties and 0 sites.", properties: [] }),
    );
    fireEvent.click(document.querySelector("[data-oauth-discover]") as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector("[data-oauth-discovery-empty]")).toHaveTextContent(
        "0 Analytics properties · 0 Search Console sites",
      ),
    );
    expect(screen.getByRole("link", { name: /Sign in as another account/ })).toHaveAttribute("href", GOOGLE_OAUTH_START_PATH);
  });

  it("says a disconnect also reaches into the operator's Google account", () => {
    renderGoogle(
      googleStatus({
        source: "store",
        fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
        auth: "oauth",
        metadata: {
          account: "ops@example.test",
          scopes: [],
          connectedAt: iso(HOUR),
          expiresAt: null,
          expirySource: null,
        },
      }),
      appStatus(true),
    );
    fireEvent.click(document.querySelector("[data-disconnect-open]") as HTMLElement);
    expect(
      document.querySelector("[data-disconnect-confirm]"),
    ).toHaveTextContent("Google sign-in revoked");
    expect(document.querySelector("[data-connection-replace]")).toBeNull();
  });

  it("says nothing about revoking when the credential is a service account", () => {
    renderGoogle(
      googleStatus({
        source: "store",
        fields: ["GOOGLE_SIGNAL_ACCOUNTS"],
        auth: "service-account",
      }),
      appStatus(true),
    );
    fireEvent.click(document.querySelector("[data-disconnect-open]") as HTMLElement);
    expect(
      document.querySelector("[data-disconnect-confirm]"),
    ).not.toHaveTextContent("sign-in revoked");
  });
});

describe("googleOAuthCardState", () => {
  const GOOGLE = INTEGRATION_PROVIDERS.find((p) => p.id === "google")!;
  const APP = INTEGRATION_PROVIDERS.find((p) => p.id === "google-oauth-app")!;
  const connected: IntegrationProviderStatus = {
    provider: GOOGLE,
    credential: credential("google", {
      source: "store",
      fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
      auth: "oauth",
      metadata: {
        account: "ops@example.test",
        scopes: [],
        connectedAt: null,
        expiresAt: null,
        expirySource: null,
      },
    }),
    assets: [],
  };
  const app: IntegrationProviderStatus = {
    provider: APP,
    credential: credential("google-oauth-app", {
      source: "store",
      fields: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    }),
    assets: [],
  };

  it("keeps saying connected from a browser Google would refuse to return to", () => {
    // An operator connects once at the loopback address and then reads the
    // card from the LAN like every other page.
    const state = googleOAuthCardState(connected, app, "http://192.168.1.20:5173");
    expect(state.state).toBe("connected");
    expect(state.account).toBe("ops@example.test");
  });

  it("asks for the app before it worries about the address", () => {
    const noApp: IntegrationProviderStatus = {
      provider: APP,
      credential: credential("google-oauth-app"),
      assets: [],
    };
    const google: IntegrationProviderStatus = {
      provider: GOOGLE,
      credential: credential("google"),
      assets: [],
    };
    expect(googleOAuthCardState(google, noApp, "http://192.168.1.20:5173").state).toBe(
      "app-missing",
    );
  });
});

describe("coming back from Google", () => {
  it("renders its OWN sentence per outcome code, never the provider's", () => {
    // The callback carries a closed vocabulary, so nothing Google or the
    // network said can be reflected into this page through a query parameter.
    expect(googleOAuthNotice("connected")).toEqual({
      tone: "ok",
      message: "Signed in to Google.",
    });
    expect(googleOAuthNotice("denied")?.message).toContain("cancelled");
    expect(googleOAuthNotice("state_expired")?.message).toContain("too long");
    expect(googleOAuthNotice("scope_incomplete")?.tone).toBe("bad");
    expect(googleOAuthNotice(null)).toBeNull();
    expect(googleOAuthNotice("")).toBeNull();
  });

  it("carries the one press that fixes a failure, as the toast's action", () => {
    expect(googleOAuthNotice("redirect_unusable", "http://192.168.1.20:5173")?.action).toEqual({
      label: "Open on 127.0.0.1",
      href: "http://127.0.0.1:5173/integrations?connect=google",
      external: false,
    });
    expect(googleOAuthNotice("exchange_failed")?.action?.href).toBe("https://console.cloud.google.com/apis/credentials");
    // Google not answering is not Google refusing: no console press, just try again.
    expect(googleOAuthNotice("unreachable")).toEqual({ tone: "bad", message: "Google did not answer. Try again." });
    expect(googleOAuthNotice("no_refresh_token")?.action?.external).toBe(true);
    expect(googleOAuthNotice("denied")?.action).toBeUndefined();
  });

  it("has a sentence for a code it has never heard of", () => {
    const notice = googleOAuthNotice("<img src=x onerror=alert(1)>");
    expect(notice?.tone).toBe("bad");
    expect(notice?.message).not.toContain("<img");
  });
});

describe("/health kept everything that pointed at it", () => {
  function CurrentPath() {
    const { pathname } = useLocation();
    return <span data-testid="path">{pathname}</span>;
  }

  it("does not redirect /integrations anywhere", () => {
    render(
      <MemoryRouter initialEntries={["/integrations"]}>
        <Routes>
          <Route path="/integrations" element={<CurrentPath />} />
          <Route path="*" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("path")).toHaveTextContent("/integrations");
  });

  it("keeps /health registered ahead of /integrations in the desk table", () => {
    const paths = deskRoutes.map((route) => route.path);
    expect(paths).toContain("/health");
    expect(paths).toContain("/integrations");
  });
});

describe("an expiring credential warns before it stops the collectors", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const stored = { source: "store" as const, fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] };
  const meta = (over: Partial<CredentialMetadata>): CredentialMetadata => ({
    account: null,
    scopes: [],
    connectedAt: null,
    expiresAt: null,
    expirySource: null,
    ...over,
  });

  function dated(days: number) {
    return status(
      "dataforseo",
      DATAFORSEO_FIELDS,
      { ...stored, metadata: meta({ expiresAt: new Date(NOW + days * DAY).toISOString(), expirySource: "operator" }) },
      [],
    ) as IntegrationProviderStatus & { provider: IntegrationProvider };
  }

  it("counts down quietly while the date is far off", () => {
    const { container } = renderCard({
      ...dated(40),
      provider: provider("dataforseo", DATAFORSEO_FIELDS, {
        expiry: { known: "operator" },
      }),
    });
    // A date forty days out is provenance, not attention.
    expect(container.querySelector("[data-expiry]")?.getAttribute("data-expiry")).toBe("ok");
    expect(screen.getByText("Expires in 40d")).toBeTruthy();
  });

  it("turns warn-toned inside the fourteen-day window", () => {
    const { container } = renderCard({
      ...dated(9),
      provider: provider("dataforseo", DATAFORSEO_FIELDS, {
        expiry: { known: "operator" },
      }),
    });
    expect(container.querySelector("[data-expiry]")?.getAttribute("data-expiry")).toBe("warn");
    const chip = screen.getByText("Expires in 9d").closest("span")!;
    // The warn token, never a colour of its own: a rival scale would be a
    // fourth severity.
    expect(chip.parentElement?.className ?? "").toContain("warn");
  });

  it("says a date has passed without claiming the credential already failed", () => {
    const { container } = renderCard({
      ...dated(-2),
      provider: provider("dataforseo", DATAFORSEO_FIELDS, {
        expiry: { known: "operator" },
      }),
    });
    expect(container.querySelector("[data-expiry]")?.getAttribute("data-expiry")).toBe("expired");
    expect(screen.getByText("Expired")).toBeTruthy();
    // Nothing has failed yet, so the connection chip does not read Failing.
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.queryByText("Failing")).toBeNull();
  });

  it("shows 'No expiry date' where an expiry cannot be known, and offers no field for a guess", () => {
    // A provider whose expiry cannot be known says so rather than showing a
    // fabricated date.
    const { container } = renderCard(
      status(
        "calendar",
        [field({ name: "CALENDAR_FEEDS", label: "Feeds", kind: "url-list" })],
        { source: "store", fields: ["CALENDAR_FEEDS"] },
      ),
    );
    expect(container.querySelector("[data-expiry]")?.getAttribute("data-expiry")).toBe("unstated");
    expect(container.querySelector("[data-expiry-value]")).toHaveTextContent("No expiry date");
    expect(container.querySelector("[data-expiry-edit]")).toBeNull();
    expect(screen.queryByText(/^Expire/)).toBeNull();
  });

  it("lets the operator record a date, and sends it as an instant rather than a day", async () => {
    const recorded: (string | null)[] = [];
    const { container } = renderCard(
      {
        ...status("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY", label: "API key", kind: "password" })], {
          source: "store",
          fields: ["BING_WEBMASTER_API_KEY"],
        }),
        provider: provider("bing-webmaster", [field({ name: "BING_WEBMASTER_API_KEY", label: "API key", kind: "password" })], {
          expiry: { known: "operator" },
        }),
      },
      { onSetExpiry: async (at) => void recorded.push(at) },
    );

    fireEvent.click(container.querySelector("[data-expiry-edit]")!);
    fireEvent.change(container.querySelector("[data-expiry-input]")!, {
      target: { value: "2026-10-04" },
    });
    fireEvent.click(container.querySelector("[data-expiry-save]")!);
    await waitFor(() => expect(recorded).toEqual(["2026-10-04T00:00:00.000Z"]));
  });

  it("takes 'it does not expire' as an answer the flow cannot overrule", async () => {
    const recorded: (string | null)[] = [];
    const googleFields = [
      field({ name: "GOOGLE_OAUTH_REFRESH_TOKEN", label: "Google sign-in", kind: "password", managed: true }),
    ];
    const { container } = renderCard(
      {
        ...status("google", googleFields, {
          source: "store",
          fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
          auth: "oauth",
          metadata: meta({
            connectedAt: new Date(NOW - DAY).toISOString(),
            expiresAt: new Date(NOW + 6 * DAY).toISOString(),
            expirySource: "flow",
          }),
        }),
        provider: provider("google", googleFields, {
          expiry: {
            known: "flow",
            fix: { url: "https://console.cloud.google.com/apis/credentials/consent", label: "Publish app" },
          },
        }),
      },
      { onSetExpiry: async (at) => void recorded.push(at) },
    );

    // Google publishes no API that says whether a consent screen is published,
    // so the card shows the Testing date and the link that ends it.
    expect(container.querySelector("[data-expiry-value]")).toHaveTextContent(new Date(NOW + 6 * DAY).toISOString().slice(0, 10));
    expect(screen.getByRole("link", { name: "Publish app" })).toHaveAttribute("href", "https://console.cloud.google.com/apis/credentials/consent");
    fireEvent.click(container.querySelector("[data-expiry-clear]")!);
    await waitFor(() => expect(recorded).toEqual([null]));
  });
});

describe("the sidebar points at an expiring credential without opening the page", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const meta = (expiresAt: string): CredentialMetadata => ({
    account: null,
    scopes: [],
    connectedAt: null,
    expiresAt,
    expirySource: "operator",
  });

  it("is silent while nothing is close, so the dot means something when it appears", () => {
    expect(
      expiringCredentials(
        page([
          status("dataforseo", DATAFORSEO_FIELDS, {
            source: "store",
            metadata: meta(new Date(NOW + 90 * DAY).toISOString()),
          }),
        ]),
        NOW,
      ),
    ).toEqual([]);
    expect(expiringCredentialSeverity([])).toBeNull();
  });

  it("names the soonest first, and escalates to error once one has actually expired", () => {
    const rows = expiringCredentials(
      page([
        status("dataforseo", DATAFORSEO_FIELDS, {
          source: "store",
          metadata: meta(new Date(NOW + 10 * DAY).toISOString()),
        }),
        status("bing-webmaster", [], {
          source: "store",
          metadata: meta(new Date(NOW - DAY).toISOString()),
        }),
      ]),
      NOW,
    );
    expect(rows.map((row) => row.provider)).toEqual(["bing-webmaster", "dataforseo"]);
    expect(expiringCredentialSeverity(rows)).toBe("error");
    expect(expiringCredentialSeverity(rows.slice(1))).toBe("warn");

    // One sentence wherever the dot appears: the sidebar entry and the
    // small-screen bar read it from here rather than composing their own.
    expect(expiringCredentialSummary(rows)).toBe(
      "2 credentials are expiring or expired",
    );
    expect(expiringCredentialSummary(rows.slice(1))).toBe(
      `${rows[1]!.label} — expires in 10 days`,
    );
    expect(expiringCredentialSummary([])).toBeNull();
  });
});

describe("a revoked Google sign-in reads as broken, and the fix leads", () => {
  // The ingest's GOOGLE_OAUTH_REVOKED_MESSAGE, word for word.
  const REVOKED = "Google revoked this sign-in: Testing-mode grants last 7 days.";
  const GOOGLE_FIELDS = [
    field({
      name: "GOOGLE_OAUTH_REFRESH_TOKEN",
      label: "Google sign-in",
      kind: "password",
      managed: true,
    }),
  ];

  function googleCard(over: Partial<CredentialSummary>) {
    const s = status("google", GOOGLE_FIELDS, {
      source: "store",
      fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"],
      auth: "oauth",
      metadata: {
        account: "ops@example.test",
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
        connectedAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: null,
        expirySource: null,
      },
      ...over,
    });
    const app = status("google-oauth-app", [], {
      source: "store",
      fields: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    });
    return renderCard(s, {
      oauth: {
        card: googleOAuthCardState(s, app, "http://127.0.0.1:5173"),
        app,
        startHref: "/api/integrations/google/oauth/start",
        onSaveApp: async () => {},
        onDiscover: async () => ({}) as GooglePropertyDiscovery,
      },
    });
  }

  it("stops claiming the account is signed in, and says what happened", () => {
    const { container } = googleCard({
      lastError: REVOKED,
      lastUsedAt: new Date(NOW - 7 * 60 * 60 * 1000).toISOString(),
      lastOkAt: new Date(NOW - 31 * 60 * 60 * 1000).toISOString(),
    });
    expect(container.querySelector("[data-oauth-grant]")?.getAttribute("data-oauth-grant")).toBe(
      "revoked",
    );
    // The identity survives, because it says which account to sign back in as.
    expect(screen.getByText(/ops@example\.test/)).toBeTruthy();
    const verdict = container.querySelector('[data-verdict="stored-verdict"]');
    expect(verdict?.textContent).toContain("Testing-mode grants last 7 days");
    expect(REVOKED.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("promotes the sign-in from a muted link to the loudest control on the card", () => {
    const { container } = googleCard({
      lastError: REVOKED,
      lastUsedAt: new Date(NOW - 7 * 60 * 60 * 1000).toISOString(),
      lastOkAt: new Date(NOW - 31 * 60 * 60 * 1000).toISOString(),
    });
    const restart = container.querySelector("[data-oauth-restart]")!;
    expect(restart.textContent).toContain("Sign in with Google again");
    // Signing in again is the fix for a sign-in, so nothing on the card offers
    // a secret to paste in its place; Disconnect stays.
    expect(container.querySelector("[data-connection-replace]")).toBeNull();
    expect(container.querySelector("[data-disconnect-open]")).not.toBeNull();
  });

  it("leads with Replace when a pasted key is the one failing", () => {
    const { container } = renderCard(
      status("dataforseo", DATAFORSEO_FIELDS, {
        source: "store",
        fields: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
        lastError: "refused",
        lastUsedAt: iso(HOUR),
        lastOkAt: null,
      }),
    );
    // When there is something to fix, the fix is not the same weight as Test
    // connection: the default variant fills its surface.
    expect(container.querySelector("[data-connection-replace]")?.className ?? "").toContain("bg-primary");
  });

  it("leaves a working grant exactly as it was — quiet link, tick, green scopes", () => {
    const { container } = googleCard({
      lastOkAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
      lastUsedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    });
    expect(container.querySelector("[data-oauth-grant]")?.getAttribute("data-oauth-grant")).toBe(
      "live",
    );
    expect(container.querySelector("[data-oauth-restart]")?.textContent).toContain(
      "Sign in again",
    );
    expect(screen.getByText(/Signed in as ops@example\.test/)).toBeTruthy();
    expect(container.querySelector("[data-disconnect-open]")?.className ?? "").not.toContain("bg-primary");
  });
});


describe("integration discovery and guided setup", () => {
  it("reads an incomplete stored credential as Not connected, with Connect as its action", () => {
    renderPage(page([status("dataforseo", DATAFORSEO_FIELDS, { source: "store", missingFields: ["DATAFORSEO_PASSWORD"] })]));
    const row = document.querySelector<HTMLElement>('[data-integration-tile="dataforseo"]')!;
    expect(row).toHaveAttribute("data-integration-status", "not-connected");
    expect(within(row).getByRole("link", { name: "Connect dataforseo" })).toBeInTheDocument();
  });

  const stored = () => status("dataforseo", DATAFORSEO_FIELDS, { source: "store" });
  it("keeps a newly failed test visible when moving to connection settings", async () => {
    api.test.mockResolvedValue({ ok: false, message: "Refused · HTTP 401", result: { outcome: "refused", status: 401 }, checkedAt: new Date(NOW).toISOString() });
    renderCard(stored(), { guided: true });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("HTTP 401")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("HTTP 401")).toBeInTheDocument();
  });
  it("groups every provider under what it is for, so no search or filter is needed", () => {
    renderPage(page([stored(), status("discord", [], {}), status("mediavine", [], {})]));
    const groups = screen.getAllByRole("list").map((list) => [
      document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent,
      within(list).getAllByRole("listitem").map((row) => row.getAttribute("data-integration-tile")),
    ]);
    expect(groups).toEqual([
      ["Traffic & search", ["dataforseo"]],
      ["Revenue", ["mediavine"]],
      ["Coordination", ["discord"]],
    ]);
    expect(screen.queryByRole("textbox", { name: "Search integrations" })).toBeNull();
  });

  it("returns from a provider to the whole list without writing anything", () => {
    renderPage(page([stored(), status("discord", [], {})]));
    openRow("dataforseo");
    fireEvent.click(screen.getByRole("link", { name: "All integrations" }));
    expect(document.querySelectorAll("[data-integration-tile]")).toHaveLength(2);
    expect(api.test).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("starts existing connections at evidence, with Replace and Disconnect on the connection itself", () => {
    renderCard(stored(), { guided: true });
    expect(screen.getByRole("button", { name: "Verify" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
    expect(document.querySelector("[data-disconnect-open]")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Replace login" }));
    expect(screen.getByRole("button", { name: "Verify" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Replace login" })).toHaveAttribute("aria-pressed", "true");
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input.value).toBe("");
    expect(api.test).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("keeps a failed connection’s evidence visible while choosing assets", () => {
    renderCard(status("dataforseo", DATAFORSEO_FIELDS, { source: "store", lastError: "The provider refused the request.", lastUsedAt: iso(HOUR), lastOkAt: null }), { guided: true });
    fireEvent.click(screen.getByRole("button", { name: "Choose sites" }));
    expect(screen.getByText("The provider refused the request.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View sites" })).toHaveAttribute("href", "/assets");
  });
});

vi.mock('@/hooks/useIntegrationHealth', () => ({ INTEGRATION_HEALTH_KEY: ['integration-health'], useIntegrationHealth: () => ({ data: payload.health, isError: false, status: integrationStatus(payload.health, false, NOW) }) }));

it('a saved Google connection shows production failure as its one status', () => {
  payload.health = { generatedAt: new Date(NOW).toISOString(), available: true, events: [], items: [{ id: 'live-failure', provider: 'google', capability: 'ga4-realtime', label: 'Live active users', asset: 'example.test', detail: null, report: null, reportDate: null, state: 'failing', lastAttemptAt: new Date(NOW).toISOString(), lastSuccessAt: null, nextAttemptAt: null, failure: 'rate-limit', code: 'rate-limit-daily', action: 'Wait for the next normal check.', coverage: 'monitored' }] };
  renderPage(page([status('google', [], { source: 'store' })]));
  const tile = document.querySelector('[data-integration-tile="google"]')!;
  expect(tile).toHaveAttribute('data-integration-status', 'failing');
  expect(tile.textContent).toBe('googleFailingManage');
});

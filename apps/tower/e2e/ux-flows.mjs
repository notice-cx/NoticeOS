// The flow registry: every operator flow the flow walker (flow-gate.mjs)
// walks, driven by clicking the controls the product offers, and measured at
// desktop (1440×900) and phone (390×844). The measurements are a report for
// design review, not a budget; the run fails only when a walk cannot finish.
//
//   - A redesign that changes a flow changes its script in the same commit.
//   - `setup` puts the fixture in the flow's start state and is not counted.
//   - `w.duplicate(label, evidence)` records a second check that no request or
//     step label reveals; it is removed by the redesign that removes the
//     second check, never on its own.
//
// Fields: title, kind ("flow" or "survey"), countStart (the starting screen
// is part of the flow), setup(page, fixture), run(w).
//
// Patterns the current flows adopted, from each vendor's own documentation:
//   - Connect with one key: Grafana's one-press save-and-test; Zapier's one
//     status per connection with Reconnect beside it; PostHog's list of the
//     permissions a key needs beside the field; Ahrefs-style listing of what
//     the key can see, pre-ticked by domain.
//   - Connect with Google: after consent, list everything the account can
//     see and pre-tick the sites that match by domain (Plausible, Ahrefs).
//   - Per-asset sources and discovery: one account connection lists every
//     project it can see, matched to sites by domain (GitHub, Vercel, Ahrefs);
//     PostHog: one key scoped to the chosen projects, region read off the key;
//     Clarity: one paste per site, inline in its row, saved on paste.
//   - Add a site: one input, the domain, then land on the site at once with
//     live checking (Plausible, Fathom, Simple Analytics); every other setting
//     defaults and lives in Settings.
//   - First run: setup ends on the product's own first number, not on a
//     "setup complete" screen (Plausible's first pageview, PostHog's first
//     event, Metabase's X-rays).
//   - Pick a PostHog row: add from the thing itself, the way a saved insight
//     joins a dashboard (PostHog, Grafana library panels, Metabase).
//   - Schedule on connection: a source's schedule lives on the source itself
//     (Fivetran, Airbyte, Hightouch, Grafana).
//   - Task source: the hosted side names the project; the one thing only the
//     machine can do is a single copyable command (Linear, Vercel link,
//     Supabase link).
//   - Inbox and filing: one verb per decision straight from the row, the
//     answer text is the note (Linear Triage and Inbox); filing a task from a
//     finding is prefilled, with the link shown on the finding afterwards
//     (PagerDuty).
//   - Settings: autosave with inline "Saved · Undo" for a low-risk single
//     field and a section Save elsewhere (GitLab Pajamas); never autosave
//     credentials or the measurement channel.
//   - Rotate and disconnect: replace a key on the connection itself, the old
//     key working until the new one passes its test (Stripe-style overlap);
//     disconnecting keeps one confirmation that names what stops.
//   - Arrange the Wall: edit straight from the TV entry, move, then Save; the
//     reason is optional (Grafana); versions are the safety net.

import { JOURNEY_ASSET as ASSET, JOURNEY_KEY as KEY, JOURNEY_SITE as SITE } from "./fixtures.ts";
import {
  SAVED, assetTab, awaitSaved, connectFromSource, connectInPanel, knobSave, nav, openAsset,
  openSourceRow, settle,
} from "./ux-walk.mjs";
import { DEFAULT_WALL_LAYOUT, wallLayoutWidgets } from "../../../scripts/wall-layout.mjs";

/** The synthetic Mediavine login the fixture accepts (harness.ts). */
const MEDIAVINE_EMAIL = "journey@example.test";
/** The synthetic Google OAuth client the fixture accepts (harness.ts). */
const GOOGLE_CLIENT_ID = "journey-client.apps.googleusercontent.com";

// ── setup helpers (not counted: they put the fixture in the flow's start state) ─

/** An asset added through the real Add a site screen, uncounted, for flows
 * that start after it. Its name is read off the domain (journey.example →
 * "Journey Example"), as the screen reads it. */
async function seedAsset(page, { domain = ASSET } = {}) {
  await page.goto("/assets/new");
  const sheet = page.getByRole("dialog", { name: "Add a site" });
  await sheet.getByLabel("Domain", { exact: true }).fill(domain);
  await sheet.getByRole("button", { name: "Add site", exact: true }).click();
  await page.waitForURL(new RegExp(`/assets/${domain.replace(".", "\\.")}`));
  await settle(page);
}

/** Bing connected through its connect panel (saved and tested in one press),
 * closed before Start: connected, nothing collected yet. */
async function seedBingConnected(page) {
  await page.goto("/integrations?connect=bing-webmaster");
  const panel = page.locator('[data-connect-panel="bing-webmaster"]');
  await panel.getByLabel("API key", { exact: true }).fill(KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 });
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await settle(page);
}

/** Asset + Bing connected, tested and mapped, one collection received, and the
 * recorded task snapshot — so the desk has measured task counts. */
async function seedPopulated(page, fixture) {
  await seedAsset(page);
  await seedBingConnected(page);
  await page.goto(`/assets/${ASSET}/sources`);
  await settle(page);
  await page.locator("#integrations").getByRole("button", { name: /^Bing Webmaster/ }).first().click();
  const site = page.locator('[data-lane-config="bing-webmaster"]').getByLabel("Site", { exact: true });
  await site.fill(SITE);
  await site.locator('xpath=following::button[normalize-space(.)="Save"][1]').click();
  await page.locator(SAVED).first().waitFor({ state: "visible", timeout: 15_000 });
  await fixture("/__journey/receive");
  await fixture("/__journey/task-source");
}

/** Mediavine signed in through its connect panel, closed before Start:
 * connected, no site synced yet. */
async function seedMediavineConnected(page) {
  await page.goto("/integrations?connect=mediavine");
  const panel = page.locator('[data-connect-panel="mediavine"]');
  await panel.getByLabel("Email", { exact: true }).fill(MEDIAVINE_EMAIL);
  await panel.getByLabel("Password", { exact: true }).fill(KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 });
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await settle(page);
}

/** Two assets, Bing collecting, Mediavine connected, revenue history: the desk
 * with enough on it that lists, statuses and prose are real. */
async function seedSurvey(page, fixture) {
  await fixture("/__journey/every-source");
  await seedPopulated(page, fixture);
  await seedAsset(page, { domain: "second.example" });
  // The fixture's 84-day revenue history stands in for a Mediavine sync (the
  // two write the same site row, so only one of them can run).
  await seedMediavineConnected(page);
  await fixture("/__journey/revenue-history");
}

// ── the flows ─────────────────────────────────────────────────────────────────

export const FLOWS = {};

/** Shared API key in the connect panel (Bing Webmaster Tools): Integrations →
 * Connect → paste → Connect (saves and tests) → the account's sites matched
 * to assets → Start collecting (saves the matches, collects now) → Working. */
FLOWS["connect-bing"] = {
  title: "Connect Bing Webmaster Tools (shared API key, saved and tested, sites matched and collected in one panel)",
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("A Bing Webmaster API key (the panel links to Bing's API access page)");
    await connectInPanel(w, "bing-webmaster", [["API key", KEY]]);
    await w.end("working");
  },
};

/** Shared login + password in the connect panel (DataForSEO): the sites its
 * weekly reports cover, each in its market, with the spend stated before
 * Start; Start runs the first reports now. */
FLOWS["connect-dataforseo"] = {
  title: "Connect DataForSEO (shared login + password, saved and tested, spend shown, first reports collected in one panel)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("The DataForSEO API login and API password (the panel links to DataForSEO's API access page)");
    await connectInPanel(w, "dataforseo", [["API login", "journey-login"], ["API password", KEY]]);
    await w.end("working");
  },
};

/** One personal API key for the account (PostHog): Integrations → Connect → paste → Connect shows the key to PostHog's US and
 * EU clouds and keeps it where it is accepted (the region found, never typed);
 * the region's projects are matched to sites by the domains each records,
 * with the project's saved funnels picked up; Start saves the match and
 * collects now → Working. */
FLOWS["connect-posthog"] = {
  title: "Connect PostHog (one account key: region found, projects matched, saved funnels picked up, collected in one panel)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("A PostHog personal API key (the panel links to PostHog's key page and names the access it needs)");
    await connectInPanel(w, "posthog", [["Personal API key", KEY]]);
    await w.end("working");
  },
};

/** A token per site, pasted on the site's row in the connect panel (Clarity):
 * the paste is saved at once, no Save, no step, and
 * the proof is the export itself, run by Run now, which says it spends one of
 * the site's ten calls a day; the site then reads Working. */
FLOWS["connect-clarity"] = {
  title: "Connect Microsoft Clarity (a token pasted on each site's row, saved on paste; Run now spends one of the day's ten calls)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("A Clarity data-export token per site (project → Settings → Data export → generate)");
    await nav(w, "Integrations");
    await w.click(w.page.locator('[data-integration-tile="clarity"]').getByRole("button", { name: /^Connect / }), "row Connect", { role: "reveal" });
    const panel = w.page.locator('[data-connect-panel="clarity"]');
    await w.fill(panel.locator(`[data-site-token-input="${ASSET}"]`), KEY, "Token — Journey Example", { paste: true });
    await w.waitFor("Paste → saved", () => panel.locator(`[data-site-token-row="${ASSET}"][data-site-token-held]`).waitFor({ timeout: 15_000 }));
    await w.click(panel.locator("[data-site-tokens-run]"), "Run now", { role: "commit" });
    await w.waitFor("Run now → Working", () => panel.locator(`[data-site-token-row="${ASSET}"] [data-connection="working"]`).waitFor({ timeout: 60_000 }));
    await w.end("working");
  },
};

/** PostHog connected with one key and started from its panel, which picks up
 * the project's two saved funnels, then its Checkout funnel removed on the
 * site's row, so the flow has one to add. */
async function seedPosthogWithOneFunnel(page) {
  await page.goto("/integrations?connect=posthog");
  const panel = page.locator('[data-connect-panel="posthog"]');
  await panel.getByLabel("Personal API key", { exact: true }).fill(KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await panel.locator("[data-sites-start]").click();
  await panel.locator('[data-site-row] [data-connection="working"]').first().waitFor({ timeout: 60_000 });
  await page.goto(`/assets/${ASSET}/sources`);
  await settle(page);
  const row = page.locator("#integrations").getByRole("button", { name: /^PostHog/ }).first();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const config = page.locator('[data-lane-config="posthog"]');
  if ((await config.getAttribute("open")) === null) await config.locator("summary").first().click();
  await config.getByRole("button", { name: "Remove funnel Checkout", exact: true }).click();
  await config.locator('[data-save-state="saved"]').waitFor({ timeout: 15_000 });
  // The flow starts where the operator looks at the site: its own page.
  await page.goto(`/assets/${ASSET}`);
  await settle(page);
}

/** Change a site's PostHog funnels on its own row: from the site's page, Data
 * sources → PostHog → Mapping → Add funnel picks one of the project's saved
 * funnels, saved at once with Undo beside it; no event name typed, no Save. */
FLOWS["change-posthog-funnel"] = {
  title: "Change a site's PostHog funnels (pick one of the project's saved funnels on the site's row, saved on the pick)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await seedPosthogWithOneFunnel(page); },
  async run(w) {
    w.know("Which of the project's saved PostHog funnels the site should report");
    await assetTab(w, "Data sources");
    await openSourceRow(w, "PostHog");
    const config = w.page.locator('[data-lane-config="posthog"]');
    if ((await config.getAttribute("open")) === null) await w.click(config.locator("summary").first(), "Mapping", { role: "reveal" });
    const pick = config.locator("[data-funnel-pick]");
    await w.waitFor("Mapping → the project's saved funnels", () => pick.waitFor({ timeout: 15_000 }));
    await w.select(pick, "checkout", "Add funnel");
    await w.waitFor("Add funnel → saved", () => config.locator('[data-funnel="checkout"]').waitFor({ timeout: 15_000 }));
    await w.end("funnel added");
  },
};

/** Account sign-in and site discovery in the connect panel (Mediavine):
 * Integrations → Connect → email and password → Connect
 * signs in and lists the account's sites before the login is kept → the site
 * matched by its domain → Start saves it and syncs now → Working. */
FLOWS["connect-mediavine"] = {
  title: "Connect Mediavine (sign-in tested before it is kept, sites found and matched, synced in one panel)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("The Mediavine Publishers Portal email and password");
    await connectInPanel(w, "mediavine", [["Email", MEDIAVINE_EMAIL], ["Password", KEY]]);
    await w.end("working");
  },
};

/** Google's client_secret.json as the Cloud console downloads it for a web
 * client, naming this Tower's redirect address (the fixture's synthetic
 * client, harness.ts). */
function googleClientFile(origin) {
  const json = JSON.stringify({ web: {
    client_id: GOOGLE_CLIENT_ID, client_secret: KEY, project_id: "journey-example",
    auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: [`${origin}/api/integrations/google/oauth/callback`],
  } });
  return { name: "client_secret_journey.json", mimeType: "application/json", buffer: Buffer.from(json) };
}

/** From the panel's Continue with Google to Working: Google's consent (the
 * walk answers it as Allow) returns to the panel on the account's sites —
 * GA4 and Search Console matched by domain on one row — and Start saves both
 * and collects now. */
async function googleSignInToWorking(w, panel) {
  await w.click(panel.locator("[data-google-continue]"), "Continue with Google", { role: "commit" });
  const start = w.page.locator('[data-connect-panel="google"] [data-sites-start]');
  await w.waitFor("Google's consent → the account's sites", () => start.waitFor({ timeout: 30_000 }));
  await w.click(start, "Start collecting", { role: "commit" });
  await w.waitFor("Start → Working", () => w.page.locator('[data-connect-panel="google"] [data-site-row] [data-connection="working"]').first().waitFor({ timeout: 60_000 }));
}

/** Google, self-hosted: the connect panel's one-time setup (two deep links
 * into the Cloud console, the redirect address with Copy, the
 * client_secret.json Google hands back dropped on the panel), then Continue
 * with Google, the sites matched, Start → Working. */
FLOWS["connect-google"] = {
  title: "Connect Google, self-hosted (console steps deep-linked, the client file dropped, signed in, sites matched and collected in one panel)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("A Google account that can read the site's GA4 property and Search Console site");
    w.outside("Google Cloud console: turn on the three APIs", { clicks: 2, source: "GoogleSignInSetup · Turn on the 3 APIs" });
    w.outside("Google Cloud console: create a web client with the redirect address, download its JSON", { clicks: 10, fields: 2, source: "GoogleSignInSetup · Create a web client" });
    await nav(w, "Integrations");
    await w.click(w.page.locator('[data-integration-tile="google"]').getByRole("button", { name: /^Connect / }), "row Connect", { role: "reveal" });
    const panel = w.page.locator('[data-connect-panel="google"]');
    await w.click(panel.locator("[data-google-step='2']").getByRole("button", { name: /^Copy / }), "Copy redirect address", { role: "commit" });
    await w.upload(panel.getByLabel("client_secret.json", { exact: true }), googleClientFile(new URL(w.page.url()).origin), "client_secret.json");
    await w.waitFor("client file → stored", () => panel.locator('[data-google-client-file="stored"]').waitFor({ timeout: 15_000 }));
    await googleSignInToWorking(w, panel);
    await w.end("working");
  },
};

/** Google, hosted: the installation's own OAuth client is already there, so
 * the panel is one button, Continue with Google, and the account's sites
 * follow the consent back: Start → Working. */
FLOWS["connect-google-hosted"] = {
  title: "Connect Google, hosted (Continue with Google, sites matched and collected in one panel)",
  async setup(page, fixture) {
    await fixture("/__journey/every-source");
    await fixture("/__journey/google-hosted");
    await seedAsset(page);
    await page.goto("/");
  },
  async run(w) {
    w.know("A Google account that can read the site's GA4 property and Search Console site");
    await nav(w, "Integrations");
    await w.click(w.page.locator('[data-integration-tile="google"]').getByRole("button", { name: /^Connect / }), "row Connect", { role: "reveal" });
    await googleSignInToWorking(w, w.page.locator('[data-connect-panel="google"]'));
    await w.end("working");
  },
};

/** The synthetic Discord webhook and calendar feed the fixture accepts (harness.ts). */
const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/0/journey-only-not-a-real-key";
const CALENDAR_FEED = "https://calendar.example/journey-only-not-a-real-key/basic.ics";

/** One secret URL in the connect panel, proved before it is kept (Discord,
 * the calendar feeds): Integrations → Connect → paste → Connect → the
 * provider's answer. No site list follows: they serve the whole installation. */
async function connectUrlInPanel(w, id, label, value) {
  await nav(w, "Integrations");
  await w.click(w.page.locator(`[data-integration-tile="${id}"]`).getByRole("button", { name: /^Connect / }), "row Connect", { role: "reveal" });
  const panel = w.page.locator(`[data-connect-panel="${id}"]`);
  await w.fill(panel.getByLabel(label, { exact: true }), value, label, { paste: true });
  await w.click(panel.getByRole("button", { name: "Connect", exact: true }), "Connect", { role: "commit" });
  await w.waitFor("Connect → accepted", () => panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 }));
}

FLOWS["connect-discord"] = {
  title: "Connect Discord (the webhook URL kept once its test message is delivered, the message named before the press)",
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("A Discord webhook URL for the operator's channel (the panel links to Discord's webhook help)");
    await connectUrlInPanel(w, "discord", "Webhook URL", DISCORD_WEBHOOK);
    await w.end("accepted");
  },
};

FLOWS["connect-calendar"] = {
  title: "Connect calendar feeds (a secret feed address pasted on its row, read once before the feeds are kept)",
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    w.know("The calendar's secret address in iCal format (the panel links to the calendar's settings)");
    await connectUrlInPanel(w, "calendar", "URL, feed 1", CALENDAR_FEED);
    await w.end("accepted");
  },
};

/** Core Tasks opens without any connection. */
FLOWS["connect-beads"] = {
  title: "Open the core Tasks board before adding a site",
  async setup(page, fixture) { await fixture("/__journey/core-tasks"); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    await w.waitFor("core task project → board", () => w.page.locator("[data-tasks-filters]").waitFor());
    await w.end("available");
  },
};

/** Empty install → a site added in one screen: Home's Add a site opens one
 * question over Home, the domain, whose name is read off it; Add lands on the
 * new asset's Data sources. */
async function addAsset(w) {
  w.know("The site's domain");
  await w.click(w.page.getByRole("button", { name: "Add your first site", exact: true }), "Add your first site", { role: "reveal" });
  const sheet = w.page.getByRole("dialog", { name: "Add a site" });
  await w.fill(sheet.getByLabel("Domain", { exact: true }), ASSET, "Domain");
  await w.click(sheet.getByRole("button", { name: "Add site", exact: true }), "Add site", { role: "commit" });
  await w.waitFor("Add → the asset's Data sources", () => w.page.waitForURL(new RegExp(`/assets/${ASSET.replace(".", "\\.")}/sources$`), { timeout: 15_000 }));
}

FLOWS["add-asset"] = {
  title: "Add a site (one screen: the domain, name inferred, lands on its Data sources)",
  countStart: true,
  async setup(page, fixture) { await fixture("/__journey/every-source"); await page.goto("/"); },
  async run(w) {
    await addAsset(w);
    await w.end("data sources");
  },
};

/** Empty install → first data: a site added in one screen, then its Bing
 * row's Connect opens the connect panel for this site, where the key is saved
 * and tested, the site matched and collected: Working inside the flow, with
 * no wait for a schedule. */
FLOWS["first-data"] = {
  title: "New site to first data (one-screen add, then its Bing row's Connect: key, site matched and collected in one panel)",
  countStart: true,
  async setup(page) { await page.goto("/"); },
  async run(w) {
    await addAsset(w);
    await connectFromSource(w, "bing-webmaster", [["API key", KEY]]);
    await w.end("working");
  },
};

/** Fresh install → the first number on screen: the empty install's Home,
 * one-screen add, the site's Bing row's Connect (key, match, first collection
 * in the panel), then the panel's Open. The walk ends only once the site's
 * Overview has drawn the collected search clicks, so the whole way from
 * nothing to a number is measured. */
FLOWS["fresh-install"] = {
  title: "Fresh install to the first number (add a site, connect Bing from its row, open the site: its clicks on screen)",
  countStart: true,
  async setup(page) { await page.goto("/"); },
  async run(w) {
    await addAsset(w);
    await connectFromSource(w, "bing-webmaster", [["API key", KEY]]);
    const panel = w.page.locator('[data-connect-panel="bing-webmaster"]');
    await w.click(panel.getByRole("link", { name: /^Open / }), "Open the site", { role: "nav" });
    // The fixture's Bing days sum to 602 clicks over 28 days (harness.ts).
    await w.waitFor("Open → the first number", () => w.page.locator('[data-overview-numbers] [data-measure="search"]').filter({ hasText: "602" }).first().waitFor({ timeout: 15_000 }));
    // …and the chart under the numbers draws that number, not an empty
    // visitors chart beside it.
    await w.waitFor("the first number → its chart", () => w.page.locator('[data-overview-chart="search"]').filter({ hasText: "Search clicks" })
      .locator("[data-overview-chart-key]").filter({ hasText: "Bing" }).first().waitFor({ timeout: 15_000 }));
    await w.end("first number");
  },
};

/** An existing asset: decline one source with a reason, set another's market.
 * Not using is one press and a reason chip, saved by the chip with Undo in
 * the toast. A site with no number yet opens on its Data sources
 * (`sitePath`), so the sidebar's site goes there directly. */
FLOWS["configure-sources"] = {
  title: "Configure an existing asset's data sources (skip one with a reason, set a market)",
  async setup(page, fixture) { await fixture("/__journey/every-source"); await seedAsset(page); await page.goto("/"); },
  async run(w) {
    await openAsset(w);
    await openSourceRow(w, "Microsoft Clarity");
    await w.click(w.page.locator('[data-lane-decline="clarity"]'), "Not using", { role: "reveal" });
    await w.click(w.page.locator('[data-decline-reasons] [data-decline-reason="not-relevant"]'), "Not relevant for this site", { role: "commit" });
    await w.waitFor("Not using → saved", () => w.page.locator(SAVED).first().waitFor({ state: "visible", timeout: 15_000 }));
    // The market is picked by name and saved on the pick, never DataForSEO's
    // numeric location code typed and saved.
    await openSourceRow(w, "DataForSEO");
    const market = w.page.locator('[data-lane-mapping="dataforseo"]').getByLabel("Market", { exact: true });
    await w.select(market, "2826:en", "Market");
    await w.waitFor("Market → Saved", () => w.page.locator('[data-lane-market] [data-save-state="saved"]').waitFor({ state: "visible", timeout: 15_000 }));
    await w.end("configured");
  },
};

/** The inbox: approve a gate and answer an ask, each on its own row (Linear Triage). */
FLOWS["inbox"] = {
  title: "Answer the inbox (approve a gate, answer an ask, on the row)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    const gate = w.page.locator('[data-inbox-row="jt-approve"]');
    await w.click(gate.getByRole("button", { name: "Approve", exact: true }), "Approve", { role: "commit" });
    const ask = w.page.locator('[data-inbox-row="jt-review"]');
    await w.click(ask.getByRole("button", { name: "Answer", exact: true }), "Answer", { role: "choose" });
    await w.fill(ask.getByLabel("Your answer to jt-review"), "Approved wording: Example headline", "Answer");
    await w.click(ask.getByRole("button", { name: "Send", exact: true }), "Send", { role: "commit" });
    await w.end("answered");
  },
};

/** A question an agent filed with options, picked with one press on its row:
 * the option is the commit, with nothing to open or type first. */
FLOWS["inbox-choose"] = {
  title: "Pick an option from the inbox (one press on the row)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await fixture("/__journey/choice-task"); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    const row = w.page.locator('[data-inbox-row="jt-pick"]');
    await w.click(row.getByRole("button", { name: "(b) Redirect to the new page", exact: true }), "Redirect to the new page", { role: "commit" });
    await w.end("chosen");
  },
};

/** Several decisions taken at once (Gmail, Linear): Select, Select all,
 * then one verb for every selected approval. */
FLOWS["inbox-bulk"] = {
  title: "Approve several decisions at once (select, then one press)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await fixture("/__journey/more-decisions"); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    const queue = w.page.locator("[data-waiting-list]");
    await w.click(queue.getByRole("button", { name: "Select", exact: true }), "Select", { role: "choose" });
    const bar = w.page.locator("[data-inbox-selection]");
    await w.click(bar.getByRole("button", { name: "Select all 5", exact: true }), "Select all", { role: "choose" });
    await w.click(bar.getByRole("button", { name: "Approve 4", exact: true }), "Approve 4", { role: "commit" });
    await w.end("approved");
  },
};

/** A backlog groomed in one sitting (Linear, Jira bulk change): the board
 * narrowed by a label, Select, Select all, then one resolution and one note
 * for every selected task, with one Undo after. */
FLOWS["tasks-bulk-close"] = {
  title: "Close several tasks at once (a label, Select all, Already handled)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await fixture("/__journey/backlog"); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    const fold = w.page.locator("[data-tasks-filters] [data-filter-toggle]");
    if (await fold.isVisible()) await w.click(fold, "Filters", { role: "choose" });
    await w.fill(w.page.locator("#tasks-label"), "groom", "Label");
    const table = w.page.locator("[data-tasks-table]");
    await w.click(table.getByRole("button", { name: "Select", exact: true }), "Select", { role: "choose" });
    const bar = w.page.locator("[data-tasks-selection]");
    await w.click(bar.getByRole("button", { name: "Select all 4", exact: true }), "Select all", { role: "choose" });
    await w.click(bar.getByRole("button", { name: "Close 3 as", exact: true }), "Close 3 as", { role: "choose" });
    await w.click(w.page.getByRole("menuitem", { name: "Already handled", exact: true }), "Already handled", { role: "choose" });
    const line = bar.locator('[data-task-form="close-as"]');
    await w.fill(line.getByLabel("Note"), "Handled by the spring redesign", "Note");
    await w.click(line.getByRole("button", { name: "Close 3 tasks", exact: true }), "Close 3 tasks", { role: "commit" });
    await w.end("closed");
  },
};

/** A question declined with a resolution from its row (Jira's resolutions):
 * Close as, the resolution, a one-line note, then the commit, with Undo after. */
FLOWS["inbox-close-as"] = {
  title: "Close a question as Won't do (Close as on the row, a note)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    const ask = w.page.locator('[data-inbox-row="jt-review"]');
    await w.click(ask.getByRole("button", { name: "Close as", exact: true }), "Close as", { role: "choose" });
    await w.click(w.page.getByRole("menuitem", { name: "Won't do", exact: true }), "Won't do", { role: "choose" });
    const line = w.page.locator('[data-task-form="close-as"]');
    await w.fill(line.getByLabel("Note"), "The launch copy is already approved", "Note");
    await w.click(line.getByRole("button", { name: "Close task", exact: true }), "Close task", { role: "commit" });
    await w.end("closed");
  },
};

/** File task on a saved finding's row, prefilled from the finding (PagerDuty
 * → Jira): two presses, on the page it is read on. */
FLOWS["file-task-from-finding"] = {
  title: "File a task from a finding (prefilled, on the asset page)",
  async setup(page, fixture) {
    await seedPopulated(page, fixture);
    await fixture("/__journey/finding");
    await page.goto(`/assets/${ASSET}`);
  },
  async run(w) {
    const row = w.page.locator('[data-finding-row="journey-sitemap-drop"]');
    await w.click(row.getByRole("button", { name: /^File task/ }), "File task", { role: "choose" });
    const form = w.page.locator("[data-task-composer]");
    await w.click(form.locator("[data-composer-submit]"), "File task", { role: "commit" });
    await awaitSaved(w, "File → filed");
    await w.end("filed");
  },
};

/** A new task from the Tasks page: the composer opens in place. */
FLOWS["file-task"] = {
  title: "File a task (Tasks → New task)",
  async setup(page, fixture) { await seedPopulated(page, fixture); await page.goto("/"); },
  async run(w) {
    await nav(w, "Tasks");
    await w.click(w.page.getByRole("button", { name: /New task|File a task/ }).first(), "New task", { role: "reveal" });
    const form = w.page.locator("[data-task-composer]");
    await w.fill(form.locator("[data-composer-title]"), "Fix the sitemap drop on journey.example", "Title");
    // The project is chosen only when the composer has not already chosen it.
    const project = form.locator("[data-composer-project]");
    if (!(await project.inputValue())) await w.select(project, { index: 1 }, "Project");
    await w.click(form.locator("[data-composer-submit]"), "File task", { role: "commit" });
    await w.waitFor("File → filed", () => settle(w.page));
    await w.end("filed");
  },
};

/** The sidebar's entries for the view on screen: one child of the Main nav
 * per page. The desk and the phone's drawer draw the same list. */
async function sidebarShows(page, count) {
  await page.waitForFunction(
    (n) => document.querySelector('nav[aria-label="Main"]')?.children.length === n,
    count,
    { timeout: 15_000 },
  );
}

/** Fresh install → a view chosen on Home's first run: "Which describes
 * you?", one pick under "What matters most?", Continue, and the sidebar drops
 * to the business view's five pages. */
FLOWS["choose-view"] = {
  title: "Choose a view on the first run",
  kind: "flow",
  countStart: true,
  async setup(page) { await page.goto("/"); },
  async run(w) {
    await w.click(w.page.locator('[data-view-choice="business"]'), "I run the business", { role: "choose" });
    await w.click(w.page.locator("[data-focus-choice]").first(), "What matters most", { role: "choose" });
    await w.click(w.page.locator("[data-focus-continue]"), "Continue", { role: "commit" });
    await w.waitFor("Continue → the business view's sidebar", () => sidebarShows(w.page, 5));
    await w.end("view chosen");
  },
};

/** Settings → General → Your view: a view picked is saved on change, the
 * sidebar follows at once, and Undo beside the choice puts it back. */
FLOWS["switch-view"] = {
  title: "Switch the view",
  kind: "flow",
  countStart: false,
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    await nav(w, "Settings");
    const panel = w.page.locator("[data-settings-view]");
    await w.click(panel.locator('[data-view-option="product"]'), "I build the product", { role: "choose" });
    await w.waitFor("I build the product → its sidebar", () => sidebarShows(w.page, 8));
    const saved = panel.locator('[data-status-for="field:Your view"][data-save-state="saved"]');
    await w.click(saved.getByRole("button", { name: "Undo", exact: true }), "Undo", { role: "commit" });
    await w.waitFor("Undo → every page in the sidebar", () => sidebarShows(w.page, 10));
    await w.end("undone");
  },
};

/** The view stored the way a person changes it later: Settings → General →
 * Your view, saved on the press, with the sidebar following at once. */
async function chooseViewInSettings(w, view, label, sidebarEntries) {
  await nav(w, "Settings");
  const panel = w.page.locator("[data-settings-view]");
  await w.click(panel.locator(`[data-view-option="${view}"]`), label, { role: "choose" });
  await w.waitFor(`${label} → its sidebar`, () => sidebarShows(w.page, sidebarEntries));
}

/** The business view's Home leads with every site's health as dots; a site's
 * row opens the site, and its Health tab shows the five words with every
 * fact's readings below them, without a press. */
FLOWS["read-site-health"] = {
  title: "Read a site's health, in the business view",
  kind: "flow",
  countStart: false,
  async setup(page, fixture) { await seedPopulated(page, fixture); await page.goto("/"); },
  async run(w) {
    await chooseViewInSettings(w, "business", "I run the business", 5);
    await nav(w, "Home");
    const row = w.page.locator(`[data-site-health-row="${ASSET}"]`);
    await w.click(row.getByRole("link").first(), "Site health · Journey Example", { role: "nav" });
    await settle(w.page);
    await assetTab(w, "Health");
    await w.waitFor("Health → every fact's readings", () => w.page.locator('[data-health-evidence="code"]').waitFor({ timeout: 10_000 }));
    await w.end("evidence read");
  },
};

/** The product view's Home: the month's money split by site, visitors by
 * channel beside the largest funnel drop, and "Worth a look", whose rows
 * each file a task through the same composer a finding uses. */
FLOWS["see-money-sources"] = {
  title: "See where the money comes from, in the product view",
  kind: "flow",
  countStart: false,
  async setup(page, fixture) {
    await seedPopulated(page, fixture);
    await fixture("/__journey/revenue-history");
    await page.goto("/");
  },
  async run(w) {
    await chooseViewInSettings(w, "product", "I build the product", 8);
    await nav(w, "Home");
    await w.page.locator("[data-surface-hero]").waitFor({ timeout: 15_000 });
    await w.page.locator("[data-home-channels]").waitFor({ timeout: 15_000 });
    const gaps = w.page.locator("[data-home-gaps]");
    await w.click(gaps.locator("[data-file-task]").first(), "Make a task", { role: "choose" });
    const form = w.page.locator("[data-task-composer]");
    // The project is chosen only when the row has not already chosen it.
    const project = form.locator("[data-composer-project]");
    if (!(await project.inputValue())) await w.select(project, { index: 1 }, "Project");
    await w.click(form.locator("[data-composer-submit]"), "File task", { role: "commit" });
    await awaitSaved(w, "File → filed");
    await w.end("filed");
  },
};

/** Settings: the time zone, saved on change, then undone beside the field. */
FLOWS["setting-timezone"] = {
  title: "Change the time zone (saved on change, then Undo)",
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    await nav(w, "Settings");
    // Settings opens on General; the time zone is the Clock panel's row.
    const section = w.page.locator("#clock");
    await w.select(section.locator("select").first(), "America/Los_Angeles", "Time zone");
    const saved = section.locator('[data-save-state="saved"]');
    await w.waitFor("Time zone → Saved", () => saved.waitFor({ state: "visible", timeout: 15_000 }));
    await w.click(saved.getByRole("button", { name: "Undo", exact: true }), "Undo", { role: "commit" });
    await w.waitFor("Undo → restored", () => settle(w.page));
    await w.end("undone");
  },
};

/** Settings: one portfolio number (the monthly data budget), saved. Money
 * keeps its explicit Save (GitLab Pajamas: never autosave financial data).
 * The budget is a row of General, the page Settings opens on, so there is no
 * section to pick first. */
FLOWS["setting-budget"] = {
  title: "Change a portfolio setting (monthly data budget)",
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    await nav(w, "Settings");
    const input = w.page.locator("#budget").locator('input[type="number"]').first();
    await w.fill(input, "40", "Monthly data budget (USD)");
    await knobSave(w, input, "data budget");
    await w.end("saved");
  },
};

/** How often data is collected, changed on the source's own connection
 * (Fivetran's and Airbyte's sync frequency on the connection): Integrations →
 * the source's Manage → the collection's time, one pick saved beside its row
 * with Undo. The traffic and search archives are fed by Google and Bing, so
 * the row is on both panels under the job's own name; this walks Bing's. The
 * row's own "Saved" is what the walk waits on, so it proves the write. */
FLOWS["setting-cadence"] = {
  title: "Change how often data is collected (a collection's schedule, on its source's Manage panel)",
  async setup(page) { await seedAsset(page); await seedBingConnected(page); await page.goto("/"); },
  async run(w) {
    await nav(w, "Integrations");
    await w.click(w.page.locator('[data-integration-tile="bing-webmaster"]').getByRole("button", { name: /^Manage / }), "row Bing Manage", { role: "choose" });
    const row = w.page.locator('[data-connect-panel="bing-webmaster"] [data-schedule-row="signal-dumps"]');
    await w.select(row.getByLabel("Traffic and search archives · time", { exact: true }), "09:15", "Traffic and search archives · time");
    await w.waitFor("Time → Saved", () => row.locator('[data-save-state="saved"]').waitFor({ state: "visible", timeout: 15_000 }));
    await w.end("saved");
  },
};

/** Rotate the Bing key on the connection itself (Stripe's roll key / Zapier's
 * Reconnect): the row's Manage opens the connection in the panel; Replace API
 * key → paste → Connect shows the new key to Bing before it is kept, so the
 * old key collects until the new one passes, and the panel ends on Bing's
 * answer with no walk back through the sites. */
FLOWS["rotate-key"] = {
  title: "Rotate a key (Bing: Replace API key on the connection, tested before it is kept)",
  async setup(page) { await seedAsset(page); await seedBingConnected(page); await page.goto("/"); },
  async run(w) {
    w.know("The new API key");
    await nav(w, "Integrations");
    await w.click(w.page.locator('[data-integration-tile="bing-webmaster"]').getByRole("button", { name: /^Manage / }), "row Bing Manage", { role: "choose" });
    const panel = w.page.locator('[data-connect-panel="bing-webmaster"]');
    await w.click(panel.getByRole("button", { name: "Replace API key", exact: true }), "Replace API key", { role: "choose" });
    await w.fill(panel.getByLabel("API key", { exact: true }), KEY, "API key", { paste: true });
    await w.click(panel.getByRole("button", { name: "Connect", exact: true }), "Connect", { role: "commit" });
    await w.waitFor("Connect → Key accepted", () => panel.locator('[data-connect-state="accepted"]').waitFor({ timeout: 15_000 }));
    await w.end("rotated");
  },
};

/** Disconnect Mediavine on the connection itself: the row's Manage opens it
 * in the panel; Disconnect, then one confirmation naming the sites that stop,
 * no Settings step, no typed id. It stays one confirmation because it cannot
 * be undone: the secret is deleted. */
FLOWS["disconnect"] = {
  title: "Disconnect an integration (Mediavine: one confirmation naming what stops)",
  async setup(page) { await seedAsset(page); await seedMediavineConnected(page); await page.goto("/"); },
  async run(w) {
    await nav(w, "Integrations");
    const tile = w.page.locator('[data-integration-tile="mediavine"]');
    await w.click(tile.getByRole("button", { name: /^Manage / }), "row Mediavine Manage", { role: "choose" });
    const panel = w.page.locator('[data-connect-panel="mediavine"]');
    await w.click(panel.getByRole("button", { name: "Disconnect", exact: true }), "Disconnect", { role: "choose" });
    await w.click(panel.getByRole("button", { name: "Disconnect Mediavine", exact: true }), "Disconnect Mediavine", { role: "commit", confirm: true });
    await w.waitFor("Disconnect → Not connected", () => tile.locator('[data-connection="not-connected"]').waitFor({ timeout: 15_000 }));
    await w.end("disconnected");
  },
};

/** Arrange the Wall: the Edit beside the sidebar's TV dashboard entry
 * (PostHog's dashboard Edit); at a desk, drag one widget onto another's top
 * edge to stack them, then move the strip down with its Move menu; on a
 * phone, the Move menu alone; save. */
FLOWS["arrange-wall"] = {
  title: "Arrange the TV Wall (Edit beside the TV entry, drag to stack and the Move menu, save)",
  async setup(page) {
    await seedAsset(page);
    const layout = structuredClone(DEFAULT_WALL_LAYOUT);
    wallLayoutWidgets(layout).find((widget) => widget.id === "sites").settings = { pulseMetrics: { [ASSET]: [] } };
    const result = await page.request.put("/api/config", {
      headers: { origin: new URL(page.url()).origin },
      data: { ops: [{ kind: "file-json-set", file: "config/tower.json", pointer: "/wall", expect: null, value: { layout, history: [] } }] },
    });
    if (!result.ok()) throw new Error(`The synthetic saved Wall could not be prepared: ${result.status()} ${await result.text()}`);
    await page.goto("/");
  },
  async run(w) {
    if (w.mobile) {
      await w.click(w.page.getByRole("button", { name: "Open navigation" }), "open menu", { role: "reveal" });
      const drawer = w.page.locator('[aria-label="Navigation"]');
      await w.click(drawer.getByRole("link", { name: "Edit the TV layout", exact: true }), "menu Edit the TV layout", { role: "nav" });
    } else {
      await w.click(w.page.locator("[data-app-sidebar]").getByRole("link", { name: "Edit the TV layout", exact: true }), "sidebar Edit the TV layout", { role: "nav" });
    }
    await settle(w.page);
    const tile = (id) => w.page.locator(`[data-wall-preview] [data-wall-edit-widget="${id}"]`);
    if (!w.mobile) {
      // The drag path: Work onto the top edge of Sites stacks it above them.
      await w.drag(tile("work"), tile("sites"), "drag Work onto the top of Sites", { at: { x: 0.5, y: 0.06 } });
      await tile("work").locator("xpath=ancestor::*[@data-wall-column='business']").waitFor({ timeout: 10_000 });
    }
    // The Move menu path, the one a keyboard or a phone takes: the strip,
    // alone in its row, goes down with it.
    await w.click(tile("strip"), "select Top strip", { role: "choose" });
    await w.click(w.page.locator('[data-wall-widget-panel="strip"]').getByRole("button", { name: "Move Top strip", exact: true }), "Move Top strip", { role: "reveal" });
    await w.click(w.page.getByRole("menuitem", { name: /^Move down/ }), "Move down", { role: "choose" });
    // One press: the version note is optional and the version is named by
    // what changed when the operator writes none.
    await w.click(w.page.getByRole("button", { name: "Save", exact: true }).first(), "Save", { role: "commit" });
    // Saved means the layout's own status reads saved ("On the TV", declared
    // for wall:layout), never any toast: an error toast is a refusal.
    await awaitSaved(w, "Save layout → On the TV", w.page.locator('[data-save-state="saved"]:has([data-status-for="wall:layout"])'));
    const state = await (await w.page.request.get("/__journey/status")).json();
    const settings = wallLayoutWidgets(state.documents["config/tower.json"].wall.layout).find((widget) => widget.id === "sites").settings;
    if (JSON.stringify(settings?.pulseMetrics) !== JSON.stringify({ [ASSET]: [] })) throw new Error("Moving the Wall lost its saved pulse choices");
    await w.end("saved");
  },
};

/** The editor's Add a widget drawer → Start from → a view's preset, which
 * replaces the whole arrangement in the preview as one step Undo takes back;
 * nothing reaches the TV until Save. */
FLOWS["start-from-preset"] = {
  title: "Start the TV from a view's preset",
  kind: "flow",
  countStart: false,
  async setup(page) { await seedAsset(page); await page.goto("/"); },
  async run(w) {
    if (w.mobile) {
      await w.click(w.page.getByRole("button", { name: "Open navigation" }), "open menu", { role: "reveal" });
      const drawer = w.page.locator('[aria-label="Navigation"]');
      await w.click(drawer.getByRole("link", { name: "Edit the TV layout", exact: true }), "menu Edit the TV layout", { role: "nav" });
    } else {
      await w.click(w.page.locator("[data-app-sidebar]").getByRole("link", { name: "Edit the TV layout", exact: true }), "sidebar Edit the TV layout", { role: "nav" });
    }
    await settle(w.page);
    const toolbar = w.page.locator("[data-wall-toolbar]");
    await w.click(toolbar.getByRole("button", { name: "Add a widget", exact: true }), "Add a widget", { role: "reveal" });
    await w.click(w.page.locator("[data-wall-start-from]"), "Start from", { role: "reveal" });
    await w.click(w.page.locator('[data-wall-preset="business"]'), "I run the business", { role: "choose" });
    const health = w.page.locator('[data-wall-preview] [data-wall-edit-widget="health"]');
    await w.waitFor("I run the business → Site health in the preview", () => health.waitFor({ timeout: 10_000 }));
    await w.click(toolbar.getByRole("button", { name: "Undo", exact: true }), "Undo", { role: "commit" });
    await w.waitFor("Undo → the arrangement as it was", () => health.waitFor({ state: "detached", timeout: 10_000 }));
    await w.end("undone");
  },
};

/** Arrange the sites: Arrange beside the Sites page's order and stage; at a
 * desk, drag the last site to the top by its grip; on a phone, its Move up;
 * then one switch takes a site off the TV, saved with Undo; Done. */
FLOWS["arrange-sites"] = {
  title: "Arrange the sites (Sites → Arrange, drag to the top or Move up, one site off the TV, Done)",
  async setup(page) {
    await seedAsset(page);
    await seedAsset(page, { domain: "second.example" });
    await page.goto("/assets");
  },
  async run(w) {
    await settle(w.page);
    const open = w.page.locator("[data-assets-arrange-open]");
    if (!(await open.isVisible())) await w.click(w.page.getByRole("button", { name: /Order & stage/ }), "Order & stage", { role: "reveal" });
    await w.click(open, "Arrange", { role: "nav" });
    await settle(w.page);
    const row = (id) => w.page.locator(`[data-site-arrange-row="${id}"]`);
    if (!w.mobile) {
      await w.drag(row("second.example").locator("[data-site-arrange-grip]"), row(ASSET), "drag Second Example to the top", { at: { x: 0.5, y: 0.1 } });
    } else {
      await w.click(w.page.getByRole("button", { name: "Move Second Example up", exact: true }), "Move Second Example up", { role: "choose" });
    }
    await awaitSaved(w, "Site order saved");
    await w.page.waitForFunction(
      () => document.querySelector("[data-site-arrange-row]")?.getAttribute("data-site-arrange-row") === "second.example",
      undefined,
      { timeout: 10_000 },
    );
    await w.click(w.page.getByRole("switch", { name: "TV for Journey Example", exact: true }), "TV for Journey Example", { role: "commit" });
    await awaitSaved(w, "Saved — Journey Example hidden on the TV", w.page.locator(SAVED).filter({ hasText: "hidden on the TV" }).first());
    await w.click(w.page.getByRole("link", { name: "Done", exact: true }), "Done", { role: "nav" });
    const state = await (await w.page.request.get("/__journey/status")).json();
    if (state.documents["config/tower.json"].sites?.[ASSET]?.tv !== false) throw new Error("The TV switch did not reach config/tower.json");
    await w.end("arranged");
  },
};

// ── the screen survey: every main screen, populated ───────────────────────────
//
// Not a flow the operator performs: it opens every main screen by URL so the
// per-screen rules (one status per subject, lists grouped by subject) cover
// the whole desk, not just the screens a flow passes through. Step counts do
// not apply to it.

const SURVEY_ROUTES = ["/", "/assets", `/assets/${ASSET}`, `/assets/${ASSET}/growth`, `/assets/${ASSET}/financials`,
  `/assets/${ASSET}/search`, `/assets/${ASSET}/health`, `/assets/${ASSET}/alerts`, `/assets/${ASSET}/tasks`, `/assets/${ASSET}/activity`,
  `/assets/${ASSET}/sources`, `/assets/${ASSET}/settings`, "/alerts", "/tasks", "/agents", "/integrations",
  "/integrations?provider=bing-webmaster", "/integrations?provider=google", "/integrations?provider=mediavine",
  "/health", "/health/operations", "/financials", "/settings", "/wall"];

FLOWS["survey"] = {
  title: "Screen survey: every main screen, populated (statuses and lists)",
  kind: "survey",
  countStart: true,
  async setup(page, fixture) { await seedSurvey(page, fixture); },
  async run(w) {
    w.heights = {};
    for (const route of SURVEY_ROUTES) {
      await w.page.goto(route);
      await w.observe();
      w.heights[route] = await w.page.evaluate(() => document.documentElement.scrollHeight);
    }
    await w.end("surveyed");
  },
};

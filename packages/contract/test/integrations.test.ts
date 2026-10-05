// The provider catalog is declared ONCE (packages/contract/src/integrations.ts)
// and read by three runtimes: the Tower renders its forms from it, the ingest
// Worker validates every submitted body against it, and
// `scripts/dev-secrets.mjs import` reads it back off the wire to move an
// operator's existing `.dev.secrets.json` into the store.
//
// So what is pinned here is the SHAPE the other two rely on. A duplicated field
// name, a field name that stops matching its legacy env binding, or a provider
// whose id drifts would each break one of them silently.

import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_EXPIRY_WARN_DAYS,
  GOOGLE_TESTING_GRANT_DAYS,
  acceptedAs,
  INTEGRATION_PROVIDERS,
  INTEGRATION_PROVIDER_IDS,
  credentialAssetRows,
  credentialAuthState,
  credentialBalance,
  credentialExpiry,
  exactUsd,
  integrationProvider,
  integrationProviderCards,
  meterRemaining,
  probeLine,
  providerReportingTimeZone,
  readEnvCredential,
  usdCents,
} from '../src/integrations.js';
import { legacyBindingAsset } from '../src/configuration.mjs';
import type {
  CredentialMetadata,
  CredentialSummary,
  ExactUsd,
  IntegrationProviderId,
} from '../src/integrations.js';

/** A credential summary with nothing in it — names and timestamps only, which
 * is all this type ever carries. */
function summary(provider: IntegrationProviderId): CredentialSummary {
  return {
    provider,
    source: 'none',
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
  };
}

describe('INTEGRATION_PROVIDERS', () => {
  it('lists each supported credential and keeps the OAuth prerequisite off its own card', () => {
    expect(INTEGRATION_PROVIDER_IDS).toEqual([
      'cloudflare',
      'mediavine',
      'google',
      'google-oauth-app',
      'bing-webmaster',
      'dataforseo',
      'calendar',
      'discord',
      'clarity',
      'posthog',
    ]);
    // `google-oauth-app` is a PREREQUISITE, not a provider you connect: the
    // Google card asks for it in place, and a fifth card reading "Google OAuth
    // app · Not connected" beside "Google · Connected" would state one
    // connection twice (bead `ro-vu8d.3`).
    expect(integrationProviderCards().map((provider) => provider.id)).toEqual([
      'cloudflare',
      'mediavine',
      'google',
      'bing-webmaster',
      'dataforseo',
      'calendar',
      'discord',
      'clarity',
      'posthog',
    ]);
    expect(integrationProvider('google-oauth-app')?.companionOf).toBe('google');
  });

  it('gives every provider a label, a doc pointer and at least one field', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.docRef).toMatch(/\.md(#|$)/);
      expect(provider.fields.length).toBeGreaterThan(0);
      expect(['shared', 'per-asset']).toContain(provider.scope);
    }
  });

  it('names every field the way its legacy env binding is named', () => {
    // This is not cosmetic: the resolver falls back to `env[field.name]`, and
    // the import script copies `.dev.secrets.json` keys straight across. A
    // camelCase field name here would silently break both.
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const field of provider.fields) {
        expect(field.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(field.label.length).toBeGreaterThan(0);
        // WHERE THE VALUE COMES FROM is a link, never a sentence under the
        // input (bead `ro-ujb9.96.6.1`): https, and two or three words on it.
        if (field.link) {
          expect(field.link.url.startsWith('https://')).toBe(true);
          expect(field.link.label.split(' ').length).toBeLessThanOrEqual(3);
        }
        for (const grant of field.grants ?? []) expect(grant.split(' ').length).toBeLessThanOrEqual(4);
        expect(field).not.toHaveProperty('help');
        expect(['text', 'password', 'json', 'url-list', 'url', 'asset-map']).toContain(
          field.kind,
        );
      }
    }
  });

  it('uses each field name exactly once across the whole catalog', () => {
    // Two providers claiming one binding would make "which credential is this"
    // unanswerable, in the store and in the env fallback alike.
    const names = INTEGRATION_PROVIDERS.flatMap((provider) =>
      provider.fields.map((field) => field.name),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks every secret field as one a form must mask', () => {
    // Managed connection metadata never renders a credential form control.
    // The one deliberate exception is the DataForSEO API login: it identifies
    // the account rather than authenticating it, and a masked field an operator
    // cannot proof-read is a support ticket.
    const clear = INTEGRATION_PROVIDERS.flatMap((provider) =>
      provider.fields.filter((field) => !field.secret && !field.managed).map((field) => field.name),
    );
    // The OAuth client ID joins it for the same reason: Google publishes it to
    // every browser that starts a sign-in, and an operator who cannot
    // proof-read it against the console cannot see a mismatch that produces
    // `invalid_client`.
    expect(clear).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'MEDIAVINE_USER', 'GOOGLE_OAUTH_CLIENT_ID', 'DATAFORSEO_LOGIN']);
  });

  it('looks a provider up by id, and answers null for anything else', () => {
    expect(integrationProvider('bing-webmaster')?.label).toBe('Bing Webmaster Tools');
    expect(integrationProvider('clarity')?.scope).toBe('per-asset');
    expect(integrationProvider('nope')).toBeNull();
    expect(integrationProvider('')).toBeNull();
  });

  it('lets Google be complete either way in, and neither way alone by halves', () => {
    // `required` cannot express *either a sign-in or a service account*, so
    // Google marks neither field required and declares two auth paths instead.
    // This is the rule the store, the card and the importer all read
    // (bead `ro-vu8d.3`).
    const google = integrationProvider('google')!;
    expect(google.fields.some((field) => field.required)).toBe(false);

    expect(credentialAuthState(google, ['GOOGLE_OAUTH_REFRESH_TOKEN'])).toEqual({
      complete: true,
      auth: 'oauth',
      missing: [],
    });
    expect(credentialAuthState(google, ['GOOGLE_SIGNAL_ACCOUNTS'])).toEqual({
      complete: true,
      auth: 'service-account',
      missing: [],
    });
    // Nothing held names the PREFERRED path, so a first-run card asks for the
    // sign-in rather than listing every field of every way in.
    expect(credentialAuthState(google, [])).toEqual({
      complete: false,
      auth: null,
      missing: ['GOOGLE_OAUTH_REFRESH_TOKEN'],
    });
    // Both held is still one answer, and it is the preferred one — that is what
    // the collectors will actually authenticate with.
    expect(
      credentialAuthState(google, ['GOOGLE_SIGNAL_ACCOUNTS', 'GOOGLE_OAUTH_REFRESH_TOKEN'])
        .auth,
    ).toBe('oauth');
  });

  it('judges a single-path provider on its required fields, and holds nothing to be incomplete', () => {
    const dataforseo = integrationProvider('dataforseo')!;
    expect(credentialAuthState(dataforseo, ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'])).toEqual(
      { complete: true, auth: null, missing: [] },
    );
    expect(credentialAuthState(dataforseo, ['DATAFORSEO_LOGIN'])).toEqual({
      complete: false,
      auth: null,
      missing: ['DATAFORSEO_PASSWORD'],
    });
    expect(credentialAuthState(dataforseo, []).complete).toBe(false);
  });

  it('never lets a managed field be one an operator is asked to type', () => {
    // A `managed` field is written by a FLOW — today only the Google refresh
    // token. A required managed field would be a form asking for something no
    // form can supply.
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const field of provider.fields) {
        if (field.managed === true) expect(field.required).toBe(false);
      }
    }
  });

  it('declares what pressing Test costs for every provider, and flags the two that surprise', () => {
    // The declaration is required in the type (bead `ro-vu8d.18`). A provider
    // that inherited "free and invisible" from an omission would be exactly the
    // button an operator presses once and never again. The button's own label
    // says what a non-free press does (bead `ro-ujb9.96.6.1`), so the
    // declaration is the cost alone — no sentence rides beside it.
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(['free', 'side-effect', 'none']).toContain(provider.test.cost);
      expect(provider.test).not.toHaveProperty('note');
    }
    // Discord is the ONE probe in this catalog that reaches the operator's own
    // channel, and the card's button names the message before the press.
    expect(integrationProvider('discord')!.test.cost).toBe('side-effect');
    // The OAuth app makes no call at all — there is no free Google endpoint
    // that proves a client id and secret.
    expect(integrationProvider('google-oauth-app')!.test.cost).toBe('none');
    // Everything else is a free read, which is what a Test button is assumed to
    // be, so the card says nothing about it.
    for (const id of ['google', 'bing-webmaster', 'dataforseo', 'calendar'] as const) {
      expect(integrationProvider(id)!.test.cost).toBe('free');
    }
  });

  it('connects in the panel only where one free read proves every typed field (bead `ro-ujb9.96.7.1`)', () => {
    // The Tower opens the one-panel save-and-test for these and the ingest
    // refuses it for every other provider, from this one declaration.
    const panel = INTEGRATION_PROVIDERS.filter((provider) => provider.connect?.kind === 'key');
    expect(panel.map((provider) => provider.id)).toEqual(['cloudflare', 'mediavine', 'bing-webmaster', 'dataforseo', 'calendar', 'discord', 'posthog']);
    // Discord and the calendar feeds connect the whole installation: no site
    // list follows the answer (bead `ro-ujb9.96.7.14`).
    expect(panel.filter((provider) => provider.connect!.sites === false).map((provider) => provider.id)).toEqual(['cloudflare', 'calendar', 'discord']);
    // Clarity connects in the panel too, a token pasted per site (bead
    // `ro-ujb9.96.7.9`): no one key, and no free read to prove it.
    const perSite = INTEGRATION_PROVIDERS.filter((provider) => provider.connect?.kind === 'site-tokens');
    expect(perSite.map((provider) => [provider.id, provider.scope, provider.test.cost])).toEqual([['clarity', 'per-asset', 'none']]);
    for (const provider of panel) {
      expect(provider.connect!.kind).toBe('key');
      // Save-and-test must never cost money. Only Discord's reaches the
      // operator's channel — one labelled test message, the proof its `test`
      // declares and the panel names beside the press.
      expect(provider.test.cost).toBe(provider.id === 'discord' ? 'side-effect' : 'free');
      expect(provider.scope).toBe('shared');
      // Every field the panel asks for is typed; a `managed` one (PostHog's
      // older per-site map, bead `ro-ujb9.96.7.8`) is never on the form, and
      // at least one field always is.
      expect(provider.fields.some((field) => field.managed !== true)).toBe(true);
      // The first field says where the provider issues it, as the panel's link
      // — except a sign-in (Mediavine, bead `ro-ujb9.96.7.6`): the operator's
      // own email and password, which nothing issues.
      if (provider.id === 'mediavine') expect(provider.fields.map((field) => field.kind)).toEqual(['text', 'password']);
      else expect(provider.fields[0]!.link?.url.startsWith('https://')).toBe(true);
    }
  });

  it('names an accepted connection for what was given, from one declaration (bead `ro-ujb9.96.7.25`)', () => {
    const named = Object.fromEntries(INTEGRATION_PROVIDERS.filter((provider) => provider.connect)
      .map((provider) => [provider.id, acceptedAs(provider)]));
    expect(named).toEqual({
      mediavine: 'sign-in', google: 'sign-in', 'bing-webmaster': 'key', dataforseo: 'key',
      calendar: 'url', discord: 'url', clarity: 'key', posthog: 'key', cloudflare: 'key',
    });
    // The stored credential's own way in decides where a provider has two:
    // Google on a service-account key is a key, and a sign-in is a sign-in.
    const google = integrationProvider('google')!;
    expect(acceptedAs(google, 'service-account')).toBe('key');
    expect(acceptedAs(google, 'oauth')).toBe('sign-in');
    expect(acceptedAs(integrationProvider('posthog')!, 'account-key')).toBe('key');
  });

  it('gives Discord one shared url that is itself the credential', () => {
    // Bead `ro-vu8d.18`: it was env-only because nobody had written a row, not
    // because of anything about Discord. One field, one data source, and the
    // field name IS the legacy binding so the importer is a copy.
    const discord = integrationProvider('discord')!;
    expect(discord.scope).toBe('shared');
    expect(discord.lanes).toEqual(['discord-webhooks']);
    expect(discord.fields.map((field) => field.name)).toEqual(['DISCORD_WEBHOOK_URL']);
    expect(discord.fields[0]!.kind).toBe('url');
    expect(discord.fields[0]!.secret).toBe(true);
    expect(credentialAuthState(discord, ['DISCORD_WEBHOOK_URL'])).toEqual({
      complete: true,
      auth: null,
      missing: [],
    });
    expect(credentialAuthState(discord, []).complete).toBe(false);
  });

  it('makes Clarity per-asset without a second credential shape', () => {
    // Bead `ro-vu8d.9`. The two obstacles that kept Clarity on its binding were
    // a per-asset token and no probe cheap enough to spend. Neither needed a
    // migration: the per-asset dimension is ONE `asset-map` field inside the one
    // row keyed on the provider, and the missing probe is declared missing.
    const clarity = integrationProvider('clarity')!;
    expect(clarity.scope).toBe('per-asset');
    expect(clarity.lanes).toEqual(['clarity']);
    expect(clarity.fields.map((field) => field.name)).toEqual(['CLARITY_TOKENS']);
    expect(clarity.fields[0]!.kind).toBe('asset-map');
    expect(clarity.test.cost).toBe('none');
    // No date can be honestly known for a map of per-asset tokens, so the card
    // prints the sentence rather than offering a field.
    expect(clarity.expiry.known).toBe('never');
  });

  it('connects PostHog with one account key in the panel, and keeps the older per-site map collecting', () => {
    // Bead `ro-ujb9.96.7.8` (was `ro-ghis.1`'s key per asset). One personal
    // API key for the account, typed once in the connect panel; region and
    // projects are discovered, and region and project id are NOT in the
    // credential — Start saves them on each site's Data sources entry.
    const posthog = integrationProvider('posthog')!;
    expect(posthog.scope).toBe('shared');
    expect(posthog.connect).toEqual({ kind: 'key', credential: 'api-key' });
    expect(posthog.lanes).toEqual(['posthog']);
    expect(posthog.fields.map((field) => field.name)).toEqual(['POSTHOG_API_KEY', 'POSTHOG_KEYS']);
    const [account, perSite] = posthog.fields;
    expect(account!.kind).toBe('password');
    expect(account!.secret).toBe(true);
    // The key's access is declared as chips beside the field, not a sentence.
    expect(account!.grants).toEqual(['Project: read', 'Insight: read', 'Query: read']);
    // The older map is never a form field again, but an install holding one
    // is still connected by it.
    expect(perSite!.kind).toBe('asset-map');
    expect(perSite!.managed).toBe(true);
    expect(credentialAuthState(posthog, ['POSTHOG_API_KEY'])).toEqual({ complete: true, auth: 'account-key', missing: [] });
    expect(credentialAuthState(posthog, ['POSTHOG_KEYS'])).toEqual({ complete: true, auth: 'site-keys', missing: [] });
    expect(credentialAuthState(posthog, []).complete).toBe(false);
    expect(posthog.test.cost).toBe('free');
    expect(posthog.expiry.known).toBe('never');
    expect(posthog.meter).toBeUndefined();
    expect(posthog.docRef).toBe('docs/11-integrations.md#posthog');
  });

  it('answers which assets a per-asset credential serves from one merged list', () => {
    // THE single representation (bead `ro-vu8d.9`): the catalog says who
    // declares the data source, the store says who has a key, and this is where
    // the two are paired — once, so the card and its form cannot disagree.
    const clarity = integrationProvider('clarity')!;
    const rows = credentialAssetRows({
      provider: clarity,
      credential: {
        ...summary('clarity'),
        source: 'store',
        fields: ['CLARITY_TOKENS'],
        assetsHeld: ['meals.example', 'stray.example'],
      },
      assets: [
        { id: 'meals.example', lanes: ['clarity'] },
        { id: 'nosh.example', lanes: ['clarity'] },
      ],
    });
    expect(rows).toEqual([
      { id: 'meals.example', lanes: ['clarity'], held: true },
      // Declared and waiting on a token — the most actionable row on the card.
      { id: 'nosh.example', lanes: ['clarity'], held: false },
      // A key stored for an asset nothing maps: named, never dropped, because
      // it is either a typo or a data source somebody forgot to declare.
      { id: 'stray.example', lanes: [], held: true },
    ]);
  });

  it('never marks a shared credential per-asset, whatever the store happens to hold', () => {
    // `held` is a fact about a per-asset credential. A shared one covers every
    // row at once, so a tick on some rows and not others would invent a
    // distinction the credential does not make.
    const rows = credentialAssetRows({
      provider: integrationProvider('bing-webmaster')!,
      credential: { ...summary('bing-webmaster'), assetsHeld: ['meals.example'] },
      assets: [{ id: 'meals.example', lanes: ['bing-webmaster'] }],
    });
    expect(rows).toEqual([{ id: 'meals.example', lanes: ['bing-webmaster'], held: false }]);
  });


});

// --- when a credential dies (bead `ro-vu8d.8`) -------------------------------

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const DAY = 86_400_000;

function metadata(over: Partial<CredentialMetadata> = {}): CredentialMetadata {
  return { account: null, scopes: [], connectedAt: null, expiresAt: null, expirySource: null, ...over };
}

describe('the expiry a card counts down', () => {
  it('says nothing at all where no date can be known, rather than guessing one', () => {
    // The whole acceptance test of `ro-vu8d.8`: a provider that cannot report an
    // expiry says so. `unstated` is what the card renders the provider's own
    // sentence for; it is never a zero, a dash, or a date derived from age.
    expect(credentialExpiry(null, NOW).state).toBe('unstated');
    expect(credentialExpiry(metadata(), NOW)).toMatchObject({
      state: 'unstated',
      expiresAt: null,
      msRemaining: null,
      daysRemaining: null,
    });
  });

  it('is quiet outside the warning window and warns inside it', () => {
    const far = credentialExpiry(
      metadata({ expiresAt: new Date(NOW + (CREDENTIAL_EXPIRY_WARN_DAYS + 1) * DAY).toISOString() }),
      NOW,
    );
    expect(far.state).toBe('ok');
    expect(far.daysRemaining).toBe(CREDENTIAL_EXPIRY_WARN_DAYS + 1);

    // Exactly on the horizon is INSIDE it: doc 15 flow C step 4 says flag at
    // T-14d, and a boundary that waited until 13 days would be flagging late.
    const edge = credentialExpiry(
      metadata({ expiresAt: new Date(NOW + CREDENTIAL_EXPIRY_WARN_DAYS * DAY).toISOString() }),
      NOW,
    );
    expect(edge.state).toBe('warn');
  });

  it('calls a date that has passed expired, and floors the days it has left', () => {
    expect(credentialExpiry(metadata({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW).state).toBe(
      'expired',
    );
    // 0 days left is the last day, not "already gone" — the chip reads
    // "Expires today" off exactly this.
    const today = credentialExpiry(
      metadata({ expiresAt: new Date(NOW + 6 * 3_600_000).toISOString() }),
      NOW,
    );
    expect(today).toMatchObject({ state: 'warn', daysRemaining: 0 });
  });

  it('treats an unreadable stored date as no date, never as an expired one', () => {
    // A defective timestamp is not evidence a credential died, and sending an
    // operator to reconnect a working provider is the more expensive mistake.
    expect(credentialExpiry(metadata({ expiresAt: 'sometime next week' }), NOW).state).toBe(
      'unstated',
    );
  });

  it('reports who supplied the date, so the card offers the right correction', () => {
    expect(
      credentialExpiry(
        metadata({ expiresAt: new Date(NOW + DAY).toISOString(), expirySource: 'operator' }),
        NOW,
      ).source,
    ).toBe('operator');
  });
});

// --- the prepaid credit a card ages (bead `ro-qpas`) -------------------------

describe('the account credit a card reports', () => {
  it('answers nothing where no balance has ever been seen', () => {
    // The card prints a SENTENCE for this, not a blank row: an account nobody
    // has read is not an account with no credit on it.
    expect(credentialBalance(null, NOW)).toBeNull();
    expect(credentialBalance(metadata(), NOW)).toBeNull();
  });

  it('reports the figure with how long ago it was seen', () => {
    const reading = credentialBalance(
      metadata({ balance: { usd: '18.72', seenAt: new Date(NOW - 2 * 3_600_000).toISOString() } }),
      NOW,
    );
    expect(reading).toMatchObject({ usd: '18.72', ageMs: 2 * 3_600_000 });
  });

  it('calls a sighting stale once two weekly refreshes have been missed (bead `ro-vu8d.27`)', () => {
    // The sweep refreshes the credit weekly and its read is silent when it
    // fails, so a figure that quietly ages is the failure mode. One missed
    // week is not an alarm; two is, and the card says so rather than showing
    // the number as though Monday could be planned on it.
    const DAY = 86_400_000;
    const at = (daysAgo: number) =>
      credentialBalance(
        metadata({ balance: { usd: '18.72', seenAt: new Date(NOW - daysAgo * DAY).toISOString() } }),
        NOW,
      );
    expect(at(2)?.stale).toBe(false);
    expect(at(13)?.stale).toBe(false);
    expect(at(15)?.stale).toBe(true);
  });

  it('drops a sighting whose instant cannot be read, rather than showing it undated', () => {
    // The whole rule of `ro-qpas`: a balance without its age is renderable as
    // though it were current, which is the one thing this must not do. So an
    // unreadable stamp answers exactly as "never seen" does.
    expect(
      credentialBalance(metadata({ balance: { usd: '18.72', seenAt: 'this morning' } }), NOW),
    ).toBeNull();
    expect(
      credentialBalance(
        metadata({ balance: { usd: 'not a number' as ExactUsd, seenAt: new Date(NOW).toISOString() } }),
        NOW,
      ),
    ).toBeNull();
  });

  it('never ages a sighting backwards', () => {
    // A clock that moved, or a stamp a moment ahead of this render, is not a
    // balance seen in the future — it reads as "just now".
    const reading = credentialBalance(
      metadata({ balance: { usd: '4', seenAt: new Date(NOW + 5_000).toISOString() } }),
      NOW,
    );
    expect(reading?.ageMs).toBe(0);
  });

  it('keeps the credit exact from the provider to the card: decimal text, never a float (ro-ujb9.76.4.4)', () => {
    // A JSON number's own digits are the value; anything else is none.
    for (const text of ['42.5', '0', '-0.25', '18.720000', '1.2e3']) expect(exactUsd(text)).toBe(text);
    for (const other of [42.5, '', ' 42.5', '42.', '.5', '$42.50', 'NaN', 'Infinity', '0x10', null]) {
      expect(exactUsd(other)).toBeNull();
    }
    // Cents from the decimal itself. The float the card used before rounds
    // a half-cent the wrong way: (1.005).toFixed(2) is '1.00'.
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(usdCents('1.005')).toBe('1.01');
    expect(usdCents('-0.125')).toBe('-0.13');
    expect(usdCents('12345678.123456')).toBe('12345678.12');
    expect(probeLine({ outcome: 'answered', facts: { creditUsd: '1.005' } })).toBe('Answered · $1.01 credit');
    expect(probeLine({ outcome: 'answered', facts: { databases: 1 } })).toBe('Answered · 1 database');
    expect(probeLine({ outcome: 'answered', facts: { databases: 2 } })).toBe('Answered · 2 databases');
  });
});

describe('every provider answers the expiry question', () => {
  it('declares whether a date can be known at all, as a value the card shows', () => {
    // The field is required in the type. A `never` provider shows "No expiry
    // date" rather than a countdown or a paragraph about why (bead
    // `ro-ujb9.96.6.1`); the reasons are doc 11's.
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(['flow', 'operator', 'never']).toContain(provider.expiry.known);
      expect(provider.expiry).not.toHaveProperty('note');
    }
  });

  it('puts the clock on Google alone, because it is the only credential with one', () => {
    expect(integrationProvider('google')!.expiry.known).toBe('flow');
    // The fix for the seven-day Testing grant is a link, beside the date.
    expect(integrationProvider('google')!.expiry.fix?.url).toContain('console.cloud.google.com');
    expect(GOOGLE_TESTING_GRANT_DAYS).toBe(7);
    // A calendar URL and a client secret die on an ACTION, not a date.
    expect(integrationProvider('calendar')!.expiry.known).toBe('never');
    expect(integrationProvider('google-oauth-app')!.expiry.known).toBe('never');
    // A Discord webhook dies on a deletion, which is an action too.
    expect(integrationProvider('discord')!.expiry.known).toBe('never');
    // A key with no stated lifetime still lets the operator record their own
    // rotation date — the difference between "cannot be known" and "nobody has
    // said yet".
    expect(integrationProvider('bing-webmaster')!.expiry.known).toBe('operator');
    expect(integrationProvider('dataforseo')!.expiry.known).toBe('operator');
  });
});

describe('the older single-asset binding (bead `ro-vu8d.24`)', () => {
  const clarity = integrationProvider('clarity')!;
  const map = clarity.fields.find((field) => field.kind === 'asset-map')!;
  // The installation's own data-source register (bead ro-ujb9.118): the OS
  // first with no Clarity lane, then two sites that have one.
  const REGISTER = {
    assets: {
      'home-os': { 'discord-webhooks': {} },
      'first.example': { clarity: { status: 'needs-setup' } },
      'second.example': { clarity: { status: 'needs-setup' } },
    },
  };

  it('is declared on the asset map it became an entry of, and nowhere else', () => {
    expect(map.legacyAssetBinding).toMatchObject({
      name: 'CLARITY_PROJECT_API_TOKEN',
      lane: 'clarity',
    });
    // It names no site: WHICH asset it serves is the installation's answer.
    expect(map.legacyAssetBinding).not.toHaveProperty('asset');
    // It is not a FIELD, so no form ever draws an input for it — the whole
    // reason it was left out of the catalog in the first place.
    expect(clarity.fields.map((field) => field.name)).not.toContain(
      'CLARITY_PROJECT_API_TOKEN',
    );
    // Exactly one field in the whole catalog declares one; a second would be a
    // second legacy shape somebody has to explain.
    const declared = INTEGRATION_PROVIDERS.flatMap((provider) =>
      provider.fields.filter((field) => field.legacyAssetBinding !== undefined),
    );
    expect(declared).toHaveLength(1);
  });

  it('serves the first site in the installation’s own register that has the lane', () => {
    // Beads ro-vu8d.24 / ro-ujb9.118: one rule, read over the installation's
    // register — never a site written into the catalog.
    expect(legacyBindingAsset('clarity', REGISTER)).toBe('first.example');
    // Register order decides, not the alphabet.
    expect(
      legacyBindingAsset('clarity', {
        assets: { 'zeta.example': { clarity: {} }, 'alpha.example': { clarity: {} } },
      }),
    ).toBe('zeta.example');
    // No site has the lane, or no register at all: the binding serves nobody.
    expect(legacyBindingAsset('clarity', { assets: { 'home-os': {} } })).toBeNull();
    expect(legacyBindingAsset('clarity', undefined)).toBeNull();
    expect(legacyBindingAsset('clarity', { assets: [] })).toBeNull();
  });

  it('reads as that asset’s key, so a working install stops saying Not connected', () => {
    const read = readEnvCredential(
      clarity,
      { CLARITY_PROJECT_API_TOKEN: 'single-project-token' },
      REGISTER,
    );
    expect(JSON.parse(read.fields.CLARITY_TOKENS!)).toEqual({
      'first.example': 'single-project-token',
    });
    expect(read.legacySlots).toEqual({ 'first.example': 'CLARITY_PROJECT_API_TOKEN' });
    // Which is what turns the card green: the map field is now held.
    expect(credentialAuthState(clarity, Object.keys(read.fields)).complete).toBe(true);
  });

  it('folds nothing when the installation’s register names no site for it', () => {
    const read = readEnvCredential(clarity, { CLARITY_PROJECT_API_TOKEN: 'single-project-token' });
    expect(read.fields).toEqual({});
    expect(read.legacySlots).toEqual({});
  });

  it('never overrides the map, and never rewrites one it cannot read', () => {
    const both = readEnvCredential(
      clarity,
      {
        CLARITY_TOKENS: JSON.stringify({ 'first.example': 'map-token' }),
        CLARITY_PROJECT_API_TOKEN: 'single-project-token',
      },
      REGISTER,
    );
    expect(JSON.parse(both.fields.CLARITY_TOKENS!)).toEqual({ 'first.example': 'map-token' });
    // The map answered, so no slot is relabelled.
    expect(both.legacySlots).toEqual({});

    // A map that does not parse is a refusal the operator has to see, not a
    // value to quietly replace.
    const broken = readEnvCredential(
      clarity,
      {
        CLARITY_TOKENS: '{not json',
        CLARITY_PROJECT_API_TOKEN: 'single-project-token',
      },
      REGISTER,
    );
    expect(broken.fields.CLARITY_TOKENS).toBe('{not json');
    expect(broken.legacySlots).toEqual({});
  });

  it('adds the asset beside the ones the map already names', () => {
    const read = readEnvCredential(
      clarity,
      {
        CLARITY_TOKENS: JSON.stringify({ 'second.example': 'second-token' }),
        CLARITY_PROJECT_API_TOKEN: 'single-project-token',
      },
      REGISTER,
    );
    expect(JSON.parse(read.fields.CLARITY_TOKENS!)).toEqual({
      'second.example': 'second-token',
      'first.example': 'single-project-token',
    });
  });

  it('leaves every other provider exactly as it reads today', () => {
    const bing = integrationProvider('bing-webmaster')!;
    expect(readEnvCredential(bing, { BING_WEBMASTER_API_KEY: 'key' })).toEqual({
      fields: { BING_WEBMASTER_API_KEY: 'key' },
      legacySlots: {},
    });
    expect(readEnvCredential(bing, { BING_WEBMASTER_API_KEY: '   ' })).toEqual({
      fields: {},
      legacySlots: {},
    });
  });
});

describe('a provider’s own reporting day (bead `ro-ujb9.118`)', () => {
  it('is declared in the catalog for Search Console only, as a zone the runtime knows', () => {
    const zone = providerReportingTimeZone('gsc');
    expect(zone).not.toBeNull();
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone! })).not.toThrow();
    // GA4 follows each property's own setting; no other lane has a fixed day.
    expect(providerReportingTimeZone('ga4')).toBeNull();
    expect(providerReportingTimeZone('bing-webmaster')).toBeNull();
  });
});

describe('the meter a card can honestly show (beads `ro-vu8d.25`, `ro-qpas`)', () => {
  it('is declared only where the OS already holds the evidence', () => {
    const metered = INTEGRATION_PROVIDERS.filter((provider) => provider.meter !== undefined);
    // The two metered providers, and only those. Clarity writes one manifest
    // row per call it makes; DataForSEO writes what each report cost onto the
    // same rows. Both are arithmetic over evidence this OS already holds.
    expect(metered.map((provider) => provider.id)).toEqual(['dataforseo', 'clarity']);
    expect(integrationProvider('clarity')!.meter).toMatchObject({
      window: 'asset-day',
      perAssetPerDay: 10,
      countedFrom: 'clarity',
    });
    expect(integrationProvider('dataforseo')!.meter).toMatchObject({
      window: 'portfolio-month',
      countedFrom: 'dataforseo',
    });
  });

  it('declares no dollar ceiling of its own — the operator owns that number', () => {
    // `monthly_caps.data_usd` is edited in /settings, so a copy here would be
    // stale the day it changed. It rides on the reading instead.
    expect(integrationProvider('dataforseo')!.meter).not.toHaveProperty('perAssetPerDay');
    expect(JSON.stringify(integrationProvider('dataforseo')!.meter)).not.toContain('25');
  });

  it('declares the meter as numbers only — the card draws the lines (bead `ro-ujb9.96.6.1`)', () => {
    // The prepaid credit is the vendor's own figure and draws as its own dated
    // line beside the cap's bar (bead `ro-qpas`); neither needs a sentence.
    for (const provider of INTEGRATION_PROVIDERS) {
      if (provider.meter) expect(provider.meter).not.toHaveProperty('note');
    }
  });

  it('says the budget is gone rather than reporting a negative one', () => {
    const meter = integrationProvider('clarity')!.meter!;
    expect(meter.window).toBe('asset-day');
    const cap = meter.window === 'asset-day' ? meter.perAssetPerDay : 0;
    expect(meterRemaining(cap, 0)).toBe(10);
    expect(meterRemaining(cap, 3)).toBe(7);
    expect(meterRemaining(cap, 10)).toBe(0);
    // A provider that let one extra call through is not a negative budget, and
    // neither is a month that overran its reserve — one floor, both windows.
    expect(meterRemaining(cap, 12)).toBe(0);
    expect(meterRemaining(25, 26.4)).toBe(0);
  });
});

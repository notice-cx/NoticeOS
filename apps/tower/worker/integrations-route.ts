// The Integrations page's write surface: connect, test and disconnect one
// provider (epic `ro-vu8d`, bead `ro-vu8d.1`).
//
//   GET    /api/integrations/providers           — every provider's state
//   PUT    /api/integrations/:provider/credential — store one credential (204)
//   DELETE /api/integrations/:provider/credential — forget it (204)
//   POST   /api/integrations/:provider/test       — one real probe
//   POST   /api/integrations/:provider/connect    — the connect panel's save and
//                                                   test: the provider is asked
//                                                   first, stored only if it
//                                                   accepts (ro-ujb9.96.7.1)
//   GET    /api/integrations/import-env           — can the legacy env
//                                                   credentials be imported HERE
//
// NOT `/api/integrations`, which already answers with the portfolio lane matrix
// the Health page renders (integrations-payload.ts). Two different questions —
// "is this lane producing data for this asset" and "does the OS hold a working
// credential for this provider" — so two payloads and two paths.
//
// The explicit standalone path preserves the LAN operator door. Hosted entries
// verify the original request and reload workspace admission at Tower and ingest
// before opening the scoped store. The private binding transports the call; it
// does not grant authority. Responses contain summaries rather than credential
// values; successful writes answer 204.

import type {
  ConnectCredentialResult,
  ConnectVerdict,
  CredentialProbe,
  CredentialStoreState,
  IntegrationMeter,
  ProviderMeterReading,
  DeleteCredentialResult,
  IntegrationCredentialsPayload,
  IntegrationProvider,
  IntegrationProviderAssetRef,
  IntegrationProviderStatus,
  PutCredentialInput,
  PutCredentialResult,
  PutSiteTokenInput,
  PutSiteTokenResult,
  SetCredentialExpiryInput,
  SetCredentialExpiryResult,
} from "@noticeos/contract";
import { INTEGRATION_PROVIDERS, integrationProvider } from "@noticeos/contract";
import { legacyBindingAsset } from "@noticeos/contract/configuration";
import type { IntegrationsConfig } from "../shared/integrations";
import { ENV_IMPORT_ELSEWHERE_DETAIL, type EnvImportAvailability } from "../shared/env-import";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/**
 * The four ingest RPCs these routes call. `env.INGEST` satisfies it
 * structurally; declaring the surface here rather than importing the binding's
 * type keeps this file free of Workers globals (the test project typechecks it
 * too) and lets a test bind a double — the same trick `AssetColumnWriter` and
 * `AssetLifecycleWriter` use next door.
 */
export interface IntegrationCredentialWriter {
  listCredentialSummaries(originalProof?: Request): Promise<CredentialStoreState>;
  putCredential(input: PutCredentialInput, originalProof?: Request): Promise<PutCredentialResult>;
  setCredentialExpiry(
    input: SetCredentialExpiryInput,
    originalProof?: Request,
  ): Promise<SetCredentialExpiryResult>;
  deleteCredential(provider: string, originalProof?: Request): Promise<DeleteCredentialResult>;
  probeCredential(provider: string, originalProof?: Request): Promise<CredentialProbe>;
  connectCredential(input: PutCredentialInput, originalProof?: Request): Promise<ConnectCredentialResult>;
  putSiteToken(input: PutSiteTokenInput, originalProof?: Request): Promise<PutSiteTokenResult>;
}

/** The path prefix all four routes share. */
export const INTEGRATIONS_API_PREFIX = "/api/integrations";

/** Where the provider list lives. Exported so a client and a test name it once. */
export const INTEGRATION_PROVIDERS_PATH = "/api/integrations/providers";

/**
 * Which assets are counting on each provider, straight out of
 * `config/integrations.json`.
 *
 * A lane the register marks `not-applicable` for an asset is excluded — the
 * point of the list is "what breaks if this credential is wrong", and a lane
 * that never applied to an asset breaks nothing there. Everything else counts,
 * including `needs-setup`: an asset waiting on this very credential is the most
 * relevant row on the card.
 */
export function assetsUsingProvider(
  config: IntegrationsConfig,
  lanes: readonly string[],
): IntegrationProviderAssetRef[] {
  const refs: IntegrationProviderAssetRef[] = [];
  for (const [assetId, cells] of Object.entries(config.assets ?? {})) {
    const used = lanes.filter(
      (lane) => cells[lane] !== undefined && cells[lane]!.status !== "not-applicable",
    );
    if (used.length > 0) refs.push({ id: assetId, lanes: used });
  }
  return refs;
}

/**
 * `GET /api/integrations/providers`.
 *
 * ALWAYS a fully-formed payload: every provider in catalog order, connected or
 * not, plus the two reasons a Save could fail before it is attempted (no
 * `CREDENTIALS_KEY`, or the migration not applied yet). A page an operator
 * opens to FIX something must never be able to go blank, and it must never
 * offer a form that cannot save.
 */
/**
 * What a metered provider has spent of its ceiling — the reader the route asks
 * for a provider that declares a meter (beads `ro-vu8d.25`, `ro-qpas`).
 *
 * IT TAKES THE METER, not a data-source id: the two metered providers have two
 * different windows (Clarity's calls per asset per day, DataForSEO's dollars
 * per calendar month) and the declaration is what says which reading to
 * produce. Passing a bare id would put that decision in the caller, where a
 * third provider would arrive as a second `if` nobody updated.
 *
 * A FUNCTION rather than the database, for the reason `IntegrationCredentialWriter`
 * is an interface: this file stays free of Workers globals and a test can hand
 * it a stub. The one implementation is `loadProviderMeter` in
 * metered-spend.ts, over the same report runs (`noticeos.archive_runs`) the
 * metered spend summary reads.
 */
export type ProviderMeterReader = (
  meter: IntegrationMeter,
  now: Date,
) => Promise<ProviderMeterReading>;

/**
 * The catalog entry as THIS installation reads it (bead `ro-ujb9.118`): an
 * older single-asset binding carries the asset it serves here —
 * `legacyBindingAsset` over the installation's own register — so the env
 * importer folds the token into the right map entry and the catalog itself
 * names no site. Every other provider passes through untouched.
 */
function providerForInstallation(
  provider: IntegrationProvider,
  config: IntegrationsConfig,
): IntegrationProvider {
  if (!provider.fields.some((field) => field.legacyAssetBinding !== undefined)) return provider;
  return {
    ...provider,
    fields: provider.fields.map((field) =>
      field.legacyAssetBinding === undefined
        ? field
        : {
            ...field,
            legacyAssetBinding: {
              ...field.legacyAssetBinding,
              asset: legacyBindingAsset(field.legacyAssetBinding.lane, config),
            },
          },
    ),
  };
}

export async function handleIntegrationProvidersRequest(
  request: Request,
  ingest: Pick<IntegrationCredentialWriter, 'listCredentialSummaries'>,
  config: IntegrationsConfig,
  now: Date,
  meterReader?: ProviderMeterReader,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError("method_not_allowed", 405);
  }
  let state: CredentialStoreState;
  try {
    state = await ingest.listCredentialSummaries();
  } catch {
    return jsonError("integration_credentials_unavailable", 503);
  }
  const summaries = new Map(state.summaries.map((summary) => [summary.provider, summary]));
  const providers: IntegrationProviderStatus[] = [];
  for (const provider of INTEGRATION_PROVIDERS) {
    const credential = summaries.get(provider.id);
    if (credential === undefined) continue;
    providers.push({
      provider: providerForInstallation(provider, config),
      credential,
      assets: assetsUsingProvider(config, provider.lanes),
      // A meter is read only where the provider declares one, and a store that
      // cannot answer costs this one block rather than the page: a card that
      // invented a budget would be worse than one that shows none.
      meter:
        provider.meter === undefined || meterReader === undefined
          ? null
          : await meterReader(provider.meter, now).catch(() => null),
    });
  }
  const payload: IntegrationCredentialsPayload = {
    generatedAt: now.toISOString(),
    keyPresent: state.keyPresent,
    blockers: state.blockers,
    keyReason: state.keyReason,
    providers,
  };
  return Response.json(payload, { headers: JSON_HEADERS });
}

/**
 * `PUT` and `DELETE /api/integrations/:provider/credential`.
 *
 * 204 on both, with no body. There is nothing to describe after a successful
 * save that would not be a copy of what the caller just sent, and the only
 * thing a caller could do with an echoed credential is leak it. The page
 * re-reads `GET /api/integrations/providers` for the new state.
 *
 * Error vocabulary matches the other write routes: 405 · 403 forbidden ·
 * 415 unsupported_media_type · 400 bad_request · 404 provider_not_found ·
 * 422 invalid_credential {field, detail} · 503 credentials_key_missing /
 * credential_store_unavailable {detail} · 500 credential_write_failed.
 */
export async function handleIntegrationCredentialRequest(
  request: Request,
  url: URL,
  ingest: Pick<IntegrationCredentialWriter, 'putCredential' | 'deleteCredential'>,
  provider: string,
): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  // The catalog is shared with ingest, so a 404 here and a refusal there can
  // never disagree — this one just arrives before the binding is called.
  if (integrationProvider(provider) === null) {
    return jsonError("provider_not_found", 404, { provider });
  }

  if (request.method === "DELETE") {
    let result: DeleteCredentialResult;
    try {
      result = await ingest.deleteCredential(provider);
    } catch {
      return jsonError("credential_delete_failed", 500);
    }
    if (!result.ok) {
      return jsonError("provider_not_found", 404, { provider });
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  if (!isJsonRequest(request)) {
    return jsonError("unsupported_media_type", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("invalid_credential", 422, { field: "body" });
  }
  const fields = (body as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return jsonError("invalid_credential", 422, {
      field: "fields",
      detail: "fields is an object of field name → value",
    });
  }

  let result: PutCredentialResult;
  try {
    // A CLAIM, not a check: ingest is the validator, and a second copy of the
    // field rules in this file would be a second answer.
    result = await ingest.putCredential({
      provider,
      fields: fields as Record<string, string>,
    });
  } catch {
    // Keep the service boundary opaque: the browser gets a code, not ingest's
    // internals, and treats it as "the credential was not saved".
    return jsonError("credential_write_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "unknown_provider") {
      return jsonError("provider_not_found", 404, { provider });
    }
    if (result.error === "key_missing") {
      // 503, not 500: nothing is wrong with the request. The install is missing
      // one env secret, and the detail is the sentence that fixes it.
      return jsonError("credentials_key_missing", 503, { detail: result.message });
    }
    if (result.error === "store_unavailable") {
      return jsonError("credential_store_unavailable", 503, { detail: result.message });
    }
    return jsonError("invalid_credential", 422, {
      field: result.issues[0]?.path ?? "fields",
      detail: result.issues[0]?.message,
    });
  }

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * `PUT /api/integrations/:provider/expiry` — when this credential stops working
 * (bead `ro-vu8d.8`).
 *
 * 204, like the credential write beside it, and for the same reason: the page
 * re-reads the providers payload for the new state rather than trusting an
 * echo. What is different is that this body carries NO SECRET at all — an
 * expiry is a public fact — so the route is the one write on this page an
 * operator could safely make with the encryption key missing, and the ingest
 * lets it through on exactly that basis.
 *
 * `{ "expiresAt": null }` is a legitimate body and means *this does not
 * expire*: it is how a published Google app switches off the Testing-mode
 * countdown, and it sticks through the next sign-in.
 *
 * Error vocabulary: 405 · 403 forbidden · 415 unsupported_media_type ·
 * 400 bad_request · 404 provider_not_found · 409 credential_not_expirable /
 * credential_not_stored · 422 invalid_credential {field, detail} ·
 * 500 credential_write_failed.
 */
export async function handleIntegrationExpiryRequest(
  request: Request,
  url: URL,
  ingest: Pick<IntegrationCredentialWriter, 'setCredentialExpiry'>,
  provider: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  if (integrationProvider(provider) === null) {
    return jsonError("provider_not_found", 404, { provider });
  }
  if (!isJsonRequest(request)) {
    return jsonError("unsupported_media_type", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("invalid_credential", 422, { field: "body" });
  }
  const raw = (body as { expiresAt?: unknown }).expiresAt;
  // `undefined` is a body that forgot to say anything, which is different from
  // `null` — the deliberate "there is no expiry". Only the second is an answer.
  if (raw !== null && typeof raw !== "string") {
    return jsonError("invalid_credential", 422, { field: "expiresAt", expected: "iso-instant-or-null" });
  }

  let result: SetCredentialExpiryResult;
  try {
    result = await ingest.setCredentialExpiry({ provider, expiresAt: raw });
  } catch {
    return jsonError("credential_write_failed", 500);
  }
  if (!result.ok) {
    if (result.error === "unknown_provider") {
      return jsonError("provider_not_found", 404, { provider });
    }
    if (result.error === "not_expirable") {
      return jsonError("credential_not_expirable", 409, { detail: result.message });
    }
    if (result.error === "not_stored") {
      return jsonError("credential_not_stored", 409, { detail: result.message });
    }
    return jsonError("invalid_credential", 422, {
      field: result.issues[0]?.path ?? "expiresAt",
      detail: result.issues[0]?.message,
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/**
 * `POST /api/integrations/:provider/test`.
 *
 * 200 with `{ ok, message, checkedAt }` whichever way the probe went: "the key
 * is wrong" is the ANSWER to the question the button asked, not a transport
 * failure, and a page that renders a red glyph plus a sentence needs the
 * sentence more than it needs a status code.
 */
export async function handleIntegrationTestRequest(
  request: Request,
  url: URL,
  ingest: Pick<IntegrationCredentialWriter, 'probeCredential'>,
  provider: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  if (integrationProvider(provider) === null) {
    return jsonError("provider_not_found", 404, { provider });
  }
  let probe: CredentialProbe;
  try {
    probe = await ingest.probeCredential(provider);
  } catch {
    return jsonError("credential_test_failed", 500);
  }
  return Response.json(probe, { headers: JSON_HEADERS });
}

/**
 * `POST /api/integrations/:provider/connect` — the connect panel's one press
 * (bead `ro-ujb9.96.7.1`).
 *
 * The ingest asks the provider FIRST and stores the credential only when it
 * accepts, so this answers the panel's question directly: 200 with
 * `{ verdict: "accepted", checkedAt, facts }`, or `{ verdict: "refused" |
 * "unreachable", checkedAt }` — a no is an answer, exactly as it is for the
 * Test button, and a panel that draws a state needs the verdict more than a
 * status code. Facts are counts and figures (Bing's verified sites,
 * DataForSEO's credit), never a value that was sent.
 *
 * Error vocabulary matches the credential PUT beside it: 405 · 403 forbidden ·
 * 415 · 400 bad_request · 404 provider_not_found · 409 connect_not_supported
 * (the provider keeps its own setup page) · 422 invalid_credential {field} ·
 * 503 credentials_key_missing / credential_store_unavailable ·
 * 500 credential_connect_failed.
 */
export async function handleIntegrationConnectRequest(
  request: Request,
  url: URL,
  ingest: Pick<IntegrationCredentialWriter, 'connectCredential'>,
  provider: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  const declared = integrationProvider(provider);
  if (declared === null) {
    return jsonError("provider_not_found", 404, { provider });
  }
  if (declared.connect?.kind !== "key") {
    return jsonError("connect_not_supported", 409, { provider });
  }
  if (!isJsonRequest(request)) {
    return jsonError("unsupported_media_type", 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  const fields = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { fields?: unknown }).fields
    : undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return jsonError("invalid_credential", 422, { field: "fields" });
  }

  let result: ConnectCredentialResult;
  try {
    // Validation is the ingest's, as it is for the PUT: one set of field rules.
    result = await ingest.connectCredential({ provider, fields: fields as Record<string, string> });
  } catch {
    return jsonError("credential_connect_failed", 500);
  }
  if (result.ok) {
    const answer: ConnectVerdict = result.verdict === "accepted"
      ? { verdict: "accepted", checkedAt: result.checkedAt, facts: result.facts }
      : { verdict: result.verdict, checkedAt: result.checkedAt };
    return Response.json(answer, { headers: JSON_HEADERS });
  }
  if (result.error === "unknown_provider") return jsonError("provider_not_found", 404, { provider });
  if (result.error === "not_supported") return jsonError("connect_not_supported", 409, { provider });
  if (result.error === "key_missing") return jsonError("credentials_key_missing", 503, { detail: result.message });
  if (result.error === "store_unavailable") return jsonError("credential_store_unavailable", 503, { detail: result.message });
  return jsonError("invalid_credential", 422, {
    field: result.issues[0]?.path ?? "fields",
    detail: result.issues[0]?.message,
  });
}

/**
 * `PUT /api/integrations/:provider/site-token` — one site's token, saved on its
 * own row of the connect panel (Clarity, bead `ro-ujb9.96.7.9`).
 *
 * Body `{ asset, token }`. The ingest merges it into the provider's per-site
 * map — the only place that map can be opened — so a paste never replaces
 * another site's token. 204 with no body, like the credential PUT beside it:
 * the page re-reads the providers payload rather than trusting an echo.
 *
 * Error vocabulary: 405 · 403 forbidden · 415 · 400 bad_request ·
 * 404 provider_not_found · 409 site_tokens_not_supported · 422
 * invalid_credential {field} · 503 credentials_key_missing /
 * credential_store_unavailable · 500 credential_write_failed.
 */
export async function handleIntegrationSiteTokenRequest(
  request: Request,
  url: URL,
  ingest: Pick<IntegrationCredentialWriter, 'putSiteToken'>,
  provider: string,
): Promise<Response> {
  if (request.method !== "PUT") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);
  const declared = integrationProvider(provider);
  if (declared === null) return jsonError("provider_not_found", 404, { provider });
  if (declared.connect?.kind !== "site-tokens") return jsonError("site_tokens_not_supported", 409, { provider });
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (record === null || typeof record.asset !== "string" || typeof record.token !== "string") {
    return jsonError("invalid_credential", 422, { field: record && typeof record.asset === "string" ? "token" : "asset" });
  }
  let result: PutSiteTokenResult;
  try {
    result = await ingest.putSiteToken({ provider, asset: record.asset, token: record.token });
  } catch {
    return jsonError("credential_write_failed", 500);
  }
  if (result.ok) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (result.error === "unknown_provider") return jsonError("provider_not_found", 404, { provider });
  if (result.error === "not_supported") return jsonError("site_tokens_not_supported", 409, { provider });
  if (result.error === "key_missing") return jsonError("credentials_key_missing", 503, { detail: result.message });
  if (result.error === "store_unavailable") return jsonError("credential_store_unavailable", 503, { detail: result.message });
  return jsonError("invalid_credential", 422, { field: result.issues[0]?.path ?? "token", detail: result.issues[0]?.message });
}

/**
 * `GET` and `POST /api/integrations/import-env` — the DEPLOYED answer (bead
 * `ro-vu8d.7`).
 *
 * In the local `os:up` dev server this path never reaches the Worker: the import
 * lane answers it first, in the Node process that has the operator's
 * `.dev.secrets.json` beside it (apps/tower/vite/env-import-lane.ts,
 * `enforce: "pre"`), and the Legacy env card gets a button.
 *
 * What is left here is the truth everywhere else. A deployed Worker has no
 * filesystem and no secrets file, so the card keeps showing the command, labelled
 * with where it runs — the same shape `/api/config` takes, and for the same
 * reason: an affordance that cannot work is worse than an honest explanation.
 */
export function handleEnvImportRequest(request: Request): Response {
  if (request.method === "GET") {
    return Response.json(
      { importable: false, reason: "elsewhere" } satisfies EnvImportAvailability,
      { headers: JSON_HEADERS },
    );
  }
  if (request.method === "POST") {
    return jsonError("no_secrets_file", 501, { detail: ENV_IMPORT_ELSEWHERE_DETAIL });
  }
  return jsonError("method_not_allowed", 405);
}

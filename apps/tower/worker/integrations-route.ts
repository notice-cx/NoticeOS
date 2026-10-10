// The Integrations page's write surface: connect, test and disconnect one
// provider.
//
//   GET    /api/integrations/providers           — every provider's state
//   PUT    /api/integrations/:provider/credential — store one credential (204)
//   DELETE /api/integrations/:provider/credential — forget it (204)
//   POST   /api/integrations/:provider/test       — one real probe
//   POST   /api/integrations/:provider/connect    — the connect panel's save and
//                                                   test: the provider is asked
//                                                   first, stored only if it
//                                                   accepts
//   GET    /api/integrations/import-env           — can the legacy env
//                                                   credentials be imported here
//
// Not `/api/integrations`, which answers with the lane matrix the Health page
// renders (integrations-payload.ts): a different question. Hosted entries
// verify the original request and reload workspace admission at Tower and
// ingest before opening the scoped store; the private binding transports the
// call and does not grant authority. Responses contain summaries, never
// credential values; successful writes answer 204.

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

/** The ingest RPCs these routes call. `env.INGEST` satisfies it structurally;
 * declaring the surface here keeps this file free of Workers globals and lets
 * a test bind a double. */
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

/** Which assets are counting on each provider, out of
 * `config/integrations.json`. A lane marked `not-applicable` for an asset is
 * excluded; everything else counts, including `needs-setup`. */
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
 * What a metered provider has spent of its ceiling — the reader the route
 * asks for a provider that declares a meter. It takes the meter, not a
 * data-source id, because the declaration says which reading to produce. The
 * one implementation is `loadProviderMeter` in metered-spend.ts.
 */
export type ProviderMeterReader = (
  meter: IntegrationMeter,
  now: Date,
) => Promise<ProviderMeterReading>;

/** The catalog entry as this installation reads it: an older single-asset
 * binding carries the asset it serves (`legacyBindingAsset` over the
 * installation's own register), so the catalog itself names no site. */
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
      // A store that cannot answer costs this one block rather than the page.
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
 * `PUT` and `DELETE /api/integrations/:provider/credential`. 204 on both, with
 * no body: an echoed credential could only leak. The page re-reads
 * `GET /api/integrations/providers` for the new state.
 *
 * Errors: 405 · 403 forbidden · 415 unsupported_media_type · 400 bad_request
 * · 404 provider_not_found · 422 invalid_credential {field, detail} · 503
 * credentials_key_missing / credential_store_unavailable {detail} · 500
 * credential_write_failed.
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
  // The catalog is shared with ingest; this 404 just arrives before the binding is called.
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
    // Ingest is the validator; the field rules live there only.
    result = await ingest.putCredential({
      provider,
      fields: fields as Record<string, string>,
    });
  } catch {
    // The browser gets a code, not ingest's internals.
    return jsonError("credential_write_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "unknown_provider") {
      return jsonError("provider_not_found", 404, { provider });
    }
    if (result.error === "key_missing") {
      // 503, not 500: nothing is wrong with the request.
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
 * `PUT /api/integrations/:provider/expiry` — when this credential stops
 * working. 204, like the credential write beside it. This body carries no
 * secret, so it is the one write an operator can make with the encryption key
 * missing. `{ "expiresAt": null }` means this does not expire, and sticks
 * through the next sign-in.
 *
 * Errors: 405 · 403 forbidden · 415 unsupported_media_type · 400 bad_request
 * · 404 provider_not_found · 409 credential_not_expirable /
 * credential_not_stored · 422 invalid_credential {field, detail} · 500
 * credential_write_failed.
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
  // `undefined` is a body that forgot to say anything; `null` is the
  // deliberate "there is no expiry".
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

/** `POST /api/integrations/:provider/test`. 200 with `{ ok, message,
 * checkedAt }` whichever way the probe went: "the key is wrong" is the answer
 * to the question, not a transport failure. */
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
 * `POST /api/integrations/:provider/connect` — the connect panel's one press.
 * The ingest asks the provider first and stores the credential only when it
 * accepts: 200 with `{ verdict: "accepted", checkedAt, facts }`, or
 * `{ verdict: "refused" | "unreachable", checkedAt }`. Facts are counts and
 * figures, never a value that was sent.
 *
 * Errors: 405 · 403 forbidden · 415 · 400 bad_request · 404
 * provider_not_found · 409 connect_not_supported · 422 invalid_credential
 * {field} · 503 credentials_key_missing / credential_store_unavailable · 500
 * credential_connect_failed.
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
 * `PUT /api/integrations/:provider/site-token` — one site's token, saved on
 * its own row of the connect panel (Clarity). Body `{ asset, token }`; the
 * ingest merges it into the provider's per-site map, so a paste never
 * replaces another site's token. 204 with no body.
 *
 * Errors: 405 · 403 forbidden · 415 · 400 bad_request · 404
 * provider_not_found · 409 site_tokens_not_supported · 422
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
 * `GET` and `POST /api/integrations/import-env` — the deployed answer. In the
 * local dev server the import lane answers first
 * (apps/tower/vite/env-import-lane.ts); a deployed Worker has no secrets
 * file, so the card keeps showing the command.
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

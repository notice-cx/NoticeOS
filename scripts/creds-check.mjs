#!/usr/bin/env node
// creds-check.mjs — the CREDENTIAL VERIFICATION RAILS for the accounts pass.
//
// The operator connects a provider on the Tower's /integrations page, where it
// lives encrypted in the store; workers/ingest/.dev.secrets.json (and legacy
// .dev.vars behind it) is the fallback for installs that have not moved yet.
// This proves each one the moment it lands (docs/15 flow C: "validation probe on
// save — one cheap real call; success shows a live data sample — proof, not a
// checkmark; failure shows the provider's actual error + the likely fix").
//
// IT ASKS THE RUNNING OS FIRST (beads ro-vu8d.10 / ro-vu8d.15). A store-held
// credential has no env binding to read and its plaintext must never leave the
// Worker, so for those lanes the OS is asked what it holds
// (GET /api/integrations/providers) and asked to prove it
// (POST /api/integrations/:provider/test — the card's own Test button). Every
// row names which source answered. With the OS stopped this is the env-only
// check and says so in one line, rather than reporting a working credential as
// missing.
//
// For each lane with credentials PRESENT it makes ONE cheap real probe and prints
// a scannable line: state glyph + lane + what the probe actually SAW (a live data
// sample) or the provider's real error + the likely fix. Lanes with no creds
// print a quiet "not configured yet" (not an error). It NEVER prints secret
// values — only names, presence, and the data a probe returned.
//
// Two lanes are probe-on-request only, because a probe COSTS something:
//   --lane clarity  — Clarity's 10-calls/project/DAY hard cap (doc 11); a probe
//                     burns 1 of them, so it never runs unasked.
//   --lane discord  — posts a real message to the operator channel (an external
//                     side effect), so it only fires when explicitly asked.
//
// At the end it reads config/integrations.json and, for every lane a probe
// actually PROVED for a property still marked needs-setup, prints the exact
// `pnpm config:apply --stdin` heredoc that records that setup proof. It never
// edits health status: collectors and their stored attempts own that truth. It
// SUGGESTS; it never applies (config:apply owns the y/N write).
//
// Plain Node ESM — no TypeScript, no build step, no dependencies. House style of
// os-up.mjs / config-apply.mjs: a tiny arg parser, plain logging, one job.
//
//   pnpm creds:check                # all configured non-explicit lanes
//   pnpm creds:check --lane bing     # probe just one lane (incl. clarity/discord)
//
// See scripts/README.md § Credentials for the slot table and behavior.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyBindingAsset } from '../packages/contract/src/configuration.mjs';
import { readablePath } from './installation.mjs';
import {
  DEFAULT_TOWER_ORIGIN,
  fetchIntegrationProviders,
  readDevSecretBindings,
} from './dev-secrets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
// This installation's copies, else the product defaults (bead ro-ujb9.125).
const PULL_JSON = readablePath('config/pull.json', { root: REPO_ROOT });
const INTEGRATIONS_JSON = readablePath('config/integrations.json', { root: REPO_ROOT });

// ── tiny logging (plain, no timestamps — this is an interactive CLI) ──────────
const c = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    }
  : {
      dim: (s) => s,
      bold: (s) => s,
      red: (s) => s,
      green: (s) => s,
      yellow: (s) => s,
      cyan: (s) => s,
    };

function out(line = '') {
  process.stdout.write(line + '\n');
}

// Row states → glyph. pass/fail/skip mirror flow C's proof / provider-error /
// quiet-not-configured. warn is used for a probe that ran but couldn't fully
// prove the lane (e.g. reachable but returned nothing to sample).
const GLYPH = {
  pass: () => c.green('✓'),
  fail: () => c.red('✘'),
  warn: () => c.yellow('!'),
  skip: () => c.dim('·'),
};
const LABEL_WIDTH = 24;

function printRow(row) {
  const glyph = (GLYPH[row.state] || GLYPH.skip)();
  const label = row.label.padEnd(LABEL_WIDTH);
  out(`  ${glyph}  ${label}  ${row.detail}`);
  for (const line of row.sub || []) out(`  ${' '.repeat(3)}${c.dim(line)}`);
}

/** Non-empty string present? (blank/whitespace slots count as absent.) */
function has(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Parse a JSON-map slot; {} on anything unparseable (a bad map ≠ configured). */
function jsonMap(v) {
  if (!has(v)) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function nonEmptyMap(v) {
  return Object.keys(jsonMap(v)).length > 0;
}

/**
 * The asset the single-project Clarity token belongs to: the product's one rule
 * (`legacyBindingAsset`, bead `ro-ujb9.118`) over this checkout's own
 * data-source register — the first site with a Clarity lane. Null when the
 * register names none (or cannot be read), and then the token serves nobody.
 */
function claritySingleTokenAsset() {
  try {
    return legacyBindingAsset('clarity', JSON.parse(readFileSync(INTEGRATIONS_JSON, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Clarity issues a data-export token PER PROJECT, so the canonical slot is the
 * asset→token map. `CLARITY_PROJECT_API_TOKEN` is the single-project shape the
 * operator configured first; it is accepted as a documented fallback bound to
 * one asset so an existing secret is not reported as "not configured".
 *
 * Precedence matches the one rule the product reads (bead `ro-vu8d.24`,
 * `readEnvCredential` in packages/contract, declared as the map field's
 * `legacyAssetBinding`): the MAP wins, because it is the only shape that can
 * express the portfolio. Each entry carries the slot it came from so a failure
 * names the variable the operator actually has to edit.
 */
function clarityTokens(vars) {
  const tokens = new Map();
  const singleAsset = has(vars.CLARITY_PROJECT_API_TOKEN) ? claritySingleTokenAsset() : null;
  if (singleAsset !== null) {
    tokens.set(singleAsset, {
      token: vars.CLARITY_PROJECT_API_TOKEN.trim(),
      slot: 'CLARITY_PROJECT_API_TOKEN',
    });
  }
  for (const [asset, token] of Object.entries(jsonMap(vars.CLARITY_TOKENS))) {
    if (has(token)) {
      tokens.set(asset, { token: token.trim(), slot: 'CLARITY_TOKENS' });
    }
  }
  return tokens;
}

const GOOGLE_SIGNAL_SLOT = 'GOOGLE_SIGNAL_ACCOUNTS';

/** Service-account-centric Google signal config. A private key is stored once;
 * each account declares the properties it can read and each property's
 * provider-specific identifier. */
function googleSignalGroups(vars, propertyField) {
  const accounts = jsonMap(vars[GOOGLE_SIGNAL_SLOT]);
  const groups = [];
  const owners = new Map();
  const duplicates = new Set();

  for (const [accountId, account] of Object.entries(accounts)) {
    const properties =
      account?.properties &&
      typeof account.properties === 'object' &&
      !Array.isArray(account.properties)
        ? account.properties
        : {};
    const targets = [];
    for (const [assetId, property] of Object.entries(properties)) {
      const providerId = property?.[propertyField];
      if (!has(providerId)) continue;
      if (owners.has(assetId)) {
        duplicates.add(assetId);
      } else {
        owners.set(assetId, accountId);
      }
      targets.push({ assetId, providerId: String(providerId) });
    }
    if (targets.length > 0) groups.push({ accountId, account, targets });
  }

  const duplicateAssets = new Set(
    [...duplicates].map((value) => String(value).split('\0')[0]),
  );
  return {
    groups: groups
      .map((group) => ({
        ...group,
        targets: group.targets.filter((target) => !duplicateAssets.has(target.assetId)),
      }))
      .filter((group) => group.targets.length > 0),
    duplicateAssets: [...duplicateAssets],
  };
}

function hasGoogleSignalTargets(vars, propertyField) {
  const { groups, duplicateAssets } = googleSignalGroups(vars, propertyField);
  return groups.length > 0 || duplicateAssets.length > 0;
}

// base64url without padding — for Google service-account JWTs.
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Normalize a site/property identifier to a bare host for comparison:
// strips a leading `sc-domain:`, the scheme, `www.`, and any path/trailing slash.
function normHost(s) {
  if (typeof s !== 'string') return '';
  let h = s.trim().toLowerCase();
  if (h.startsWith('sc-domain:')) h = h.slice('sc-domain:'.length);
  h = h.replace(/^[a-z]+:\/\//, '');
  h = h.replace(/^www\./, '');
  h = h.replace(/[/?#].*$/, '');
  return h.replace(/\/+$/, '');
}

/** Search Console site identifiers are exact resources. Keep URL-prefix paths
 * and their case intact; normalize domain casing and one trailing slash. */
function normGscSite(s) {
  if (typeof s !== 'string') return '';
  const value = s.trim();
  if (value.toLowerCase().startsWith('sc-domain:')) {
    return `sc-domain:${value.slice('sc-domain:'.length).toLowerCase().replace(/\/+$/, '')}`;
  }
  try {
    const url = new URL(value);
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

/** Best-effort short body for an error line — collapse whitespace, cap length. */
function snippet(s, n = 160) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Integrations register helpers (config/integrations.json).
// ─────────────────────────────────────────────────────────────────────────────
async function loadRegister() {
  try {
    return JSON.parse(await fs.readFile(INTEGRATIONS_JSON, 'utf8'));
  } catch {
    return { assets: {} };
  }
}

/** Property ids for which a lane is relevant (status !== not-applicable). */
function applicableAssets(register, integrationId) {
  const out = [];
  for (const [assetId, lanes] of Object.entries(register.assets || {})) {
    const st = lanes?.[integrationId]?.status;
    if (st && st !== 'not-applicable') out.push(assetId);
  }
  return out;
}

// RFC 6901 escape for a pointer token (asset ids have none of these today, but
// the pointer must be correct regardless).
function ptrEscape(tok) {
  return String(tok).replace(/~/g, '~0').replace(/\//g, '~1');
}

// ─────────────────────────────────────────────────────────────────────────────
// The changeset SUGGESTION (pure, exported for the unit test).
//
// proofs: [{ integrationId, assets: [assetId, …] }] — a lane's probe passed and
// PROVED those properties (Bing/GSC: verified-sites gate; GA4/Clarity: the one
// probed property; Discord: the System row).
//
// HONESTY GATE: a passed preflight probe proves CREDENTIAL + ENROLLMENT, not
// ongoing health. It may record that proof (note + since), but it never changes
// a status. Collector-backed health is derived from the collectors' runs;
// lanes without collectors remain needs-setup until end-to-end evidence exists.
//
// THE NOTE IS ONE LINE (bead `ro-ujb9.96.6.4`): the `asset-lane` register caps
// it at 90 characters and the Sources tab shows it whole, so the proof REPLACES
// the note — it is the newest thing that blocks nothing — rather than growing
// it into a log. The earlier note stays in git history.
// ─────────────────────────────────────────────────────────────────────────────

/** The one-line proof a passed probe records: setup proof only, never health. */
export function probeMarker(day) {
  return `Setup probe passed ${day} (creds:check)`;
}

export function suggestChangeset(proofs, register, nowIso) {
  const ops = [];
  let recorded = 0;
  const seen = new Set();
  const day = nowIso.slice(0, 10);
  for (const { integrationId, assets } of proofs || []) {
    for (const assetId of assets || []) {
      const key = `${assetId}/${integrationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = register?.assets?.[assetId]?.[integrationId];
      if (cell?.status !== 'needs-setup') continue; // only touch what a probe actually proved
      const base = `/assets/${ptrEscape(assetId)}/${ptrEscape(integrationId)}`;
      const marker = probeMarker(day);
      const curNote = String(cell.note ?? '');
      if (curNote.includes('probe passed') && curNote.includes('(creds:check)')) continue;
      ops.push(
        {
          kind: 'file-json-set',
          file: 'config/integrations.json',
          pointer: `${base}/note`,
          expect: cell.note ?? '',
          value: marker,
        },
        {
          kind: 'file-json-set',
          file: 'config/integrations.json',
          pointer: `${base}/since`,
          expect: cell.since ?? '',
          value: day,
        },
      );
      recorded++;
    }
  }
  if (ops.length === 0) return null;
  return {
    changeset: { version: 1, createdAt: nowIso, slug: `probe-proved-${day}`, ops },
    recorded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Probes. Each returns { rows: [Row], proofs: [{ integrationId, assets }] }.
// A Row is { state, label, detail, sub?[] }. Probes never throw for a provider
// error — they render it as a fail row; only a bug would escape.
// ─────────────────────────────────────────────────────────────────────────────

// Wrap fetch so a socket/DNS failure renders as a clean line, not a stack.
async function probeFetch(url, init, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, init);
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON — keep text */
    }
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    // Node's fetch wraps the real cause (ECONNREFUSED, ENOTFOUND, a sandbox
    // EPERM) as a generic "fetch failed" — surface the cause so the line is useful.
    const cause = err?.cause;
    return { networkError: cause?.code || cause?.message || err?.message || String(err) };
  }
}

// Self-report pull (ASSET_TOKENS): GET each enabled pull.json endpoint with that
// property's own token — the same map the ingest Worker checks its pushes
// against, because a property holds exactly one secret. Success = the counter
// names it returned (a live sample). `pullFile` is for tests, which read a
// fixture rather than the checkout's config (bead ro-ujb9.97).
export async function probePull(vars, { pullFile = PULL_JSON } = {}) {
  const rows = [];
  const tokens = jsonMap(vars.ASSET_TOKENS);
  let pull = [];
  try {
    pull = JSON.parse(await fs.readFile(pullFile, 'utf8'));
  } catch {
    pull = [];
  }
  const targets = (Array.isArray(pull) ? pull : []).filter(
    (e) => e && e.enabled !== false && has(tokens[e.asset]),
  );
  // ASSET_TOKENS is non-empty whenever any property can push, so "configured"
  // no longer implies a pullable target. Say so rather than printing nothing.
  if (targets.length === 0) {
    return {
      rows: [
        {
          state: 'skip',
          label: 'Self-report (pull)',
          detail:
            'no pullable property yet — every enabled config/pull.json entry needs its own ASSET_TOKENS entry',
        },
      ],
      proofs: [],
    };
  }
  for (const t of targets) {
    const label = `${t.asset} self-report`;
    const r = await probeFetch(t.url, {
      headers: { Authorization: `Bearer ${tokens[t.asset]}` },
    });
    if (r.networkError) {
      rows.push({
        state: 'fail',
        label,
        detail: `could not reach ${t.url} — ${r.networkError}`,
        sub: ['fix: confirm the property is deployed and reachable.'],
      });
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      rows.push({
        state: 'fail',
        label,
        detail: `HTTP ${r.status} — the property rejected the pull token`,
        sub: [
          `fix: ASSET_TOKENS["${t.asset}"] must equal ${t.asset}'s own` +
            ` ASSET_TOKEN wrangler secret — the one token gating its self-report` +
            ` endpoint and authenticating its pushes.` +
            ` See doc 11 §"Credential naming — the ASSET_TOKEN convention".`,
        ],
      });
      continue;
    }
    if (!r.ok) {
      rows.push({
        state: 'fail',
        label,
        detail: `HTTP ${r.status} — ${snippet(r.text) || 'no body'}`,
        sub: [`fix: check the self-report endpoint at ${t.url}.`],
      });
      continue;
    }
    // Success — pull a small live sample to show (proof, not a checkmark). The
    // shape follows the entry's declared `format`: a JSON envelope's metric
    // keys, or — for Prometheus — the COUNTER LABELS (e.g. table="profiles"),
    // because those are what config/pull.json's metric mapping consumes; the
    // bare metric names (d1_row_count) once read as a mapping mismatch to a
    // reviewer when they weren't one.
    const kind = t.format === 'envelope' ? 'metrics' : 'counters';
    let names = [];
    if (t.format === 'envelope') {
      names = Object.keys(r.json?.metrics || {});
    } else {
      const mapped = new Set(Object.values(t.metrics || {}).map((m) => m.counter));
      for (const line of (r.text || '').split('\n')) {
        const lbl = line.match(/\{[^}]*(?:table|counter)="([^"]+)"[^}]*\}\s+-?[\d.]/);
        if (lbl && !names.includes(lbl[1])) names.push(lbl[1]);
      }
      // Fall back to metric names if the body carries no recognizable labels.
      if (names.length === 0) {
        for (const line of (r.text || '').split('\n')) {
          const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+-?[\d.]/);
          if (m && !names.includes(m[1])) names.push(m[1]);
        }
      } else {
        // Name any mapped counter the body did NOT carry — that IS a real gap.
        const missing = [...mapped].filter((c) => c && !names.includes(c));
        if (missing.length > 0) {
          rows.push({
            state: 'warn',
            label,
            detail: `mapped counter${missing.length === 1 ? '' : 's'} absent from the response: ${missing.join(', ')}`,
            sub: ['fix: the config/pull.json metric mapping names a counter the endpoint no longer serves.'],
          });
        }
      }
    }
    if (names.length === 0) {
      rows.push({
        state: 'warn',
        label,
        detail: `reachable (HTTP ${r.status}) but returned no ${kind} to sample`,
      });
      continue;
    }
    const shown = names.slice(0, 3).join(', ');
    rows.push({
      state: 'pass',
      label,
      detail: `${names.length} ${kind} — ${shown}${names.length > 3 ? ', …' : ''}`,
    });
  }
  // The pull/self-report lane is the pulse pipeline, not a doc-11 catalog lane,
  // so it has no integrations.json cell to flip — no proof entry.
  return { rows, proofs: [] };
}

// Bing (BING_WEBMASTER_API_KEY): GetUserSites (apikey auth); success = verified
// site URLs, and NAME the applicable properties that aren't verified yet.
// Exported so the provider-error path can be exercised with a fake key without
// touching the operator's real .dev.vars.
export async function probeBing(vars, register) {
  const key = vars.BING_WEBMASTER_API_KEY;
  const url = `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(key)}`;
  const r = await probeFetch(url);
  const label = 'Bing Webmaster';
  if (r.networkError) {
    return {
      rows: [{ state: 'fail', label, detail: `could not reach Bing — ${r.networkError}` }],
      proofs: [],
    };
  }
  // The JSON endpoint wraps a success payload in `d`; an auth/other failure comes
  // back as an error object (shape varies — Message / ErrorCode) or a non-200.
  const sites = Array.isArray(r.json?.d) ? r.json.d : Array.isArray(r.json) ? r.json : null;
  if (!r.ok || !sites) {
    const msg =
      r.json?.Message ||
      r.json?.ErrorMessage ||
      r.json?.error?.Message ||
      snippet(r.text) ||
      `HTTP ${r.status}`;
    return {
      rows: [
        {
          state: 'fail',
          label,
          detail: `${msg}`,
          sub: [
            'fix: check BING_WEBMASTER_API_KEY — copy it from Bing Webmaster Tools' +
              ' → Settings → API access.',
          ],
        },
      ],
      proofs: [],
    };
  }
  const verifiedHosts = sites
    .map((s) => normHost(s?.Url || s?.url || s))
    .filter(Boolean);
  const applicable = applicableAssets(register, 'bing-webmaster');
  const proved = applicable.filter((a) => verifiedHosts.includes(normHost(a)));
  const missing = applicable.filter((a) => !proved.includes(a));
  const sub = [];
  if (missing.length) {
    sub.push(
      `not verified yet: ${missing.join(', ')} — add in Bing Webmaster or import from GSC.`,
    );
  }
  return {
    rows: [
      {
        state: 'pass',
        label,
        detail: `${verifiedHosts.length} verified site${verifiedHosts.length === 1 ? '' : 's'} — ${verifiedHosts.join(', ') || '(none)'}`,
        sub,
      },
    ],
    proofs: [{ integrationId: 'bing-webmaster', assets: proved }],
  };
}

// DataForSEO (login/password): the cheapest account-info endpoint (basic auth);
// success = remaining balance — it's a metered account, so balance IS the sample.
async function probeDataForSEO(vars) {
  const label = 'DataForSEO';
  const auth = Buffer.from(`${vars.DATAFORSEO_LOGIN}:${vars.DATAFORSEO_PASSWORD}`).toString('base64');
  const r = await probeFetch('https://api.dataforseo.com/v3/appendix/user_data', {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (r.networkError) {
    return {
      rows: [{ state: 'fail', label, detail: `could not reach DataForSEO — ${r.networkError}` }],
      proofs: [],
    };
  }
  const result = r.json?.tasks?.[0]?.result?.[0];
  const money = result?.money;
  if (r.status === 401 || r.json?.status_code === 40100 || r.json?.status_code === 40101) {
    return {
      rows: [
        {
          state: 'fail',
          label,
          detail: `${r.json?.status_message || 'authentication failed'} (HTTP ${r.status})`,
          sub: [
            'fix: check DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD — the API login/password' +
              ' from the DataForSEO dashboard (not your account email).',
          ],
        },
      ],
      proofs: [],
    };
  }
  if (!r.ok || !money) {
    return {
      rows: [
        {
          state: 'fail',
          label,
          detail: `${r.json?.status_message || snippet(r.text) || `HTTP ${r.status}`}`,
          sub: ['fix: verify the account is active and the API credentials are current.'],
        },
      ],
      proofs: [],
    };
  }
  const bal = typeof money.balance === 'number' ? money.balance.toFixed(2) : String(money.balance);
  // The balance proves only that the shared credential works. Per-property
  // health is derived from the five stored collector results, so this check
  // deliberately does not write a file-backed proof or claim a property is live.
  return {
    rows: [
      {
        state: 'pass',
        label,
        detail: `account OK — balance $${bal}`,
        sub: [
          'note: proves the shared key only; each property turns green from fresh' +
            ' stored collector results, not from this credential probe.',
        ],
      },
    ],
    proofs: [],
  };
}

const GOOGLE_SCOPES = {
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
};

/** Mint one short-lived access token from one configured service-account key.
 * Both GA4 and GSC use this exact JWT-bearer path with different read-only
 * scopes; callers reuse the result across every property tagged to the account. */
async function googleServiceAccountToken(accountId, account, scope, vars) {
  const credentialBinding = has(account?.service_account_binding)
    ? account.service_account_binding
    : null;
  const encoded =
    account?.service_account_b64 || (credentialBinding ? vars?.[credentialBinding] : '');
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(
      Buffer.from(encoded || '', 'base64').toString('utf8'),
    );
  } catch (err) {
    return {
      ok: false,
      detail: `service-account credential is not valid base64 JSON — ${err.message}`,
      fix: credentialBinding
        ? `replace the generated ${credentialBinding} value from the structured Google account map.`
        : `base64 the JSON key into ${GOOGLE_SIGNAL_SLOT}["${accountId}"].service_account_b64.`,
    };
  }
  if (!has(serviceAccount?.client_email) || !has(serviceAccount?.private_key)) {
    return {
      ok: false,
      detail: 'service-account JSON is missing client_email or private_key',
      fix: `replace ${GOOGLE_SIGNAL_SLOT}["${accountId}"].service_account_b64 with the full current JSON key.`,
    };
  }

  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  let assertion;
  try {
    const signingInput =
      `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
      b64url(JSON.stringify(claims));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    assertion = `${signingInput}.${b64url(signer.sign(serviceAccount.private_key))}`;
  } catch (err) {
    return {
      ok: false,
      detail: `could not sign the JWT with the service-account key — ${err.message}`,
      fix: 'check that the private_key survived the base64 round-trip intact.',
    };
  }

  const response = await probeFetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (response.networkError) {
    return {
      ok: false,
      detail: `could not reach Google token endpoint — ${response.networkError}`,
    };
  }
  if (!response.ok || !response.json?.access_token) {
    return {
      ok: false,
      detail:
        'token request failed — ' +
        (response.json?.error_description ||
          response.json?.error ||
          snippet(response.text) ||
          `HTTP ${response.status}`),
      fix: `confirm the JSON key for ${serviceAccount.client_email} is current and its APIs are enabled.`,
    };
  }
  return {
    ok: true,
    accessToken: response.json.access_token,
    clientEmail: serviceAccount.client_email,
  };
}

/** Probe every GA4 property tagged to each service account. One token is minted
 * per account, then reused across its properties. */
export async function probeGA4(vars) {
  const { groups, duplicateAssets } = googleSignalGroups(vars, 'ga4_property_id');
  const rows = duplicateAssets.map((assetId) => ({
    state: 'fail',
    label: `GA4 · ${assetId}`,
    detail: `property appears under more than one ${GOOGLE_SIGNAL_SLOT} service account`,
    sub: ['fix: choose one active service account per property.'],
  }));
  const proved = [];

  for (const { accountId, account, targets } of groups) {
    const auth = await googleServiceAccountToken(accountId, account, GOOGLE_SCOPES.ga4, vars);
    if (!auth.ok) {
      rows.push({
        state: 'fail',
        label: `GA4 · ${accountId}`,
        detail: auth.detail,
        sub: auth.fix ? [`fix: ${auth.fix}`] : undefined,
      });
      continue;
    }

    for (const { assetId, providerId } of targets) {
      const label = `GA4 · ${assetId}`;
      const report = await probeFetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(providerId)}:runReport`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
            metrics: [{ name: 'sessions' }],
          }),
        },
      );
      if (report.networkError) {
        rows.push({
          state: 'fail',
          label,
          detail: `could not reach the GA4 Data API — ${report.networkError}`,
        });
        continue;
      }
      if (!report.ok) {
        const message =
          report.json?.error?.message || snippet(report.text) || `HTTP ${report.status}`;
        const fix =
          report.status === 403
            ? `grant ${auth.clientEmail} Viewer on GA4 property ${providerId} (Admin → Property Access Management).`
            : `check ${GOOGLE_SIGNAL_SLOT}["${accountId}"].properties["${assetId}"].ga4_property_id = ${providerId}.`;
        rows.push({ state: 'fail', label, detail: message, sub: [`fix: ${fix}`] });
        continue;
      }
      const sessions = report.json?.rows?.[0]?.metricValues?.[0]?.value ?? '0';
      rows.push({
        state: 'pass',
        label,
        detail: `${sessions} sessions yesterday · service account ${accountId}`,
      });
      proved.push(assetId);
    }
  }
  return { rows, proofs: [{ integrationId: 'ga4', assets: proved }] };
}

/** Probe Search Console once per service account, then prove each exact site
 * resource tagged to it. The configured Full-user grant supplies property
 * access; the token remains read-only via webmasters.readonly. */
export async function probeGSC(vars) {
  const { groups, duplicateAssets } = googleSignalGroups(vars, 'gsc_site_url');
  const rows = duplicateAssets.map((assetId) => ({
    state: 'fail',
    label: `GSC · ${assetId}`,
    detail: `property appears under more than one ${GOOGLE_SIGNAL_SLOT} service account`,
    sub: ['fix: choose one active service account per property.'],
  }));
  const proved = [];

  for (const { accountId, account, targets } of groups) {
    const auth = await googleServiceAccountToken(accountId, account, GOOGLE_SCOPES.gsc, vars);
    if (!auth.ok) {
      rows.push({
        state: 'fail',
        label: `GSC · ${accountId}`,
        detail: auth.detail,
        sub: auth.fix ? [`fix: ${auth.fix}`] : undefined,
      });
      continue;
    }

    const sites = await probeFetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (sites.networkError) {
      rows.push({
        state: 'fail',
        label: `GSC · ${accountId}`,
        detail: `could not reach the Search Console API — ${sites.networkError}`,
      });
      continue;
    }
    if (!sites.ok) {
      rows.push({
        state: 'fail',
        label: `GSC · ${accountId}`,
        detail:
          `sites.list failed — ` +
          (sites.json?.error?.message || snippet(sites.text) || `HTTP ${sites.status}`),
        sub: [
          `fix: enable the Search Console API and grant ${auth.clientEmail} Full-user access to the configured properties.`,
        ],
      });
      continue;
    }

    const visibleSites = (Array.isArray(sites.json?.siteEntry) ? sites.json.siteEntry : [])
      .filter((entry) => entry.permissionLevel && entry.permissionLevel !== 'siteUnverifiedUser')
      .map((entry) => normGscSite(entry.siteUrl))
      .filter(Boolean);
    for (const { assetId, providerId } of targets) {
      const label = `GSC · ${assetId}`;
      if (visibleSites.includes(normGscSite(providerId))) {
        rows.push({
          state: 'pass',
          label,
          detail:
            `${providerId} readable · service account ${accountId} sees ` +
            `${visibleSites.length} site${visibleSites.length === 1 ? '' : 's'}`,
        });
        proved.push(assetId);
      } else {
        rows.push({
          state: 'fail',
          label,
          detail: `${providerId} is not readable by service account ${accountId}`,
          sub: [
            `fix: add ${auth.clientEmail} as a Full user on ${providerId}, or correct ` +
              `${GOOGLE_SIGNAL_SLOT}["${accountId}"].properties["${assetId}"].gsc_site_url.`,
          ],
        });
      }
    }
  }
  return { rows, proofs: [{ integrationId: 'gsc', assets: proved }] };
}

// Clarity (CLARITY_TOKENS, or CLARITY_PROJECT_API_TOKEN as the single-project
// fallback): explicit-only — the 10/project/DAY cap makes a probe expensive.
// Probe ONLY the first configured project (burns 1 of its 10).
async function probeClarity(vars) {
  const label = 'Microsoft Clarity';
  const tokens = clarityTokens(vars);
  const [asset, entry] = tokens.entries().next().value ?? [];
  if (!asset) {
    return {
      rows: [
        {
          state: 'skip',
          label,
          detail:
            'not configured yet — set CLARITY_TOKENS (asset → project token), or CLARITY_PROJECT_API_TOKEN for a single project',
        },
      ],
      proofs: [],
    };
  }
  out(
    c.yellow('  ⚠ ') +
      `Clarity has a hard 10 calls/project/day cap — this probes ${asset} and uses 1 of its 10 today.`,
  );
  const r = await probeFetch(
    'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1',
    { headers: { Authorization: `Bearer ${entry.token}` } },
  );
  if (r.networkError) {
    return {
      rows: [{ state: 'fail', label: `${label} (${asset})`, detail: `could not reach Clarity — ${r.networkError}` }],
      proofs: [],
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      rows: [
        {
          state: 'fail',
          label: `${label} (${asset})`,
          detail: `HTTP ${r.status} — Clarity rejected the token`,
          sub: [
            `fix: ${
              entry.slot === 'CLARITY_TOKENS'
                ? `CLARITY_TOKENS["${asset}"]`
                : 'CLARITY_PROJECT_API_TOKEN'
            } must be that project's data-export token (Clarity → Settings → Data export).`,
          ],
        },
      ],
      proofs: [],
    };
  }
  if (!r.ok) {
    return {
      rows: [
        {
          state: 'fail',
          label: `${label} (${asset})`,
          detail: `HTTP ${r.status} — ${snippet(r.text) || 'no body'}`,
          sub: ['fix: confirm the project has data-export enabled and the token is current.'],
        },
      ],
      proofs: [],
    };
  }
  const blocks = Array.isArray(r.json) ? r.json : [];
  const names = blocks.map((b) => b?.metricName).filter(Boolean).slice(0, 3);
  const detail = names.length
    ? `${blocks.length} metric blocks — ${names.join(', ')}${blocks.length > 3 ? ', …' : ''} (last 1d)`
    : `export reachable (HTTP ${r.status})`;
  return {
    rows: [{ state: 'pass', label: `${label} (${asset})`, detail }],
    proofs: [{ integrationId: 'clarity', assets: [asset] }],
  };
}

// PostHog (POSTHOG_KEYS, bead ro-ghis.1): one project-settings read per keyed
// asset — no query runs, so PostHog's hourly query budget is untouched. The
// region and project are not secrets and come from config/integrations.json
// (the asset's Sources tab), never from this file. No proof is offered for a
// posture change: PostHog's health is derived from the daily archive's runs.
async function probePosthog(vars) {
  const label = 'PostHog';
  const keys = Object.entries(jsonMap(vars.POSTHOG_KEYS)).filter(([, key]) => has(key));
  if (keys.length === 0) {
    return {
      rows: [{ state: 'skip', label, detail: 'not configured yet — connect a key per asset on /integrations (POSTHOG_KEYS is the legacy fallback)' }],
      proofs: [],
    };
  }
  let register = {};
  try {
    register = JSON.parse(await fs.readFile(INTEGRATIONS_JSON, 'utf8'));
  } catch {
    // Unreadable register: every asset below reads as having no project saved.
  }
  const rows = [];
  for (const [asset, key] of keys) {
    const cell = register?.assets?.[asset]?.posthog ?? {};
    if (!['us', 'eu'].includes(cell.host) || !/^[1-9][0-9]{0,11}$/.test(String(cell.projectId ?? ''))) {
      rows.push({ state: 'skip', label: `${label} (${asset})`, detail: 'no PostHog region and project saved on this asset’s Sources tab' });
      continue;
    }
    const r = await probeFetch(`https://${cell.host}.posthog.com/api/projects/${cell.projectId}/`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
    if (r.networkError) {
      rows.push({ state: 'fail', label: `${label} (${asset})`, detail: `could not reach PostHog — ${r.networkError}` });
    } else if (r.status === 401 || r.status === 403) {
      rows.push({
        state: 'fail',
        label: `${label} (${asset})`,
        detail: `HTTP ${r.status} — PostHog refused the key`,
        sub: [`fix: POSTHOG_KEYS["${asset}"] must be a personal API key for project ${cell.projectId} with read access to Query and Project.`],
      });
    } else if (!r.ok) {
      rows.push({ state: 'fail', label: `${label} (${asset})`, detail: `HTTP ${r.status} — ${snippet(r.text) || 'no body'}` });
    } else {
      const zone = typeof r.json?.timezone === 'string' ? `, ${r.json.timezone}` : '';
      rows.push({ state: 'pass', label: `${label} (${asset})`, detail: `project ${cell.projectId} (${cell.host}${zone}) — settings read, no query run` });
    }
  }
  return { rows, proofs: [] };
}

// Discord (DISCORD_WEBHOOK_URL): explicit-only — posts ONE clearly-labeled test
// message to the operator channel (an external side effect).
//
// THE SENTENCE IS MIRRORED, not invented here: `DISCORD_TEST_MESSAGE` in
// workers/ingest/src/credential-probes.ts is the same line the card's Test
// button posts, and this file cannot import that TypeScript. Two wordings would
// be two things an operator has to recognize in their own channel.
const DISCORD_TEST_MESSAGE =
  'NoticeOS connection test — nothing is wrong, you can ignore this.';

/** The Discord webhook is portfolio-wide, so a delivered test proves the lane
 * on every row of the register that carries it — in practice the OS's own row.
 * Read from the register, never an asset id written here (bead ro-ujb9.120). */
export async function probeDiscord(vars, register) {
  const label = 'Discord';
  out(c.yellow('  ⚠ ') + 'This posts one real message to the operator channel (labeled "ignore").');
  const r = await probeFetch(vars.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: DISCORD_TEST_MESSAGE }),
  });
  if (r.networkError) {
    return {
      rows: [{ state: 'fail', label, detail: `could not reach Discord — ${r.networkError}` }],
      proofs: [],
    };
  }
  // A webhook post returns 204 No Content on success.
  if (r.status === 204 || r.ok) {
    return {
      rows: [{ state: 'pass', label, detail: `test message delivered (HTTP ${r.status}) — check the channel` }],
      proofs: [{ integrationId: 'discord-webhooks', assets: applicableAssets(register ?? {}, 'discord-webhooks') }],
    };
  }
  return {
    rows: [
      {
        state: 'fail',
        label,
        detail: `HTTP ${r.status} — ${r.json?.message || snippet(r.text) || 'rejected'}`,
        sub: ['fix: DISCORD_WEBHOOK_URL should be the full https://discord.com/api/webhooks/… URL.'],
      },
    ],
    proofs: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar feeds (CALENDAR_FEEDS): GET each configured secret ICS link and say,
// per LABEL, whether it still answers with a calendar.
//
// WHY THIS LANE EXISTS. Every other credential here fails loudly somewhere. A
// calendar link does not. Google's "secret address in iCal format" is revoked by
// resetting it, after which the old address answers 404 — or 200 with a sign-in
// page — forever; ingest reports that as one `calendar_feed_failed` line inside a
// Worker log, and the Wall's meetings panel blanks BY DESIGN when `feedsOk` is 0.
// So a rotated link is silent in every place the operator actually looks, until
// they miss a meeting. This lane is the place that names it.
//
// THE URL IS THE CREDENTIAL. Whoever holds one of these links reads the whole
// calendar, with no account, until it is reset. So a row carries the operator's
// LABEL and a failure class and nothing else: not the address in a detail, not in
// a fix, not out of an error object (see the catch in `fetchCalendarFeed`), and
// not out of the raw slot value when that value turns out not to be JSON — a
// bare url pasted into the slot is a common way to get there. `withoutFeedUrls`
// is the second lock on that, in the same spirit as the calendar module's charset
// check on a pinned color.
//
// THE FAILURE CLASSES ARE INGEST'S OWN CODES — `http_403`, `timeout`,
// `not_calendar`, `too_large`, `invalid_url`, `config_missing_url`. The word this
// lane prints is the word the Worker would log for the same feed, so the checker
// and the running lane can never describe one broken link two ways.
//
// PARSED HERE RATHER THAN IMPORTED. workers/ingest/src/calendar.ts owns the
// acceptance rules, but `parseFeedTargets` is not exported, the module is
// TypeScript, and it imports `@noticeos/contract` and reads a Worker `env` —
// pulling it into a plain-Node script with no build step would drag worker types
// behind it, and exporting a shared helper would restructure a module another
// bead owns. The few acceptance lines are therefore duplicated below and marked.
// The REQUEST SHAPE is duplicated for the same reason and matters as much: an
// origin that content-negotiates would answer a different `accept` differently,
// and a tighter timeout than ingest's would call a slow-but-working feed dead.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `CALENDAR_USER_AGENT` in workers/ingest/src/calendar.ts — the origin
 * must see the same reader this OS sends when it really reads the calendar. */
const CALENDAR_USER_AGENT =
  'NoticeOS-Calendar/1.0 (+https://www.notice.cx; operator dashboard read)';

/** Mirrors that module's `REQUEST_TIMEOUT_MS`. Deliberately the SAME ceiling and
 * not a tighter one: a feed this check calls dead is a feed ingest calls dead. */
const CALENDAR_TIMEOUT_MS = 10_000;

/** Mirrors that module's `RESPONSE_BYTE_LIMIT`. */
const CALENDAR_BYTE_LIMIT = 4 * 1024 * 1024;

/** Mirrors `feedField`: a string field of an object entry, or null. */
function calendarFeedField(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const read = value[field];
  return typeof read === 'string' ? read : null;
}

/**
 * What this report is allowed to call a feed.
 *
 * The label is the operator's own word for the calendar and, with the color, the
 * only part of an entry that ever travels — except when the map has been written
 * inside out (`{ "<url>": "<label>" }`), which puts the credential in the KEY,
 * and keys are the one thing this report prints. A label that looks like an
 * address is withheld and the feed is named by position instead.
 *
 * `quotable` is true only when the printable form IS the operator's key, so a
 * fix line naming `CALENDAR_FEEDS["…"]` never names a key that does not exist.
 */
function displayFeedLabel(key, index) {
  // Control and format characters out, whitespace collapsed: a label is one
  // line of a report, and a bidi override has no business steering it.
  const flat = key.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return { display: `feed #${index + 1} (unnamed)`, quotable: false };
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(flat) || /private-[A-Za-z0-9_-]{10,}/.test(flat)) {
    return {
      display: `feed #${index + 1} (label withheld — it looks like a url)`,
      quotable: false,
    };
  }
  if (flat.length > 40) return { display: `${flat.slice(0, 39)}…`, quotable: false };
  return { display: flat, quotable: flat === key };
}

/**
 * Mirrors `parseFeedTargets` in workers/ingest/src/calendar.ts, so the checker
 * and the lane can never disagree about what is configured:
 *
 * - absent or blank → no calendars at all (the lane's quiet not-configured line).
 * - unparseable, or parsed to something that is not an object → zero configured
 *   feeds, which ingest logs as `config_unparseable` / `config_not_a_map`. Its
 *   own state: the operator DID set the slot, and the Wall cannot tell that from
 *   never having configured one.
 * - a bare string entry is exactly `{ url }`; unknown keys are ignored.
 * - a named entry with no usable url stays COUNTED — ingest puts it in
 *   `feedsConfigured` and never in `feedsOk`, so the typo is visible rather than
 *   indistinguishable from a calendar that was never configured.
 */
function parseCalendarFeeds(raw) {
  if (!has(raw)) return { config: 'absent', targets: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: 'unparseable', targets: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: 'not_a_map', targets: [] };
  }

  const targets = Object.entries(parsed).map(([key, value], index) => {
    const named = typeof value === 'string' ? value : calendarFeedField(value, 'url');
    return {
      key,
      ...displayFeedLabel(key, index),
      url: named === null || named.trim() === '' ? null : named.trim(),
    };
  });
  return { config: 'ok', targets };
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* nothing left to discard */
  }
}

/**
 * One feed, one GET, one coarse verdict. Everything about the request — headers,
 * redirect handling, timeout, byte ceiling, and what counts as a calendar — is
 * ingest's, so that "this link works" means the same thing in both places.
 */
async function fetchCalendarFeed(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { code: 'invalid_url' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { code: 'unsupported_scheme' };
  }

  let response;
  try {
    response = await fetch(target.href, {
      headers: {
        accept: 'text/calendar, text/plain;q=0.5',
        'user-agent': CALENDAR_USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
    });
  } catch (error) {
    // Deliberately NOT the message or the cause, unlike `probeFetch` above: a
    // transport error may carry the request url, and here the url is the secret.
    // The error's NAME is all that is read, and only to tell a timeout apart.
    const name = error?.name;
    return { code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
  }

  if (!response.ok) {
    await discardBody(response);
    return { code: `http_${response.status}` };
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CALENDAR_BYTE_LIMIT) {
    await discardBody(response);
    return { code: 'too_large' };
  }

  let text;
  try {
    text = await response.text();
  } catch {
    return { code: 'unreachable' };
  }
  if (text.length > CALENDAR_BYTE_LIMIT) return { code: 'too_large' };

  // Ingest's own `sawCalendar` rule: a `BEGIN:VCALENDAR` property line. A folded
  // continuation starts with a space and so cannot match, exactly as there. The
  // sign-in page a reset link serves has no such line, which is the whole point.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!/^BEGIN:VCALENDAR/im.test(normalized)) return { code: 'not_calendar' };
  return {
    ok: true,
    bytes: text.length,
    events: (normalized.match(/^BEGIN:VEVENT/gim) ?? []).length,
  };
}

/** The slot the operator has to edit, named only when naming it is exact. */
function feedSlot(feed) {
  return feed.quotable
    ? `CALENDAR_FEEDS[${JSON.stringify(feed.key)}]`
    : "that entry's url in CALENDAR_FEEDS";
}

/**
 * The only real remedy for a link that has been reset: hold the current one.
 * One line, because several feeds can carry this fix in the same report and the
 * WHY behind it is said once, on the lane's own row.
 */
function freshLinkFix(feed) {
  return (
    `fix: put a current "Secret address in iCal format" in ${feedSlot(feed)} (Google` +
    ' Calendar → Settings → that calendar → Integrate calendar), then' +
    ' `pnpm dev:secrets:sync` and restart ingest.'
  );
}

/** One feed's verdict as a row body: the class ingest would log, in plain words,
 * plus the fix when there is one to name. */
function describeFeed(result, feed) {
  if (result.ok) {
    const kb = Math.max(1, Math.round(result.bytes / 1024));
    return {
      state: 'pass',
      detail: `${result.events} event${result.events === 1 ? '' : 's'} in ${kb} KB of ICS`,
    };
  }
  const code = result.code;
  if (code === 'timeout') {
    return {
      state: 'fail',
      detail: `timeout — no answer within ${CALENDAR_TIMEOUT_MS / 1000}s, the same ceiling ingest gives a feed`,
      fix:
        'fix: retry. Google serves these links out of its own cache, so a good one' +
        ' answers fast; one that keeps timing out is throttled or its host is down.',
    };
  }
  if (code === 'unreachable') {
    return {
      state: 'fail',
      detail: 'unreachable — DNS or socket failure before any response',
      fix: "fix: check this machine's network, then that the host in that entry is the one you meant.",
    };
  }
  if (code === 'not_calendar') {
    return {
      state: 'fail',
      detail:
        'not_calendar — HTTP 200, but the body is not a calendar; a reset Google' +
        ' link answers with a sign-in page, which is exactly this',
      fix: freshLinkFix(feed),
    };
  }
  if (code === 'too_large') {
    return {
      state: 'fail',
      detail: "too_large — past the 4 MB ceiling ingest refuses to expand in a Worker's memory",
      fix: 'fix: a body that big is almost certainly not a calendar — check what that entry points at.',
    };
  }
  if (code === 'invalid_url' || code === 'unsupported_scheme') {
    return {
      state: 'fail',
      detail:
        code === 'invalid_url'
          ? 'invalid_url — the configured value is not a url, so ingest never fetches it'
          : 'unsupported_scheme — the configured url is not http(s), so ingest never fetches it',
      fix: freshLinkFix(feed),
    };
  }

  const status = Number(code.slice('http_'.length));
  if (status === 401 || status === 403) {
    return {
      state: 'fail',
      detail: `${code} — the calendar host rejected the link`,
      fix: freshLinkFix(feed),
    };
  }
  if (status === 404 || status === 410) {
    return {
      state: 'fail',
      detail: `${code} — nothing is served at that address any more`,
      fix: freshLinkFix(feed),
    };
  }
  if (status === 429) {
    return {
      state: 'fail',
      detail: `${code} — the host is throttling this reader`,
      fix:
        'fix: nothing to change. Ingest holds one fetch round for 5 minutes against' +
        " the Wall's 60s poll, so this is normally transient.",
    };
  }
  if (status >= 500) {
    return {
      state: 'fail',
      detail: `${code} — the calendar host failed`,
      fix: 'fix: provider-side. Retry; if it persists the calendar host is having an outage.',
    };
  }
  return {
    state: 'fail',
    detail: `${code} — the calendar host refused the request`,
    fix: freshLinkFix(feed),
  };
}

/**
 * The second lock: every line this lane emits, with any configured address
 * removed. The rows are built not to contain one; this is what makes that a
 * property of the output rather than a promise about the code above.
 *
 * Only values carrying a scheme are scrubbed — a value without one was never
 * fetchable and is not an address, and blanket-replacing a short garbage value
 * would eat ordinary words out of the fix lines.
 */
function withoutFeedUrls(rows, urls) {
  const secrets = new Set();
  for (const url of urls) {
    if (typeof url !== 'string' || !url.includes('://')) continue;
    secrets.add(url);
    try {
      secrets.add(new URL(url).href);
    } catch {
      /* the row for that feed already says it is not a url */
    }
  }
  if (secrets.size === 0) return rows;
  const scrub = (text) =>
    [...secrets].reduce((acc, secret) => acc.split(secret).join('<redacted url>'), String(text));
  return rows.map((row) => ({
    ...row,
    label: scrub(row.label),
    detail: scrub(row.detail),
    sub: row.sub?.map(scrub),
  }));
}

export async function probeCalendar(vars) {
  const label = 'Calendar feeds';
  const { config, targets } = parseCalendarFeeds(vars.CALENDAR_FEEDS);

  if (config === 'absent') {
    return {
      rows: [{ state: 'skip', label, detail: 'not configured yet — set CALENDAR_FEEDS' }],
      proofs: [],
    };
  }
  if (config !== 'ok') {
    // Set but unreadable, which is NOT the quiet not-configured line: ingest
    // reads zero calendars and the Wall shows the same blank panel it shows for a
    // calendar nobody ever configured. The raw value is never echoed — pasting a
    // bare secret url into the slot is one of the ways to land here.
    return {
      rows: [
        {
          state: 'fail',
          label,
          detail:
            config === 'unparseable'
              ? 'config_unparseable — CALENDAR_FEEDS is set but is not parseable JSON, so ingest reads zero calendars'
              : 'config_not_a_map — CALENDAR_FEEDS is set but is not a JSON object, so ingest reads zero calendars',
          sub: [
            'fix: CALENDAR_FEEDS is a JSON map of label → secret ICS url, or label →' +
              ' { url, color?, email? } — not a bare url and not an array. See' +
              ' workers/ingest/.dev.secrets.example.json for the shape.',
          ],
        },
      ],
      proofs: [],
    };
  }
  if (targets.length === 0) {
    return {
      rows: [
        {
          state: 'warn',
          label,
          detail:
            'CALENDAR_FEEDS is an empty map — no calendar is configured, so the Wall' +
            ' shows its no-calendars state rather than a failure',
        },
      ],
      proofs: [],
    };
  }

  const rows = [];
  let answered = 0;
  for (const feed of targets) {
    const outcome =
      feed.url === null
        ? {
            state: 'fail',
            detail: 'config_missing_url — the entry names no url, so it can never be ok',
            fix:
              `fix: give ${feedSlot(feed)} the calendar's secret ICS url. Ingest still` +
              ' counts this entry as configured, so it reads on the Wall as one degraded' +
              ' feed rather than a missing one.',
          }
        : describeFeed(await fetchCalendarFeed(feed.url), feed);
    if (outcome.state === 'pass') answered += 1;
    rows.push({
      state: outcome.state,
      label: `Calendar · ${feed.display}`,
      detail: outcome.detail,
      sub: outcome.fix ? [outcome.fix] : undefined,
    });
  }

  // The sentence that would have named the rotation. `feedsOk` 0 is the state the
  // meetings panel renders as nothing at all, so it has to be said out loud here —
  // and it is where the shared cause belongs, since one reset takes out every
  // calendar whose address came from the same "Reset private URLs" click.
  if (answered === 0) {
    rows.push({
      state: 'fail',
      label,
      detail:
        `0 of ${targets.length} feed${targets.length === 1 ? '' : 's'} answered with a calendar —` +
        " the Wall's meetings panel stays blank while feedsOk is 0, which is why a" +
        ' rotated link is otherwise silent',
      sub:
        targets.length > 1
          ? [
              'note: resetting a private URL invalidates the old address everywhere it' +
                ' was pasted, at once — several calendars going dark together is usually' +
                ' one reset rather than several failures.',
            ]
          : undefined,
    });
  }

  // Calendars are current display state, not evidence: nothing writes signal_runs
  // and there is no config/integrations.json cell to record — same reason the
  // pull lane proves nothing. See "WHY AN RPC AND NOT A LANE" in calendar.ts.
  return { rows: withoutFeedUrls(rows, targets.map((feed) => feed.url)), proofs: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE HALF (beads ro-vu8d.10 / ro-vu8d.15).
//
// Since the credential store landed, a provider can be fully connected with NO
// env binding at all — entered on the Tower's Integrations page and kept
// encrypted in D1. Reading only `.dev.secrets.json` made this script report
// exactly those as "not configured yet": a false red on the one tool the repo
// tells an operator to trust, and the more the epic succeeds the more lanes it
// misreports.
//
// So the checker ASKS THE RUNNING OS instead of re-deriving the answer. It never
// learns to decrypt — `CREDENTIALS_KEY` must not leave the Worker — which means
// a store-held credential is also PROVED by the OS: the same
// `POST /api/integrations/:provider/test` the card's Test button presses, which
// resolves the credential inside ingest and makes the provider's cheapest real
// call. One answer for the page and for the terminal.
//
// When the OS is not running this falls back to the env-only check and SAYS SO
// in one line, because silence there would be the same false red in a new place.
// ─────────────────────────────────────────────────────────────────────────────

/** How a credential's `auth` reads in a terminal row. Null for the providers
 * with one implicit way in — there is no choice to report. */
const AUTH_WORD = {
  oauth: 'signed in',
  'service-account': 'service account',
};

/**
 * What the running OS holds, per provider id — or why it could not be asked.
 *
 * Never throws: "the OS is not running" is an ANSWER this script has to render,
 * not a failure that should stop the env lanes from being probed.
 */
export async function readStoreCredentials({
  origin = DEFAULT_TOWER_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  try {
    const payload = await fetchIntegrationProviders({ origin, fetchImpl });
    const byProvider = new Map();
    for (const entry of payload.providers ?? []) {
      const id = entry.provider?.id ?? entry.provider;
      if (typeof id === 'string') byProvider.set(id, entry.credential ?? {});
    }
    // `probes` memoizes one test per PROVIDER for the run: Google is one
    // credential behind two lanes, and testing it twice would spend two real
    // calls to answer one question.
    return { reachable: true, origin, reason: null, byProvider, probes: new Map() };
  } catch (err) {
    return {
      reachable: false,
      origin,
      reason: err?.message ?? String(err),
      byProvider: new Map(),
      probes: new Map(),
    };
  }
}

/**
 * The credential this lane's provider holds IN THE STORE, or null.
 *
 * `source: 'store'` is the whole test, whichever way in it used: a Google
 * credential from a sign-in and one from a service-account paste are both
 * connected, and the bug this closes (`ro-vu8d.15`) was exactly a checker that
 * only knew the second. A store row still missing a required field is NOT
 * counted — half-configured is its own state, and the env fallback below is the
 * honest thing to report for it.
 */
export function storeCredential(lane, store) {
  if (!lane.provider || !store?.reachable) return null;
  const credential = store.byProvider.get(lane.provider);
  if (!credential || credential.source !== 'store') return null;
  if ((credential.missingFields ?? []).length > 0) return null;
  return credential;
}

/**
 * Where this lane's credential comes from, by the SAME precedence the runtime
 * resolves with: the store wins over any binding, and `none` is the quiet line.
 */
export function laneSource(lane, vars, store) {
  if (storeCredential(lane, store) !== null) return 'store';
  return lane.configured(vars) ? 'env' : 'none';
}

/**
 * Prove a store-held credential by asking the OS to test it.
 *
 * The OS resolves the credential and makes the provider's own cheapest
 * authenticated read (workers/ingest/src/credential-probes.ts), so what comes
 * back is a live sample from the credential the collectors actually run with —
 * not from a copy of it this script decrypted, which it cannot and must not do.
 *
 * NO PROOFS. The env probes earn a config/integrations.json suggestion by
 * proving ENROLLMENT per property (a verified-sites gate, one probed property).
 * A provider-level test proves the credential and nothing about which properties
 * it reaches, so claiming those cells would be over-claiming — the honesty gate
 * this file already keeps for status applies here too.
 */
export async function probeStoreLane(lane, store, { fetchImpl = fetch } = {}) {
  const url = `${store.origin}/api/integrations/${encodeURIComponent(lane.provider)}/test`;
  const cached = store.probes?.get(lane.provider);
  const r =
    cached ??
    (await probeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
      },
      fetchImpl,
    ));
  store.probes?.set(lane.provider, r);
  if (r.networkError) {
    return {
      rows: [
        {
          state: 'fail',
          label: lane.label,
          detail: `the OS answered nothing at ${url} — ${r.networkError}`,
          sub: ['fix: the credential is stored; re-run once `pnpm os:up` is serving again.'],
        },
      ],
      proofs: [],
    };
  }
  if (!r.ok || !r.json) {
    return {
      rows: [
        {
          state: 'fail',
          label: lane.label,
          detail: `the OS refused the test with HTTP ${r.status}`,
          sub: [`fix: check the os:up log for ${lane.provider}.`],
        },
      ],
      proofs: [],
    };
  }
  return {
    rows: [
      {
        state: r.json.ok ? 'pass' : 'fail',
        label: lane.label,
        detail: String(r.json.message ?? '(the OS returned no message)'),
        sub: r.json.ok
          ? []
          : [`fix: reconnect ${lane.provider} on /integrations, then re-run.`],
      },
    ],
    proofs: [],
  };
}

/** The one dim line under a lane's first row saying where its credential came
 * from — the fact `ro-vu8d.10` exists to stop an operator having to guess. */
export function sourceNote(lane, source, store, secretSource) {
  if (source === 'store') {
    const auth = AUTH_WORD[storeCredential(lane, store)?.auth] ?? null;
    return (
      `source: store — entered in the product${auth ? ` (${auth})` : ''};` +
      ` probed by the OS at ${store.origin}`
    );
  }
  return `source: env — ${lane.slots} in ${secretSource}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane registry — order is the print order. `explicit` lanes never run in a
// default sweep. `configured` decides ENV probe vs the quiet not-configured
// line; `provider` is this lane's row in the credential catalog, so the store
// half above can ask the OS about it. Null only where the catalog genuinely has
// no such provider — the OS's own pull tokens, which are a bootstrap secret
// rather than a third-party account.
//
// Exported so a unit test can assert a lane is actually WIRED here: a probe that
// exists but is not registered runs never and reports nothing, which is the same
// silence the calendar lane was added to break.
// ─────────────────────────────────────────────────────────────────────────────
export const LANES = [
  {
    id: 'pull',
    label: 'Self-report (pull)',
    explicit: false,
    // ASSET_TOKENS is the OS's OWN bootstrap secret, not a provider credential —
    // it never moves into the store, so there is nothing to ask the OS about.
    provider: null,
    slots: 'ASSET_TOKENS',
    configured: (v) => nonEmptyMap(v.ASSET_TOKENS),
    probe: (v) => probePull(v),
  },
  {
    id: 'bing',
    label: 'Bing Webmaster',
    explicit: false,
    provider: 'bing-webmaster',
    slots: 'BING_WEBMASTER_API_KEY',
    configured: (v) => has(v.BING_WEBMASTER_API_KEY),
    probe: (v, reg) => probeBing(v, reg),
  },
  {
    id: 'dataforseo',
    label: 'DataForSEO',
    explicit: false,
    provider: 'dataforseo',
    slots: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD',
    configured: (v) => has(v.DATAFORSEO_LOGIN) && has(v.DATAFORSEO_PASSWORD),
    probe: (v) => probeDataForSEO(v),
  },
  {
    id: 'ga4',
    label: 'GA4 (Analytics)',
    explicit: false,
    // Both Google lanes point at the ONE `google` credential, which is what makes
    // `--lane google` select them together and one OS test serve both rows.
    provider: 'google',
    slots: GOOGLE_SIGNAL_SLOT,
    configured: (v) => hasGoogleSignalTargets(v, 'ga4_property_id'),
    probe: (v) => probeGA4(v),
  },
  {
    id: 'gsc',
    label: 'Search Console',
    explicit: false,
    provider: 'google',
    slots: GOOGLE_SIGNAL_SLOT,
    configured: (v) => hasGoogleSignalTargets(v, 'gsc_site_url'),
    probe: (v) => probeGSC(v),
  },
  {
    id: 'calendar',
    label: 'Calendar feeds',
    // Not explicit: a calendar read is free and has no side effect, and a rotated
    // link is silent everywhere else — so this lane has to run unasked or it does
    // not do its job.
    explicit: false,
    provider: 'calendar',
    slots: 'CALENDAR_FEEDS',
    // `has` and not a parse check, on purpose: a set-but-mangled slot must reach
    // the probe and be reported as broken. Reading it as "not configured yet"
    // would hide the exact case this lane exists for.
    configured: (v) => has(v.CALENDAR_FEEDS),
    probe: (v) => probeCalendar(v),
  },
  {
    id: 'clarity',
    label: 'Microsoft Clarity',
    // STILL EXPLICIT, and only half for the old reason (bead `ro-vu8d.9`). A
    // credential in the STORE is proved by the OS, whose Clarity probe makes no
    // call at all — there is no free one to make. A credential still in the
    // environment file is proved HERE, by a real export call that costs one of
    // that asset's ten for the day. The expensive half is why this lane never
    // runs in a default sweep.
    provider: 'clarity',
    // The map is canonical; the single-project token is the documented fallback
    // the collector also accepts, so a configured secret is never reported as
    // missing just because it uses the other shape.
    slots: 'CLARITY_TOKENS (or CLARITY_PROJECT_API_TOKEN for one project)',
    configured: (v) => clarityTokens(v).size > 0,
    probe: (v) => probeClarity(v),
    explicitHint:
      'probe on request: --lane clarity (spends 1 of 10 daily calls while the tokens are ' +
      'still in the environment file; free once they are in the store)',
  },
  {
    id: 'posthog',
    label: 'PostHog',
    // Not explicit: a project-settings read is free, runs no query and has no
    // side effect (bead ro-ghis.1).
    explicit: false,
    provider: 'posthog',
    slots: 'POSTHOG_KEYS',
    configured: (v) => Object.values(jsonMap(v.POSTHOG_KEYS)).some((key) => has(key)),
    probe: (v) => probePosthog(v),
  },
  {
    id: 'discord',
    label: 'Discord',
    explicit: true,
    // Connected in the product since bead `ro-vu8d.18`. It stays EXPLICIT on
    // both sides of the move, because the probe posts a real message into the
    // operator's channel either way — the store half asks the OS to press the
    // same button its card offers, so one press is one message wherever it came
    // from.
    provider: 'discord',
    slots: 'DISCORD_WEBHOOK_URL',
    configured: (v) => has(v.DISCORD_WEBHOOK_URL),
    probe: (v, register) => probeDiscord(v, register),
    explicitHint: 'probe on request: --lane discord (posts a test message)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing.
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { lane: null, help: false, origin: DEFAULT_TOWER_ORIGIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--lane') opts.lane = argv[++i];
    else if (a.startsWith('--lane=')) opts.lane = a.slice('--lane='.length);
    else if (a === '--origin') opts.origin = argv[++i];
    else if (a.startsWith('--origin=')) opts.origin = a.slice('--origin='.length);
    else if (a === '--') continue; // pnpm's separator
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/**
 * The lanes one `--lane` selector names: a lane id, or a PROVIDER id, which
 * selects every lane that credential powers.
 *
 * `--lane google` is the reason (bead `ro-vu8d.15`): Google is one credential
 * behind two lanes, and an operator who just connected it asks about *google*,
 * not about `ga4` and `gsc` separately. A provider selector picks both, and the
 * OS is asked to test that one credential once.
 */
export function lanesFor(selector) {
  if (selector === null) return LANES;
  const byId = LANES.filter((lane) => lane.id === selector);
  if (byId.length > 0) return byId;
  return LANES.filter((lane) => lane.provider === selector);
}

/** Everything `--lane` accepts, in print order, providers last. */
function laneSelectors() {
  const providers = [...new Set(LANES.map((l) => l.provider).filter(Boolean))];
  return [...LANES.map((l) => l.id), ...providers];
}

function usage() {
  out(`${c.bold('pnpm creds:check')} — prove each credential the OS is actually using with one real probe.

  pnpm creds:check                 all configured non-explicit lanes
  pnpm creds:check --lane <id>     probe just one lane, or every lane one provider powers
  pnpm creds:check --origin <url>  where the running OS is (default ${DEFAULT_TOWER_ORIGIN})

Lanes: ${LANES.map((l) => l.id).join(', ')}
Providers: ${[...new Set(LANES.map((l) => l.provider).filter(Boolean))].join(', ')}
  clarity and discord are ${c.bold('probe-on-request')} (a Clarity probe against the
  environment file burns 1 of 10 daily calls; a Discord probe posts a real
  message), so they only run with --lane.

A credential connected in the product is read from the running OS and proved
there; one still in the environment file is read and proved here. With the OS
stopped this is the env-only check and says so.

Never prints secret values. See scripts/README.md § Credentials.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main.
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    out(c.red(`✘ ${err.message}`));
    out('');
    usage();
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    usage();
    return;
  }
  const selected = lanesFor(opts.lane);
  if (selected.length === 0) {
    out(c.red(`✘ unknown lane "${opts.lane}" — one of: ${laneSelectors().join(', ')}`));
    process.exitCode = 2;
    return;
  }

  // The env half. A missing local secret source is no longer fatal: everything
  // could be in the store, which is the whole direction of the epic. It is
  // reported as one line and every lane still gets asked about.
  let vars = {};
  let secretSource = null;
  let secretsError = null;
  try {
    const loaded = await readDevSecretBindings();
    vars = loaded.bindings;
    secretSource = path.relative(REPO_ROOT, loaded.sourceFile);
  } catch (err) {
    secretsError = err.message;
  }

  // The store half: what the running OS holds. Never throws — "the OS is not
  // running" is an answer to render, not a reason to stop.
  const store = await readStoreCredentials({ origin: opts.origin });

  const register = await loadRegister();

  out(c.bold('Credentials check'));
  out(
    store.reachable
      ? c.dim(
          `  store: ${store.origin} · env: ${secretSource ?? 'none on this machine'}` +
            ' — a credential in the store wins, and is proved by the OS.',
        )
      : c.dim(
          `  env only: ${secretSource ?? 'none on this machine'}` +
            ` — the OS is not answering at ${store.origin}, so a credential connected in the` +
            ' product is invisible here. Start `pnpm os:up` for the full answer.',
        ),
  );
  if (secretsError !== null && !store.reachable) {
    out(c.red(`  ✘ could not read local secrets either: ${secretsError}`));
    out(
      c.dim(
        '  copy workers/ingest/.dev.secrets.example.json to .dev.secrets.json and fill in real values.',
      ),
    );
    process.exitCode = 1;
    return;
  }
  out('');

  const allProofs = [];
  for (const lane of selected) {
    const source = laneSource(lane, vars, store);
    // Nothing anywhere → quiet line, never an error. It names the product first
    // and the binding second (D21): connecting is now the documented way.
    if (source === 'none') {
      printRow({
        state: 'skip',
        label: lane.label,
        detail: lane.provider
          ? `not configured yet — connect it on /integrations, or set ${lane.slots}`
          : `not configured yet — set ${lane.slots}`,
      });
      continue;
    }
    const note = sourceNote(lane, source, store, secretSource ?? 'the local secret source');
    // Configured but explicit-only and NOT explicitly selected → note, don't probe.
    if (lane.explicit && opts.lane === null) {
      printRow({
        state: 'skip',
        label: lane.label,
        detail: `configured — ${lane.explicitHint}`,
        sub: [note],
      });
      continue;
    }
    const { rows, proofs } =
      source === 'store'
        ? await probeStoreLane(lane, store)
        : await lane.probe(vars, register);
    // The source rides on the lane's FIRST row: one line per lane, so which
    // half of the epic answered is read rather than assumed.
    if (rows.length > 0) rows[0].sub = [note, ...(rows[0].sub ?? [])];
    for (const row of rows) printRow(row);
    for (const p of proofs || []) allProofs.push(p);
  }

  // ── changeset suggestion — SUGGEST, never apply ─────────────────────────────
  out('');
  const suggestion = suggestChangeset(allProofs, register, new Date().toISOString());
  if (!suggestion) {
    out(c.dim('No newly-proven lanes to record — nothing to stage.'));
    return;
  }
  const parts = [];
  if (suggestion.recorded > 0) {
    parts.push(
      `${suggestion.recorded} cell${suggestion.recorded === 1 ? '' : 's'} proved credential + enrollment — ` +
        'this records setup evidence without setting runtime health',
    );
  }
  out(c.bold(parts.join('; ') + '.') + ' Review, then stage:');
  out('');
  out(c.dim("  pnpm config:apply --stdin <<'CHANGESET'"));
  for (const line of JSON.stringify(suggestion.changeset, null, 2).split('\n')) out(`  ${line}`);
  out(c.dim('  CHANGESET'));
  out('');
  out(
    c.dim(
      '  Only properties the probe actually proved are touched; config:apply previews the diff' +
        ' and asks y/N before writing.',
    ),
  );
}

// Run only when invoked directly — importing (the unit test) must not run main.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    out(c.red(`✘ unexpected: ${err?.stack || err?.message || err}`));
    process.exitCode = 1;
  });
}

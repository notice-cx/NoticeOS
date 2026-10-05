// GA4 event-parameter report for one asset — the manual companion to the daily
// GA4 archive lane, for event params the archive does not export (yet; the
// 2026-07-31 audit brief F5 tracks folding js_error params into the collector).
//
//   pnpm signals:event-params -- --asset example.com
//   pnpm signals:event-params -- --asset example.com --event js_error --dims message,source
//   pnpm signals:event-params -- --asset example.com --days 7 --page --limit 60
//
// Reads GOOGLE_SIGNAL_ACCOUNTS from workers/ingest/.dev.secrets.json at
// runtime and mints a read-only (analytics.readonly) token; credential
// material is never printed. Requires each requested param to be registered
// as an event-scoped custom dimension in GA4 admin — values are "(not set)"
// for events collected before the dimension was registered (registration is
// forward-only), and a dimension can take up to 48h to start populating.
//
// Origin: a 2026-07-31 js_error triage on one site (message/source pull).

import { readFileSync } from "node:fs";
import crypto from "node:crypto";

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== "--");
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const asset = argValue("--asset", null);
const eventName = argValue("--event", "js_error");
const dims = argValue("--dims", "message,source").split(",").map((d) => d.trim()).filter(Boolean);
const days = Number(argValue("--days", "3"));
const limit = Number(argValue("--limit", "40"));
const includePage = argv.includes("--page");

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "Usage: pnpm signals:event-params -- --asset <id> [--event js_error] " +
      "[--dims message,source] [--days 3] [--limit 40] [--page]",
  );
  process.exit(1);
}
if (!asset) usage("--asset is required");
if (!dims.length) usage("--dims needs at least one registered event parameter");
if (!Number.isFinite(days) || days < 1) usage("--days must be a positive number");

// ── credential + property lookup (never printed) ────────────────────
const SECRETS_URL = new URL("../workers/ingest/.dev.secrets.json", import.meta.url);
let secrets;
try {
  secrets = JSON.parse(readFileSync(SECRETS_URL, "utf8"));
} catch (err) {
  usage(`could not read workers/ingest/.dev.secrets.json — ${err.message}`);
}
const accounts = secrets.GOOGLE_SIGNAL_ACCOUNTS || {};
let propertyId = null;
let serviceAccountB64 = null;
let accountLabel = null;
const ga4Assets = [];
for (const [label, account] of Object.entries(accounts)) {
  for (const [prop, cfg] of Object.entries(account.properties || {})) {
    if (cfg?.ga4_property_id) ga4Assets.push(prop);
    if (prop === asset && cfg?.ga4_property_id) {
      propertyId = cfg.ga4_property_id;
      serviceAccountB64 = account.service_account_b64;
      accountLabel = label;
    }
  }
}
if (!propertyId) {
  usage(
    `no GA4-tagged "${asset}" in GOOGLE_SIGNAL_ACCOUNTS — configured GA4 assets: ` +
      (ga4Assets.join(", ") || "(none)"),
  );
}
console.log(`account: ${accountLabel} · property: ${propertyId} · event: ${eventName} · last ${days}d`);

// ── mint a read-only access token (same JWT-bearer path as creds:check) ──
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sa = JSON.parse(Buffer.from(serviceAccountB64 || "", "base64").toString("utf8"));
const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: sa.client_email,
  scope: "https://www.googleapis.com/auth/analytics.readonly",
  aud: tokenUri,
  iat: now,
  exp: now + 3600,
};
const signingInput =
  `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` + b64url(JSON.stringify(claims));
const signer = crypto.createSign("RSA-SHA256");
signer.update(signingInput);
signer.end();
const assertion = `${signingInput}.${b64url(signer.sign(sa.private_key))}`;

const tokenRes = await fetch(tokenUri, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
});
const tokenJson = await tokenRes.json();
if (!tokenJson.access_token) {
  console.error(
    "token request failed —",
    tokenJson.error_description || tokenJson.error || `HTTP ${tokenRes.status}`,
  );
  process.exit(1);
}

// ── the report ──────────────────────────────────────────────────────
const dimensionNames = [
  ...dims.map((d) => `customEvent:${d}`),
  ...(includePage ? ["unifiedPagePathScreen"] : []),
];
const report = await fetch(
  `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
      dimensions: dimensionNames.map((name) => ({ name })),
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
      dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: eventName } } },
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit,
    }),
  },
);
const data = await report.json();
if (data.error) {
  console.error("runReport error:", data.error.message);
  if (/not a valid dimension/i.test(data.error.message || "")) {
    console.error(
      "fix: register the param as an event-scoped custom dimension in GA4 admin " +
        "(Admin → Custom definitions), then allow up to 48h before it populates.",
    );
  }
  process.exit(1);
}
const rows = data.rows || [];
console.log(`rows: ${rows.length} of ${data.rowCount ?? 0}`);
console.log(["events", "users", ...dimensionNames].join("\t"));
for (const r of rows) {
  const dimValues = r.dimensionValues.map((d) => d.value || "-");
  const [events, users] = r.metricValues.map((m) => m.value);
  console.log([events, users, ...dimValues].join("\t"));
}
if (rows.some((r) => r.dimensionValues.some((d) => d.value === "(not set)"))) {
  console.log(
    '\nnote: "(not set)" rows predate the custom dimension\'s registration (or the event genuinely lacked the param).',
  );
}

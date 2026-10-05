// THE FILE GOOGLE HANDS YOU FOR A WEB CLIENT (bead `ro-ujb9.96.7.7`).
//
// Creating an OAuth client in the Google Cloud console ends on a "Download
// JSON" button: `client_secret_<id>.json`, shaped `{ "web": { "client_id",
// "client_secret", "redirect_uris": [...] , ... } }`. Dropping that file on the
// connect panel replaces typing (or mis-pasting) two long strings, and the file
// also says whether this Tower's redirect address was added — the single most
// common reason a sign-in fails (`redirect_uri_mismatch`).
//
// Pure, so the rules are tested without a browser. Nothing here is stored:
// the two values go to the credential write, and the file is dropped.

export type GoogleClientFile =
  | {
      ok: true;
      clientId: string;
      clientSecret: string;
      /** Whether the client lists this Tower's redirect address. False is a
       * sign-in Google will refuse until it is added in the console. */
      redirectListed: boolean;
    }
  | {
      ok: false;
      /** `not-json` — not a JSON file; `not-web-client` — a desktop, service
       * account or other file, which cannot sign in through a browser here;
       * `incomplete` — a web client missing its id or secret. */
      problem: "not-json" | "not-web-client" | "incomplete";
    };

/** Read a dropped `client_secret.json` against this Tower's redirect address. */
export function readGoogleClientFile(text: string, redirectUri: string): GoogleClientFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not-json" };
  }
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const web = root && typeof root.web === "object" && root.web !== null && !Array.isArray(root.web) ? (root.web as Record<string, unknown>) : null;
  if (web === null) return { ok: false, problem: "not-web-client" };
  const clientId = typeof web.client_id === "string" ? web.client_id.trim() : "";
  const clientSecret = typeof web.client_secret === "string" ? web.client_secret.trim() : "";
  if (clientId === "" || clientSecret === "") return { ok: false, problem: "incomplete" };
  const uris = Array.isArray(web.redirect_uris) ? web.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  return { ok: true, clientId, clientSecret, redirectListed: uris.includes(redirectUri) };
}

/** The console pages the one-time setup opens, deep-linked to the step. */
export const GOOGLE_CONSOLE = {
  /** Turns on the Analytics Data, Analytics Admin and Search Console APIs in
   * one confirmation. */
  apis: "https://console.cloud.google.com/flows/enableapi?apiid=analyticsdata.googleapis.com,analyticsadmin.googleapis.com,searchconsole.googleapis.com",
  /** Creates an OAuth client (Web application), where the redirect address is
   * pasted and the JSON is downloaded. */
  client: "https://console.cloud.google.com/auth/clients/create",
} as const;

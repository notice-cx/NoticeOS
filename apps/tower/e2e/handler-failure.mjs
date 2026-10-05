// WHY A FIXTURE CALL FAILED, IN THE FAILING TEST'S OWN OUTPUT (bead
// ro-ujb9.76.56).
//
// When a fixture server's handler throws (server.mjs), the reason used to go
// to the server's own output alone, and the test saw "500". A journey that
// failed in its setup on a busy machine left nothing to read. Now the server
// answers 500 with the error's own words, prints the same words on one line
// behind HANDLER_FAILURE_MARK, and the runner (journey-test.ts) attaches every
// such line a failing test's server printed to that test's output.
//
// Those words never carry an address or a password: every URL and loopback
// address, every socket file and the password of this run's Postgres are
// replaced before the text leaves the handler, and the shared log scrubber
// (scripts/os-log.mts) takes whatever credential shape is left.

import { redactLogText } from "../../../scripts/os-log.mjs";

/** The mark on the one line the server prints for a failed handler. */
export const HANDLER_FAILURE_MARK = "JOURNEY_HANDLER_FAILED";

/** How much of one failure's words are kept. */
const MAX_LENGTH = 1500;

/**
 * `error`'s own message and its causes', with no address or password in
 * them: every URL, IPv4 address (with its port), `localhost:<port>` and socket
 * file is named by what it is, and each of `secrets` (this run's database
 * password, say) is withheld wherever it appears.
 *
 * @param {unknown} error
 * @param {readonly string[]} [secrets]
 */
export function handlerFailureText(error, secrets = []) {
  const words = [];
  for (let at = error, depth = 0; at !== undefined && at !== null && depth < 5; at = at instanceof Error ? at.cause : undefined, depth += 1) {
    words.push(at instanceof Error ? `${at.message}` : String(at));
  }
  let text = words.join(" ← because ");
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  text = redactLogText(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "<address>")
    .replace(/(?:\/[^\s"'/]+)+\/(?:\.s\.PGSQL\.\d+|[^\s"'/]+\.sock)\b/gu, "<socket>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gu, "<address>")
    .replace(/\blocalhost:\d+\b/giu, "<address>")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text || "no reason given";
}

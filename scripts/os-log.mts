// Shared secret scrubbing for every local-runner log write, every control
// command read and the ingest Worker's failed-step line (bead ro-ujb9.173).
// Keeping one implementation prevents the diagnostic path from drifting away
// from the persistent-log path.
//
// Authored TypeScript, portable (no `node:` import), so the Worker can import
// it too: `pnpm config:generate` writes the `.mjs` and the `.d.mts` beside it.

/** Redact common credential shapes without knowing or loading any secret. */
export function redactLogText(value: unknown): string {
  let text = String(value ?? '');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]');
  text = text.replace(
    /([?&](?:(?:access|refresh|id)_?token|client_?secret|api_?key|auth|authorization|key|password|secret|token)=)[^&#\s]*/giu,
    '$1[REDACTED]',
  );
  text = text.replace(
    /(^|[\s,{;])((?:"|')?(?:(?:access|refresh|id)_?token|client_?secret|api_?key|auth|authorization|cookie|password|private_?key|secret|token)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s,;}]+)/gimu,
    '$1$2[REDACTED]',
  );
  text = text.replace(
    /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gu,
    '[REDACTED PRIVATE MATERIAL]',
  );
  // The password inside a connection URL (scheme://user:password@host), such
  // as the database address DATABASE_URL holds (bead ro-ujb9.76.7.2).
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#@]+@/giu, '$1[REDACTED]@');
  return text;
}

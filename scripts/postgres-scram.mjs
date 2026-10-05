// A Postgres login's password as the server keeps it: its SCRAM-SHA-256
// verifier. One computation for both places that set a password: the
// development profile's loopback login and the installation's secret files
// (`pnpm postgres:secrets`).

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802/7677,
 * the form pg_authid holds), computed here, as psql's \password does, so the
 * password itself never reaches the server: a statement carrying it would be
 * kept by pg_stat_statements, which records utility statements' text
 * (scripts/postgres-test-cluster.test.mjs found it there). `password` is
 * printable ASCII, so SASLprep leaves it unchanged.
 */
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  if (!/^[\x21-\x7e]+$/u.test(password)) throw new TypeError('a password set by verifier here is printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

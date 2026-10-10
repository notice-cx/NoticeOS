// Fail-closed tripwire for the isolated journey server: the harness must run
// from a fresh checkout and in CI, and must never borrow the operator's live
// runtime when it runs on the operator's machine. Inside this process:
//
//   - reading or opening `.dev.vars` / `.dev.secrets.json` (any directory) is
//     refused before the filesystem is touched;
//   - so is reading any file in the checkout's own `config/` directory or its
//     installation folder: server.mjs answers config imports with the
//     fixture's synthetic documents, and a read that gets past that is
//     refused here;
//   - a socket to an owner port (Tower 5173, ingest door 8791, task hub 3308)
//     is refused before it connects, whatever library opened it.
//
// Each refusal also prints one `JOURNEY_ISOLATION_VIOLATION` line, so the
// harness test can prove a whole journey produced none, even where the caller
// swallowed the error and answered something else.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { installationDir } from "../../../scripts/installation.mjs";
import { OWNER_PORTS } from "./journey-port.mjs";

export const SECRET_FILES = Object.freeze([".dev.vars", ".dev.secrets.json"]);
/** The checkout's own configuration directory: the operator's settings. */
export const OWNER_CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config");
/** This installation's own folder: its saved documents, change history and
 * host files. Refused exactly like config/. */
export const OWNER_INSTALLATION_DIR = installationDir({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") });
export const VIOLATION_MARK = "JOURNEY_ISOLATION_VIOLATION";
export const ARMED_MARK = "JOURNEY_ISOLATION_GUARD armed";

const INSTALLED = Symbol.for("noticeos.journey-isolation-guard");

function pathText(target) {
  try {
    if (target instanceof URL) return fileURLToPath(target);
    if (typeof target === "string") return target;
    if (Buffer.isBuffer(target)) return target.toString("utf8");
  } catch { /* not a file path */ }
  return null;
}

/** True for a secrets file in ANY directory: the operator's checkout, a
 * worktree's parent or a copied fixture are all equally out of bounds. */
export function isSecretFile(target) {
  const text = pathText(target);
  return text !== null && SECRET_FILES.includes(path.basename(text));
}

/** True for a file inside the checkout's `config/` directory. Another
 * directory named `config` — the fixture repo's own `config/task-host.json` —
 * is not the operator's and stays readable. */
export function isOwnerConfigFile(target, configDir = OWNER_CONFIG_DIR) {
  const text = pathText(target);
  if (text === null) return false;
  const resolved = path.resolve(text);
  return resolved.startsWith(configDir + path.sep);
}

/** The owner port a URL or socket target names, or null. A URL without an
 * explicit port uses its scheme default, which is never an owner port. */
export function ownerPortOf(target) {
  let port = null;
  if (typeof target === "number" || (typeof target === "string" && /^\d+$/.test(target))) port = Number(target);
  else if (target instanceof URL || typeof target === "string") {
    try { port = Number(new URL(String(target)).port) || null; } catch { port = null; }
  } else if (target && typeof target === "object") {
    if (typeof target.url === "string") return ownerPortOf(target.url);
    if (target.port !== undefined) port = Number(target.port);
  }
  return port !== null && OWNER_PORTS.includes(port) ? port : null;
}

/** Socket#connect receives (options), (port, host) or Node's internal
 * normalized [options, callback] array. */
function socketTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  return first;
}

export function installIsolationGuard({ report = (line) => process.stderr.write(`${line}\n`), ownerConfigDir = OWNER_CONFIG_DIR } = {}) {
  if (globalThis[INSTALLED]) return globalThis[INSTALLED];
  const violations = [];
  const refuse = (kind, target) => {
    const entry = { kind, target: String(target) };
    violations.push(entry);
    report(`${VIOLATION_MARK} ${JSON.stringify(entry)}`);
    return new Error(`The isolated journey server refused to ${kind} ${target}: it never uses the operator's secrets, configuration or live services.`);
  };

  const refused = (target) => isSecretFile(target) || isOwnerConfigFile(target, ownerConfigDir)
    || isOwnerConfigFile(target, OWNER_INSTALLATION_DIR);
  const guardFile = (owner, name, { callback = false } = {}) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function guardedFileAccess(target, ...rest) {
      if (refused(target)) {
        const error = refuse("read", pathText(target));
        const done = callback ? rest.findLast((value) => typeof value === "function") : undefined;
        if (done) { queueMicrotask(() => done(error)); return undefined; }
        throw error;
      }
      return original.call(this, target, ...rest);
    };
  };
  for (const name of ["readFileSync", "openSync", "createReadStream"]) guardFile(fs, name);
  for (const name of ["readFile", "open"]) guardFile(fs, name, { callback: true });
  for (const name of ["readFile", "open"]) {
    const original = fs.promises[name];
    fs.promises[name] = async function guardedPromiseAccess(target, ...rest) {
      if (refused(target)) throw refuse("read", pathText(target));
      return original.call(this, target, ...rest);
    };
  }
  syncBuiltinESMExports();

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const port = ownerPortOf(socketTarget(args));
    if (port !== null) {
      const error = refuse("connect to", `127.0.0.1:${port}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };

  const guard = {
    violations,
    /** For code that refuses a request itself (the server's fetch override):
     * record an owner-port attempt that never reached a socket. */
    noteFetch(input) {
      const port = ownerPortOf(input);
      if (port !== null) refuse("contact", `127.0.0.1:${port}`);
    },
  };
  globalThis[INSTALLED] = guard;
  report(ARMED_MARK);
  return guard;
}

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_PORTS = new Set([5173, 8791]);
export interface DoorAttempt {
  port: number;
  towerPort: number;
  pid: number;
  descendants: number[];
  collision: boolean;
  closed: boolean;
  directory: string;
  removed: boolean;
  failure?: string;
}
export interface DoorFixture {
  towerPort: number;
  doorPort: number;
  optimizerDisabled: boolean;
  attempts: DoorAttempt[];
  close(): Promise<void>;
}

export async function proposedDoorPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string" || LIVE_PORTS.has(address.port)) throw new Error("unsafe ephemeral door port");
  return address.port;
}

function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

/** Refuse deletion until the child and every recorded descendant are gone. */
async function retired(attempt: DoorAttempt): Promise<void> {
  const deadline = Date.now() + 10_000;
  const groupGone = () => absent(-attempt.pid);
  while ([attempt.pid, ...attempt.descendants].some(pid => !absent(pid)) || !groupGone()) {
    if (Date.now() >= deadline) throw new Error(`door fixture processes still present: ${JSON.stringify(attempt)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  attempt.closed = true;
}

export async function startDoorFixture(options: {
  env: NodeJS.ProcessEnv;
  root: string;
  attempts?: DoorAttempt[];
  maxAttempts?: number;
  beforeAttempt?: (port: number, attempt: number, towerPort: number) => Promise<void>;
}): Promise<DoorFixture> {
  const attempts = options.attempts ?? [];
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("fixture acquisition requires one to three attempts");
  const deadline = Date.now() + 90_000;
  for (let index = 0; index < maxAttempts; index++) {
    const port = await proposedDoorPort();
    let towerPort = await proposedDoorPort();
    for (let pick = 0; towerPort === port && pick < 3; pick++) towerPort = await proposedDoorPort();
    if (towerPort === port) throw new Error("could not acquire distinct fixture ports");
    await options.beforeAttempt?.(port, index, towerPort);
    const directory = await fs.mkdtemp(path.join(options.root, "door-attempt-"));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./runner-door-child.mts", import.meta.url))], {
      env: { ...options.env, OS_UP_INGEST_DOOR_PORT: String(port), NOTICEOS_TEST_TOWER_PORT: String(towerPort),
        OS_UP_PERSIST_STATE: path.join(directory, "state"), MINIFLARE_REGISTRY_PATH: path.join(directory, "registry"),
        XDG_CONFIG_HOME: path.join(directory, "xdg"), WRANGLER_LOG_PATH: path.join(directory, "logs"), TMPDIR: directory },
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const attempt: DoorAttempt = { port, towerPort, pid: child.pid ?? 0, descendants: [], collision: false, closed: false, directory, removed: false };
    attempts.push(attempt);
    let logs = "";
    child.stdout?.on("data", chunk => { logs += String(chunk); });
    child.stderr?.on("data", chunk => { logs += String(chunk); });
    const exited = new Promise<void>(resolve => {
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    const waitForExit = async (ms: number) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), ms); })]);
      } finally { clearTimeout(timeout); }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (attempt.pid <= 0) return;
      try { process.kill(-attempt.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<{ towerPort: number; optimizerDisabled: boolean }>((resolve, reject) => {
      child.on("message", (message: { type?: string; pid?: number; towerPort?: number; optimizerDisabled?: boolean }) => {
        if (message.type === "collision") attempt.collision = true;
        if (message.type === "descendant" && message.pid) attempt.descendants.push(message.pid);
        if (message.type === "ready" && message.towerPort) resolve({ towerPort: message.towerPort, optimizerDisabled: message.optimizerDisabled === true });
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`door fixture exited (${code ?? signal}): ${logs}`)));
      timer = setTimeout(() => reject(new Error(`door fixture acquisition timed out: ${logs}`)), Math.max(1, deadline - Date.now()));
    });
    const close = async () => {
      if (attempt.closed) return;
      // A failed bind exits before async workerd cleanup; retire only this
      // child's process group, including its acquired workerd children.
      if (child.exitCode === null && child.signalCode === null && child.connected) child.send("close");
      if (!await waitForExit(10_000)) {
        signalGroup("SIGTERM");
        if (!await waitForExit(2_000)) {
          signalGroup("SIGKILL");
          if (!await waitForExit(2_000)) throw new Error("door fixture child did not exit");
        }
      }
      if (attempt.pid > 0) {
        signalGroup("SIGTERM");
        await retired(attempt);
      } else attempt.closed = true;
      await fs.rm(directory, { recursive: true, force: true });
      try { await fs.stat(directory); throw new Error("fixture directory still present"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      attempt.removed = true;
    };
    try {
      const result = await ready;
      return { ...result, doorPort: port, attempts, close };
    } catch (error) {
      attempt.failure = String(error);
      await close();
      if (!attempt.collision || child.exitCode !== 1 || index + 1 === maxAttempts) throw error;
    } finally { clearTimeout(timer); }
  }
  throw new Error("no door fixture acquisition attempts");
}

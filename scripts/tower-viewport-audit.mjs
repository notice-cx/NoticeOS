import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function pixels(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.round(value);
}

if (args.includes("--help")) {
  console.log(`Capture the running Tower through a local Firefox Marionette session.

Firefox must be listening on the selected Marionette port and the Tower must be
running at the selected origin.

Options:
  --label NAME             output filename prefix (default: wall)
  --path PATH              Tower route to frame (default: /)
  --origin URL             running Tower origin (default: http://localhost:5173)
  --out DIR                screenshot directory (default: /private/tmp)
  --focus SELECTOR         scroll the framed route to this CSS selector before capture
  --host HOST              Marionette host (default: 127.0.0.1)
  --port PORT              Marionette port (default: 2828)
  --desktop-width PX       framed desktop width (default: 1440)
  --desktop-height PX      framed desktop height (default: 1800)
  --mobile-width PX        framed mobile width (default: 390)
  --mobile-height PX       framed mobile height (default: 2400)
  --wait-ms MS             settle time before each capture (default: 1000)
`);
  process.exit(0);
}

const label = option("--label", "wall").replace(/[^a-z0-9_-]+/gi, "-");
const targetPath = option("--path", "/");
const origin = option("--origin", "http://localhost:5173").replace(/\/+$/, "");
const outputDirectory = path.resolve(option("--out", "/private/tmp"));
const focusSelector = option("--focus", "");
const marionetteHost = option("--host", "127.0.0.1");
const marionettePort = pixels("--port", 2828);
const waitMilliseconds = pixels("--wait-ms", 1000);
const presets = [
  {
    name: "desktop",
    width: pixels("--desktop-width", 1440),
    height: pixels("--desktop-height", 1800),
  },
  {
    name: "mobile",
    width: pixels("--mobile-width", 390),
    height: pixels("--mobile-height", 2400),
  },
];

class Marionette {
  socket = null;
  buffer = "";
  frames = [];
  waiters = [];
  id = 0;

  async connect() {
    this.socket = net.createConnection({
      host: marionetteHost,
      port: marionettePort,
    });
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.parse();
    });
    this.socket.on("error", (error) => {
      while (this.waiters.length > 0) this.waiters.shift().reject(error);
    });
    const hello = await this.next();
    if (hello.marionetteProtocol !== 3) {
      throw new Error(`Unsupported Marionette greeting: ${JSON.stringify(hello)}`);
    }
  }

  parse() {
    while (true) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) return;
      const size = Number(this.buffer.slice(0, colon));
      if (!Number.isFinite(size) || this.buffer.length < colon + 1 + size) return;
      const raw = this.buffer.slice(colon + 1, colon + 1 + size);
      this.buffer = this.buffer.slice(colon + 1 + size);
      const frame = JSON.parse(raw);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }

  next() {
    if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async command(name, params = {}) {
    const id = ++this.id;
    const payload = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    const response = await this.next();
    if (!Array.isArray(response) || response[0] !== 1 || response[1] !== id) {
      throw new Error(`Unexpected ${name} response: ${JSON.stringify(response)}`);
    }
    if (response[2]) {
      throw new Error(`${name}: ${JSON.stringify(response[2])}`);
    }
    return response[3];
  }

  close() {
    this.socket?.end();
  }
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

await fs.mkdir(outputDirectory, { recursive: true });
const marionette = new Marionette();
const results = {};

try {
  console.error(`Connecting to Firefox Marionette at ${marionetteHost}:${marionettePort}`);
  await marionette.connect();
  await marionette.command("WebDriver:NewSession", {
    capabilities: { alwaysMatch: { acceptInsecureCerts: true } },
  });
  await marionette.command("WebDriver:MaximizeWindow");

  for (const preset of presets) {
    const query = new URLSearchParams({
      path: targetPath,
      width: String(preset.width),
      height: String(preset.height),
    });
    const url = `${origin}/viewport-audit.html?${query}`;
    console.error(`Capturing ${preset.name}: ${preset.width}×${preset.height} ${targetPath}`);
    await marionette.command("WebDriver:Navigate", { url });
    await wait(waitMilliseconds);
    if (focusSelector) {
      const focused = await marionette.command("WebDriver:ExecuteScript", {
        script: `const frame = document.querySelector("#audit-frame");
          const target = frame?.contentDocument?.querySelector(${JSON.stringify(focusSelector)});
          if (!target) return false;
          target.scrollIntoView({ block: "start" });
          return true;`,
        args: [],
        newSandbox: true,
        sandbox: null,
      });
      if (!focused) {
        throw new Error(`Could not find focus selector in framed route: ${focusSelector}`);
      }
      await wait(250);
    }
    const image = await marionette.command("WebDriver:TakeScreenshot", {
      id: null,
      highlights: [],
      full: true,
      scroll: true,
    });
    const file = path.join(
      outputDirectory,
      `noticeos-${label}-${preset.name}-${preset.width}.png`,
    );
    const base64 = typeof image === "string" ? image : image.value;
    await fs.writeFile(file, Buffer.from(base64, "base64"));
    results[preset.name] = {
      path: file,
      viewport: { width: preset.width, height: preset.height },
      route: targetPath,
    };
  }
} finally {
  marionette.close();
}

console.log(JSON.stringify(results, null, 2));

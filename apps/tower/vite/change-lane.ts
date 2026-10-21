// The change stream: one server-side check of the pushed reads, shared by
// every open page, sent as Server-Sent Events (shared/change-topics.ts).

import type { AddressInfo } from "node:net";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { CHANGE_STREAM_PATH } from "../shared/change-topics";
import { createChangeWatch, topicReader } from "../../../scripts/change-watch.mjs";
export { createChangeWatch, topicReader, type TopicRead } from "../../../scripts/change-watch.mjs";

/** The server's own address, for reading its topics as a page would. */
function selfOrigin(server: ViteDevServer): string | null {
  const address = server.httpServer?.address() as AddressInfo | string | null | undefined;
  if (!address || typeof address === "string") return null;
  const host = ["::", "0.0.0.0", ""].includes(address.address) ? "127.0.0.1"
    : address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/** The middleware that answers `CHANGE_STREAM_PATH` from one watch. */
export function changeStreamMiddleware(watch: ReturnType<typeof createChangeWatch>): Connect.NextHandleFunction {
  return (req, res, next) => {
    if ((req.url ?? "").split("?")[0] !== CHANGE_STREAM_PATH) { next(); return; }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    watch.open(res);
  };
}

/** `enforce: "pre"`: the stream is answered here, never by the Worker. Its
 * reads go to this server's own address, through the Worker as a page's do. */
export function changeLane(): Plugin {
  return {
    name: "noticeos:change-lane",
    enforce: "pre",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(changeStreamMiddleware(createChangeWatch(topicReader((request) => fetch(request), () => selfOrigin(server)))));
    },
  };
}

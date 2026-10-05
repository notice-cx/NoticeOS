import type { Connect, Plugin } from 'vite';
import { demoViewerCapabilities, demoViewerReply, type DemoViewerDescriptor } from '../shared/demo-viewer';

/** Runs before native file/task middleware; refusals never read the request body. */
export function demoViewerMiddleware(viewer: DemoViewerDescriptor | null): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (viewer === null) { next(); return; }
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://demo.local').pathname; }
    catch { pathname = '/api/invalid'; }
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/cdn-cgi/')) { next(); return; }
    const reply = demoViewerReply(viewer, request.method ?? '', pathname);
    if (reply === null) {
      // These existing native readers finish their small JSON answer in end().
      // Apply the feature limit after they have derived real hub/store state.
      if (request.method === 'GET' && ['/api/config', '/api/tasks/capabilities'].includes(pathname)) {
        const end = response.end;
        response.end = function (chunk?: unknown, ...args: unknown[]) {
          if (response.statusCode < 200 || response.statusCode >= 300) return Reflect.apply(end, response, [chunk, ...args]);
          let value: unknown;
          try {
            if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw new Error('Invalid capability body');
            if (Buffer.byteLength(chunk) > 65_536) throw new Error('Oversized capability body');
            value = demoViewerCapabilities(viewer, pathname, JSON.parse(chunk.toString()));
          } catch {
            response.statusCode = 503; value = { error: 'demo_capability_unavailable' };
          }
          response.removeHeader('content-length');
          return Reflect.apply(end, response, [JSON.stringify(value), ...args]);
        } as typeof response.end;
      }
      next(); return;
    }
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.statusCode = reply.status;
    response.end(JSON.stringify(reply.body));
  };
}
export function demoViewerLane(viewer: DemoViewerDescriptor | null): Plugin {
  return { name: 'noticeos:demo-viewer', enforce: 'pre', apply: 'serve',
    configureServer(server) { server.middlewares.use(demoViewerMiddleware(viewer)); } };
}

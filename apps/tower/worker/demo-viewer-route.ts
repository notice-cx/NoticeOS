import { demoViewerCapabilities, demoViewerReply, type DemoViewerDescriptor } from '../shared/demo-viewer';
import { JSON_HEADERS } from './http';

export function demoViewerResponse(request: Request, viewer: DemoViewerDescriptor | null): Response | null {
  const reply = demoViewerReply(viewer, request.method, new URL(request.url).pathname);
  return reply === null ? null : Response.json(reply.body, { status: reply.status, headers: JSON_HEADERS });
}

export async function demoViewerReadResponse(request: Request, viewer: DemoViewerDescriptor | null, response: Response): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (viewer === null || request.method !== 'GET' || !['/api/config', '/api/tasks/capabilities'].includes(pathname)
    || !response.ok) return response;
  const body = demoViewerCapabilities(viewer, pathname, await response.json());
  const headers = new Headers(response.headers); headers.delete('content-length');
  return Response.json(body, { status: response.status, headers });
}

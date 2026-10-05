/** Compatibility metadata, never authentication or workspace authority. */
export const APP_RELEASE_HEADER = 'x-noticeos-release';
export const APP_RELEASE_PATH = '/api/app-release';
declare const __NOTICEOS_RELEASE__: string | undefined;

export function validAppRelease(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function compiledAppRelease(): string | null {
  return typeof __NOTICEOS_RELEASE__ !== 'undefined' && validAppRelease(__NOTICEOS_RELEASE__)
    ? __NOTICEOS_RELEASE__ : null;
}

export function isAppApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || /^\/visit\/[a-f0-9]{32}\/api\//u.test(pathname);
}

export function releaseMismatch(client: string | null, server: string): boolean {
  // Headerless CLI clients keep their existing contract. This is no grant.
  return client !== null && (!validAppRelease(client) || client !== server);
}

/** Refuse before invoking any route, including provider reads with effects. */
export async function withAppRelease(request: Request, next: () => Promise<Response>, release = compiledAppRelease()): Promise<Response> {
  if (release === null || !isAppApiPath(new URL(request.url).pathname)) return next();
  const response = releaseMismatch(request.headers.get(APP_RELEASE_HEADER), release)
    ? Response.json({ error: 'app_release_changed' }, { status: 409 })
    : new URL(request.url).pathname === APP_RELEASE_PATH
      ? Response.json({ release }) : await next();
  const headers = new Headers(response.headers);
  headers.set(APP_RELEASE_HEADER, release);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

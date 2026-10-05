import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { BrowserRuntimeProvider } from '@/lib/browser-context';
import { createBrowserRuntime, BrowserRetiredError } from '@/lib/browser-runtime';
import { useGoogleOAuthStart } from '@/hooks/useGoogleOAuthStart';
import { GoogleStartPress } from '@/components/provider-card/GoogleStartPress';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_OAUTH_START_PATH, googleOAuthRedirectUri } from '@noticeos/contract/google-oauth';
import { createApi, type ApiTransport } from '@/lib/api';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const origin = window.location.origin;
const owned: ReturnType<typeof createBrowserRuntime>[] = [];
function runtime(fetch: ApiTransport, workspaceId = id) {
  const value = createBrowserRuntime({ mode: 'hosted', principalId: id, sessionId: id, workspaceId, clientGeneration: 1 },
    { origin, fetch, sendAnswer: async () => {} });
  owned.push(value); return value;
}
function success(over: Record<string, unknown> = {}) {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: 'code', redirect_uri: googleOAuthRedirectUri(origin), state: 'generated-state' }).toString();
  return { ok: true, authorizeUrl: url.toString(), redirectUri: googleOAuthRedirectUri(origin), ...over };
}
function Press() { return <GoogleStartPress href={GOOGLE_OAUTH_START_PATH} {...useGoogleOAuthStart()}>Connect Google</GoogleStartPress>; }
afterEach(() => { owned.splice(0).forEach(value => value.retire()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('two owners send independent captured headers with bodyless POST, and decode only the fixed consent URL', async () => {
  const fetch = vi.fn<ApiTransport>(async () => Response.json(success()));
  const a = runtime(fetch), b = runtime(fetch, other);
  await a.api.beginGoogleOAuth(); await b.api.beginGoogleOAuth();
  for (const [index, [input, init]] of fetch.mock.calls.entries()) {
    expect(String(input)).toBe(`${origin}${GOOGLE_OAUTH_START_PATH}`);
    expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get(WORKSPACE_SELECTION_HEADER)).toBe(index === 0 ? id : other);
    expect(new Headers(init?.headers).get(WORKSPACE_SESSION_HEADER)).toBe(id);
  }
});
it('unbound compatibility clients cannot start hosted custody', async () => {
  const fetch = vi.fn<ApiTransport>();
  await expect(createApi(fetch).beginGoogleOAuth()).rejects.toThrow('Google sign-in requires a bound browser entry.');
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses foreign, credentialed, malformed, duplicate-state and wrong-callback redirects', async () => {
  const valid = success();
  for (const value of [null, { ok: false, error: 'app_missing' }, success({ authorizeUrl: 'javascript:alert(1)' }),
    success({ authorizeUrl: String(valid.authorizeUrl).replace('accounts.google.com', 'foreign.example') }),
    success({ authorizeUrl: String(valid.authorizeUrl).replace('https://', 'https://user:pass@') }),
    success({ authorizeUrl: `${valid.authorizeUrl}&state=another` }), success({ authorizeUrl: `${valid.authorizeUrl}#fragment` }),
    success({ redirectUri: 'https://foreign.example/callback' })]) {
    const valueRuntime = runtime(async () => Response.json(value));
    await expect(valueRuntime.api.beginGoogleOAuth()).rejects.toThrow('Google sign-in could not start.');
  }
});
it('retirement during body decode refuses a late valid result', async () => {
  let finish!: (value: unknown) => void;
  const response = Response.json(success());
  vi.spyOn(response, 'json').mockImplementation(() => new Promise(yes => { finish = yes; }));
  const value = runtime(async () => response);
  const result = value.api.beginGoogleOAuth();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  value.retire(); finish(success());
  await expect(result).rejects.toThrow(BrowserRetiredError);
});
it.each(['success', 'error'])('the hosted control issues once and retired %s cannot navigate or toast', async outcome => {
  const assign = vi.fn();
  const original = window;
  vi.stubGlobal('window', new Proxy(original, { get(target, key) {
    return key === 'location' ? { origin, assign } : Reflect.get(target, key, target);
  } }));
  let finish!: (value: Response) => void;
  let fail!: (value: Error) => void;
  const errorToast = vi.spyOn(toast, 'error');
  const fetch = vi.fn<ApiTransport>(() => new Promise((yes, no) => { finish = yes; fail = no; }));
  const value = runtime(fetch);
  render(<BrowserRuntimeProvider value={{ runtime: value, workspaceLabel: 'Generated' }}><Press /></BrowserRuntimeProvider>);
  const press = screen.getByRole('button', { name: 'Connect Google' });
  expect(press).not.toHaveAttribute('href');
  fireEvent.click(press); fireEvent.click(press);
  expect(fetch).toHaveBeenCalledTimes(1); expect(press).toBeDisabled();
  value.retire(); await act(async () => { if (outcome === 'success') finish(Response.json(success())); else fail(new Error('predecessor error')); });
  expect(assign).not.toHaveBeenCalled();
  expect(errorToast).not.toHaveBeenCalled();
});
it('an active hosted completion navigates once to the decoded URL', async () => {
  const assign = vi.fn(), original = window;
  vi.stubGlobal('window', new Proxy(original, { get(target, key) { return key === 'location' ? { origin, assign } : Reflect.get(target, key, target); } }));
  const value = runtime(async () => Response.json(success()));
  render(<BrowserRuntimeProvider value={{ runtime: value, workspaceLabel: 'Generated' }}><Press /></BrowserRuntimeProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(success().authorizeUrl));
});

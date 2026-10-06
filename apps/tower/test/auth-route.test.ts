// @vitest-environment node
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleAuthRequest, type AuthEntryBindings } from '../worker/auth-route';
import type { EmailCodeOptions, EmailEnrollment } from '@noticeos/postgres/email-code';
import { EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS } from '../../../scripts/identity-protocol.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';

const origin = 'https://auth.example.test';
const code = String(randomInt(100000, 1000000));
function request(action: keyof typeof EMAIL_CODE_PATHS = 'request', headers: Record<string, string> = {}, edge = true) {
  const request = new Request(origin + EMAIL_CODE_PATHS[action], { method: 'POST', headers: {
    origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.22', ...headers,
  }, body: JSON.stringify({ email: 'person@example.test', ...(action === 'verify' ? { otp: code } : {}) }) });
  if (edge) Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
  return request;
}
function fixture() {
  const messages: unknown[] = [], opened: EmailCodeOptions[] = [], selected: (EmailEnrollment | undefined)[] = [];
  let closed = 0, fail = false;
  const env: AuthEntryBindings = {
    NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
    NOTICEOS_IDENTITY_DATABASE_URL: 'postgresql://noticeos_identity@localhost/synthetic',
    NOTICEOS_IDENTITY_SESSION_SECRET: randomBytes(48).toString('base64url'),
    NOTICEOS_IDENTITY_EDGE: 'cloudflare', NOTICEOS_IDENTITY_EMAIL_FROM: 'hello@example.test',
    NOTICEOS_IDENTITY_EMAIL: { async send(message) { messages.push(message); } },
  };
  const open = (options: EmailCodeOptions) => {
    opened.push(options);
    const run = async (enrollment?: EmailEnrollment) => {
      selected.push(enrollment);
      if (fail) throw new Error('Synthetic private connection details');
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    };
    return {
      async requestCode(_request: Request, enrollment?: EmailEnrollment) {
        const response = await run(enrollment);
        await options.deliver({ email: 'person@example.test', code });
        return response;
      },
      verifyCode: (_request: Request, enrollment?: EmailEnrollment) => run(enrollment),
      logout: (_request: Request) => run(),
      async close() { closed++; },
    };
  };
  return { env, open, messages, opened, selected, closed: () => closed, fail: () => { fail = true; } };
}

describe('fixed hosted identity entry', () => {
  it('takes only the declared edge peer, captures enrollment and awaits delivery and closure', async () => {
    const f = fixture(), id = randomUUID();
    const response = await handleAuthRequest(request('request', {
      'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.10', 'x-noticeos-trusted-peer': '198.51.100.11',
      [EMAIL_ENROLLMENT_HEADERS.kind]: 'platform', [EMAIL_ENROLLMENT_HEADERS.id]: id,
    }), f.env, f.open);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.opened[0]?.peerAddress).toBe('192.0.2.22');
    expect(f.selected).toEqual([{ kind: 'platform', id }]); expect(f.closed()).toBe(1);
    expect(f.messages).toEqual([{ from: 'hello@example.test', to: 'person@example.test',
      subject: 'Your NoticeOS sign-in code', text: `Your NoticeOS sign-in code is ${code}.`,
      html: `<p>Your NoticeOS sign-in code</p><p><strong>${code}</strong></p>` }]);
  });
  it('refuses wrong profiles, native forged edge headers and Worker subrequests before identity or mail', async () => {
    const f = fixture();
    for (const profile of ['standalone', 'demo', 'unknown']) {
      expect((await handleAuthRequest(request(), { ...f.env, NOTICEOS_WORKSPACE_PROFILE: profile }, f.open)).status).toBe(403);
    }
    for (const proof of [request('request', {}, false), request('request', { 'cf-worker': 'upstream.example.test' }),
      request('request', { 'cf-connecting-ip': '2a06:98c0:3600::103' }), request('request', { 'cf-connecting-ip': '192.0.2.22, 192.0.2.23' })]) {
      expect((await handleAuthRequest(proof, f.env, f.open)).status).toBe(403);
    }
    expect((await handleAuthRequest(request(), { ...f.env, NOTICEOS_IDENTITY_EDGE: undefined }, f.open)).status).toBe(403);
    expect(f.opened).toEqual([]); expect(f.messages).toEqual([]);
  });
  it('refuses other auth operations, CSRF, malformed selectors and missing delivery before identity', async () => {
    const f = fixture();
    const probes = [new Request(origin + '/api/auth/sign-up/email'), request('request', { origin: 'https://foreign.example.test' }),
      request('request', { 'content-type': 'text/plain' }), request('request', { [EMAIL_ENROLLMENT_HEADERS.id]: randomUUID() }),
      request('request', { [EMAIL_ENROLLMENT_HEADERS.kind]: 'platform', [EMAIL_ENROLLMENT_HEADERS.id]: 'malformed' }),
      request('request', { [WORKSPACE_SESSION_HEADER]: randomUUID() }), request('logout')];
    for (const proof of probes) {
      const response = await handleAuthRequest(proof, f.env, f.open);
      expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await handleAuthRequest(request(), { ...f.env, NOTICEOS_IDENTITY_EMAIL: undefined }, f.open)).status).toBe(403);
    expect(f.opened).toEqual([]); expect(f.messages).toEqual([]);
  });
  it('verification and bound logout do not depend on delivery; failures close and redact', async () => {
    const f = fixture(), env = { ...f.env, NOTICEOS_IDENTITY_EMAIL: undefined, NOTICEOS_IDENTITY_EMAIL_FROM: undefined };
    expect((await handleAuthRequest(request('verify'), env, f.open)).status).toBe(200);
    expect((await handleAuthRequest(request('logout', { [WORKSPACE_SESSION_HEADER]: randomUUID() }), env, f.open)).status).toBe(200);
    expect(f.messages).toEqual([]); expect(f.closed()).toBe(2);
    f.fail();
    const response = await handleAuthRequest(request('verify'), env, f.open);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false });
    expect(f.closed()).toBe(3);
  });
});

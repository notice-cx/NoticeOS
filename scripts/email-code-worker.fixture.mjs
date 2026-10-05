// Generated fixture bindings only; no production route or sender is activated.
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const action = Object.entries(EMAIL_CODE_PATHS).find(([, value]) => value === pathname)?.[0];
    if (!action) return new Response(null, { status: 404 });
    const login = openEmailCodeLogin({
      connectionString: env.FIXTURE_CONNECTION, trustedOrigin: env.FIXTURE_ORIGIN,
      sessionSecret: env.FIXTURE_SECRET, peerAddress: env.FIXTURE_PEER,
      deliver: async (message) => {
        const reply = await env.CAPTURE_MAIL.fetch('https://fixture.example.test/capture', { method: 'POST', body: JSON.stringify(message) });
        if (!reply.ok) throw new Error('Captured delivery refused');
        await reply.arrayBuffer();
      },
    });
    try {
      const id = request.headers.get('x-fixture-enrollment');
      const enrollment = id ? { kind: 'platform', id } : undefined;
      if (action === 'request') return await login.requestCode(request, enrollment);
      if (action === 'verify') return await login.verifyCode(request, enrollment);
      return await login.logout(request);
    } catch {
      return new Response(JSON.stringify({ ok: false }), { status: 403, headers: { 'content-type': 'application/json' } });
    } finally { await login.close(); }
  },
};

// Generated-fixture entry only; no public platform route or caller readiness.
import { openPlatformProvisioning } from '../packages/postgres/src/platform-provisioning.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === EMAIL_CODE_PATHS.request || pathname === EMAIL_CODE_PATHS.verify) {
      const login = openEmailCodeLogin({ connectionString: env.FIXTURE_IDENTITY_CONNECTION,
        trustedOrigin: 'https://provision.example.test', sessionSecret: env.FIXTURE_SESSION_SECRET,
        peerAddress: '192.0.2.201', deliver: async message => {
          const response = await env.FIXTURE_MAIL.fetch('https://captured-mail.example.test/', {
            method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json' },
          });
          if (response.status !== 204) throw new Error('Captured delivery refused');
        } });
      try {
        const selector = { kind: 'platform', id: env.FIXTURE_ENROLLMENT_ID };
        return await (pathname === EMAIL_CODE_PATHS.request ? login.requestCode(request, selector) : login.verifyCode(request, selector));
      } finally { await login.close(); }
    }
    const module = openPlatformProvisioning({
      platformConnectionString: env.FIXTURE_PLATFORM_CONNECTION,
      identityConnectionString: env.FIXTURE_IDENTITY_CONNECTION,
      trustedOrigin: 'https://provision.example.test', sessionSecret: env.FIXTURE_SESSION_SECRET,
      // Fixed fixture service. A future successful activation proof must bind
      // this to actual Node executor verification and same-realm custody checks.
      verifyProject: async (mapping, budget) => {
        const result = await env.FIXTURE_VERIFIER.fetch('https://verifier.example.test/', {
          method: 'POST', body: JSON.stringify({ mapping, deadline: budget.deadline }), headers: { 'content-type': 'application/json' },
        });
        await result.body?.cancel();
        if (result.status !== 204) throw new Error('Physical verification refused');
      },
    });
    try {
      const command = await request.json();
      const value = new URL(request.url).pathname === '/prepare'
        ? await module.prepare(command) : await module.activate(command);
      return Response.json(value);
    } catch {
      return Response.json({ refused: true }, { status: 403 });
    } finally {
      await module.close();
    }
  },
};

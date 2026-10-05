import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, type EmailEnrollment } from '../../../../scripts/identity-protocol.mjs';
import { WORKSPACE_SESSION_HEADER } from '../../../../scripts/browser-request-policy.mjs';
import type { ApiTransport } from './api';

/** Login precedes workspace ownership. Logout compares the captured session
 * against the maintained cookie identity at the server; it cannot target a
 * replacement session from another tab. No raw auth-engine interface here. */
export function createBrowserAuth(fetch: ApiTransport) {
  async function post(path: string, body: { email: string } | { email: string; otp: string } | { invitationId: string } | Record<string, never>, options: {
    sessionId?: string; enrollment?: EmailEnrollment; signal?: AbortSignal;
  } = {}) {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    if (options.sessionId !== undefined) headers.set(WORKSPACE_SESSION_HEADER, options.sessionId);
    if (options.enrollment) {
      headers.set(EMAIL_ENROLLMENT_HEADERS.kind, options.enrollment.kind);
      headers.set(EMAIL_ENROLLMENT_HEADERS.id, options.enrollment.id);
    }
    const response = await fetch(path, { method: 'POST', body: JSON.stringify(body), headers,
      credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]) });
    void response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new Error('Sign-in could not be completed.');
    }
  }
  return Object.freeze({
    request(email: string, options?: { enrollment?: EmailEnrollment; signal?: AbortSignal }) { return post(EMAIL_CODE_PATHS.request, { email }, options); },
    verify(email: string, otp: string, options?: { enrollment?: EmailEnrollment; signal?: AbortSignal }) { return post(EMAIL_CODE_PATHS.verify, { email, otp }, options); },
    logout(sessionId: string, signal?: AbortSignal) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(sessionId)) throw new Error('Browser session is invalid.');
      return post(EMAIL_CODE_PATHS.logout, {}, { sessionId, signal });
    },
    acceptInvitation(sessionId: string, invitationId: string, signal?: AbortSignal) {
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
      if (!uuid.test(sessionId) || !uuid.test(invitationId)) throw new Error('Invitation is invalid.');
      return post(ACCEPT_INVITATION_PATH, { invitationId }, { sessionId, signal });
    },
  });
}

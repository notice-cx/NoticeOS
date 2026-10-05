/** Browser-visible protocol names only; none grants identity or membership. */
export const EMAIL_CODE_PATHS = Object.freeze({
  request: '/api/auth/email-otp/send-verification-otp',
  verify: '/api/auth/sign-in/email-otp',
  logout: '/api/auth/sign-out',
});
export const EMAIL_ENROLLMENT_HEADERS = Object.freeze({
  kind: 'x-noticeos-enrollment-kind',
  id: 'x-noticeos-enrollment-id',
});
export const MEMBERSHIP_PATH = '/api/memberships';
export const ACCEPT_INVITATION_PATH = '/api/invitations/accept';
export interface EmailEnrollment {
  readonly kind: 'platform' | 'invitation';
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export type EmailEnrollmentLanding =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'enrollment'; enrollment: EmailEnrollment; cleanUrl: string }>;

/** A mailbox-bound enrollment selector, never email, code or authority. */
export function emailEnrollmentUrl(origin: string, enrollment: EmailEnrollment): string {
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin
    || !['platform', 'invitation'].includes(enrollment.kind) || !UUID.test(enrollment.id)) throw new Error('Enrollment link is invalid.');
  return `${origin}/sign-in#${enrollment.kind}=${enrollment.id}`;
}

/** Capture once, then remove the fragment before making a request. Unknown or
 * malformed sign-in links must not become ordinary account login. */
export function parseEmailEnrollmentLanding(input: string): EmailEnrollmentLanding {
  try {
    if (input.length > 8192) return Object.freeze({ kind: 'invalid' });
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return Object.freeze({ kind: 'invalid' });
    if (url.pathname !== '/sign-in') return Object.freeze({ kind: 'none' });
    if (url.search) return Object.freeze({ kind: 'invalid' });
    if (!url.hash) return Object.freeze({ kind: 'none' });
    const match = url.hash.match(/^#(platform|invitation)=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u);
    if (!match || match[2] === undefined) return Object.freeze({ kind: 'invalid' });
    return Object.freeze({ kind: 'enrollment', enrollment: Object.freeze({ kind: match[1] as EmailEnrollment['kind'], id: match[2] }),
      cleanUrl: `${url.origin}/sign-in` });
  } catch { return Object.freeze({ kind: 'invalid' }); }
}

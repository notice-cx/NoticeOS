import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';

export interface IdentityMailBindings {
  NOTICEOS_IDENTITY_EMAIL_FROM?: string;
  NOTICEOS_IDENTITY_EMAIL?: SendEmail;
}
export interface IdentityMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}
/** Server-selected sender, captured before identity work. No provider account
 * or binding is enabled by importing this adapter. */
export function captureIdentityMail(env: IdentityMailBindings): (message: IdentityMail) => Promise<void> {
  const from = env[PRODUCT_ENV.identityEmailFrom.name], mail = env.NOTICEOS_IDENTITY_EMAIL;
  if (typeof from !== 'string' || from.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(from)
    || !mail || typeof mail.send !== 'function') throw new Error('Identity delivery unavailable');
  return async message => { await mail.send({ from, ...message }); };
}

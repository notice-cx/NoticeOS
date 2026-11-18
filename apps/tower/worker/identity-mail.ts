import { PRODUCT_ENV } from '../../../scripts/product-env.mjs';

export interface IdentityMailBindings {
  NOTICEOS_IDENTITY_EMAIL_FROM?: string;
  NOTICEOS_IDENTITY_EMAIL?: SendEmail;
  NOTICEOS_IDENTITY_MAIL_WORKSPACES?: readonly string[];
}
export interface IdentityMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Only the prepared customer runtime sets this scope on the Tower Worker. */
export function identityMailWorkspaces(env: IdentityMailBindings): readonly string[] | undefined {
  const workspaces = env.NOTICEOS_IDENTITY_MAIL_WORKSPACES;
  if (workspaces === undefined) return undefined;
  if (!Array.isArray(workspaces) || workspaces.length < 1 || workspaces.length > 64
    || workspaces.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))
    || new Set(workspaces).size !== workspaces.length) throw new Error('Identity mail scope unavailable');
  return workspaces;
}
/** Server-selected sender, captured before identity work. No provider account
 * or binding is enabled by importing this adapter. */
export function captureIdentityMail(env: IdentityMailBindings): (message: IdentityMail) => Promise<void> {
  const from = env[PRODUCT_ENV.identityEmailFrom.name], mail = env.NOTICEOS_IDENTITY_EMAIL;
  if (typeof from !== 'string' || from.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(from)
    || !mail || typeof mail.send !== 'function') throw new Error('Identity delivery unavailable');
  return async message => { await mail.send({ from, ...message }); };
}

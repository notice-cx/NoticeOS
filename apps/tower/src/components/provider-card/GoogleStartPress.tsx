import type { HTMLAttributes, Ref } from 'react';

/** The existing full-page standalone link and hosted custody POST share their
 * presentation. Hosted controls never expose a GET fallback in their href. */
export function GoogleStartPress({ href, rel, onStart, starting, children, ref, ...props }:
  HTMLAttributes<HTMLElement> & { href: string; rel?: string; ref?: Ref<HTMLElement>; onStart?: () => void; starting?: boolean }) {
  const attach = (node: HTMLElement | null) => { if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; };
  if (!onStart) return <a {...props} href={href} rel={rel} ref={attach}>{children}</a>;
  const { onClick: _onClick, ...buttonProps } = props;
  return <button {...buttonProps} ref={attach} type="button" disabled={starting} onClick={onStart}>{children}</button>;
}

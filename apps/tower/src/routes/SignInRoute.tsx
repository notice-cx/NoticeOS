import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import type { BrowserEntry } from '@/lib/browser-entry';

/** The public identity protocol precedes a workspace; no bound product API,
 * remembered email/code or browser-selected permission enters this form. */
export function SignInRoute({ entry }: { entry: BrowserEntry }) {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const abort = new AbortController();
    request.current?.abort(); request.current = abort;
    setBusy(true); setFailed(false);
    try {
      const options = { enrollment: entry.enrollment, signal: abort.signal };
      if (sent) {
        await entry.auth.verify(email, otp, options);
        if (!mounted.current || abort.signal.aborted) return;
        setOtp(''); setEmail('');
        await entry.signedIn();
      } else {
        await entry.auth.request(email, options);
        if (mounted.current && !abort.signal.aborted) setSent(true);
      }
    } catch {
      if (mounted.current && !abort.signal.aborted) setFailed(true);
    } finally { if (mounted.current) setBusy(false); }
  }
  return <form className="flex flex-col gap-4" onSubmit={event => void submit(event)}>
    <h1 className="text-lg font-semibold">Sign in</h1>
    <div className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor="sign-in-email">Email *</label>
      <input className={`${fieldClass} w-full`} id="sign-in-email" type="email" autoComplete="email" required value={email} disabled={busy || sent}
        onChange={event => setEmail(event.target.value)} />
    </div>
    {sent ? <div className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor="sign-in-code">Email code *</label>
      <input className={`${fieldClass} w-full`} id="sign-in-code" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={6}
        pattern="[0-9]{6}" value={otp} disabled={busy} onChange={event => setOtp(event.target.value)} />
    </div> : null}
    {failed ? <span role="status" data-status-for="sign-in" className="text-sm text-error">{sent ? 'Code not accepted. Try again.' : 'Code could not be sent. Try again.'}</span> : null}
    <Button type="submit" disabled={busy}>{busy ? 'Working…' : sent ? entry.enrollment?.kind === 'invitation' ? 'Sign in and join' : 'Sign in' : 'Send code'}</Button>
    {sent ? <Button type="button" variant="ghost" disabled={busy} onClick={() => { setSent(false); setOtp(''); setFailed(false); }}>Change email</Button> : null}
  </form>;
}

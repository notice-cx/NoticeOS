import { useRef, useState } from 'react';
import { useBrowserRuntime, useOwnerToast } from '@/lib/browser-context';

/** Navigation is the last owner-bound effect, after the API decoded its body. */
export function useGoogleOAuthStart() {
  const runtime = useBrowserRuntime();
  const toast = useOwnerToast();
  const [starting, setStarting] = useState(false);
  const issuing = useRef(false);
  if (runtime.owner.mode !== 'hosted') return { onStart: undefined, starting: false };
  return {
    starting,
    onStart: runtime.guard(() => {
      if (issuing.current) return;
      issuing.current = true;
      setStarting(true);
      void (async () => {
        try {
          const target = await runtime.api.beginGoogleOAuth();
          runtime.guard(() => window.location.assign(target))();
        } catch {
          toast.error('Google sign-in could not start.');
        } finally {
          issuing.current = false;
          runtime.guard(() => setStarting(false))();
        }
      })();
    }),
  };
}

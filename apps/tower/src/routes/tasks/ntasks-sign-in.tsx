import { useQueryClient } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { useCallback, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useNtasksSignIn } from "@/hooks/useNtasksSignIn";
import { TASK_SERVICE_KEY } from "@/hooks/useTaskService";
import { useOwnerToast, useTowerApi } from "@/lib/browser-context";
import { startSignIn, type NtasksApp } from "@/lib/ntasks-sign-in";

/**
 * Starts the person's sign-in to Ntasks from this page, and comes back here.
 * With no Tower client ID saved, the installation registers the Tower in
 * Ntasks first, so the first sign-in is the same one press. A refusal is
 * shown as a toast and starts nothing. Resolves false when nothing started.
 */
export function useBeginNtasksSignIn(): () => Promise<boolean> {
  const signIn = useNtasksSignIn();
  const api = useTowerApi();
  const queryClient = useQueryClient();
  const { pathname, search, hash } = useLocation();
  const toast = useOwnerToast();
  const returnTo = `${pathname}${search}${hash}`;
  return useCallback(async () => {
    async function appToSignIn(): Promise<NtasksApp> {
      // A browser still signed in whose token Ntasks refused signs in again.
      if (signIn.kind === "signed-out" || signIn.kind === "signed-in") return signIn.app;
      if (signIn.kind !== "unconfigured") throw new Error("Tasks here do not live in Ntasks.");
      const { clientId } = await api.registerNtasksApp();
      // Saved with the connection now: every surface reads the new client id.
      void queryClient.invalidateQueries({ queryKey: TASK_SERVICE_KEY });
      return { origin: signIn.origin, clientId };
    }
    try {
      window.location.assign(await startSignIn(await appToSignIn(), { towerOrigin: window.location.origin, returnTo }));
      return true;
    } catch (error) {
      toast.error("Not signed in to Ntasks", { description: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }, [signIn, api, queryClient, returnTo, toast]);
}

/**
 * Settings' way to sign in to Ntasks while this browser is not: Ntasks takes
 * decisions only from a person, never from the installation's credential.
 */
export function SignInToNtasks({ size = "sm", className }: { size?: "sm" | "default"; className?: string }) {
  const signIn = useNtasksSignIn();
  const begin = useBeginNtasksSignIn();
  const [starting, setStarting] = useState(false);
  if (signIn.kind === "local" || signIn.kind === "signed-in") return null;
  async function press() {
    setStarting(true);
    if (!(await begin())) setStarting(false);
  }
  return (
    <Button type="button" size={size} className={className} disabled={starting} onClick={() => void press()} data-task-action="sign-in-to-ntasks">
      <LogIn aria-hidden />
      Sign in to Ntasks
    </Button>
  );
}

/** Who is signed in to Ntasks in this browser, and the way out. */
export function NtasksSignedInAs() {
  const signIn = useNtasksSignIn();
  if (signIn.kind !== "signed-in") return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-ntasks-signed-in>
      {signIn.name ? <span>Ntasks: <span className="font-medium text-foreground">{signIn.name}</span></span> : null}
      <Button type="button" size="sm" variant="outline" onClick={() => signIn.session.signOut()}>Sign out of Ntasks</Button>
    </span>
  );
}

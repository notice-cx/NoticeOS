import { useQueryClient } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { useCallback, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useNtasksSignIn } from "@/hooks/useNtasksSignIn";
import { TASK_SERVICE_KEY } from "@/hooks/useTaskService";
import { useOwnerPreferences, useOwnerToast, useTowerApi } from "@/lib/browser-context";
import { heldSentence, keepApp, keptApp, startSignIn } from "@/lib/ntasks-sign-in";

/**
 * Starts the person's sign-in to Ntasks from this page, and comes back here.
 * The installation first asks Ntasks for the Tower's app at this page's
 * address, registering it there the first time, so the first sign-in from
 * any address is the same one press; this browser keeps that app for the
 * address. A refusal is shown as a toast and starts nothing. Resolves false
 * when nothing started.
 */
export function useBeginNtasksSignIn(): () => Promise<boolean> {
  const signIn = useNtasksSignIn();
  const api = useTowerApi();
  const storage = useOwnerPreferences();
  const queryClient = useQueryClient();
  const { pathname, search, hash } = useLocation();
  const toast = useOwnerToast();
  const returnTo = `${pathname}${search}${hash}`;
  return useCallback(async () => {
    try {
      if (signIn.kind === "local") throw new Error("Tasks here do not live in Ntasks.");
      const origin = signIn.kind === "unconfigured" ? signIn.origin : signIn.app.origin;
      const { clientId, held } = await api.registerNtasksApp();
      keepApp(storage, origin, { clientId, held });
      // The first registration is saved with the connection: every surface reads its client id.
      if (signIn.kind === "unconfigured") void queryClient.invalidateQueries({ queryKey: TASK_SERVICE_KEY });
      window.location.assign(await startSignIn({ origin, clientId }, { towerOrigin: window.location.origin, returnTo, held }));
      return true;
    } catch (error) {
      toast.error("Not signed in to Ntasks", { description: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }, [signIn, api, storage, queryClient, returnTo, toast]);
}

/**
 * Settings' way to sign in to Ntasks while this browser is not: Ntasks takes
 * decisions only from a person, never from the installation's credential.
 */
export function SignInToNtasks({ size = "sm", className }: { size?: "sm" | "default"; className?: string }) {
  const signIn = useNtasksSignIn();
  const begin = useBeginNtasksSignIn();
  const storage = useOwnerPreferences();
  const [starting, setStarting] = useState(false);
  if (signIn.kind === "local" || signIn.kind === "signed-in") return null;
  async function press() {
    setStarting(true);
    if (!(await begin())) setStarting(false);
  }
  const button = (
    <Button type="button" size={size} className={className} disabled={starting} onClick={() => void press()} data-task-action="sign-in-to-ntasks">
      <LogIn aria-hidden />
      Sign in to Ntasks
    </Button>
  );
  const origin = signIn.kind === "unconfigured" ? signIn.origin : signIn.app.origin;
  if (!keptApp(storage, origin)?.held) return button;
  return (
    <div className="flex basis-full flex-col items-start gap-2">
      {button}
      <p className="m-0 text-sm text-muted-foreground" data-ntasks-address-held>{heldSentence(window.location.origin)}</p>
    </div>
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

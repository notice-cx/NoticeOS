import { useQueryClient } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useNtasksSignIn } from "@/hooks/useNtasksSignIn";
import { TASK_SERVICE_KEY } from "@/hooks/useTaskService";
import { useOwnerToast, useTowerApi } from "@/lib/browser-context";
import { startSignIn, type NtasksApp } from "@/lib/ntasks-sign-in";

/**
 * What a decision, an approval or a dispute shows while tasks live in Ntasks
 * and this browser is not signed in to it: Ntasks takes those only from a
 * person, never from the installation's credential. Once signed in, the
 * decision's own buttons return and act as that person. The first sign-in
 * on an installation with no Tower client ID saved has the installation
 * register the Tower in Ntasks first, so it is the same one press.
 */
export function SignInToNtasks({ size = "sm", className }: { size?: "sm" | "default"; className?: string }) {
  const signIn = useNtasksSignIn();
  const api = useTowerApi();
  const queryClient = useQueryClient();
  const { pathname, search, hash } = useLocation();
  const toast = useOwnerToast();
  const [starting, setStarting] = useState(false);
  if (signIn.kind === "local" || signIn.kind === "signed-in") return null;
  async function appToSignIn(): Promise<NtasksApp> {
    if (signIn.kind === "signed-out") return signIn.app;
    if (signIn.kind !== "unconfigured") throw new Error("Tasks here do not live in Ntasks.");
    const { clientId } = await api.registerNtasksApp();
    // Saved with the connection now: every surface reads the new client id.
    void queryClient.invalidateQueries({ queryKey: TASK_SERVICE_KEY });
    return { origin: signIn.origin, clientId };
  }
  async function begin() {
    setStarting(true);
    try {
      window.location.assign(await startSignIn(await appToSignIn(), { towerOrigin: window.location.origin, returnTo: `${pathname}${search}${hash}` }));
    } catch (error) {
      setStarting(false);
      toast.error("Not signed in to Ntasks", { description: error instanceof Error ? error.message : String(error) });
    }
  }
  return (
    <Button type="button" size={size} className={className} disabled={starting} onClick={() => void begin()} data-task-action="sign-in-to-ntasks">
      <LogIn aria-hidden />
      Sign in to Ntasks
    </Button>
  );
}

/** The Tasks page header's note of who decides here, and the way out. */
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

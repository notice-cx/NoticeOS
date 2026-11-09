import { LogIn } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { TASK_SOURCES_PATH } from "@shared/task-source";
import { Button } from "@/components/ui/button";
import { useNtasksSignIn } from "@/hooks/useNtasksSignIn";
import { useOwnerToast } from "@/lib/browser-context";
import { startSignIn } from "@/lib/ntasks-sign-in";

/**
 * What a decision, an approval or a dispute shows while tasks live in Ntasks
 * and this browser is not signed in to it: Ntasks takes those only from a
 * person, never from the installation's credential. Once signed in, the
 * decision's own buttons return and act as that person. Before a Tower client
 * ID is saved, it leads to Settings → Task projects, where it is.
 */
export function SignInToNtasks({ size = "sm", className }: { size?: "sm" | "default"; className?: string }) {
  const signIn = useNtasksSignIn();
  const { pathname, search, hash } = useLocation();
  const toast = useOwnerToast();
  const [starting, setStarting] = useState(false);
  if (signIn.kind === "local" || signIn.kind === "signed-in") return null;
  if (signIn.kind === "unconfigured") {
    return (
      <Button asChild size={size} variant="outline" className={className}>
        <Link to={`${TASK_SOURCES_PATH}#ntasks`} data-task-action="set-up-ntasks-sign-in">Set up Ntasks sign-in</Link>
      </Button>
    );
  }
  async function begin() {
    if (signIn.kind !== "signed-out") return;
    setStarting(true);
    try {
      window.location.assign(await startSignIn(signIn.app, { towerOrigin: window.location.origin, returnTo: `${pathname}${search}${hash}` }));
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

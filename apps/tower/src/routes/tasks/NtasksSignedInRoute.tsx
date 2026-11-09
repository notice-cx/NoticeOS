import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { personSession } from "@/hooks/useNtasksSignIn";
import { useOwnerPreferences } from "@/lib/browser-context";
import { useDocumentTitle } from "@/lib/document-title";
import { finishSignIn } from "@/lib/ntasks-sign-in";

/** One exchange per code: a page drawn twice must not spend it twice. */
const exchanges = new Map<string, Promise<{ returnTo: string }>>();

/** The address Ntasks returns the person's browser to after sign-in: the code
 * is exchanged for their tokens here, and the page they started from opens. */
export function NtasksSignedInRoute() {
  useDocumentTitle("Signing in to Ntasks");
  const { search } = useLocation();
  const navigate = useNavigate();
  const storage = useOwnerPreferences();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let exchange = exchanges.get(search);
    if (!exchange) {
      exchange = finishSignIn(search, { sessionFor: (app) => personSession(app, storage) });
      exchanges.set(search, exchange);
    }
    exchange.then(({ returnTo }) => { if (current) navigate(/^\/(?!\/)/u.test(returnTo) ? returnTo : "/tasks", { replace: true }); },
      (error: unknown) => { if (current) setFailure(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [search, storage, navigate]);
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Tasks" />
      {failure === null ? (
        <p className="m-0 text-sm text-muted-foreground" role="status" data-status-for="tasks:ntasks-sign-in">Signing in to Ntasks…</p>
      ) : (
        <div className="flex flex-col items-start gap-2" data-ntasks-sign-in-failed>
          <p className="m-0 text-sm text-destructive" role="alert">{failure}</p>
          <Link to="/tasks" className="text-sm font-medium text-foreground underline-offset-4 hover:underline">Back to Tasks</Link>
        </div>
      )}
    </div>
  );
}

export default NtasksSignedInRoute;

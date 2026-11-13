import { useQuery } from "@tanstack/react-query";
import { API_VERSION, NtasksApp, type TokenSource } from "@notice-cx/ntasks-ui";
import "@notice-cx/ntasks-ui/styles.css";
import { useCallback, useMemo, type ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ConnectNtasks, TaskHubUnavailable } from "@/components/TaskSourceSection";
import { useNtasksSignIn, type NtasksSignIn } from "@/hooks/useNtasksSignIn";
import { needsNtasks, useTaskService } from "@/hooks/useTaskService";
import { useAppliedTheme } from "@/hooks/useTheme";
import { useDemoReadonly } from "@/lib/browser-context";
import { documentTitle } from "@/lib/document-title";
import { SignInToNtasks, useBeginNtasksSignIn } from "@/routes/tasks/ntasks-sign-in";

/** Where the Tower mounts the Ntasks UI; every task address is under it. */
const BASE_PATH = "/tasks";
/** What the package ends each page's title with; the Tower names itself instead. */
const NTASKS_TITLE_SUFFIX = " — Ntasks";

export const OLDER_NTASKS = "This Ntasks is older than the Tower's task pages need; update it.";
export const NEWER_NTASKS = "This Ntasks no longer answers the Tower's task pages; update NoticeOS.";

/** `GET /api/version`, which an Ntasks answers before anyone signs in. */
export interface NtasksVersion {
  readonly version: number;
  readonly oldest: number;
}

/** Why the pages cannot work with this Ntasks, or null when they can or its version is unread. */
export function versionProblem(found: NtasksVersion | null | undefined, needed: number = API_VERSION): string | null {
  if (!found) return null;
  if (found.version < needed) return OLDER_NTASKS;
  if (found.oldest > needed) return NEWER_NTASKS;
  return null;
}

async function readVersion(origin: string, signal: AbortSignal): Promise<NtasksVersion | null> {
  const answer = await fetch(`${origin}/api/version`, { headers: { accept: "application/json" }, signal });
  if (!answer.ok) return null;
  const body = (await answer.json()) as Partial<NtasksVersion>;
  return typeof body.version === "number" && typeof body.oldest === "number" ? { version: body.version, oldest: body.oldest } : null;
}

/**
 * The person's side of every request the Ntasks UI sends: their access token
 * once they signed in to Ntasks in this browser, and what its Sign in does,
 * the same one press as Settings' Sign in to Ntasks. The installation's
 * service credential never reaches the browser.
 */
function useTokenSource(signIn: NtasksSignIn): TokenSource {
  const begin = useBeginNtasksSignIn();
  return useMemo(() => ({
    token: () => (signIn.kind === "signed-in" ? signIn.session.token() : null),
    signIn: () => void begin(),
  }), [signIn, begin]);
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Tasks" />
      {children}
    </div>
  );
}

/**
 * `/tasks/*`: the Ntasks web app, from the published `@notice-cx/ntasks-ui`
 * package, acting as the person signed in to Ntasks in this browser. Its own
 * sidebar stays behind its Sidebar button, so the Tower's sidebar is the one
 * beside the page. Counts elsewhere in the Tower are read on the server with
 * the installation's credential and are not drawn here.
 *
 * Until this browser signs in, the page is the Tower's Sign in to Ntasks and
 * the app is not mounted: it would call Ntasks with no token, and an Ntasks
 * that has not registered the Tower answers that without CORS headers, so
 * the browser reports only "Failed to fetch".
 */
export function TasksRoute() {
  const status = useTaskService();
  const signIn = useNtasksSignIn();
  const theme = useAppliedTheme();
  const demo = useDemoReadonly();
  const tokenSource = useTokenSource(signIn);
  const origin = signIn.kind === "local" ? null : signIn.kind === "unconfigured" ? signIn.origin : signIn.app.origin;
  const version = useQuery({
    queryKey: ["ntasks-version", origin],
    queryFn: ({ signal }) => readVersion(origin!, signal),
    enabled: origin !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const onTitle = useCallback((title: string) => {
    document.title = documentTitle(title.endsWith(NTASKS_TITLE_SUFFIX) ? title.slice(0, -NTASKS_TITLE_SUFFIX.length) : title, demo);
  }, [demo]);

  if (needsNtasks(status.data)) return <Notice><ConnectNtasks /></Notice>;
  if (origin === null) return status.isPending ? null : <Notice><TaskHubUnavailable /></Notice>;
  const problem = versionProblem(version.data);
  if (problem) return <Notice><p className="m-0 text-sm" role="alert" data-ntasks-version>{problem}</p></Notice>;
  if (version.isPending) return null;
  if (signIn.kind === "unconfigured" || signIn.kind === "signed-out") return <Notice><SignInToNtasks size="default" className="self-start" /></Notice>;
  return <NtasksApp apiOrigin={origin} tokenSource={tokenSource} basePath={BASE_PATH} theme={theme} onTitle={onTitle} sidebar="sheet" />;
}

export default TasksRoute;

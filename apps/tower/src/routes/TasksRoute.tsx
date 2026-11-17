import { useQuery } from "@tanstack/react-query";
import { API_VERSION, NtasksApp, type NtasksAppProps, type TokenSource } from "@notice-cx/ntasks-ui";
import "@notice-cx/ntasks-ui/styles.css";
import { useCallback, useMemo, type ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ConnectNtasks, TaskHubUnavailable } from "@/components/TaskSourceSection";
import { useNtasksSignIn, type NtasksSignIn } from "@/hooks/useNtasksSignIn";
import { needsNtasks, useTaskService } from "@/hooks/useTaskService";
import { useAppliedTheme } from "@/hooks/useTheme";
import { useBrowserRuntime, useDemoReadonly, useVerifiedDemoMode } from "@/lib/browser-context";
import { documentTitle } from "@/lib/document-title";
import { SignInToNtasks, useBeginNtasksSignIn } from "@/routes/tasks/ntasks-sign-in";
import { demoViewer } from "@shared/demo-viewer";
import { hostedTaskAuthorization } from "../../../../scripts/hosted-task-request.mjs";

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
  const runtime = useBrowserRuntime();
  return useMemo(() => ({
    async token() {
      const active = runtime.guard(() => true);
      if (active() !== true) throw new Error("This browser session has ended.");
      const personal = signIn.kind === "signed-in" ? await signIn.session.token().catch(error => {
        if (runtime.owner.mode !== "hosted") throw error;
        return null;
      }) : null;
      if (active() !== true) throw new Error("This browser session has ended.");
      const owner = runtime.owner;
      return owner.mode === "hosted" ? hostedTaskAuthorization(owner.workspaceId, owner.sessionId, personal) : personal;
    },
    signIn: () => void begin(),
  }), [signIn, begin, runtime]);
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Tasks" />
      {children}
    </div>
  );
}

export function TasksRoute() {
  const theme = useAppliedTheme();
  const demo = useDemoReadonly();
  const hostedDemo = useVerifiedDemoMode() && demoViewer() === null;
  const onTitle = useCallback((title: string) => {
    document.title = documentTitle(title.endsWith(NTASKS_TITLE_SUFFIX) ? title.slice(0, -NTASKS_TITLE_SUFFIX.length) : title, demo);
  }, [demo]);
  const app = { basePath: BASE_PATH, theme, onTitle, sidebar: "sheet" } as const;

  return hostedDemo ? <NtasksApp {...app} /> : <ConnectedTasks app={app} />;
}

/** Mount the personal task board once Ntasks has granted this browser access. */
function ConnectedTasks({ app }: { app: Pick<NtasksAppProps, "basePath" | "theme" | "onTitle" | "sidebar"> }) {
  const hosted = useBrowserRuntime().owner.mode === "hosted";
  const status = useTaskService();
  const signIn = useNtasksSignIn();
  const tokenSource = useTokenSource(signIn);
  const origin = signIn.kind === "local" ? null : signIn.kind === "unconfigured" ? signIn.origin : signIn.app.origin;
  const version = useQuery({
    queryKey: ["ntasks-version", origin],
    queryFn: ({ signal }) => readVersion(origin!, signal),
    enabled: origin !== null && !hosted,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (needsNtasks(status.data)) return <Notice><ConnectNtasks /></Notice>;
  if (hosted && status.data?.connected === true) return (
    <>
      {status.data.writable && signIn.kind !== "signed-in" ? (
        <div className="mx-auto w-full max-w-[1400px] px-4 pt-4 md:px-6"><SignInToNtasks /></div>
      ) : null}
      <NtasksApp {...app} tokenSource={tokenSource} />
    </>
  );
  if (hosted && status.data?.reason) return <Notice><p role="alert" className="m-0 text-sm">{status.data.reason}</p></Notice>;
  if (origin === null) return status.isPending ? null : <Notice><TaskHubUnavailable /></Notice>;
  const problem = versionProblem(version.data);
  if (problem) return <Notice><p className="m-0 text-sm" role="alert" data-ntasks-version>{problem}</p></Notice>;
  if (version.isPending) return null;
  if (signIn.kind === "unconfigured" || signIn.kind === "signed-out") return <Notice><SignInToNtasks size="default" className="self-start" /></Notice>;
  return <NtasksApp {...app} apiOrigin={origin} tokenSource={tokenSource} />;
}

export default TasksRoute;

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TaskServiceStatus } from "@shared/tasks";
import { useBrowserRuntime, useOwnerPreferences, useTowerApi } from "@/lib/browser-context";
import type { TowerApi } from "@/lib/api";
import { createPersonSession, keptApp, personDecisions, type NtasksApp, type PersonSession, type TokenStorage } from "@/lib/ntasks-sign-in";
import { useTaskService } from "@/hooks/useTaskService";

/**
 * Who decides on the Tasks pages. `local`: tasks do not live in Ntasks (or
 * the status is unread), and the Tower's own routes take every decision.
 * `unconfigured`: they live in Ntasks, but no Tower client ID is saved yet;
 * Sign in to Ntasks has the installation register the Tower there first.
 * `signed-out` and `signed-in`: the person's sign-in to Ntasks in this
 * browser, with which their decisions are sent.
 */
export type NtasksSignIn =
  | { readonly kind: "local" }
  | { readonly kind: "unconfigured"; readonly origin: string }
  | { readonly kind: "signed-out"; readonly app: NtasksApp; readonly session: PersonSession }
  | { readonly kind: "signed-in"; readonly app: NtasksApp; readonly session: PersonSession; readonly name: string | null };

/** The connected app a status names, when people can sign in to it. */
export function ntasksApp(status: TaskServiceStatus | undefined): NtasksApp | "unconfigured" | null {
  if (status?.connected !== true || !status.origin) return null;
  return status.app ? { origin: status.origin, clientId: status.app.clientId } : "unconfigured";
}

/** One holder per app in each browser runtime, so every surface sees one
 * sign-in, and a runtime that replaced a retired one starts its own. */
let sessions = new WeakMap<object, Map<string, PersonSession>>();
export function personSession(runtime: object, app: NtasksApp, storage: TokenStorage): PersonSession {
  const key = JSON.stringify([app.origin, app.clientId]);
  let held = sessions.get(runtime);
  if (!held) { held = new Map(); sessions.set(runtime, held); }
  let session = held.get(key);
  if (!session) { session = createPersonSession(app, { storage }); held.set(key, session); }
  return session;
}
/** Tests only: forget every holder. */
export function resetPersonSessions(): void { sessions = new WeakMap(); }

const NO_SUBSCRIPTION = () => () => {};
const SIGNED_OUT = { signedIn: false, name: null } as const;

export function useNtasksSignIn(): NtasksSignIn {
  const { data } = useTaskService();
  const runtime = useBrowserRuntime();
  const storage = useOwnerPreferences();
  const app = ntasksApp(data);
  const origin = app === null ? null : app === "unconfigured" ? data!.origin! : app.origin;
  // The app this Tower address signed in with wins over the installation's
  // saved one, which Ntasks registered for the address the Tower first signed in from.
  const kept = origin === null ? null : keptApp(storage, origin);
  const clientId = app === null ? null : kept?.clientId ?? (app === "unconfigured" ? null : app.clientId);
  const session = useMemo(() => origin !== null && clientId !== null ? personSession(runtime, { origin, clientId }, storage) : null,
    [runtime, origin, clientId, storage]);
  const state = useSyncExternalStore(session?.subscribe ?? NO_SUBSCRIPTION, session?.snapshot ?? (() => SIGNED_OUT), session?.snapshot ?? (() => SIGNED_OUT));
  // A sign-in or a sign-out in another tab of this browser holds here too.
  useEffect(() => {
    if (!session) return;
    const reload = () => session.reload();
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [session]);
  return useMemo<NtasksSignIn>(() => {
    if (origin === null) return { kind: "local" };
    if (session === null) return { kind: "unconfigured", origin };
    return state.signedIn ? { kind: "signed-in", app: session.app, session, name: state.name } : { kind: "signed-out", app: session.app, session };
  }, [origin, session, state]);
}

/** Whether a decision here needs the person to sign in to Ntasks first: its
 * buttons give way to Sign in to Ntasks. */
export function needsSignIn(signIn: NtasksSignIn): boolean {
  return signIn.kind === "unconfigured" || signIn.kind === "signed-out";
}
export function useNeedsNtasksSignIn(): boolean {
  return needsSignIn(useNtasksSignIn());
}

/** The Tower's API with a signed-in person's decisions sent to Ntasks as them;
 * everything else, and every decision while tasks live elsewhere, stays on the
 * Tower's own routes. */
export function useDecisionApi(): TowerApi {
  const api = useTowerApi();
  const signIn = useNtasksSignIn();
  const status = useTaskService().data;
  const projects = status?.projects;
  const workspaceId = status?.app?.workspaceId ?? null;
  const session = signIn.kind === "signed-in" ? signIn.session : null;
  return useMemo(() => {
    if (session === null) return api;
    const readsFrom = (taskId: string) => {
      const prefix = taskId.slice(0, Math.max(0, taskId.indexOf("-"))).toLowerCase();
      const projectId = projects?.find((entry) => entry.prefix.toLowerCase() === prefix)?.project?.projectId;
      return projectId === undefined || workspaceId === null ? null : { projectId, workspaceId };
    };
    return { ...api, ...personDecisions(session, readsFrom) };
  }, [api, session, projects, workspaceId]);
}

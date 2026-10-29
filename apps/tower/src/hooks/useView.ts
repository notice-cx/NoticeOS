import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  DEFAULT_VIEW,
  DEFAULT_VIEW_CHOICE,
  homeModulesFor,
  normalizeViewId,
  parseViewChoice,
  serializeViewChoice,
  viewSpec,
  type HomeModuleId,
  type ViewChoice,
  type ViewId,
  type ViewSpec,
} from "@shared/views";
import { browserOwnerKey } from "@/lib/browser-owner";
import { useWall } from "@/hooks/useWall";
import { useBrowserRuntime, useOwnerPreferences, useOwnerToast, useTowerApi } from "@/lib/browser-context";

/** Where the person's own choice is kept, under the owner's preference key. */
export const VIEW_PREFERENCE_NAME = "view";

/** The hosted person's choice as their workspace keeps it (GET /api/me/preferences/view). */
export const VIEW_PREFERENCE_QUERY_KEY = ["view-preference"] as const;

/** Who decided the view the screens are drawn in. */
export type ViewSource = "person" | "workspace" | "default";

/**
 * One in-memory notice board so every surface drawing from the view (the
 * sidebar, Home, a site's tabs, Settings) re-renders on a write: the
 * preference store itself tells nobody. The value lives in the preference
 * store, never here, so a new browser context reads it afresh.
 */
const listeners = new Set<() => void>();
const purposeNotices = new WeakSet<object>();
let generation = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return generation;
}

function announce(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

function readChoice(read: (name: string) => string | null): ViewChoice | null {
  const raw = read(VIEW_PREFERENCE_NAME);
  if (raw === null) return null;
  try {
    return parseViewChoice(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface ViewState {
  /** The choice the screens are drawn in. */
  choice: ViewChoice;
  view: ViewSpec;
  /** Home's modules, in order, after the person's picks. */
  modules: HomeModuleId[];
  source: ViewSource;
  /** The view the workspace starts new people from, when saved. */
  workspaceDefault: ViewId | null;
  /** Save the person's own choice; the screens change at once. */
  setChoice: (next: ViewChoice) => void;
  /** Forget the person's own choice, back to the workspace default. */
  clearChoice: () => void;
}

/** The person's choice as the server keeps it, and how to send one there. */
interface ServerView {
  /** The server's answer once it arrives: a choice, or null when none is saved. */
  choice: ViewChoice | null | undefined;
  /** Send `choice`; draw `shown` meanwhile (null: the browser's copy decides). */
  save: (choice: ViewChoice, shown: ViewChoice | null) => void;
}

type Preferences = ReturnType<typeof useOwnerPreferences>;

const BROWSER_ONLY: ServerView = { choice: undefined, save: () => {} };

/** Standalone and the demo: no person on the server, the browser keeps the choice. */
function useBrowserOnlyView(_preferences: Preferences): ServerView {
  return BROWSER_ONLY;
}

/** Hosted: the server's copy, read once per page load and written on each
 * save. A refused or failed save keeps the browser's copy and the screens as
 * they are, and says so. */
interface SaveState { revision: number; pending: Promise<void> }
const saves = new WeakMap<QueryClient, SaveState>();

function useHostedView(preferences: Preferences): ServerView {
  const api = useTowerApi();
  const runtime = useBrowserRuntime();
  const queryClient = useQueryClient();
  const toast = useOwnerToast();
  const queryKey = useMemo(() => [...VIEW_PREFERENCE_QUERY_KEY, browserOwnerKey(runtime.owner)], [runtime]);
  let state = saves.get(queryClient);
  if (!state) {
    state = { revision: 0, pending: Promise.resolve() };
    saves.set(queryClient, state);
  }
  const saveState = state;
  const { data } = useQuery<ViewChoice | null>({
    queryKey,
    queryFn: async ({ signal }) => {
      const revision = saveState.revision;
      const stored = await api.fetchViewPreference(signal);
      if (!signal.aborted && revision === saveState.revision && stored) {
        runtime.guard(() => preferences.write(VIEW_PREFERENCE_NAME, serializeViewChoice(stored)))();
      }
      return stored;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const save = useCallback(
    (choice: ViewChoice, shown: ViewChoice | null) => {
      const revision = ++saveState.revision;
      void queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, shown);
      // Serialize writes so the server also ends with the newest choice.
      saveState.pending = saveState.pending.then(async () => {
        if (runtime.guard(() => true)() !== true) return;
        try {
          const stored = await api.saveViewPreference(choice);
          runtime.guard(() => {
            if (revision === saveState.revision && shown !== null) queryClient.setQueryData(queryKey, stored);
          })();
        } catch {
          if (revision === saveState.revision) toast.error("View kept in this browser only — not saved to your workspace");
        }
      });
    },
    [api, queryClient, queryKey, runtime, saveState, toast],
  );
  return useMemo(() => ({ choice: data, save }), [data, save]);
}

/**
 * The view the person sees: their own stored choice first, else the
 * workspace's saved default, else Overview. Overview is also what a
 * fresh install draws before anyone answers, so every existing screen and
 * test keeps its meaning until a choice is made.
 *
 * A standalone installation and the demo keep the choice in this browser. A
 * hosted workspace keeps it per person on the server, so it follows them to
 * every sign-in and device; the browser's copy is a cache, drawn until the
 * server's answer arrives and whenever the server holds none.
 */
export function useView(): ViewState {
  const preferences = useOwnerPreferences();
  const runtime = useBrowserRuntime();
  // An owner's mode is fixed for the runtime's whole life (lib/browser-owner.ts),
  // so a mounted tree calls the same hook on every render.
  const server = (runtime.owner.mode === "hosted" ? useHostedView : useBrowserOnlyView)(preferences);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const { data } = useWall();
  const storedDefault = data?.dashboard?.view?.default;
  const workspaceDefault = storedDefault == null ? null : normalizeViewId(storedDefault);
  const own = server.choice ?? readChoice(preferences.read);

  const choice: ViewChoice = own ?? (workspaceDefault ? { view: workspaceDefault, focus: [] } : DEFAULT_VIEW_CHOICE);
  const source: ViewSource = own ? "person" : workspaceDefault ? "workspace" : "default";

  const toast = useOwnerToast();
  useEffect(() => {
    const needsChoice = own?.needsPurposeChoice || (!own && (storedDefault === "business" || storedDefault === "product"));
    const noticeKey = "view-purpose-notice";
    if (!needsChoice || purposeNotices.has(runtime) || preferences.read(noticeKey)) return;
    purposeNotices.add(runtime);
    preferences.write(noticeKey, "shown");
    toast.warning("Your view is now Overview. Choose a purpose from the view bar.");
  }, [own?.needsPurposeChoice, storedDefault, preferences, runtime, toast]);

  const { save } = server;
  const setChoice = useCallback(
    (next: ViewChoice) => {
      preferences.write(VIEW_PREFERENCE_NAME, serializeViewChoice(next));
      save(next, next);
      announce();
    },
    [preferences, save],
  );
  // The server keeps every save and the newest wins, so a hosted clear saves
  // the workspace's default as the person's choice; this page then draws it
  // as the workspace's own.
  const clearChoice = useCallback(() => {
    preferences.forget(VIEW_PREFERENCE_NAME);
    save({ view: workspaceDefault ?? DEFAULT_VIEW, focus: [] }, null);
    announce();
  }, [preferences, save, workspaceDefault]);

  return useMemo(
    () => ({
      choice,
      view: viewSpec(choice.view),
      modules: homeModulesFor(choice),
      source,
      workspaceDefault,
      setChoice,
      clearChoice,
    }),
    [choice.view, choice.focus.join(","), source, workspaceDefault, setChoice, clearChoice],
  );
}

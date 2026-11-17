import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { API_VERSION } from "@notice-cx/ntasks-ui";
import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { createOwnerStorage } from "@/lib/browser-storage";
import { keepApp } from "@/lib/ntasks-sign-in";
import { useNtasksSignIn } from "@/hooks/useNtasksSignIn";
import { SignInToNtasks } from "@/routes/tasks/ntasks-sign-in";

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("uses the verified hosted client and reloads it when registration changes the id", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const origin = "https://ntasks.example.com";
  const owner = { mode: "hosted", workspaceId: id, principalId: id, sessionId: id, clientGeneration: 1 };
  const storage = createOwnerStorage({ ...owner, clientGeneration: 0 }, localStorage);
  keepApp(storage, origin, { clientId: "stale-browser-client", held: true });
  storage.write("ntasks-person:" + origin + ":stale-browser-client",
    JSON.stringify({ access: "old-person-token", expiresAt: Number.MAX_SAFE_INTEGER, refresh: null, name: "Old client" }));
  let current = "saved-workspace-client";
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push((init?.method ?? "GET") + " " + url.pathname);
    if (url.pathname === "/api/tasks/service") {
      return Response.json({ connected: true, origin, projects: [], app: { clientId: current, workspaceId: id } });
    }
    if (url.pathname === "/api/tasks/service/app") {
      current = "replacement-workspace-client";
      return Response.json({ clientId: current, held: false });
    }
    throw new Error("Unexpected Tower request");
  });
  const runtime = createBrowserRuntime(owner, { origin: window.location.origin, fetch, sendAnswer: async () => {} });
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, origin: window.location.origin });
  vi.stubGlobal("fetch", vi.fn(async input => {
    expect(String(input)).toBe(origin + "/api/version");
    return Response.json({ version: API_VERSION });
  }));
  function App() {
    const state = useNtasksSignIn();
    return <>
      <output>{state.kind === "signed-out" || state.kind === "signed-in" ? state.kind + " " + state.app.clientId : state.kind}</output>
      <SignInToNtasks />
    </>;
  }
  const view = render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: "Fixture" }}>
    <QueryClientProvider client={runtime.queries}><MemoryRouter><App /></MemoryRouter></QueryClientProvider>
  </BrowserRuntimeProvider>);
  try {
    expect(await screen.findByText("signed-out saved-workspace-client")).toBeVisible();
    expect(view.container.querySelector("[data-ntasks-address-held]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Ntasks" }));
    await waitFor(() => expect(assign).toHaveBeenCalledOnce());
    expect(new URL(String(assign.mock.calls[0]![0])).searchParams.get("client_id")).toBe(current);
    expect(await screen.findByText("signed-out replacement-workspace-client")).toBeVisible();
    expect(calls).toEqual(["GET /api/tasks/service", "POST /api/tasks/service/app", "GET /api/tasks/service"]);
  } finally { view.unmount(); runtime.retire(); }
});

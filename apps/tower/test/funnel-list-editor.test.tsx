import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PosthogFunnel } from "@noticeos/contract";
import type { JsonValue, SettingOp } from "@shared/changeset";
import { configRegister, fieldOf, fieldRefusal } from "@shared/config-registers";
import { FunnelListEditor } from "@/components/FunnelListEditor";

// An asset's PostHog funnels (bead ro-ghis.1): the whole list is one value,
// judged by the `asset-lane` register's own `funnels` rule — the function the
// store save runs — and written as ONE file-json-set.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const FIELD = fieldOf(configRegister("asset-lane"), "funnels")!;
const refusal = (value: unknown) => fieldRefusal(FIELD, value);

const CALCULATOR: PosthogFunnel = {
  id: "calculator",
  name: "Calculator",
  steps: [{ event: "$pageview", path: "/calculator" }, { event: "form_start" }, { event: "calculation_complete" }],
};

function withClient(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>
  );
}

function writable(ok: boolean, reason: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ writable: ok, reason }), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

function makeOp(held: PosthogFunnel[] | null) {
  return (value: PosthogFunnel[]): SettingOp =>
    held === null
      ? { kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/meals.example/posthog/funnels", expectAbsent: true, value: value as unknown as JsonValue }
      : { kind: "file-json-set", file: "config/integrations.json", pointer: "/assets/meals.example/posthog/funnels", expect: held as unknown as JsonValue, value: value as unknown as JsonValue };
}

afterEach(() => vi.unstubAllGlobals());

describe("FunnelListEditor", () => {
  it("renders the saved funnels with their ordered steps, and Save waits for a change", () => {
    writable(true);
    render(withClient(<FunnelListEditor current={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={vi.fn()} />));
    expect((screen.getByDisplayValue("Calculator") as HTMLInputElement).value).toBe("Calculator");
    const events = [...document.querySelectorAll<HTMLInputElement>("[data-funnel-step-event]")].map((input) => input.value);
    expect(events).toEqual(["$pageview", "form_start", "calculation_complete"]);
    expect((document.querySelector("[data-funnel-step-path]") as HTMLInputElement).value).toBe("/calculator");
    expect((document.querySelector("[data-funnel-save]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds, reorders and removes steps, and writes the whole list as one op", async () => {
    writable(true);
    const onSave = vi.fn(async (_op: SettingOp) => {});
    render(withClient(<FunnelListEditor current={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={onSave} />));

    fireEvent.click(document.querySelector("[data-funnel-add-step]")!);
    const added = [...document.querySelectorAll<HTMLInputElement>("[data-funnel-step-event]")].at(-1)!;
    fireEvent.change(added, { target: { value: "plan_save" } });
    // Move the new last step up one place, then remove the first step.
    const ups = document.querySelectorAll<HTMLButtonElement>("[data-funnel-step-up]");
    fireEvent.click(ups[ups.length - 1]!);
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>("[data-funnel-step-remove]")[0]!);

    const save = document.querySelector("[data-funnel-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({
      kind: "file-json-set",
      file: "config/integrations.json",
      pointer: "/assets/meals.example/posthog/funnels",
      expect: [CALCULATOR],
      value: [{ id: "calculator", name: "Calculator", steps: [{ event: "form_start" }, { event: "plan_save" }, { event: "calculation_complete" }] }],
    });
  });

  it("shows the store's own refusal and will not save a funnel the store would refuse", () => {
    writable(true);
    const onSave = vi.fn();
    render(withClient(<FunnelListEditor current={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={onSave} />));
    // Down to one step: a funnel needs at least two.
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>("[data-funnel-step-remove]")[0]!);
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>("[data-funnel-step-remove]")[0]!);
    expect(screen.getByRole("alert").textContent).toBe(refusal([{ ...CALCULATOR, steps: [{ event: "calculation_complete" }] }]));
    expect(screen.getByRole("alert").textContent).toMatch(/needs 2 to 10 steps/);
    expect((document.querySelector("[data-funnel-save]") as HTMLButtonElement).disabled).toBe(true);

    // A path that is not a path is named too.
    fireEvent.click(document.querySelector("[data-funnel-discard]")!);
    fireEvent.change(document.querySelector("[data-funnel-step-path]")!, { target: { value: "calculator?x=1" } });
    expect(screen.getByRole("alert").textContent).toMatch(/path must start with \//);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("adds a funnel whose id follows its name, as a first write when none was saved", async () => {
    writable(true);
    const onSave = vi.fn(async (_op: SettingOp) => {});
    render(withClient(<FunnelListEditor current={null} refusal={refusal} makeOp={makeOp(null)} onSave={onSave} />));
    expect(document.querySelector("[data-funnel-empty]")).not.toBeNull();
    fireEvent.click(document.querySelector("[data-funnel-add]")!);
    fireEvent.change(document.querySelector("[data-funnel-name]")!, { target: { value: "Save a plan" } });
    expect((document.querySelector("[data-funnel-id]") as HTMLInputElement).value).toBe("save-a-plan");
    const [first, second] = document.querySelectorAll<HTMLInputElement>("[data-funnel-step-event]");
    fireEvent.change(first!, { target: { value: "calculation_complete" } });
    fireEvent.change(second!, { target: { value: "plan_save" } });
    fireEvent.click(document.querySelector("[data-funnel-save]")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      expectAbsent: true,
      value: [{ id: "save-a-plan", name: "Save a plan", steps: [{ event: "calculation_complete" }, { event: "plan_save" }] }],
    });
  });

  it("removes a funnel, and an empty list is a valid save", async () => {
    writable(true);
    const onSave = vi.fn(async (_op: SettingOp) => {});
    render(withClient(<FunnelListEditor current={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={onSave} />));
    fireEvent.click(document.querySelector("[data-funnel-remove]")!);
    fireEvent.click(document.querySelector("[data-funnel-save]")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ value: [] });
  });

  it("renders the list as text with the deployment's reason when nothing can be saved", async () => {
    writable(false, "This deployment reads settings but cannot save them.");
    render(withClient(<FunnelListEditor current={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} />));
    await waitFor(() => expect(document.querySelector("[data-funnel-editor-read-only]")).not.toBeNull());
    expect(document.querySelector("[data-funnel-editor-read-only]")!.textContent).toContain("cannot save");
    expect(screen.getByText("$pageview /calculator → form_start → calculation_complete")).toBeTruthy();
    expect(document.querySelector("[data-funnel-save]")).toBeNull();
  });

  // Bead ro-ujb9.96.7.24: with the project's saved funnels in hand the list is
  // picked, never typed, and each change is saved at once.
  describe("picked from the project's saved funnels", () => {
    const SIGNUP: PosthogFunnel = { id: "signup", name: "Signup", steps: [{ event: "$pageview" }, { event: "signed_up" }] };

    it("offers only the saved funnels not on the list, and a pick writes the whole list at once", async () => {
      writable(true);
      const onSave = vi.fn(async (_op: SettingOp) => {});
      render(withClient(<FunnelListEditor current={[CALCULATOR]} saved={[CALCULATOR, SIGNUP]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={onSave} />));
      // Nothing to type: no event, path, name or id field, and no Save.
      expect(document.querySelectorAll("input")).toHaveLength(0);
      expect(document.querySelector("[data-funnel-save]")).toBeNull();
      expect(screen.getByText("$pageview /calculator → form_start → calculation_complete")).toBeTruthy();
      const pick = screen.getByLabelText("Add funnel") as HTMLSelectElement;
      expect([...pick.options].map((option) => option.textContent)).toEqual(["Add funnel", "Signup"]);
      fireEvent.change(pick, { target: { value: "signup" } });
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0]![0]).toMatchObject({ expect: [CALCULATOR], value: [CALCULATOR, SIGNUP] });
      expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
    });

    it("removes a funnel with its own press, and hides Add funnel once every saved one is listed", async () => {
      writable(true);
      const onSave = vi.fn(async (_op: SettingOp) => {});
      render(withClient(<FunnelListEditor current={[CALCULATOR]} saved={[CALCULATOR]} refusal={refusal} makeOp={makeOp([CALCULATOR])} onSave={onSave} />));
      expect(screen.queryByLabelText("Add funnel")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Remove funnel Calculator" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0]![0]).toMatchObject({ value: [] });
    });
  });
});

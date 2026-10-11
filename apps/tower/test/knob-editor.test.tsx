import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, SettingOp } from "@shared/changeset";
import { fieldFromDraft, type RegisterField } from "@shared/config-registers";
import { KnobEditor } from "@/components/KnobEditor";
import { configSaveReply } from "./config-save-reply";
import {
  validateProbability,
  validateRegisterField,
  validateUrl,
} from "@/lib/knob-validators";

// The Tower's one editable-setting affordance. Sonner is mocked so the suite can
// prove no toast is raised: every outcome is said beside the field
// (`InlineSaveState`).
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

function withClient(node: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>
  );
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The Tower's API, as far as one field can tell. `reply` decides what the write
 * answers; the writability read always says this is a local deployment unless a
 * case overrides it. */
function stubFetch(
  reply?: { status: number; body: unknown },
  writable: { writable: boolean; reason: string | null } = { writable: true, reason: null },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify(writable), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push({
        url,
        method,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(reply ? reply.body : configSaveReply(init)), {
        status: reply?.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const alphaOp = (value: JsonValue): SettingOp => ({
  kind: "file-json-set",
  file: "config/constants.json",
  pointer: "/flag_defaults/alpha",
  expect: 0.01,
  value,
});

const senseOp = (value: JsonValue): SettingOp => ({
  kind: "store-asset-set",
  asset: "northwind.example",
  column: "sense_only",
  expect: 1,
  value,
});

function renderAlpha() {
  return render(
    withClient(
      <KnobEditor
        label="Anomaly sensitivity"
        current={0.01}
        format={(v) => String(v)}
        makeOp={alphaOp}
        control={{ type: "number", validate: validateProbability }}
        slug="anomaly-sensitivity"
      />,
    ),
  );
}

function renderSenseToggle() {
  return render(
    withClient(
      <KnobEditor
        label="Automation"
        assetId="northwind.example"
        current={1}
        format={(v) => (v === 1 ? "Monitor only" : "Automation enabled")}
        makeOp={senseOp}
        control={{
          type: "toggle",
          onValue: 1,
          offValue: 0,
          onLabel: "Monitor only",
          offLabel: "Automation enabled",
        }}
      />,
    ),
  );
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KnobEditor — a setting saves where it stands", () => {
  it("refuses an invalid value locally, before anything is written", () => {
    const calls = stubFetch();
    const { container } = renderAlpha();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(container.textContent).toContain("between 0 and 1");
    expect(calls).toEqual([]);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("has nothing to press until the value actually changes", () => {
    stubFetch();
    renderAlpha();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.05" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  // The `expect` is the value the field was rendered from, not the one being
  // typed, so a save from a page left open while the file moved is refused.
  it("saves a file-owned knob through the config lane, carrying the rendered value as expect", async () => {
    const calls = stubFetch({ status: 200, body: { applied: 1, archive: "config/changesets/0009_x.json", commit: "abc1234" } });
    renderAlpha();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: "/api/config",
      method: "PUT",
      body: {
        slug: "anomaly-sensitivity",
        ops: [
          {
            kind: "file-json-set",
            file: "config/constants.json",
            pointer: "/flag_defaults/alpha",
            expect: 0.01,
            value: 0.05,
          },
        ],
      },
    });
  });

  it("saves on Enter, so a typed value does not need the mouse", async () => {
    const calls = stubFetch();
    renderAlpha();

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0.02" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls).toHaveLength(1));
  });

  // Undo over confirm, and the way back is not privileged: it is the same
  // write with the values swapped and `expect` set to what was just saved.
  it("offers an Undo that writes the previous value back, guarded by the one just saved", async () => {
    const calls = stubFetch();
    renderAlpha();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(toasts.success).not.toHaveBeenCalled();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({
      ops: [{ pointer: "/flag_defaults/alpha", expect: 0.05, value: 0.01 }],
    });
  });

  it("names a stale value instead of overwriting it", async () => {
    stubFetch({
      status: 409,
      body: {
        error: "expect_mismatch",
        mismatches: [{ file: "config/constants.json", pointer: "/flag_defaults/alpha", current: 0.02 }],
      },
    });
    renderAlpha();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Changed elsewhere — reload to see the current value",
    );
    expect(toasts.error).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  // A store column is not a file, so it saves in a deployed build too.
  it("saves a store-owned column through the Worker, one PATCH per asset", async () => {
    const calls = stubFetch({ status: 200, body: { ok: true } });
    renderSenseToggle();

    fireEvent.click(screen.getByRole("button", { name: "Automation enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: "/api/assets/northwind.example",
      method: "PATCH",
      body: { column: "sense_only", value: 0, expect: 1 },
    });
  });

  it("disables a file-owned field on a deployment that has no filesystem, and says why", async () => {
    const reason =
      "This deployment has no filesystem: file-owned settings are read-only here. " +
      "Start NoticeOS (pnpm os:start) to edit them, or edit the file and redeploy.";
    stubFetch({ status: 501, body: { error: "read_only_deployment" } }, { writable: false, reason });
    renderAlpha();

    await waitFor(() => expect(screen.getByRole("spinbutton")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("keeps a store-owned column editable on that same deployment", async () => {
    stubFetch(
      { status: 200, body: { ok: true } },
      { writable: false, reason: "no filesystem here" },
    );
    renderSenseToggle();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Automation enabled" })).toBeEnabled(),
    );
    expect(screen.queryByText("no filesystem here")).not.toBeInTheDocument();
  });

  it("lets the gallery exercise the control without writing anything", async () => {
    const calls = stubFetch();
    const saved: SettingOp[] = [];
    render(
      withClient(
        <KnobEditor
          label="Metrics endpoint"
          current="https://a.test/metrics"
          format={(v) => String(v)}
          makeOp={(value) => ({
            kind: "file-json-set",
            file: "config/pull.json",
            pointer: "/0/url",
            expect: "https://a.test/metrics",
            value,
          })}
          control={{ type: "text", validate: validateUrl }}
          onSave={async (op) => {
            saved.push(op);
          }}
        />,
      ),
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://b.test/metrics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ value: "https://b.test/metrics" });
    expect(calls).toEqual([]);
  });

  /** A select is as wide as its longest option, so a long option could widen
   * the page; it is capped the way the text box already is. */
  it("caps a select at its container so a long option cannot widen the page", () => {
    stubFetch();
    render(
      withClient(
        <KnobEditor
          label="GA4 property id"
          current=""
          format={(v) => String(v)}
          makeOp={alphaOp}
          control={{
            type: "select",
            options: [
              { value: "", label: "Pick one…" },
              { value: "123456789", label: "Journey Example — production web stream (all traffic) — Journey Example Holdings International (123456789)" },
            ],
          }}
        />,
      ),
    );
    const select = screen.getByRole("combobox");
    expect(select.className).toContain("max-w-full");
    expect(select.className).toContain("min-w-0");
  });
  /** A knob's input seeds with the parse's inverse, not `String()`: `String()`
   * agrees with `fieldFromDraft` for string, enum, date and integer knobs and
   * disagrees for every other declared field type. Both directions come from
   * `@shared/config-registers`, so the pair cannot drift. */
  for (const [type, current, seeded] of [
    ['boolean', true, 'true'],
    ['boolean', false, 'false'],
    ['string-list', ['gsc', 'ga4'], 'gsc, ga4'],
    ['integer', 15, '15'],
    ['string', 'nightly', 'nightly'],
  ] as [RegisterField['type'], JsonValue, string][]) {
    it(`seeds a ${type} knob with what fieldFromDraft would read back`, () => {
      const field = { name: 'knob', label: 'Knob', type, required: true } as RegisterField;
      stubFetch();
      render(
        withClient(
          <KnobEditor
            label="Knob"
            current={current}
            format={(v) => String(v)}
            makeOp={(value) => ({
              kind: 'file-json-set',
              file: 'config/constants.json',
              pointer: '/knob',
              expect: current,
              value,
            })}
            control={{ type: 'text', validate: validateRegisterField(field) }}
          />,
        ),
      );

      const box = screen.getByRole('textbox') as HTMLInputElement;
      expect(box.value).toBe(seeded);
      expect(fieldFromDraft(field, box.value)).toEqual(current);
      // The seed matching the stored value is what makes Save dead until
      // something is actually typed.
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  }
});

/** A save is confirmed where it was made, and a refusal is said there too. */
describe("KnobEditor — inline save says its outcome beside the field", () => {
  const zoneOp = (value: JsonValue): SettingOp => ({
    kind: "file-json-set",
    file: "config/constants.json",
    pointer: "/os_time_zone",
    expect: "UTC",
    value,
  });

  function renderZone() {
    return render(
      withClient(
        <KnobEditor
          label="Operator timezone"
          current="UTC"
          format={(v) => String(v)}
          makeOp={zoneOp}
          slug="os-time-zone"
          autosave
          control={{
            type: "select",
            options: [
              { value: "UTC", label: "UTC" },
              { value: "America/Los_Angeles", label: "America / Los Angeles" },
            ],
          }}
        />,
      ),
    );
  }

  it("saves a pick through the config door and puts Saved · Undo beside it, never a toast", async () => {
    const calls = stubFetch();
    renderZone();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "America/Los_Angeles" } });

    await waitFor(() =>
      expect(document.querySelector('[data-save-state="saved"]')).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/config",
      method: "PUT",
      body: {
        slug: "os-time-zone",
        ops: [{ kind: "file-json-set", pointer: "/os_time_zone", expect: "UTC", value: "America/Los_Angeles" }],
      },
    });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("undoes through the same write, guarded by the value just saved, and puts the field back", async () => {
    const calls = stubFetch();
    renderZone();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "America/Los_Angeles" } });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      url: "/api/config",
      method: "PUT",
      body: { ops: [{ pointer: "/os_time_zone", expect: "America/Los_Angeles", value: "UTC" }] },
    });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("UTC"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("says a refused save beside the field as a short state, and the pick goes back to what is stored", async () => {
    stubFetch({ status: 409, body: { error: "expect_mismatch", mismatches: [] } });
    renderZone();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "America/Los_Angeles" } });

    const refused = await screen.findByRole("alert");
    expect(refused).toHaveAttribute("data-save-state", "refused");
    expect(refused).toHaveTextContent("Not saved");
    expect(refused).toHaveTextContent("Changed elsewhere — reload to see the current value");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("UTC"));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("says a refused Undo beside the field too", async () => {
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ writable: true, reason: null }), { status: 200 });
        }
        puts += 1;
        return puts === 1
          ? new Response(JSON.stringify(configSaveReply(init)), { status: 200 })
          : new Response(JSON.stringify({ error: "expect_mismatch" }), { status: 409 });
      }),
    );
    renderZone();

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "America/Los_Angeles" } });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    const refused = await screen.findByRole("alert");
    expect(refused).toHaveTextContent("Not saved");
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps a typed value that was refused, so it can be corrected rather than retyped", async () => {
    stubFetch({ status: 422, body: { error: "invalid", detail: "Choose a probability the detector accepts." } });
    render(
      withClient(
        <KnobEditor
          label="Anomaly sensitivity"
          current={0.01}
          format={(v) => String(v)}
          makeOp={alphaOp}
          control={{ type: "number", validate: validateProbability }}
        />,
      ),
    );

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a probability the detector accepts.");
    expect(screen.getByRole("spinbutton")).toHaveValue(0.05);
  });
});

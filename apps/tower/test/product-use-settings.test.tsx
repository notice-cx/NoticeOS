import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { CollectionEditor } from "@/components/CollectionEditor";
import { GrowthTab } from "@/routes/asset-detail/GrowthTab";
import { everyTabPayload } from "./asset-detail-fixture";
import type { ProductUseSnapshot } from "@shared/asset-detail";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}
afterEach(() => { vi.unstubAllGlobals(); toasts.success.mockReset(); toasts.error.mockReset(); });
const stage = { eventName: "document_open", label: "Opened a document", group: "primary" };
describe("stored Product use declarations", () => {
  it.each([false, true])("adds beside protected measurement settings when holder exists=%s", async (holderExists) => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") calls.push(JSON.parse(String(init.body)));
      const body = init?.method === "PUT"
        ? { applied: 1, archive: null, commit: null }
        : { writable: true, reason: null, sources: {} };
      return new Response(JSON.stringify(body), {headers:{"content-type":"application/json"}});
    }));
    wrap(<CollectionEditor register="product-use-stages" params={{asset:"example.com"}} rows={null} holderExists={holderExists}/>);
    fireEvent.click(await screen.findByRole("button", {name:"Add"}));
    const form = within(document.querySelector("[data-collection-add]") as HTMLElement);
    fireEvent.change(form.getByLabelText("GA4 event"), {target:{value:stage.eventName}});
    fireEvent.change(form.getByLabelText("Label"), {target:{value:stage.label}});
    fireEvent.change(form.getByLabelText("Group"), {target:{value:stage.group}});
    fireEvent.click(form.getByRole("button", {name:"Add"}));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.ops).toEqual([{kind:"file-json-insert",file:"config/value-events.json",pointer:holderExists?"/assets/example.com/productUseStages":"/assets/example.com",value:holderExists?[stage]:{productUseStages:[stage]}}]);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo=toasts.success.mock.calls[0]?.[1] as {action:{onClick:()=>void}}; undo.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.ops).toEqual([{kind:"file-json-delete",file:"config/value-events.json",pointer:"/assets/example.com/productUseStages",expect:[stage]}]);
  });
  it("renders declared generic stage volumes and only a supported independent comparison", () => {
    const body=everyTabPayload();
    const snapshot:ProductUseSnapshot={windowStart:"2026-07-02",windowEnd:"2026-07-29",days:28,
      build:[{key:"document_open",eventName:"document_open",label:"Opened a document",users:30,events:40}],
      sharing:[{key:"document_share",eventName:"document_share",label:"Shared a document",users:0,events:0,compareTo:"document_open",comparisonLabel:"Shared of opened"}],
      supporting:[{key:"document_search",eventName:"document_search",label:"Searched documents",users:null,events:null}],source:"ga4/events-28d",caveat:"Independent event totals"};
    body.executive={...body.executive!,productUse:snapshot};
    const {container}=wrap(<GrowthTab data={body} nowMs={Date.parse("2026-07-30T12:00:00Z")} onWatch={()=>undefined}/>);
    const strip=container.querySelector("#product-use")!;
    expect(strip.textContent).toContain("Opened a document");
    expect(strip.textContent).toContain("Shared of opened");
    expect(strip.textContent).toContain("0%"); expect(strip.textContent).toContain("0 of 30");
    expect(strip.querySelector('[data-small-multiple="Shared of opened"]')).toHaveAttribute("title","Independent event-user volumes, not a same-person conversion");
    expect(strip.querySelector('[data-small-multiple="Searched documents"]')).toHaveTextContent("—");
    expect(strip.textContent).not.toContain("Added of opened");
  });
});

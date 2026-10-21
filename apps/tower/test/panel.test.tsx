import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "@/components/surface/Panel";
import { Panel as AssetPanel } from "@/routes/asset-detail/shared";
import { PanelLock, SettingsPanel } from "@/routes/settings/SettingsPanel";

describe("shared panel shell", () => {
  it("keeps the site-detail import on the shared implementation", () => {
    expect(AssetPanel).toBe(Panel);
  });

  it("labels each region with its own heading, excluding its caption and action", () => {
    render(<>
      <Panel id="site-collection" title="Collection" count="last 7 days" action={<button>Collect now</button>} data-collection="site">
        <p>Site settings</p>
      </Panel>
      <SettingsPanel id="portfolio-collection" title="Collection" caption="last 28 days" aside={<button>Schedule</button>} data-collection="portfolio">
        <p>Portfolio settings</p>
      </SettingsPanel>
    </>);
    const regions = screen.getAllByRole("region", { name: "Collection" });
    expect(regions).toHaveLength(2);
    const headingIds = regions.map((region) => {
      const heading = within(region).getByRole("heading", { name: "Collection", level: 2 });
      expect(region).toHaveAttribute("aria-labelledby", heading.id);
      return heading.id;
    });
    expect(new Set(headingIds).size).toBe(2);
    expect(regions[0]).toHaveAttribute("id", "site-collection");
    expect(regions[0]).toHaveAttribute("data-collection", "site");
    expect(within(regions[0]!).getByText("last 7 days")).toBeVisible();
    expect(within(regions[0]!).getByRole("button", { name: "Collect now" })).toBeVisible();
    expect(regions[1]).toHaveAttribute("id", "portfolio-collection");
    expect(regions[1]).toHaveAttribute("data-collection", "portfolio");
    expect(within(regions[1]!).getByText("last 28 days")).toBeVisible();
    expect(within(regions[1]!).getByRole("button", { name: "Schedule" })).toBeVisible();
  });

  it("omits an empty body and preserves the header-only action", () => {
    render(<SettingsPanel title="Layout" aside={<button>Edit layout</button>} data-header-only />);
    const region = screen.getByRole("region", { name: "Layout" });
    expect(region).toHaveAttribute("data-header-only", "true");
    expect(region.children).toHaveLength(1);
    expect(within(region).getByRole("button", { name: "Edit layout" })).toBeVisible();
  });

  it("keeps the paused-save lock accessible and forwards its caller's marks", () => {
    render(<SettingsPanel title="Sites" aside={<PanelLock data-sites-locked />}><button disabled>Save</button></SettingsPanel>);
    const region = screen.getByRole("region", { name: "Sites" });
    expect(within(region).getByText("Saves paused")).toHaveClass("sr-only");
    expect(within(region).getByText("Saves paused").parentElement).toHaveAttribute("data-sites-locked", "true");
    expect(within(region).getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

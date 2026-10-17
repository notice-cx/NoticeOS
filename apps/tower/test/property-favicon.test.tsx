import { act, fireEvent, render, waitFor } from "./render";
import { afterEach, describe, expect, it } from "vitest";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import { PropertyFavicon, propertyIconSources } from "@/components/PropertyFavicon";

const LIGHT = "https://www.example.com/brand/icon-32.png";
const DARK = "https://www.example.com/brand/icon-32-dark.png";
const FAVICON = "https://example.com/favicon.ico";

function icons(light: string | null, dark: string | null): SiteIcons {
  return { light, dark, readAt: "2026-10-17T04:00:00.000Z", outcome: light || dark ? "read" : "no-icon" };
}

function drawn(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector<HTMLImageElement>("[data-property-favicon] img");
}

function initial(container: HTMLElement): string | null {
  return container.querySelector("[data-property-favicon] [data-initial]")?.getAttribute("data-initial") ?? null;
}

afterEach(() => document.documentElement.classList.remove("light"));

describe("PropertyFavicon draws the icon a site declares for the surface", () => {
  it("draws the dark icon on a dark surface when the site declares both", () => {
    const { container } = render(
      <PropertyFavicon domain="example.com" displayName="Example" icons={icons(LIGHT, DARK)} scheme="dark" />,
    );
    expect(drawn(container)).toHaveAttribute("src", DARK);
  });

  it("draws the light icon on a dark surface when the site declares no dark one", () => {
    const { container } = render(
      <PropertyFavicon domain="example.com" displayName="Example" icons={icons(LIGHT, null)} scheme="dark" />,
    );
    expect(drawn(container)).toHaveAttribute("src", LIGHT);
  });

  it("draws the light icon on the light desk", () => {
    document.documentElement.classList.add("light");
    const { container } = render(
      <PropertyFavicon domain="example.com" displayName="Example" icons={icons(LIGHT, DARK)} />,
    );
    expect(drawn(container)).toHaveAttribute("src", LIGHT);
  });

  it("draws /favicon.ico when the card carries no icons", () => {
    for (const none of [undefined, null, icons(null, null)]) {
      const { container, unmount } = render(
        <PropertyFavicon domain="example.com" displayName="Example" icons={none} scheme="dark" />,
      );
      expect(drawn(container)).toHaveAttribute("src", FAVICON);
      unmount();
    }
    // A dark-only mark is drawn for a dark background, never on a light one.
    expect(propertyIconSources("example.com", icons(null, DARK), "light")).toEqual([FAVICON]);
  });

  it("falls back from a declared icon that fails to /favicon.ico, and then to the initial", () => {
    const { container } = render(
      <PropertyFavicon domain="example.com" displayName="Example" icons={icons(LIGHT, DARK)} scheme="dark" />,
    );
    expect(initial(container)).toBe("E");
    fireEvent.error(drawn(container)!);
    expect(drawn(container)).toHaveAttribute("src", FAVICON);
    expect(initial(container)).toBe("E");
    fireEvent.error(drawn(container)!);
    expect(drawn(container)).toBeNull();
    expect(initial(container)).toBe("E");
  });

  it("switches to the other scheme's icon when the desk's theme is toggled, without a reload", async () => {
    const { container } = render(
      <PropertyFavicon domain="example.com" displayName="Example" icons={icons(LIGHT, DARK)} />,
    );
    expect(drawn(container)).toHaveAttribute("src", DARK);
    fireEvent.load(drawn(container)!);
    expect(initial(container)).toBeNull();

    act(() => document.documentElement.classList.add("light"));
    await waitFor(() => expect(drawn(container)).toHaveAttribute("src", LIGHT));
    // The new source starts again: the initial holds the place until it loads.
    expect(initial(container)).toBe("E");
    fireEvent.load(drawn(container)!);
    expect(initial(container)).toBeNull();

    act(() => document.documentElement.classList.remove("light"));
    await waitFor(() => expect(drawn(container)).toHaveAttribute("src", DARK));
  });
});

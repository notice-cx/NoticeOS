import { fireEvent, render, screen } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Drill } from "@/components/Drill";

function EvidenceLink() {
  return (
    <Drill interactive to="/assets/example.com#alerts" className="font-medium">
      <span>3 open alerts</span>
    </Drill>
  );
}

describe("Drill evidence navigation", () => {
  it("opens the declared evidence route through the app router", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<EvidenceLink />} />
          <Route path="/assets/example.com" element={<h1>Asset evidence</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "3 open alerts" });
    expect(link).toHaveAttribute("href", "/assets/example.com#alerts");
    expect(link).toHaveClass("font-medium", "focus-visible:ring-2");
    expect(link).not.toHaveAttribute("title");
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: "Asset evidence" })).toBeVisible();
  });

  it("keeps the Wall plain without a router or interactive wrapper", () => {
    const { container } = render(
      <Drill interactive={false} to="/tasks" className="font-medium">
        <span>14 queued</span>
      </Drill>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("14 queued")).toBeVisible();
    expect(container.innerHTML).toBe("<span>14 queued</span>");
  });
});

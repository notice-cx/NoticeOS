import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { assertBrowserStorage } from "./environment";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

it("uses separate jsdom storage areas with browser key and removal behavior", () => {
  for (const storage of [localStorage, sessionStorage]) {
    expect(storage).toBeInstanceOf(Storage);
    storage.setItem("same-key", "persisted");
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe("same-key");
    expect(storage.getItem("same-key")).toBe("persisted");
    storage.removeItem("same-key");
    expect(storage.getItem("same-key")).toBeNull();
  }
  localStorage.setItem("local-only", "local");
  expect(sessionStorage.getItem("local-only")).toBeNull();
  render(createElement("p", {}, "cleanup sentinel"));
  expect(screen.getByText("cleanup sentinel")).toBeInTheDocument();
});

it("unmounts the preceding render and clears both storage areas", () => {
  expect(screen.queryByText("cleanup sentinel")).not.toBeInTheDocument();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  render(createElement("p", {}, "cleanup sentinel"));
  expect(screen.getAllByText("cleanup sentinel")).toHaveLength(1);
});

it("fails clearly when browser storage is unavailable, before rendering", () => {
  vi.stubGlobal("localStorage", undefined);
  try {
    expect(assertBrowserStorage).toThrow("Tower tests require usable jsdom localStorage and sessionStorage");
    expect(document.body).toBeEmptyDOMElement();
  } finally { vi.unstubAllGlobals(); }
});

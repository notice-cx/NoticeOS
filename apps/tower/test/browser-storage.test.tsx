// A browser that used the desk under the product's old name keeps every
// choice: its localStorage holds `reindex-os:*` keys; the desk reads
// `noticeos:*` and moves an old value over on the first read.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX, forgetStored, readStored, storageKey } from "@/lib/browser-storage";
import { THEME_STORAGE_KEY, useTheme } from "@/hooks/useTheme";

afterEach(() => window.localStorage.clear());

describe("browser storage under the NoticeOS name", () => {
  it("namespaces every key noticeos:, and knows the name it replaced", () => {
    expect(STORAGE_PREFIX).toBe("noticeos:");
    expect(LEGACY_STORAGE_PREFIX).toBe("reindex-os:");
    expect(storageKey("theme")).toBe("noticeos:theme");
    expect(THEME_STORAGE_KEY).toBe("noticeos:theme");
  });

  it("reads a value saved under the old key, and moves it to the new key", () => {
    window.localStorage.setItem("reindex-os:nav-assets", '{"open":true,"seen":4}');
    expect(readStored(window.localStorage, "nav-assets")).toBe('{"open":true,"seen":4}');
    expect(window.localStorage.getItem("noticeos:nav-assets")).toBe('{"open":true,"seen":4}');
    expect(window.localStorage.getItem("reindex-os:nav-assets")).toBeNull();
  });

  it("prefers the new key when both exist, and forgets both", () => {
    window.localStorage.setItem("reindex-os:palette-recent", '["page:Home"]');
    window.localStorage.setItem("noticeos:palette-recent", '["asset:example.com"]');
    expect(readStored(window.localStorage, "palette-recent")).toBe('["asset:example.com"]');
    forgetStored(window.localStorage, "palette-recent");
    expect(readStored(window.localStorage, "palette-recent")).toBeNull();
  });

  it("answers nothing, never throws, when storage refuses", () => {
    const refusing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(readStored(refusing, "theme")).toBeNull();
    expect(() => forgetStored(refusing, "theme")).not.toThrow();
    expect(readStored(null, "theme")).toBeNull();
  });

  it("an operator who chose the light theme under the old key still gets it, and keeps it", () => {
    window.localStorage.setItem("reindex-os:theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.toggle());
    expect(window.localStorage.getItem("noticeos:theme")).toBe("dark");
    expect(window.localStorage.getItem("reindex-os:theme")).toBeNull();
  });
});

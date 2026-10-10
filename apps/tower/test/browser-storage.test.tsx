import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_PREFIX, forgetStored, readStored, storageKey } from "@/lib/browser-storage";
import { THEME_STORAGE_KEY } from "@/hooks/useTheme";

afterEach(() => window.localStorage.clear());

describe("browser storage under the NoticeOS name", () => {
  it("namespaces every key noticeos:", () => {
    expect(STORAGE_PREFIX).toBe("noticeos:");
    expect(storageKey("theme")).toBe("noticeos:theme");
    expect(THEME_STORAGE_KEY).toBe("noticeos:theme");
  });

  it("reads and forgets a stored value", () => {
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
});

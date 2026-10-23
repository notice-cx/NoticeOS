// One of two identical probes; the test and why there are two: isolation-probe.ts.
import { vi } from "vitest";
import { isolationProbe } from "./isolation-probe";

vi.mock("./isolation-probe-mocked", () => ({ who: "probe b's stand-in" }));

isolationProbe("b");

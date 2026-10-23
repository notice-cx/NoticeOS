// Module state for test/isolation-probe.ts, and a module that imports the one
// each probe replaces with its own `vi.mock` stand-in.
import { who } from "./isolation-probe-mocked";

export const marks: string[] = [];

export function stoodIn(): string {
  return who;
}

// @vitest-environment node
import { expect, it } from "vitest";
import { snapshotRpcData } from "../worker/rpc-data";

it("copies plain returned data and disposes the original exactly once", async () => {
  let disposed = 0;
  const result = [{ body: { value: 3 }, version: 1 }];
  Object.defineProperty(result, Symbol.dispose, { value: () => { disposed++; } });
  const copy = await snapshotRpcData(Promise.resolve(result));
  expect(copy).toEqual(result);
  expect(copy).not.toBe(result);
  expect(copy[0]!.body).not.toBe(result[0]!.body);
  expect(Reflect.get(copy, Symbol.dispose)).toBeUndefined();
  expect(disposed).toBe(1);
});

it("disposes the returned object exactly once when copying fails", async () => {
  let disposed = 0;
  const result = { unsupported: () => undefined, [Symbol.dispose]: () => { disposed++; } };
  await expect(snapshotRpcData(Promise.resolve(result))).rejects.toThrow();
  expect(disposed).toBe(1);
});

it("preserves the original RPC rejection without manufacturing a result", async () => {
  const failure = new Error("Generated fixture refusal");
  await expect(snapshotRpcData(Promise.reject(failure))).rejects.toBe(failure);
});

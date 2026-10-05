/** These calls return plain data, never callable RPC stubs. Copy the data
 * before releasing its cross-service lifetime, including when copying fails. */
export async function snapshotRpcData<T>(pending: Promise<T>): Promise<T> {
  const result = await pending;
  try {
    return structuredClone(result);
  } finally {
    (result as T & { [Symbol.dispose]?: () => void })?.[Symbol.dispose]?.();
  }
}

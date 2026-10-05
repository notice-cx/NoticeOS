/** Empty this fixture bucket even when reset() cannot see its detached actor. */
export async function clearRawSignals(bucket: Pick<R2Bucket, 'list' | 'delete'>): Promise<void> {
  let listed = await bucket.list();
  while (true) {
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map(object => object.key));
    if (!listed.truncated) break;
    listed = await bucket.list({ cursor: listed.cursor });
  }
  if ((await bucket.list({ limit: 1 })).objects.length !== 0) {
    throw new Error('the fixture raw-signal bucket was not emptied');
  }
}

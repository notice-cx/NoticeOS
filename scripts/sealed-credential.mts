/** The workspace vault's existing AES-GCM envelope, shared by its readers. */
export async function unsealCredential(key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>) {
  const decoded = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decoded, ciphertext);
}

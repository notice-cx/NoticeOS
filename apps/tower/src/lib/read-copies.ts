import { ANSWER_TIMES_HEADER, withAnswerTimes } from '@shared/read-validator';

/**
 * The page's own copy of each read, kept in memory for one runtime: a later
 * read of the same address sends the copy's validator, and a 304 answer is
 * handed to the caller as the copy with the answer times the 304 carried, so
 * an unchanged read costs a header and decodes to equal data
 * (`shared/read-validator.ts` is the server's half).
 * Nothing is written to the browser's cache or storage.
 */

/** A copy longer than this is not kept; its reads are answered in full. */
const MAX_COPY_CHARACTERS = 8 * 1024 * 1024;

interface ReadCopy {
  validator: string;
  body: string;
  headers: Headers;
}

export function createReadCopies() {
  const copies = new Map<string, ReadCopy>();
  return Object.freeze({
    /** The validator to send for this address, when a copy is held. */
    validatorFor(address: string): string | null {
      return copies.get(address)?.validator ?? null;
    },
    /** The answer the caller sees: the copy for a 304, the response itself
     * otherwise, kept as the new copy when it carries a validator. */
    async settle(address: string, response: Response): Promise<Response> {
      const held = copies.get(address);
      if (response.status === 304 && held) {
        return new Response(withAnswerTimes(held.body, response.headers.get(ANSWER_TIMES_HEADER)), { status: 200, headers: held.headers });
      }
      if (response.status !== 200) return response;
      const validator = response.headers.get('etag');
      if (validator === null) { copies.delete(address); return response; }
      const body = await response.clone().text();
      if (body.length > MAX_COPY_CHARACTERS) copies.delete(address);
      else copies.set(address, { validator, body, headers: new Headers(response.headers) });
      return response;
    },
    clear() { copies.clear(); },
  });
}

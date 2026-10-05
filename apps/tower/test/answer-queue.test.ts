import { afterEach, describe, expect, it, vi } from "vitest";

// The inbox's Undo window (bead ro-ujb9.96.7.11): an answer is HELD, never
// reversed, because none of the three lane verbs has an inverse. These pin the
// window, the take-back, the page-leaving flush and what a row reads.

const api = vi.hoisted(() => ({
  respondToTask: vi.fn(async () => undefined),
  dismissTask: vi.fn(async () => undefined),
  resolveGate: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import {
  UNDO_WINDOW_MS,
  answerHides,
  createAnswerQueue,
  flushAnswers,
  resetAnswerQueue,
  scheduleAnswer,
  undoAnswer,
} from "@/lib/answer-queue";
import { sendInboxAnswer } from "@/hooks/useTasks";
import { browserOwnerKey, captureBrowserOwner } from '@/lib/browser-owner';

const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const OWNER_A = { mode: 'hosted', principalId: PRINCIPAL, sessionId: SESSION, workspaceId: WORKSPACE_A, clientGeneration: 1 };
const OWNER_B = { ...OWNER_A, workspaceId: WORKSPACE_B };
const retireOwned: Array<() => void> = [];
function ownedQueue<Answer>(owner: unknown, send: (answer: Answer, keepalive: boolean) => Promise<void>, page?: Window) {
  const queue = createAnswerQueue(owner, send, page);
  retireOwned.push(queue.retire);
  return queue;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const retire of retireOwned.splice(0)) retire();
  resetAnswerQueue();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('one captured browser owner', () => {
  it('refuses malformed or unrecognized owners before installing hooks or scheduling work', () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const add = vi.spyOn(window, 'addEventListener');
    const invalid: unknown[] = [null, [], {}, { ...OWNER_A, mode: 'unknown' },
      { ...OWNER_A, principalId: 'not-a-uuid' }, { ...OWNER_A, sessionId: null },
      { ...OWNER_A, workspaceId: 'a|b' }, { ...OWNER_A, clientGeneration: -1 },
      { ...OWNER_A, clientGeneration: 0.5 }, { ...OWNER_A, role: 'owner' },
      { mode: 'demo', clientGeneration: 0 }, { mode: 'standalone', clientGeneration: 0, sessionId: SESSION }];
    const getter = vi.fn(() => SESSION);
    const accessor = { ...OWNER_A };
    Object.defineProperty(accessor, 'sessionId', { enumerable: true, get: getter });
    invalid.push(accessor, Object.assign(Object.create({ extra: true }), OWNER_A),
      Object.defineProperty({ ...OWNER_A }, 'hidden', { value: 'unowned' }),
      { ...OWNER_A, [Symbol('unowned')]: true });
    for (const owner of invalid) expect(() => createAnswerQueue(owner, send, window)).toThrow('Browser owner is invalid.');
    expect(add).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    add.mockRestore();
  });

  it('captures immutable identity and distinct framed keys for workspace, session, generation and entry mode', () => {
    const source = { ...OWNER_A };
    const queue = ownedQueue(source, async () => {});
    source.workspaceId = WORKSPACE_B;
    source.clientGeneration = 9;
    expect(queue.owner).toEqual(OWNER_A);
    expect(Object.isFrozen(queue.owner)).toBe(true);
    expect(JSON.parse(queue.ownerKey)).toEqual(['hosted', PRINCIPAL, SESSION, WORKSPACE_A, 1]);
    const keys = [OWNER_A, OWNER_B, { ...OWNER_A, sessionId: WORKSPACE_B },
      { ...OWNER_A, clientGeneration: 2 }, { mode: 'demo', workspaceId: WORKSPACE_A, clientGeneration: 1 },
      { mode: 'standalone', clientGeneration: 1 }].map(owner => browserOwnerKey(captureBrowserOwner(owner)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('matching and separator-bearing task IDs never let another owner read, Undo or flush the answer', async () => {
    vi.useFakeTimers();
    const sendA = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const sendB = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const a = ownedQueue(OWNER_A, sendA);
    const b = ownedQueue(OWNER_B, sendB);
    const id = 'same-task|["owner","resource"]';
    a.schedule({ id, answer: 'A' });
    expect(b.hides(id, null)).toBe(false);
    expect(b.undo(id)).toBe(false);
    b.flush();
    expect(sendA).not.toHaveBeenCalled();
    b.schedule({ id, answer: 'B' });
    expect(b.undo(id)).toBe(true);
    expect(a.hides(id, null)).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(sendA).toHaveBeenCalledExactlyOnceWith('A', false);
    expect(sendB).not.toHaveBeenCalled();
    expect(b.hides(id, null)).toBe(false);
  });

  it('a replaced timer sends only its replacement and leaves other answers intact', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const queue = ownedQueue(OWNER_A, send);
    queue.schedule({ id: 'same', answer: 'first' });
    queue.schedule({ id: 'other', answer: 'other' });
    await vi.advanceTimersByTimeAsync(1000);
    queue.schedule({ id: 'same', answer: 'replacement' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(send.mock.calls).toEqual([['other', false]]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls).toEqual([['other', false], ['replacement', false]]);
  });

  it.each(['success', 'failure'] as const)('a dispatched %s stays hidden until its own sender settles', async outcome => {
    const pending = deferred();
    const a = ownedQueue(OWNER_A, () => pending.promise);
    const b = ownedQueue(OWNER_B, async () => {});
    const failed = vi.fn();
    a.schedule({ id: 'same', answer: null, onFailed: failed });
    a.flush();
    expect(a.hides('same', null)).toBe(true);
    expect(a.undo('same')).toBe(false);
    expect(b.hides('same', null)).toBe(false);
    b.schedule({ id: 'same', answer: null });
    // Another queue update/read cannot expose the issued answer during I/O.
    expect(a.hides('same', null)).toBe(true);
    if (outcome === 'success') pending.resolve();
    else pending.reject(new Error('original request refused'));
    await pending.promise.catch(() => {});
    await Promise.resolve();
    expect(a.hides('same', null)).toBe(outcome === 'success');
    expect(failed).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
    expect(b.hides('same', null)).toBe(true);
    expect(b.undo('same')).toBe(true);
    expect(a.hides('same', null)).toBe(outcome === 'success');
  });

  it('retirement cancels unsent work, hooks and subscriptions without pretending it was undone', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const undo = vi.fn();
    const changed = vi.fn();
    const queue = ownedQueue(OWNER_A, send, window);
    const remove = vi.spyOn(window, 'removeEventListener');
    queue.subscribe(changed);
    queue.schedule({ id: 'same', answer: null, onUndo: undo });
    changed.mockClear();
    queue.retire();
    expect(changed).toHaveBeenCalledOnce();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(['pagehide', 'keydown']);
    remove.mockRestore();
    changed.mockClear();
    queue.retire();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(queue.hides('same', null)).toBe(false);
    expect(queue.undo('same')).toBe(false);
    expect(() => queue.schedule({ id: 'same', answer: null })).toThrow('no longer active');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'failure'] as const)('a dispatched %s retains its sender but cannot update the successor', async outcome => {
    const pending = deferred();
    const sentA = vi.fn();
    const failedA = vi.fn();
    const changedA = vi.fn();
    const sendA = vi.fn((_answer: string, _keepalive: boolean) => pending.promise);
    const sendB = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const a = ownedQueue(OWNER_A, sendA);
    a.subscribe(changedA);
    a.schedule({ id: 'same', answer: 'original', onSent: sentA, onFailed: failedA });
    a.flush();
    expect(sendA).toHaveBeenCalledExactlyOnceWith('original', false);
    a.retire();
    changedA.mockClear();
    const b = ownedQueue({ ...OWNER_A, clientGeneration: 2 }, sendB);
    b.schedule({ id: 'same', answer: 'successor' });
    expect(b.undo('same')).toBe(true);
    if (outcome === 'success') pending.resolve();
    else pending.reject(new Error('original request refused'));
    await pending.promise.catch(() => {});
    await Promise.resolve();
    expect(sentA).not.toHaveBeenCalled();
    expect(failedA).not.toHaveBeenCalled();
    expect(changedA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(b.hides('same', null)).toBe(false);
    expect(a.undo('same')).toBe(false);
  });

  it.each(['success', 'failure', 'undo'] as const)('a subscriber switching owner during %s suppresses the retired callback', async outcome => {
    const pending = deferred();
    const callback = vi.fn();
    const a = ownedQueue(OWNER_A, () => pending.promise, window);
    a.schedule({ id: 'same', answer: null, onSent: callback, onFailed: callback, onUndo: callback });
    a.subscribe(() => { ownedQueue(OWNER_B, async () => {}, window); });
    if (outcome === 'undo') expect(a.undo('same')).toBe(true);
    else {
      a.flush();
      if (outcome === 'success') pending.resolve();
      else pending.reject(new Error('original request refused'));
      await pending.promise.catch(() => {});
      await Promise.resolve();
    }
    expect(callback).not.toHaveBeenCalled();
    expect(a.hides('same', null)).toBe(false);
  });

  it('a successor owns pagehide and keyboard Undo without acting on its predecessor', async () => {
    vi.useFakeTimers();
    const sendA = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const sendB = vi.fn(async (_answer: string, _keepalive: boolean) => {});
    const undoA = vi.fn();
    const undoB = vi.fn();
    const a = ownedQueue(OWNER_A, sendA, window);
    a.schedule({ id: 'same', answer: 'A', onUndo: undoA });
    const b = ownedQueue(OWNER_B, sendB, window);
    b.schedule({ id: 'same', answer: 'B', onUndo: undoB });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(undoB).toHaveBeenCalledOnce();
    expect(undoA).not.toHaveBeenCalled();
    expect(a.hides('same', null)).toBe(false);
    b.schedule({ id: 'next', answer: 'B next' });
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledExactlyOnceWith('B next', true);
  });

  it('creating a successor with no actions immediately cancels prior timers and late callbacks', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const sendA = vi.fn(() => pending.promise);
    const sent = vi.fn();
    const a = ownedQueue(OWNER_A, sendA, window);
    a.schedule({ id: 'issued', answer: null, onSent: sent });
    a.flush();
    a.schedule({ id: 'waiting', answer: null });
    const b = ownedQueue(OWNER_B, async () => {}, window);
    expect(a.hides('waiting', null)).toBe(false);
    expect(b.hides('issued', null)).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(sendA).toHaveBeenCalledOnce();
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(sent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a context created by a retiring subscriber wins without leaving a superseded page hook', async () => {
    vi.useFakeTimers();
    const a = ownedQueue(OWNER_A, async () => {}, window);
    const newestSender = vi.fn(async () => {});
    const add = vi.spyOn(window, 'addEventListener');
    a.subscribe(() => {
      const newest = ownedQueue({ ...OWNER_B, clientGeneration: 3 }, newestSender, window);
      newest.schedule({ id: 'latest', answer: null });
    });
    const superseded = ownedQueue(OWNER_B, async () => {}, window);
    // Only the reentrant, latest context attaches a pair of page hooks.
    expect(add.mock.calls.map(([type]) => type)).toEqual(['pagehide', 'keydown']);
    add.mockRestore();
    expect(() => superseded.schedule({ id: 'stale', answer: null })).toThrow('no longer active');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(newestSender).toHaveBeenCalledExactlyOnceWith(null, true);
  });

  it('typing Undo in an editable field never removes an inbox answer', () => {
    const queue = ownedQueue(OWNER_A, async () => {}, window);
    queue.schedule({ id: 'same', answer: null });
    const input = document.createElement('input');
    document.body.append(input);
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      expect(queue.hides('same', null)).toBe(true);
    } finally { input.remove(); }
  });
});

describe("the Undo window", () => {
  it("sends nothing until the window closes, then sends once", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const onSent = vi.fn();
    scheduleAnswer({ id: "mp-1", send, onSent });
    expect(answerHides("mp-1", null)).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(false);
    expect(onSent).toHaveBeenCalledOnce();
  });

  it("takes an answer back inside the window, exactly: nothing is ever sent", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const onUndo = vi.fn();
    scheduleAnswer({ id: "mp-1", send, onUndo });
    expect(undoAnswer("mp-1")).toBe(true);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(answerHides("mp-1", null)).toBe(false);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2);
    expect(send).not.toHaveBeenCalled();
    // Too late once sent.
    scheduleAnswer({ id: "mp-2", send });
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    expect(undoAnswer("mp-2")).toBe(false);
  });

  it("sends everything still waiting, with keepalive, when the page is leaving", async () => {
    const send = vi.fn(async () => undefined);
    scheduleAnswer({ id: "mp-1", send });
    scheduleAnswer({ id: "mp-2", send });
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, true);
    expect(send).toHaveBeenNthCalledWith(2, true);
  });

  it("brings the row back when the lane refuses", async () => {
    const onFailed = vi.fn();
    scheduleAnswer({ id: "mp-1", send: async () => { throw new Error("bd: no such issue mp-1"); }, onFailed });
    flushAnswers();
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(answerHides("mp-1", null)).toBe(false);
  });

  it("keeps a sent answer's row out until a read taken after it", async () => {
    scheduleAnswer({ id: "mp-1", send: async () => undefined });
    flushAnswers();
    await vi.waitFor(() => expect(answerHides("mp-1", new Date(Date.now() - 60_000).toISOString())).toBe(true));
    expect(answerHides("mp-1", new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });
});

describe("each answer is one call on the lane the inbox always used", () => {
  it("approve → gate resolve, answer → human respond, dismiss → human dismiss", async () => {
    await sendInboxAnswer({ kind: "approve", id: "mp-gate", title: "Approve" });
    await sendInboxAnswer({ kind: "answer", id: "mp-ask", title: "Ask", text: "Yes" });
    await sendInboxAnswer({ kind: "dismiss", id: "mp-ask2", title: "Ask" });
    expect(api.resolveGate).toHaveBeenCalledWith("mp-gate");
    expect(api.respondToTask).toHaveBeenCalledWith("mp-ask", "Yes");
    expect(api.dismissTask).toHaveBeenCalledWith("mp-ask2");
  });

  it("asks the browser to finish the call only when the page is leaving", async () => {
    await sendInboxAnswer({ kind: "answer", id: "mp-ask", title: "Ask", text: "Yes" }, true);
    expect(api.respondToTask).toHaveBeenCalledWith("mp-ask", "Yes", { keepalive: true });
  });
});

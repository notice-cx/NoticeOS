import { useSyncExternalStore } from "react";
import { browserOwnerKey, captureBrowserOwner, type BrowserOwner } from './browser-owner';

/** An inbox answer lands after its Undo window (ro-ujb9.96.7.11).
 * It has no inverse, so Undo cancels an unsent answer rather than reversing it.
 * Each queue owns one captured browser context and its already-bound sender.
 * Retirement cancels unissued work; a dispatched request cannot be unsent. */
export const UNDO_WINDOW_MS = 5_000;

interface AnswerCallbacks {
  onSent?: () => void;
  onFailed?: (error: unknown) => void;
  onUndo?: () => void;
  delayMs?: number;
}

export interface QueuedAnswer<Answer> extends AnswerCallbacks {
  id: string;
  answer: Answer;
}

export interface ScheduledAnswer extends AnswerCallbacks {
  id: string;
  /** An already-bound lane call; keepalive is true only when leaving. */
  send: (keepalive: boolean) => Promise<void>;
}

export interface AnswerQueue<Answer> {
  readonly owner: BrowserOwner;
  readonly ownerKey: string;
  schedule(answer: QueuedAnswer<Answer>): void;
  undo(id: string): boolean;
  undoLatest(): string | null;
  flush(keepalive?: boolean): void;
  hides(id: string, readAt: string | null): boolean;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
  retire(): void;
}

interface Waiting {
  id: string;
  timer: ReturnType<typeof setTimeout>;
  send: (keepalive: boolean) => Promise<void>;
  onUndo: () => void;
}

// Only one queue can own a page's keyboard/exit hooks. Installing a successor
// retires the predecessor before attaching any new hooks; no global task map.
const pageOwners = new WeakMap<Window, () => void>();

/** The sender must already address the captured owner's request context.
 * This queue never selects a workspace or interprets permissions at send time.
 * Supplying a page enables its exit/keyboard hooks; tests without one are pure. */
export function createAnswerQueue<Answer>(
  identity: unknown,
  send: (answer: Answer, keepalive: boolean) => Promise<void>,
  page?: Window,
): AnswerQueue<Answer> {
  const owner = captureBrowserOwner(identity);
  const ownerKey = browserOwnerKey(owner);
  const key = (id: string) => JSON.stringify([ownerKey, id]);
  const waiting = new Map<string, Waiting>();
  const dispatched = new Map<string, number>();
  const sentAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  let active = true;
  let installed = false;

  function emit() {
    version += 1;
    for (const listener of listeners) listener();
  }
  const leaving = () => flush(true);
  const keydown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (waiting.size === 0 || isEditable(event.target)) return;
    event.preventDefault();
    undoLatest();
  };
  function installPageHooks() {
    if (!page || installed) return;
    const previous = pageOwners.get(page);
    pageOwners.set(page, retire);
    previous?.();
    // Retirement notifies subscribers. A newer context created there wins;
    // this superseded constructor must not attach another set of hooks.
    if (!active || pageOwners.get(page) !== retire) return;
    page.addEventListener('pagehide', leaving);
    page.addEventListener('keydown', keydown);
    installed = true;
  }
  function schedule({ id, answer, onSent, onFailed, onUndo, delayMs = UNDO_WINDOW_MS }: QueuedAnswer<Answer>) {
    if (!active) throw new Error('This browser context is no longer active.');
    installPageHooks();
    const ownedId = key(id);
    const previous = waiting.get(ownedId);
    if (previous) clearTimeout(previous.timer);
    const entry: Waiting = {
      id,
      timer: setTimeout(() => void run(false), delayMs),
      send: run,
      onUndo: onUndo ?? (() => {}),
    };
    async function run(keepalive: boolean) {
      // An already-queued old timer cannot dispatch its replacement's payload.
      if (!active || waiting.get(ownedId) !== entry) return;
      clearTimeout(entry.timer);
      waiting.delete(ownedId);
      dispatched.set(ownedId, (dispatched.get(ownedId) ?? 0) + 1);
      const settled = () => {
        const remaining = (dispatched.get(ownedId) ?? 1) - 1;
        if (remaining === 0) dispatched.delete(ownedId);
        else dispatched.set(ownedId, remaining);
      };
      try {
        await send(answer, keepalive);
      } catch (error) {
        if (!active) return;
        settled();
        emit();
        if (active) onFailed?.(error);
        return;
      }
      if (!active) return;
      settled();
      sentAt.set(ownedId, Date.now());
      emit();
      if (active) onSent?.();
    }
    waiting.set(ownedId, entry);
    emit();
  }
  function undo(id: string) {
    if (!active) return false;
    const ownedId = key(id);
    const entry = waiting.get(ownedId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    waiting.delete(ownedId);
    emit();
    if (active) entry.onUndo();
    return true;
  }
  function undoLatest() {
    const latest = [...waiting.values()].at(-1)?.id ?? null;
    if (latest !== null) undo(latest);
    return latest;
  }
  function flush(keepalive = false) {
    if (!active) return;
    for (const entry of [...waiting.values()]) void entry.send(keepalive);
  }
  function hides(id: string, readAt: string | null) {
    if (!active) return false;
    const ownedId = key(id);
    if (waiting.has(ownedId) || dispatched.has(ownedId)) return true;
    const sent = sentAt.get(ownedId);
    if (sent === undefined) return false;
    const read = readAt === null ? Number.NaN : Date.parse(readAt);
    return !Number.isFinite(read) || read <= sent;
  }
  function retire() {
    if (!active) return;
    active = false;
    for (const entry of waiting.values()) clearTimeout(entry.timer);
    waiting.clear();
    dispatched.clear();
    sentAt.clear();
    if (page && installed) {
      page.removeEventListener('pagehide', leaving);
      page.removeEventListener('keydown', keydown);
      if (pageOwners.get(page) === retire) pageOwners.delete(page);
      installed = false;
    }
    emit();
    listeners.clear();
  }
  // A switched page must relinquish its old timers even before the successor
  // schedules anything; installation is a context transition, not an action.
  installPageHooks();
  return {
    owner, ownerKey, schedule, undo, undoLatest, flush, hides, retire,
    subscribe: listener => {
      if (!active) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => version,
  };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function standaloneQueue() {
  return createAnswerQueue<ScheduledAnswer['send']>({ mode: 'standalone', clientGeneration: 0 },
    (send, keepalive) => send(keepalive), typeof window === 'undefined' ? undefined : window);
}
// The existing standalone API delegates to the same owner-bound implementation.
let current = standaloneQueue();
/** Explicit compatibility adapter for the standalone component test harness. */
export function standaloneAnswerQueue(): AnswerQueue<ScheduledAnswer['send']> { return current; }
export function scheduleAnswer({ send, ...answer }: ScheduledAnswer): void { current.schedule({ ...answer, answer: send }); }
export function undoAnswer(id: string): boolean { return current.undo(id); }
export function undoLatestAnswer(): string | null { return current.undoLatest(); }
export function flushAnswers(keepalive = false): void { current.flush(keepalive); }
export function answerHides(id: string, readAt: string | null): boolean { return current.hides(id, readAt); }
export function useAnswerQueue(): number {
  return useSyncExternalStore(current.subscribe, current.snapshot, current.snapshot);
}
/** Tests only: retire callbacks and page hooks, then start a fresh context. */
export function resetAnswerQueue(): void {
  current.retire();
  current = standaloneQueue();
}

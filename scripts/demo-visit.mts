// Local generation selection. A visit never grants permission to mutate data.
export const DEMO_VISIT_TTL_MS = 15 * 60 * 1000;
export const DEMO_LAUNCH_MAX_MS = 12 * 60 * 60 * 1000;
export const DEMO_GENERATION_MAX_MS = 10 * 60 * 1000;
export const DEMO_REQUEST_MAX_MS = 30 * 1000;
export const DEMO_CLEANUP_MAX_MS = 2 * 60 * 1000;
export const DEMO_MAX_VISITS = 1024;
export const DEMO_MAX_VISIT_REQUESTS = 8;

export class DemoVisitRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface DemoVisit {
  readonly id: string;
  readonly generation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface DemoVisitRequest {
  readonly visit: Readonly<DemoVisit>;
  readonly path: string;
  readonly release: () => void;
}
const generationId = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const visitId = (value: string): boolean => /^[a-f0-9]{32}$/u.test(value);

/** Only the dedicated gateway issues visits. Polls, navigation and refresh
 * resolve the original visit instead of touching its recorded deadline. */
export class DemoVisits {
  private readonly visits = new Map<string, Readonly<DemoVisit>>();
  private readonly requests = new Map<string, number>();
  private current: string;
  private previous: { generation: string; retireAt: number } | null = null;
  readonly deadline: number;

  constructor(current: string, startedAt: number, durationMs: number,
    private readonly newId: () => string) {
    if (!generationId(current) || !Number.isFinite(startedAt)
      || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > DEMO_LAUNCH_MAX_MS) {
      throw new DemoVisitRefusal(400, 'demo_launch_invalid');
    }
    this.current = current;
    this.deadline = startedAt + durationMs;
  }

  state(): Readonly<{ current: string; previous: Readonly<{ generation: string; retireAt: number }> | null; deadline: number }> {
    return Object.freeze({ current: this.current, previous: this.previous && Object.freeze({ ...this.previous }), deadline: this.deadline });
  }

  begin(now: number): Readonly<DemoVisit> {
    this.live(now);
    // Bound all issued selectors, including expired ones, for this finite run.
    // Keeping them means an expired URL always receives the same honest refusal.
    if (this.visits.size >= DEMO_MAX_VISITS) throw new DemoVisitRefusal(429, 'demo_visit_limit');
    const id = this.newId();
    if (!visitId(id) || this.visits.has(id)) throw new DemoVisitRefusal(503, 'demo_visit_id_invalid');
    const visit = Object.freeze({ id, generation: this.current, issuedAt: now,
      expiresAt: Math.min(now + DEMO_VISIT_TTL_MS, this.deadline) });
    this.visits.set(id, visit);
    return visit;
  }

  resolve(requestPath: string, now: number): DemoVisitRequest {
    const match = requestPath.match(/^\/visit\/([a-f0-9]{32})(\/[^#]*)?$/u);
    if (!match || /[\\\r\n\0]/u.test(requestPath) || /%(?:2f|5c|00|0a|0d)/iu.test(requestPath.split('?')[0]!)) {
      throw new DemoVisitRefusal(400, 'demo_visit_invalid');
    }
    const path = match[2] ?? '/';
    if (path.split('?')[0]!.split('/').some(part => part === '.' || part === '..' || /%(?:2e)/iu.test(part))) {
      throw new DemoVisitRefusal(400, 'demo_visit_invalid');
    }
    const visit = this.visits.get(match[1]!);
    if (!visit) throw new DemoVisitRefusal(404, 'demo_visit_unknown');
    if (!Number.isFinite(now) || now >= visit.expiresAt || now >= this.deadline) {
      throw new DemoVisitRefusal(410, 'demo_visit_expired');
    }
    const available = visit.generation === this.current || visit.generation === this.previous?.generation;
    if (!available) throw new DemoVisitRefusal(503, 'demo_generation_unavailable');
    const active = this.requests.get(visit.id) ?? 0;
    if (active >= DEMO_MAX_VISIT_REQUESTS) throw new DemoVisitRefusal(429, 'demo_request_limit');
    this.requests.set(visit.id, active + 1);
    let released = false;
    return Object.freeze({ visit, path, release: () => {
      if (released) return;
      released = true;
      const count = this.requests.get(visit.id) ?? 0;
      if (count <= 1) this.requests.delete(visit.id);
      else this.requests.set(visit.id, count - 1);
    } });
  }

  /** Called once, only after the caller has qualified and durably published
   * the exact complete candidate. No third backend is adopted or queued. */
  publish(generation: string, now: number): void {
    this.live(now);
    if (!generationId(generation) || generation === this.current || this.previous !== null) {
      throw new DemoVisitRefusal(409, 'demo_publish_refused');
    }
    this.previous = { generation: this.current,
      retireAt: Math.min(now + DEMO_VISIT_TTL_MS + DEMO_REQUEST_MAX_MS, this.deadline) };
    this.current = generation;
  }

  retired(generation: string, now: number): void {
    if (!this.previous || this.previous.generation !== generation || !Number.isFinite(now)
      || now < this.previous.retireAt || [...this.visits.values()].some(visit =>
        visit.generation === generation && (this.requests.get(visit.id) ?? 0) !== 0)) {
      throw new DemoVisitRefusal(409, 'demo_retirement_refused');
    }
    this.previous = null;
  }

  private live(now: number): void {
    if (!Number.isFinite(now) || now >= this.deadline) throw new DemoVisitRefusal(410, 'demo_launcher_expired');
  }
}

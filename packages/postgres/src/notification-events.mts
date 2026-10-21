import { Client } from 'pg';
import { openWorkspaceStore, type WorkspaceStore } from './store.mjs';

/** LISTEN requires a direct connection, never a transaction-pooled transport.
 * The signal contains no workspace or alert data. Every subsequent read uses
 * the scoped application store; wake-ups are hints, the outbox is durable. */
export interface NotificationEventListener {
  close(): Promise<void>;
}
export interface NotificationEventOptions {
  connectionString: string;
  drain(trigger: 'event' | 'recovery', signal: AbortSignal): Promise<boolean>;
  unavailable?(): void;
  /** Explicit deployment selection for a hosted consumer; absent: standalone. */
  workspaceId?: string;
}

export async function startNotificationEvents(options: NotificationEventOptions): Promise<NotificationEventListener> {
  const store = openWorkspaceStore(options.connectionString, { workspaceId: options.workspaceId });
  try {
    // Validates application role and workspace before opening the listener.
    await store.read(tx => tx.query('SELECT 1'));
  } catch (error) { await store.close(); throw error; }
  return notificationEvents(options, store);
}

function notificationEvents(options: NotificationEventOptions, store: WorkspaceStore): NotificationEventListener {
  const abort = new AbortController();
  let client: Client | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let connecting: Promise<void> | null = null;
  let pending = false;
  let nextKind: 'event' | 'recovery' = 'recovery';

  const report = () => { try { options.unavailable?.(); } catch { /* diagnostics cannot stop recovery */ } };
  function schedule(delayMs: number, kind: 'event' | 'recovery') {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextKind = kind;
    timer = setTimeout(() => { timer = undefined; kick(nextKind); }, delayMs);
    timer.unref();
  }
  function wake() {
    if (stopped) return;
    if (running) { pending = true; return; }
    // A fixed batching window: more events cannot postpone delivery forever.
    if (timer && nextKind === 'event') return;
    schedule(1000, 'event');
  }
  async function next(productive: boolean) {
    if (stopped) return;
    try {
      const [row] = await store.read(tx => tx.query<{ due: string | null }>(
        `SELECT min(greatest(next_attempt_at, coalesce(lease_until, next_attempt_at))) AS due
           FROM noticeos.notification_outbox WHERE state = 'pending'`));
      if (stopped) return;
      const due = row?.due ? Date.parse(row.due) - Date.now() : Infinity;
      // The minute check bounds missed wake-up/reconnect recovery. Failed or
      // paused consumers cannot spin on an already-due row.
      if (Number.isFinite(due)) schedule(due > 0 ? Math.max(1000, Math.min(2_147_483_647, due))
        : productive ? 1000 : 60_000, 'recovery');
    } catch { report(); schedule(60_000, 'recovery'); }
  }
  function kick(kind: 'event' | 'recovery') {
    if (stopped) return;
    if (running) { pending = true; return; }
    running = (async () => {
      let productive = false;
      try { productive = await options.drain(kind, abort.signal); }
      catch { if (!stopped) report(); }
      await next(productive);
    })().finally(() => {
      running = null;
      if (pending && !stopped) { pending = false; wake(); }
    });
  }
  function retryConnection() {
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => { reconnect = undefined; connect(); }, 5000);
    reconnect.unref();
  }
  function connect() {
    if (stopped || connecting) return;
    connecting = (async () => {
      const selected = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5000,
        application_name: 'noticeos-notification-events' });
      client = selected;
      const lost = () => {
        if (client !== selected || stopped) return;
        client = null;
        report();
        void selected.end().catch(() => {});
        retryConnection();
      };
      selected.on('error', lost);
      selected.on('end', lost);
      selected.on('notification', message => { if (message.channel === 'noticeos_notifications') wake(); });
      try {
        await selected.connect();
        if (stopped) { await selected.end(); return; }
        const result = await selected.query<{ role: string }>('SELECT session_user::text AS role');
        if (result.rows[0]?.role !== 'noticeos_app') throw new Error('Notification listener requires application role.');
        await selected.query('LISTEN noticeos_notifications');
        // Subscribe before recovering, closing the startup race with writers.
        kick('recovery');
      } catch {
        if (client === selected) client = null;
        await selected.end().catch(() => {});
        if (!stopped) { report(); retryConnection(); schedule(60_000, 'recovery'); }
      }
    })().finally(() => { connecting = null; });
  }
  // Re-read only while idle. A missed wake-up does not manufacture an empty
  // workflow run every minute, and a persisted retry timer keeps its deadline.
  let checking = false;
  const sweep = setInterval(() => {
    if (stopped || running || timer || checking) return;
    checking = true;
    void store.read(tx => tx.query<{ due: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM noticeos.notification_outbox WHERE state = 'pending'
        AND next_attempt_at <= clock_timestamp()
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())) AS due`))
      .then(rows => { if (rows[0]?.due) kick('recovery'); })
      .catch(report).finally(() => { checking = false; });
  }, 60_000);
  sweep.unref();
  connect();
  return {
    async close() {
      if (stopped) return;
      stopped = true;
      abort.abort();
      clearInterval(sweep);
      if (timer) clearTimeout(timer);
      if (reconnect) clearTimeout(reconnect);
      await connecting;
      await running;
      await client?.end().catch(() => {});
      await store.close();
    },
  };
}

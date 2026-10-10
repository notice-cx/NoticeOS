/** What the OS interrupts the operator about, declared once: the notifier
 * (`workers/ingest/src/notifier.ts`) decides what to send from it, and the
 * Integrations card tells the operator what the credential is for from it.
 * The list is the minimum: something the operator would want to know before
 * they next open the Tower. A warning is not that. */

/** The conditions worth a message. */
export type NotifiedCondition =
  /**
   * An alert that is open, `error`-severity, and new. Never every alert, never
   * a digest of the open set: one line per firing the OS had not already
   * mentioned.
   */
  | 'open-error'
  /**
   * A provider credential whose last use did not work — the Failing state the
   * Integrations card leads with. Not an alert, because `flags.asset` is `NOT
   * NULL` and a portfolio-shared credential is a statement about no single
   * asset. Worth interrupting for because a stopped collector is silent.
   */
  | 'source-failing';

export interface NotificationRule {
  id: NotifiedCondition;
  /** What lands in the channel, as a label ("New error alert"). Rendered on
   * the provider card, so what it promises is what the sender sends. */
  label: string;
  /** How often one of them arrives ("Each alert", "Once"), drawn beside the
   * label. */
  cadence: string;
}

export const NOTIFIED_CONDITIONS: readonly NotificationRule[] = [
  // One line per new error alert on any site, never a digest.
  { id: 'open-error', label: 'New error alert', cadence: 'Each alert' },
  // Once, when a data source stops working.
  { id: 'source-failing', label: 'Data source stops working', cadence: 'Once' },
] as const;

/**
 * The most lines one message carries. Past the cap the message says how many
 * more there were, and every one of them is recorded as notified: re-sending
 * them next hour would be the fatigue the cap exists to prevent.
 */
export const NOTIFY_BATCH_CAP = 10;

/**
 * How recently a condition must have arisen to be worth interrupting for. A
 * notifier with no horizon replays history: the first tick after a broken
 * webhook is fixed would deliver every open error the store has ever held.
 */
export const NOTIFY_WINDOW_HOURS = 24;

/** The one channel the OS can deliver on. A second channel would join this,
 * not replace it. */
export const NOTIFICATION_CHANNEL = 'discord';

/** WHAT THE OS INTERRUPTS THE OPERATOR ABOUT — declared ONCE, here
 * (bead `ro-vu8d.23`, doc 14 flow E, doc 11's Discord row).
 *
 * WHY IT IS A DECLARATION AND NOT A FUNCTION IN THE SENDER. Two runtimes have to
 * agree: `workers/ingest/src/notifier.ts` decides what to send, and the
 * Integrations card tells the operator what this credential is FOR before they
 * connect it. A card promising more than the sender delivers is exactly the
 * defect this bead was filed against — doc 11's catalog row has promised a flags
 * digest, approvals-needed and kill-switch confirmations since 2026-07-06, and
 * nothing in the OS sent anything at all.
 *
 * THE LIST IS SHORT ON PURPOSE. Alert fatigue is doc 11's own named failure mode
 * for this channel ("keep channels few"), and doc 14 flow E's whole design is
 * that a roll-up defers to the action list (D15). A notifier that forwarded
 * every alert would be a second, worse copy of `/alerts` arriving at 3am — so
 * what qualifies is the honest minimum: something the operator would want to
 * know about BEFORE they next open the Tower, and nothing else. A warning is not
 * that. Every condition below is a written rule rather than a severity filter
 * somebody can widen without noticing.
 */

/** The conditions worth a message. */
export type NotifiedCondition =
  /**
   * An alert that is OPEN, `error`-severity, and new.
   *
   * Error is the whole filter, deliberately: `warn` is the severity doc 02 gives
   * to something the operator should look at eventually, and "eventually" is
   * what the desk is for. Never every alert, never a digest of the open set —
   * one line per firing the OS had not already mentioned.
   */
  | 'open-error'
  /**
   * A provider credential whose last use did not work — the *Failing* state the
   * Integrations card leads with.
   *
   * It belongs here and not in the alert lane for the reason `ro-vu8d.8` gave
   * for an expiring credential: `flags.asset` is `NOT NULL REFERENCES
   * assets(id)`, and a portfolio-shared credential is a statement about no
   * single asset. It is worth interrupting for because a stopped collector is
   * silent — nothing else in the OS says "the data stopped arriving" until the
   * operator notices a gap.
   */
  | 'source-failing';

export interface NotificationRule {
  id: NotifiedCondition;
  /** What lands in the channel, as a label ("New error alert"). Rendered on
   * the provider card, so what it promises is what the sender sends. */
  label: string;
  /** How often one of them arrives ("Each alert", "Once") — the rule's other
   * half, drawn beside the label rather than written into a sentence (bead
   * `ro-ujb9.96.6.1`). */
  cadence: string;
}

export const NOTIFIED_CONDITIONS: readonly NotificationRule[] = [
  // One line per new error alert on any site, never a digest.
  { id: 'open-error', label: 'New error alert', cadence: 'Each alert' },
  // Once, when a data source stops working.
  { id: 'source-failing', label: 'Data source stops working', cadence: 'Once' },
] as const;

/**
 * The most lines one message carries.
 *
 * doc 14 flow E's own rule for this channel, applied to a live notifier rather
 * than to the digest it was written about: "capped at 10 items — if more than 10
 * things need attention, the digest's own noise is the incident". Past the cap
 * the message says how many more there were, and every one of them is recorded
 * as notified: they WERE told, collectively, and re-sending them next hour would
 * be the fatigue this cap exists to prevent.
 */
export const NOTIFY_BATCH_CAP = 10;

/**
 * How recently a condition must have arisen to be worth interrupting for.
 *
 * A notifier with no horizon replays history: the first tick after this ships —
 * or the first tick after a broken webhook is fixed — would deliver every open
 * error the store has ever held. An error from three weeks ago is not news, and
 * the surface that owns it is `/alerts`, which has never stopped showing it.
 */
export const NOTIFY_WINDOW_HOURS = 24;

/** The one channel the OS can deliver on today. Doc 11 names email as its
 * fallback; nothing implements one, and this constant is what a second channel
 * would join rather than replace. */
export const NOTIFICATION_CHANNEL = 'discord';

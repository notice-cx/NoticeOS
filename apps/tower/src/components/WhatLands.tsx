import { Send } from "lucide-react";
import { NOTIFIED_CONDITIONS } from "@shared/integrations-page";

/**
 * WHAT ACTUALLY LANDS IN THE NOTIFICATION CHANNEL (bead `ro-vu8d.23`).
 *
 * The card asked for a webhook and could not say what would come out of it —
 * `config/integrations.json` promised a digest, approvals-needed and kill-switch
 * confirmations, and the OS sent none of them, because until this bead there was
 * no sender at all.
 *
 * IT READS THE SENDER'S OWN DECLARATION. `NOTIFIED_CONDITIONS` lives in
 * `packages/contract` and the ingest's notifier decides from the same list, so a
 * condition added there reaches this sentence with no edit here — and the card
 * cannot promise something the channel does not carry.
 *
 * THE SHORTNESS IS THE POINT, so it says so. Alert fatigue is the documented
 * failure mode for this channel (doc 11), and an operator who expects everything
 * and receives two things a week will assume it is broken. Neutral ink: this is
 * a description, not a fault and not connectivity — the two colour systems doc
 * 14 licenses on this card.
 *
 * Its own file since bead `ro-ujb9.96.7.14`: the provider card and Discord's
 * connect panel both draw it, and the panel (opened from a site's Data
 * sources too) must not carry the whole card to do so.
 */
export function WhatLands({
  connected,
}: {
  connected: boolean;
}) {
  return (
    <div className="flex flex-col gap-1" data-what-lands>
      <span className="text-xs font-medium text-foreground">
        {connected ? "What NoticeOS sends here" : "What NoticeOS will send here"}
      </span>
      {/* Each rule as what lands and how often (bead `ro-ujb9.96.6.1`): a
          label and its cadence, never a sentence per rule. */}
      <ul className="flex flex-col gap-0.5">
        {NOTIFIED_CONDITIONS.map((rule) => (
          <li
            key={rule.id}
            className="flex items-center gap-2 text-xs"
            data-notified-condition={rule.id}
          >
            <Send className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 text-foreground">{rule.label}</span>
            <span className="text-muted-foreground" aria-hidden>·</span>
            <span className="text-muted-foreground">{rule.cadence}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default WhatLands;

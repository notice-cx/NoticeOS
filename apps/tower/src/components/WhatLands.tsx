import { Send } from "lucide-react";
import { NOTIFIED_CONDITIONS } from "@shared/integrations-page";

/**
 * What lands in the notification channel, read from the sender's own
 * declaration (`NOTIFIED_CONDITIONS`, which the ingest's notifier decides
 * from), so the card cannot promise something the channel does not carry.
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

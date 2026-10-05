import type { ConnectBlocker } from "@shared/integrations-page";
import { CopyCommand } from "@/components/CopyCommand";
import { StatusBanner } from "@/components/surface/StatusBanner";

/**
 * WHY NOTHING CAN BE CONNECTED YET, AND THE ONE COMMAND THAT CLEARS IT (beads
 * `ro-ujb9.96.6.19`, `ro-ujb9.204`, `ro-e70g`): a warn banner per blocker —
 * its lead, the environment binding where there is one, the command with Copy.
 * Never the ingest's sentence.
 *
 * Said ONCE per screen, where Connect is: at the top of `/integrations`, and
 * inside the connect panel a site's Data sources opens, since that page has no
 * banner of its own. A panel opened over `/integrations` draws none — the page
 * behind already says it.
 *
 * *Registry justification:* the Integrations page drew these banners inline; a
 * site's connect panel needed the same state and command, and two copies of one
 * blocker would drift.
 */
export function ConnectBlockers({ blockers }: { blockers: readonly ConnectBlocker[] }) {
  return blockers.map((blocker) => (
    <div key={blocker.kind} data-connect-blocked="" data-blocker={blocker.kind}>
      <StatusBanner lead={blocker.lead} subject={`setup:${blocker.kind}`} severity="warn" className="border-warn/35 bg-warn/10">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {blocker.binding ? <code className="font-mono text-xs text-foreground" data-blocker-binding>{blocker.binding}</code> : null}
          <CopyCommand command={blocker.command} mark={{ "data-blocker-command": blocker.kind }} />
        </span>
      </StatusBanner>
    </div>
  ));
}

export default ConnectBlockers;

import type { ConnectBlocker } from "@shared/integrations-page";
import { CopyCommand } from "@/components/CopyCommand";
import { StatusBanner } from "@/components/surface/StatusBanner";

/**
 * Why nothing can be connected yet, and the one command that clears it.
 * Said once per screen: a panel opened over `/integrations` draws none
 * because the page behind already says it.
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

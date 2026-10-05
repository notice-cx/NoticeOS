import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";

/**
 * ONE COMMAND, VERBATIM, WITH COPY BESIDE IT — the press that clears a state
 * only the operator's own terminal can clear (a migration, a bootstrap key).
 *
 * *Registry justification:* it was `ProviderCard`'s private helper (the
 * notification store, the legacy-env import); the Integrations page's setup
 * blockers now draw the same state-and-command (bead `ro-ujb9.96.6.19`), and
 * two copies of one control would drift. `mark` is the data attribute a test
 * or the capture harness finds it by.
 */
export function CopyCommand({ command, mark }: { command: string; mark: Record<`data-${string}`, string> }) {
  const [copied, flash] = useCopyFlash();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <code
        className="min-w-0 break-all rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        {...mark}
      >
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Copy ${command}`}
        onClick={() => {
          void copyText(command).then(flash, () => {});
        }}
      >
        <Copy className="size-3.5" aria-hidden />
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

export default CopyCommand;

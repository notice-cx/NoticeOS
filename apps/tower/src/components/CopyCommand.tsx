import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * One command, verbatim, with Copy beside it: the press that clears a state
 * only the operator's own terminal can clear. `block` keeps the text's own
 * lines, for a file the operator pastes whole, with Copy above it. `mark` is
 * the data attribute a test finds it by.
 */
export function CopyCommand({ command, mark, block = false, label }: {
  command: string;
  mark: Record<`data-${string}`, string>;
  block?: boolean;
  /** Names a block's text, for Copy's accessible name: "the workflow file". */
  label?: string;
}) {
  const [copied, flash] = useCopyFlash();
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`Copy ${label ?? command}`}
      onClick={() => {
        void copyText(command).then(flash, () => {});
      }}
    >
      <Copy className="size-3.5" aria-hidden />
      {copied ? "Copied" : "Copy"}
    </Button>
  );
  if (block) {
    return (
      <span className="grid min-w-0 gap-1">
        <span className="flex justify-end">{button}</span>
        <pre
          className={cn(
            "m-0 min-w-0 overflow-x-auto rounded-md border border-border bg-background px-3 py-2",
            "font-mono text-xs leading-relaxed whitespace-pre text-foreground",
          )}
          {...mark}
        >
          <code>{command}</code>
        </pre>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <code
        className="min-w-0 break-all rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        {...mark}
      >
        {command}
      </code>
      {button}
    </span>
  );
}

export default CopyCommand;

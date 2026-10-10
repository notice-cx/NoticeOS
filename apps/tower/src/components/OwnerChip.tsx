import { useOwnerToast } from '@/lib/browser-context';
import { Check, Copy } from "lucide-react";

import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export interface OwnerChipProps {
  /** The reference file or store table behind this setting or fact. */
  path: string;
  /** Replaces the hover sentence when the chip points at something to read (a
   * doc section) rather than the owner of a fact. */
  hint?: string;
  className?: string;
}

/**
 * A technical reference chip. Click copies its path; whether a setting is
 * editable is determined by its form and store capability, not by this chip.
 */
export function OwnerChip({ path, hint, className }: OwnerChipProps) {
  const toast = useOwnerToast();
  const [copied, flashCopied] = useCopyFlash();

  async function copy() {
    try {
      await copyText(path);
      flashCopied();
      toast.success(`Copied ${path}`);
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={
        hint ??
        `Configuration reference: ${path} — click to copy the path.`
      }
      /* On a phone the button is a 44px target that draws nothing; the span
       * draws the 23px chip, and hover and focus follow through `group-`. The
       * negative margin hands the extra height back to the row, and `py-2.5`
       * matches it so a wrapped chip keeps its own slot instead of spilling
       * over the label above. The path breaks anywhere so it never widens the
       * page. */
      // The audit that keeps owner chips off view surfaces finds them by this
      // mark and reports the path.
      data-owner-chip={path}
      className={cn(
        "group inline-flex max-w-full items-center text-start outline-none max-sm:-my-2.5 max-sm:min-h-11 max-sm:py-2.5",
        className,
      )}
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
        {copied ? (
          <Check className="size-3 shrink-0" aria-hidden />
        ) : (
          <Copy className="size-3 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 wrap-anywhere" data-owner-chip-path>{path}</span>
      </span>
    </button>
  );
}

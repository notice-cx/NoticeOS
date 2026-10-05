import { useOwnerToast } from '@/lib/browser-context';
import { Check, Copy } from "lucide-react";

import { useCopyFlash } from "@/hooks/useCopyFlash";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export interface OwnerChipProps {
  /** The reference file or store table behind this setting or fact. */
  path: string;
  /** Replaces the owning-file hover sentence when the chip points at a reference
   * the operator should READ (a doc section) rather than the owner of a fact. */
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
      /* THE CHIP IS 23px AND A THUMB IS 44px (bead `ro-9smi`).
       *
       * `ro-md80` declared the floor on buttons, fields, palette rows and nav
       * rows; this is none of those four, which is how it survived that sweep
       * and then `ro-khoy`'s, and it is on every file-owned section in the
       * product — 18 of them on /settings alone. Growing the chip itself would
       * have been the wrong fix: it is a MONOSPACE PATH at 11px beside a
       * heading, and a 44px bordered box would read as a button competing with
       * the heading it qualifies rather than a pointer under it.
       *
       * So the target and the chip are separated. This button is the target and
       * draws nothing; the span below draws the chip at exactly the size it
       * always had. The hover and the focus ring follow the pointer to the outer
       * box through `group-`, so the ring still hugs the chip and does not
       * outline the empty space around it.
       *
       * AND THE HEIGHT IS CLAIMED FROM THE ROWS AROUND IT, NOT ADDED TO THEM.
       * A bare `min-h-11` cost /settings 279px — 18 chips, each driving the
       * heading row it sits in from 23px to 44px — which is the page cost
       * `ro-khoy` and `ro-c59x` both went to lengths to avoid. The negative
       * margin gives the extra 21px back to the layout while the BOX keeps it:
       * the target measures 44px, the row measures 24px, and the chip lands
       * within half a pixel of where it was drawn before. `min-h` rather than
       * `h`, so a chip that wraps in a narrow column grows instead of clipping.
       * `max-sm:` only: a pointer hits 23px exactly, and the desk owes nothing.
       */
      // Doc 21 bans an owner chip from a view surface — it belongs on Settings
      // and Sources — so the audit measuring that acceptance line has to be able
      // to FIND one. The mark is here rather than at each call site because a
      // chip somebody adds tomorrow is exactly the one an audit must catch, and
      // it CARRIES THE PATH (bead `ro-78qo.21`, the contract in
      // `scripts/README.md`): a failure that can only say "some chip is on this
      // page" leaves the operator hunting by eye across the eighteen on
      // /settings.
      data-owner-chip={path}
      /* A LONG REFERENCE WRAPS; IT NEVER WIDENS THE PAGE (bead `ro-ujb9.79`).
       * The path used to be `truncate`, which could never actually truncate:
       * nothing above it could shrink, so its min-content was the whole path
       * and a doc anchor like `docs/11-integrations.md#the-catalog` pushed a
       * phone-width Sources row past the viewport. Now the chip is capped at
       * its container (`max-w-full`), the pill can shrink (`min-w-0`), and the
       * path breaks anywhere — a monospace reference has no spaces to break
       * at. Short paths, and every path on a desk-width screen, still sit on
       * one line exactly as before.
       *
       * `py-2.5` MATCHES THE `-my-2.5` so a WRAPPED chip keeps its own slot. The
       * margin gives back 20px on the assumption that the drawn chip is one
       * line inside a 44px box; a three-line chip is taller than 44px, and
       * without the padding it spilled 10px over the label above it. With it
       * the box is the chip plus 20px, never under 44px, and the row still
       * measures exactly the chip — identical to before for a one-line chip. */
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

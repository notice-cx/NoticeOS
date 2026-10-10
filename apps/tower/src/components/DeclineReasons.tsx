import { X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { DECLINE_REASONS, OWN_REASON_MAX_LENGTH } from "@shared/lane-decline";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

export interface DeclineReasonsProps {
  /** What is being declined, for the group's accessible name. */
  subject: string;
  /** The reason, in the operator's words: a chip's label or their own line.
   * The prefix the register needs is the caller's write, never shown here. */
  onChoose: (reason: string) => void | Promise<void>;
  /** Closes the chips without deciding (the ✕, or Esc). Omitted where closing
   * is some other control's job — the connect panel's checkbox. */
  onCancel?: () => void;
  /** The reason already chosen, drawn filled, so it can be changed in place. */
  selected?: string | null;
  /** A save is in flight: nothing can be pressed twice. */
  busy?: boolean;
  /** Focus the first chip when shown — a press just opened it. */
  autoFocus?: boolean;
}

const PRESETS: readonly string[] = DECLINE_REASONS.map((reason) => reason.label);

/**
 * Why a data source is not used, as one press: the preset reasons as choice
 * chips, and Other for the operator's own line. A chip is the decision; the
 * caller saves it. Nothing is preselected, since a reason the product picked
 * would be a reason nobody gave.
 */
export function DeclineReasons({ subject, onChoose, onCancel, selected = null, busy = false, autoFocus = false }: DeclineReasonsProps) {
  const custom = selected !== null && !PRESETS.includes(selected) ? selected : null;
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(custom ?? "");
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);

  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (typing) setTyping(false);
    else onCancel?.();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const reason = text.trim();
    if (reason === "" || busy) return;
    void onChoose(reason);
    setTyping(false);
  };

  return (
    <div role="group" aria-label={`Why not use ${subject}?`} className="flex min-w-0 flex-wrap items-center gap-2" data-decline-reasons onKeyDown={escape}>
      {DECLINE_REASONS.map((reason, index) => (
        <button
          key={reason.id}
          ref={index === 0 ? first : undefined}
          type="button"
          disabled={busy}
          aria-pressed={selected === reason.label}
          className={cn(pillChoiceClass, pillChoiceStateClass(selected === reason.label), "disabled:opacity-60")}
          onClick={() => void onChoose(reason.label)}
          data-decline-reason={reason.id}
        >
          {reason.label}
        </button>
      ))}
      {typing ? (
        <form className="flex min-w-0 max-w-full flex-1 basis-60 items-center gap-2" onSubmit={submit}>
          <input
            autoFocus
            aria-label="Your reason"
            placeholder="Your reason"
            value={text}
            maxLength={OWN_REASON_MAX_LENGTH}
            onChange={(event) => setText(event.target.value)}
            className={cn(fieldClass, "h-8 min-w-0 flex-1 px-2 text-sm max-sm:h-11")}
            data-decline-own
          />
          <Button type="submit" size="sm" disabled={busy || text.trim() === ""}>
            Save
          </Button>
        </form>
      ) : (
        <button
          type="button"
          disabled={busy}
          aria-pressed={custom !== null}
          className={cn(pillChoiceClass, pillChoiceStateClass(custom !== null), "max-w-full truncate disabled:opacity-60")}
          onClick={() => setTyping(true)}
          data-decline-reason="other"
        >
          {custom ?? "Other…"}
        </button>
      )}
      {onCancel ? (
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Cancel" disabled={busy} onClick={onCancel}>
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export default DeclineReasons;

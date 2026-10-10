import { Clock } from "lucide-react";
import { useState } from "react";
import { proposedTimeZone } from "@noticeos/contract/time-zone-setting";
import type { SettingOp } from "@shared/changeset";
import { localTimezone } from "@shared/scheduled-jobs";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { Button } from "@/components/ui/button";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { type FieldUndoOutcome, useFieldConfigSave } from "@/hooks/useConfigSave";
import { useSettings } from "@/hooks/useSettings";
import { formatZoneName } from "@/lib/format";

/** The same field Settings → General → Time zone saves, so a save here and
 * there is one subject. */
const SUBJECT = "field:Time zone";

/**
 * The clock, proposed from the browser: while nobody has chosen one
 * (`clock.chosen`) and the browser reads another zone, one press saves the
 * browser's, with Undo beside it. Nothing is saved on a page view. Once
 * pressed, the row stays for the visit even though the saved choice now hides
 * the proposal.
 */
export function ClockProposal() {
  const { data } = useSettings();
  const { writable } = useConfigWritable();
  const saveField = useFieldConfigSave();
  const clock = data?.clock;
  const proposal = clock ? proposedTimeZone(clock, localTimezone()) : null;
  // The zone this row offered, kept once pressed: the proposal itself goes
  // away the moment the choice is saved.
  const [offer, setOffer] = useState<string | null>(null);
  // What this row's own save or Undo put in place, until the next read.
  const [inEffect, setInEffect] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "saved"; undo: () => Promise<FieldUndoOutcome>; from: string }
    | { kind: "refused"; refusal: string }
    | null
  >(null);

  const zone = offer ?? proposal;
  if (!clock || zone === null || (offer === null && !writable)) return null;
  const current = inEffect ?? clock.timeZone;

  async function adopt(to: string) {
    const from = current;
    const op: SettingOp = { kind: "file-json-set", file: "config/constants.json", pointer: "/os_time_zone", expect: from, value: to };
    setOffer(to);
    setSaving(true);
    setOutcome(null);
    try {
      const result = await saveField({ ops: [op], slug: "os-time-zone", label: "Time zone" });
      if (!result.saved) {
        setOutcome({ kind: "refused", refusal: result.refusal });
        return;
      }
      setInEffect(to);
      setOutcome({ kind: "saved", undo: result.undo, from });
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== "saved") return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      if (back.undone) {
        setInEffect(outcome.from);
        setOutcome(null);
      } else {
        setOutcome({ kind: "refused", refusal: back.refusal });
      }
    } finally {
      setUndoing(false);
    }
  }

  const save: InlineSave = saving
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };

  return (
    <div
      data-clock-proposal={zone}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-4 text-sm"
    >
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <Clock aria-hidden className="size-4" />
        Timezone
        <span className="font-medium text-foreground" data-clock-in-effect>
          {formatZoneName(current)}
        </span>
      </span>
      {current === zone ? null : (
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void adopt(zone)}>
          Use {formatZoneName(zone)}
        </Button>
      )}
      <InlineSaveState save={save} subject={SUBJECT} />
    </div>
  );
}

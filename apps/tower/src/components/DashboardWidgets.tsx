import { Settings2, X } from "lucide-react";
import { useState } from "react";
import type { CountdownConfig, DashboardRefusal } from "@shared/dashboard";
import type { FileJsonSetOp, JsonValue } from "@shared/changeset";
import { OwnerChip } from "@/components/OwnerChip";
import { CountdownFace } from "@/components/TimeFaces";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useConfigSave, useLandmarkSave } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { toLocalDateTimeInput } from "@/lib/countdown";
import {
  validateCountdownEmoji,
  validateDisplayLabel,
  validateFutureDateTime,
} from "@/lib/knob-validators";
import { cn } from "@/lib/utils";

// The countdown on the desk: its face with the Configure button, and its
// settings form, which Settings and the Wall editor both render. The face
// itself is `TimeFaces.tsx`.

const OWNER = "config/tower.json";
/** The whole countdown at one pointer: the emoji, the words and the moment are
 * one landmark, added and removed together. */
const COUNTDOWN_POINTER = "/countdown";

function configOp(
  pointer: "/countdown/emoji" | "/countdown/label" | "/countdown/targetAt",
  expect: JsonValue,
  value: JsonValue,
): FileJsonSetOp {
  return {
    kind: "file-json-set",
    file: OWNER,
    pointer,
    expect,
    value,
  };
}

/** What of a refused saved countdown still reads, to start the form from:
 * each field that is a string, the moment only when it parses. */
function refusedFields(refused: DashboardRefusal | null): { emoji?: string; label?: string; targetAt?: string } | null {
  const saved = refused?.saved;
  if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return null;
  const { emoji, label, targetAt } = saved as Record<string, unknown>;
  return {
    emoji: typeof emoji === "string" ? emoji : undefined,
    label: typeof label === "string" ? label : undefined,
    targetAt: typeof targetAt === "string" && !Number.isNaN(Date.parse(targetAt)) ? toLocalDateTimeInput(targetAt) : undefined,
  };
}

/**
 * The countdown on the desk: the face every surface draws, plus — with
 * `interactive` — the Configure button in its header and the settings form
 * under its measures. Without `interactive` it is exactly `CountdownFace`.
 */
export function CountdownWidget({
  config,
  nowMs,
  interactive = false,
  statesReadOnly = true,
  className,
}: {
  config: CountdownConfig;
  nowMs: number;
  interactive?: boolean;
  /** Passed to the editor it opens: `false` where the page says once that
   * saves are paused. */
  statesReadOnly?: boolean;
  /** Placement from the page that owns it. */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <CountdownFace
      config={config}
      nowMs={nowMs}
      className={className}
      action={
        interactive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-expanded={editing}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? <X /> : <Settings2 />}
            {editing ? "Close" : "Configure"}
          </Button>
        ) : undefined
      }
      editor={
        interactive && editing ? (
          <CountdownEditor config={config} nowMs={nowMs} statesReadOnly={statesReadOnly} />
        ) : undefined
      }
    />
  );
}

/**
 * The countdown's three settings, saved as one guarded write: the emoji, words
 * and moment describe one landmark, so the set applies whole and Undo restores
 * all three. The fields hold drafts; the widget shows what is configured until
 * the save lands. Exported for the Wall editor's settings pane, so one form
 * owns the three values. A saved countdown the Tower refused starts the form
 * from whatever still reads, and Save replaces it guarded by the stored value.
 */
export function CountdownEditor({
  config,
  refused = null,
  nowMs,
  embedded = false,
  statesReadOnly = true,
}: {
  /** Absent = there is no countdown yet, and this form makes the first one. */
  config?: CountdownConfig;
  /** The saved countdown the Tower refused, when `config` is absent for that
   * reason rather than because nothing is saved. */
  refused?: DashboardRefusal | null;
  nowMs: number;
  /**
   * The frame is already drawn: the Wall editor heads every widget with its
   * name and owning file, so the form omits its own copy of that heading.
   */
  embedded?: boolean;
  /** Whether the form also says why it cannot be saved while saves are paused.
   * A page that says it once passes `false`; Save is dark either way. */
  statesReadOnly?: boolean;
}) {
  const save = useConfigSave();
  const saveLandmark = useLandmarkSave();
  const { writable, reason } = useConfigWritable();
  const stored = config ? null : refusedFields(refused);
  const [emoji, setEmoji] = useState(config?.emoji ?? stored?.emoji ?? "");
  const [label, setLabel] = useState(config?.label ?? stored?.label ?? "");
  const [targetAt, setTargetAt] = useState(() =>
    config ? toLocalDateTimeInput(config.targetAt) : (stored?.targetAt ?? ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Anything saved over a refused countdown is a change: the store holds a
  // value nothing can draw.
  const dirty = config
    ? emoji !== config.emoji ||
      label !== config.label ||
      targetAt !== toLocalDateTimeInput(config.targetAt)
    : refused !== null || emoji !== "" || label !== "" || targetAt !== "";

  function submit() {
    const checkedEmoji = validateCountdownEmoji(emoji);
    if (!checkedEmoji.ok) return setError(checkedEmoji.error);
    const checkedLabel = validateDisplayLabel(label);
    if (!checkedLabel.ok) return setError(checkedLabel.error);
    const checkedTarget = validateFutureDateTime(targetAt, nowMs);
    if (!checkedTarget.ok) return setError(checkedTarget.error);
    setError(null);
    setSaving(true);
    // The first one is an insert of the whole landmark: a fresh config has no
    // `countdown` key, and a set never creates one.
    const value = { emoji: checkedEmoji.value, label: checkedLabel.value, targetAt: checkedTarget.value };
    const write = config
      ? save({
          label: "Countdown",
          slug: "countdown",
          ops: [
            configOp("/countdown/emoji", config.emoji, checkedEmoji.value),
            configOp("/countdown/label", config.label, checkedLabel.value),
            configOp("/countdown/targetAt", config.targetAt, checkedTarget.value),
          ],
        })
      : refused
        ? save({
            label: "Countdown",
            slug: "countdown",
            ops: [{
              kind: "file-json-set",
              file: OWNER,
              pointer: COUNTDOWN_POINTER,
              expect: refused.saved as JsonValue,
              value,
            }],
          })
        : saveLandmark({
          label: "Countdown",
          slug: "countdown",
          op: {
            kind: "file-json-insert",
            file: OWNER,
            pointer: COUNTDOWN_POINTER,
            value,
          },
        });
    void write.finally(() => setSaving(false));
  }

  /** Take the whole landmark away — the exact inverse of the insert above, and
   * the way back out of a countdown that has served its purpose. The Undo in the
   * toast puts it back with the same three values. */
  function remove() {
    const expect = config ? { ...config } : refused ? (refused.saved as JsonValue) : null;
    if (expect === null) return;
    setError(null);
    setSaving(true);
    void saveLandmark({
      label: "Countdown",
      slug: "countdown",
      op: {
        kind: "file-json-delete",
        file: OWNER,
        pointer: COUNTDOWN_POINTER,
        expect,
      },
    }).finally(() => setSaving(false));
  }

  return (
    <div className={cn("flex flex-col gap-2", embedded ? null : "border-t border-border pt-2")}>
      {embedded ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Countdown settings</span>
          <OwnerChip path={OWNER} />
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          Countdown emoji
          <input
            type="text"
            aria-label="Countdown emoji"
            value={emoji}
            disabled={!writable || saving}
            placeholder="🌁"
            onChange={(e) => {
              setEmoji(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className={cn(fieldClass, "w-full")}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          Countdown label
          <input
            type="text"
            aria-label="Countdown label"
            value={label}
            disabled={!writable || saving}
            placeholder="Event or milestone"
            onChange={(e) => {
              setLabel(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className={cn(fieldClass, "w-full")}
          />
        </label>
      </div>
      <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        Target date and time
        <input
          type="datetime-local"
          aria-label="Target date and time"
          value={targetAt}
          disabled={!writable || saving}
          min={toLocalDateTimeInput(nowMs + 60_000)}
          step="60"
          onChange={(e) => {
            setTargetAt(e.target.value);
            setError(null);
          }}
          className={cn(fieldClass, "w-full")}
        />
      </label>
      <span className="text-xs text-muted-foreground">
        This browser's local timezone; every Wall receives the same exact moment.
      </span>
      {error ? <span className="text-xs text-error">{error}</span> : null}
      {writable || !statesReadOnly ? null : (
        <span className="text-xs leading-snug text-muted-foreground" data-knob-read-only>
          {reason ?? CONFIG_READ_ONLY_FALLBACK}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={submit}
          disabled={!writable || saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {config || refused ? (
          // No confirmation: the toast carries the way back, the same landmark
          // with the same three values.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={remove}
            disabled={!writable || saving}
            data-countdown-remove
          >
            Remove countdown
          </Button>
        ) : null}
      </div>
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { Layers, Snowflake } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { FactChip, type FactChoice } from "@/components/FactChip";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { STATE_TONE } from "@/components/StateChip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { useOwnerToast } from "@/lib/browser-context";
import { TASK_STATUSES } from "@/lib/task-board-read";
import { PriorityMark, statusFace } from "@/routes/tasks/task-face";

// FactChip in each of its editor kinds, on invented task facts. Every save
// changes the demo's own state and toasts the Undo the task page carries.

const STATUSES: FactChoice[] = TASK_STATUSES.map((status) => {
  const face = statusFace(status.stored);
  const Icon = face.icon;
  return { value: status.stored, label: status.label, mark: <Icon className={`size-3.5 ${STATE_TONE[face.tone].text}`} /> };
});

const BANDS = ["top", "high", "normal", "low", "lowest"] as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={eyebrowClass}>{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function FactChipDemo() {
  const toast = useOwnerToast();
  const [status, setStatus] = useState("in_progress");
  const [priority, setPriority] = useState(1);
  const [holder, setHolder] = useState("claude");
  const [parent, setParent] = useState("os-8f7p");
  const [parked, setParked] = useState("");
  const face = statusFace(status);
  const Icon = face.icon;

  function saved<T>(what: string, set: (value: T) => void, next: T, before: T): boolean {
    set(next);
    toast.success(`Saved — ${what}`, { action: { label: "Undo", onClick: () => set(before) } });
    return true;
  }

  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      <Fact label="Status">
        <FactChip label="Status" valueText={face.label} editor={{ kind: "choice", value: status, choices: STATUSES }}
          onSave={(next) => saved("status", setStatus, next, status)}>
          <Icon aria-hidden className={`size-3.5 ${STATE_TONE[face.tone].text}`} />
          <span className={STATE_TONE[face.tone].text}>{face.label}</span>
        </FactChip>
      </Fact>
      <Fact label="Priority">
        <FactChip label="Priority" valueText={BANDS[priority] ?? "normal"}
          editor={{ kind: "choice", value: String(priority), choices: BANDS.map((band, index) => ({ value: String(index), label: band, mark: <PriorityMark priority={index} size="chip" hint={false} /> })) }}
          onSave={(next) => saved("priority", setPriority, Number(next), priority)}>
          <PriorityMark priority={priority} size="chip" hint={false} />
          {BANDS[priority]}
        </FactChip>
      </Fact>
      <Fact label="Assignee (choice with a typed value)">
        <FactChip label="Assignee" valueText={holder || "Nobody"} quiet={holder === ""}
          editor={{ kind: "choice", value: holder, choices: [{ value: "claude", label: "claude" }, { value: "codex", label: "codex" }, { value: "", label: "Nobody" }],
            other: { label: "Someone else", placeholder: "A name or an agent" } }}
          onSave={(next) => saved("assignee", setHolder, next, holder)}>
          {holder ? <AgentMark name={holder} models={[holder === "claude" ? "Opus 5.5" : null]} size="small" /> : null}
          <span>{holder || "Nobody"}</span>
        </FactChip>
      </Fact>
      <Fact label="Parent epic (split: link and editor)">
        <FactChip label="Parent epic" valueText={parent || "Hangs off nothing"} quiet={parent === ""} to={parent ? `/tasks/${parent}` : undefined}
          editor={{ kind: "choice", value: parent, choices: [{ value: "os-8f7p", label: "Tasks are managed in the Tower" }, { value: "", label: "No epic" }],
            other: { label: "Another task id", placeholder: "os-…", mono: true } }}
          onSave={(next) => saved("the parent", setParent, next, parent)}>
          {parent ? <Layers aria-hidden className="size-3.5 text-muted-foreground" /> : null}
          {parent === "os-8f7p" ? "Tasks are managed in the Tower" : parent || "Hangs off nothing"}
        </FactChip>
      </Fact>
      <Fact label="Parked until (date)">
        <FactChip label="Parked until" valueText={parked || "Not parked"} quiet={parked === ""}
          editor={{ kind: "date", value: parked, presets: [{ label: "Tomorrow", value: "2026-10-17" }, { label: "In a week", value: "2026-10-23" }], clearLabel: "Not parked" }}
          onSave={(next) => saved("the deferral", setParked, next, parked)}>
          {parked ? <Snowflake aria-hidden className="size-3.5 text-muted-foreground" /> : null}
          <span className="tabular-nums">{parked || "Not parked"}</span>
        </FactChip>
      </Fact>
      <Fact label="Add a label (text)">
        <FactChip label="Add a label" valueText="" quiet className="border-dashed"
          editor={{ kind: "text", value: "", inputLabel: "New label", placeholder: "human, tower, ux…" }}
          onSave={(next) => { toast.success(`Saved — label ${next}`); return true; }}>
          + Label
        </FactChip>
      </Fact>
      <Fact label="Project (link)">
        <FactChip label="Project" valueText="System" to="/tasks?project=system">
          <PropertyFavicon domain="system" displayName="System" className="size-4" />
          System
        </FactChip>
      </Fact>
      <Fact label="Read-only (plain)">
        <FactChip label="Status" valueText="Open" readOnly editor={{ kind: "choice", value: "open", choices: STATUSES }} onSave={() => true}>
          Open
        </FactChip>
      </Fact>
    </div>
  );
}

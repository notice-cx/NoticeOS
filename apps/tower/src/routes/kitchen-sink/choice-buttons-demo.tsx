import { useState, type ReactNode } from "react";
import type { TaskChoiceKey, TaskChoices } from "@noticeos/contract/task-choices";
import { choiceName } from "@noticeos/contract/task-choices";
import { ChoiceButtons } from "@/components/ChoiceButtons";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { useOwnerToast } from "@/lib/browser-context";

// ChoiceButtons with two, three and six invented options, a recorded pick and
// the face a workspace that cannot pick sees. A press toasts the pick with
// the Undo the task page carries and draws it as the record.

const TWO: TaskChoices = {
  question: "Keep the old pricing page live during the switch?",
  options: [
    { key: "a", label: "Keep it live", detail: "Both pages stay up for two weeks.", recommended: true },
    { key: "b", label: "Take it down" },
  ],
};

const THREE: TaskChoices = {
  question: "What happens to the retired recipe page?",
  options: [
    { key: "a", label: "Keep the old page", detail: "It stays reachable at its address; nothing links to it." },
    { key: "b", label: "Redirect to the new page", detail: "A permanent redirect keeps its search traffic.", recommended: true },
    { key: "c", label: "Remove it", detail: "Visitors get a not-found page." },
  ],
};

const SIX: TaskChoices = {
  question: "Which day does the weekly newsletter go out?",
  options: [
    { key: "a", label: "Monday" },
    { key: "b", label: "Tuesday", detail: "Opens were highest on Tuesdays last quarter.", recommended: true },
    { key: "c", label: "Wednesday" },
    { key: "d", label: "Thursday" },
    { key: "e", label: "Friday" },
    { key: "f", label: "Saturday", detail: "Weekend readers only." },
  ],
};

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className={eyebrowClass}>{label}</span>
      {children}
    </div>
  );
}

/** One live set: a press shows the pick as the record, and Undo brings the
 * options back. */
function LiveChoice({ choices }: { choices: TaskChoices }) {
  const toast = useOwnerToast();
  const [picked, setPicked] = useState<TaskChoiceKey | null>(null);
  return (
    <ChoiceButtons
      choices={choices}
      chosen={picked}
      onChoose={(option) => {
        const label = choices.options.find((entry) => entry.key === option)?.label ?? option;
        setPicked(option);
        toast.success(`Chose ${choiceName(option, label)}`, { action: { label: "Undo", onClick: () => setPicked(null) } });
      }}
      footer={
        <>
          <Button type="button" size="sm" variant="outline">Answer</Button>
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground">Dismiss</Button>
        </>
      }
    />
  );
}

export function ChoiceButtonsDemo() {
  return (
    <div className="grid w-full gap-6">
      <Example label="Two options">
        <LiveChoice choices={TWO} />
      </Example>
      <Example label="Three options">
        <LiveChoice choices={THREE} />
      </Example>
      <Example label="Six options">
        <LiveChoice choices={SIX} />
      </Example>
      <Example label="Picked">
        <ChoiceButtons choices={THREE} chosen="b" />
      </Example>
      <Example label="Unavailable">
        <ChoiceButtons choices={TWO} disabledReason="Unavailable in this workspace." />
      </Example>
    </div>
  );
}

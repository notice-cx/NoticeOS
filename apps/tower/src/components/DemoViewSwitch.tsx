import { useId } from "react";
import { VIEW_LIBRARY, type ViewId } from "@shared/views";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useView } from "@/hooks/useView";
import { cn } from "@/lib/utils";

/**
 * The demo visitor's view, one press per view, in the demo bar above every
 * desk page and the TV. The choice is the visitor's own preference
 * (`useView`), so it is kept in their browser and every screen redraws at
 * once. `value` overrides the pressed option where the page draws a view the
 * stored choice does not name (the TV's `?view=` link); `onChosen` runs after
 * a press, after the choice is stored.
 */
export function DemoViewSwitch({ value, onChosen, className }: {
  value?: ViewId;
  onChosen?: (view: ViewId) => void;
  className?: string;
}) {
  const { choice, setChoice } = useView();
  const labelId = useId();
  const pressed = value ?? choice.view;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-demo-view-switch
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
    >
      <span id={labelId} className="sr-only">Your view</span>
      {VIEW_LIBRARY.map((spec) => {
        const on = spec.id === pressed;
        return (
          <button
            key={spec.id}
            type="button"
            aria-pressed={on}
            data-demo-view-option={spec.id}
            onClick={() => {
              setChoice({ view: spec.id, focus: choice.focus });
              onChosen?.(spec.id);
            }}
            className={cn(pillChoiceClass, pillChoiceStateClass(on), "motion-reduce:transition-none")}
          >
            {spec.label}
          </button>
        );
      })}
    </div>
  );
}

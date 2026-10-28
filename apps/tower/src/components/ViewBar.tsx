import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { VIEW_LIBRARY, viewSpec, type ViewId } from "@shared/views";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useView } from "@/hooks/useView";
import { cn } from "@/lib/utils";

/** A purpose preference changes presentation while keeping the current page mounted. */
export function ViewBar({ value, onChosen, className }: {
  value?: ViewId;
  onChosen?: (view: ViewId) => void;
  className?: string;
}) {
  const { choice, setChoice } = useView();
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const selected = value ?? choice.view;
  const spec = viewSpec(selected);
  const choose = (view: ViewId) => {
    setChoice({ view, focus: choice.focus });
    onChosen?.(view);
  };
  return (
    <div data-view-bar className={cn("border-b border-border bg-card px-4 py-2 lg:px-6", className)}>
      <div className="hidden items-center gap-3 md:flex">
        <span id={labelId} className="text-xs font-medium text-muted-foreground">View</span>
        <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1">
          {VIEW_LIBRARY.map((view) => (
            <button key={view.id} type="button" aria-pressed={selected === view.id}
              title={view.detail} onClick={() => choose(view.id)}
              className={cn(pillChoiceClass, pillChoiceStateClass(selected === view.id))}>
              {view.label}
            </button>
          ))}
        </div>
        <p className="ml-auto hidden text-xs text-muted-foreground xl:block">{spec.detail}</p>
      </div>
      <div className="md:hidden">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="min-h-11 w-full justify-between" aria-label={`View: ${spec.label}`}>
              <span><span className="text-muted-foreground">View: </span>{spec.label}</span>
              <ChevronDown className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Choose a view" className="w-80 max-w-[calc(100vw-2rem)] p-1">
            <div role="group" aria-label="Views" className="flex flex-col gap-1">
              {VIEW_LIBRARY.map((view) => (
                <button key={view.id} type="button" aria-pressed={selected === view.id}
                  onClick={() => { choose(view.id); setOpen(false); }}
                  className={cn("flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", selected === view.id && "bg-accent-soft")}>
                  <span className="flex-1"><span className="block text-sm font-medium">{view.label}</span><span className="block text-xs text-muted-foreground">{view.detail}</span></span>
                  {selected === view.id ? <Check className="size-4 text-primary" aria-hidden /> : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

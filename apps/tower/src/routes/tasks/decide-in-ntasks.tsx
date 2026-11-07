import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Where a decision, an approval or a dispute is made while tasks live in
 * Ntasks: the task's own page there, in a new tab (`useNtasksTaskPage`). */
export function DecideInNtasks({ href, label = "Decide in Ntasks", size = "sm", className }: {
  href: string;
  label?: "Decide in Ntasks" | "Dispute in Ntasks";
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <Button asChild size={size} className={className}>
      <a href={href} target="_blank" rel="noopener noreferrer" data-task-action="decide-in-ntasks">
        <ExternalLink aria-hidden />
        {label}
      </a>
    </Button>
  );
}

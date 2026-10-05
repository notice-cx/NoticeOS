import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

// --- what the asset page shows instead of an asset -------------------------
// A detail read that failed is the desk's shared `ReadFailed` (bead
// `ro-ujb9.218`); the id that matched nothing is this page's own.

// --- unknown asset ---------------------------------------------------------
/** The id that matched nothing, and the way back as a button rather than an
 * instruction to go and find it. */
export function NotFound({ id }: { id: string }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="flex flex-col items-start gap-3" data-route-state="not-found">
        <EmptyState title="No such site" hint={<span className="font-mono">{id}</span>} />
        <Button asChild variant="outline" size="sm">
          <Link to="/assets">
            <ArrowLeft className="size-4" />
            All sites
          </Link>
        </Button>
      </div>
    </div>
  );
}

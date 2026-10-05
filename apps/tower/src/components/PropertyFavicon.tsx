import { useDemoReadonly } from '@/lib/browser-context';
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface PropertyFaviconProps {
  domain: string;
  displayName: string;
  className?: string;
}

/**
 * Site identity only. Integration health and alert state stay in their
 * dedicated indicators instead of overloading the asset-name glyph.
 *
 * IT IS DECORATION, AND SAYS SO (bead `ro-hou2`). The wrapper used to carry
 * `title={`${displayName} favicon`}`, and a titled element with no text
 * contributes that title to the accessible NAME of whatever it sits inside
 * (accname step 2I) — so the sidebar's asset row announced as "Example favicon
 * Example", the palette's as "Example favicon Example example.com", and the
 * asset page's heading the same way. The identity was stated twice and the
 * second one said the word "favicon" out loud. Nothing was wrong on screen,
 * which is exactly why it survived until a test tried to name a row by its
 * role.
 *
 * Every one of the twelve call sites draws this glyph BESIDE a visible name —
 * the sidebar and palette rows, alert rows, the asset page's heading, asset
 * cards, Home's assets table, the P&L and provider lists, the task page's
 * project fact, the composer's picker, the settings pickers and the collection
 * editor's key column. So the honest markup is `aria-hidden`: the name is
 * already in the accessible tree, and doc 14's one-representation rule says it
 * belongs there once. The tooltip goes with it — "Example favicon" hovering
 * over the word Example told a sighted reader nothing either.
 *
 * THE ICON IS THE SITE'S OWN (bead `ro-ujb9.118`): every asset's glyph is
 * `https://<domain>/favicon.ico`, the same URL for every site, and a site that
 * serves none draws its initial. The browser's HTTP cache holds it, and the
 * `<img>` keeps its `src` across polls, so a Wall refresh fetches nothing new.
 * No list of particular sites gets an icon of its own shipped with the Tower.
 *
 * A future caller where this glyph is the ONLY identity may not simply drop it
 * in: it would be an unnamed image, which is the opposite defect. Give the
 * asset a visible name beside it, or give that call site its own labelled
 * wrapper — this component stays decoration.
 */
export function PropertyFavicon({
  domain,
  displayName,
  className,
}: PropertyFaviconProps) {
  const demoReadonly = useDemoReadonly();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [domain]);
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center overflow-hidden text-[10px] font-semibold text-muted-foreground",
        className,
      )}
      aria-hidden
      data-property-favicon={domain}
    >
      {failed || demoReadonly ? (
        <span aria-hidden>{initial}</span>
      ) : (
        <img
          src={propertyFaviconUrl(domain)}
          alt=""
          aria-hidden
          className="size-full object-contain"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function propertyFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`;
}

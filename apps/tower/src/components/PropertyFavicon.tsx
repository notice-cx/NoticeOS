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
 * Decoration: it is `aria-hidden` with no title, because every caller draws it
 * beside a visible name. A caller where it is the only identity must add its
 * own label. A site that serves no `/favicon.ico` draws its initial on a muted
 * tile; a site's own icon is drawn bare, so callers pass no background.
 */
export function PropertyFavicon({
  domain,
  displayName,
  className,
}: PropertyFaviconProps) {
  const demoReadonly = useDemoReadonly();
  // The initial holds the place until the icon has loaded, so a site without
  // one never changes and a site with one changes once.
  const [image, setImage] = useState<"loading" | "loaded" | "failed">("loading");
  useEffect(() => setImage("loading"), [domain]);
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
      {image !== "loaded" ? (
        // Drawn, not text: the link it sits in keeps the site's name alone,
        // and the initial is the same element before and after an icon fails.
        <span
          aria-hidden
          data-initial={initial}
          className="grid size-full place-items-center rounded-[22%] bg-muted [grid-area:1/1] before:content-[attr(data-initial)]"
        />
      ) : null}
      {image !== "failed" ? (
        <img
          src={demoReadonly ? demoFaviconUrl(domain) : propertyFaviconUrl(domain)}
          alt=""
          aria-hidden
          className={cn("size-full object-contain [grid-area:1/1]", image === "loaded" ? null : "opacity-0")}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setImage("loaded")}
          onError={() => setImage("failed")}
        />
      ) : null}
    </span>
  );
}

export function propertyFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`;
}

/** A synthetic demo site's icon, served by the Tower itself
 * (`public/demo/favicons`): a demo page never requests another origin. */
export function demoFaviconUrl(domain: string): string {
  return `/demo/favicons/${encodeURIComponent(domain)}.svg`;
}

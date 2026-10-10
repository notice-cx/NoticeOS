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
 * own label. A site that serves no `/favicon.ico` draws its initial.
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

import { useDemoReadonly } from '@/lib/browser-context';
import { useState } from "react";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import { useAppliedTheme, type Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

export interface PropertyFaviconProps {
  domain: string;
  displayName: string;
  /** The icons the site's card carries (`AssetCard.icons`). A caller that
   * holds no card passes nothing and draws `/favicon.ico`. */
  icons?: SiteIcons | null;
  /** The surface's scheme. The Wall passes `dark`, because it is dark on a
   * light desk too; on the desk it follows the theme the page is drawn in. */
  scheme?: Theme;
  className?: string;
}

/**
 * Site identity only. Integration health and alert state stay in their
 * dedicated indicators instead of overloading the asset-name glyph.
 *
 * Decoration: it is `aria-hidden` with no title, because every caller draws it
 * beside a visible name. A caller where it is the only identity must add its
 * own label. It draws the first source that loads (`propertyIconSources`), and
 * the site's initial on a muted tile when none does; a site's own icon is
 * drawn bare, so callers pass no background.
 */
export function PropertyFavicon({
  domain,
  displayName,
  icons,
  scheme,
  className,
}: PropertyFaviconProps) {
  const demoReadonly = useDemoReadonly();
  const applied = useAppliedTheme();
  const sources = demoReadonly
    ? [demoFaviconUrl(domain)]
    : propertyIconSources(domain, icons, scheme ?? applied);
  const chain = sources.join(" ");
  // How far down this chain the drawing is. A new chain (a theme toggle, a new
  // read) starts again at its first source, in the same render.
  const [attempt, setAttempt] = useState({ chain, tried: 0, loaded: false });
  const { tried, loaded } = attempt.chain === chain ? attempt : { tried: 0, loaded: false };
  const src = sources[tried];
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
      {/* The initial holds the place until an icon has loaded, so a site
          without one never changes and a site with one changes once. */}
      {!loaded ? (
        // Drawn, not text: the link it sits in keeps the site's name alone,
        // and the initial is the same element before and after an icon fails.
        <span
          aria-hidden
          data-initial={initial}
          className="grid size-full place-items-center rounded-[22%] bg-muted [grid-area:1/1] before:content-[attr(data-initial)]"
        />
      ) : null}
      {src !== undefined ? (
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden
          className={cn("size-full object-contain [grid-area:1/1]", loaded ? null : "opacity-0")}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setAttempt({ chain, tried, loaded: true })}
          onError={() => setAttempt({ chain, tried: tried + 1, loaded: false })}
        />
      ) : null}
    </span>
  );
}

/**
 * The addresses to try, in order, for one site on one scheme: the icon its
 * pages declare for that scheme, then `/favicon.ico`. A dark surface takes the
 * dark icon and, without one, the light one; a light surface takes only the
 * light one, because a dark-scheme mark is drawn for a dark background.
 */
export function propertyIconSources(
  domain: string,
  icons: SiteIcons | null | undefined,
  scheme: Theme,
): string[] {
  const declared = scheme === "dark" ? (icons?.dark ?? icons?.light) : icons?.light;
  const fallback = propertyFaviconUrl(domain);
  return declared && declared !== fallback ? [declared, fallback] : [fallback];
}

export function propertyFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`;
}

/** A synthetic demo site's icon, served by the Tower itself
 * (`public/demo/favicons`): a demo page never requests another origin. */
export function demoFaviconUrl(domain: string): string {
  return `/demo/favicons/${encodeURIComponent(domain)}.svg`;
}

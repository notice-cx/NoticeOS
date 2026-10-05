import { useOwnerPreferences } from '@/lib/browser-context';
import { ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sitePath } from "@shared/first-run";
import type { AssetCard } from "@shared/wall";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SeverityDot } from "@/components/SeverityDot";
import { PAGE_ITEMS, shownPages } from "@/components/nav-items";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useWall } from "@/hooks/useWall";
import { storageKey } from "@/lib/browser-storage";

/** Where the palette remembers what the operator jumped to last. */
const PALETTE_RECENT_NAME = "palette-recent";
export const PALETTE_RECENT_KEY = storageKey(PALETTE_RECENT_NAME);

/** Five is the list you can take in without reading it — the point of recents. */
const RECENT_LIMIT = 5;

/**
 * A bead id as the operator types it: `ro-d298`, `ro-pbzu.1`. Two to four
 * letters of repo prefix, then digits, letters and dots.
 */
const BEAD_ID = /^[a-z]{2,4}-[a-z0-9.]+$/;

/** cmdk needs one stable, unique string per row; these are also what recents
 * store, so the prefix is what tells a remembered page from a remembered asset. */
function pageValue(label: string): string {
  return `page:${label}`;
}
function assetValue(id: string): string {
  return `asset:${id}`;
}

function readRecent(preferences: ReturnType<typeof useOwnerPreferences>): string[] {
  try {
    const raw = preferences.read(PALETTE_RECENT_NAME);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_LIMIT);
  } catch {
    // A private window, a cleared store, or JSON somebody hand-edited. Recents
    // are a convenience; losing them is not an error worth showing anyone.
    return [];
  }
}

function writeRecent(preferences: ReturnType<typeof useOwnerPreferences>, values: string[]): void {
  try {
    preferences.write(PALETTE_RECENT_NAME, JSON.stringify(values));
  } catch {
    /* storage disabled or full — the palette still works, it just forgets */
  }
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `/dev/kitchen-sink` only: render the box in place, with no portal and no
   * backdrop, so the gallery can show the list beside the shell's own palette.
   * (The ⌘K binding is not this component's: the shell owns it, so the
   * shortcut works before this file has been downloaded — bead `ro-ujb9.84`.)
   */
  inline?: boolean;
  /**
   * `/dev/kitchen-sink` only: the assets to list. Passing them also keeps the
   * gallery off `useWall` entirely — the demo shows a fixture, not the store.
   */
  assets?: AssetCard[];
  /** `/dev/kitchen-sink` only: the query the demo opens with. */
  defaultQuery?: string;
}

/**
 * Go-to-anything for the desk (bead `ro-d298`).
 *
 * [doc 10](../../../docs/10-control-tower.md) principle 4 has named a ⌘K
 * command palette since the Tower was a sketch. Alongside the sidebar,
 * it is the affordance a keyboard operator reaches for first, and
 * the one they reach for most is an asset — which is why assets are a group
 * here rather than a later phase.
 *
 * Scope is NAVIGATION, and only navigation: it moves the operator, it never
 * acts for them. Running commands from the palette (approve, snooze, file) is
 * doc 16's flow L — a larger thing that needs a verb vocabulary and a
 * confirmation story. What ships here is the half that is pure win.
 *
 * `AppShell` mounts it, so it exists on every desk page and on none of `/wall`:
 * the television renders outside the shell, has no keyboard, and stays
 * read-only by construction.
 *
 * IT IS FETCHED ON FIRST OPEN (bead `ro-ujb9.84`): the shell holds the ⌘K
 * binding and the Search button, and draws this — through
 * `lib/palette-launch.tsx` — the first time either is used, so no desk page
 * downloads cmdk before somebody asks for it.
 */
export function CommandPalette({
  open,
  onOpenChange,
  inline = false,
  assets,
  defaultQuery = "",
}: CommandPaletteProps) {
  const [query, setQuery] = useState(defaultQuery);

  // Every open starts from a clean query: the operator pressed ⌘K to go
  // somewhere new, not to resume last time's search.
  useEffect(() => {
    if (open) setQuery(defaultQuery);
  }, [open, defaultQuery]);

  const body =
    assets === undefined ? (
      <LivePaletteBody query={query} onQueryChange={setQuery} onClose={() => onOpenChange(false)} />
    ) : (
      <PaletteBody
        assets={assets}
        query={query}
        onQueryChange={setQuery}
        onClose={() => onOpenChange(false)}
      />
    );

  if (inline) {
    return (
      <Command label="Search pages and sites" className="border border-border">
        {body}
      </Command>
    );
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search pages and sites">
      {body}
    </CommandDialog>
  );
}

interface BodyProps {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

/**
 * The wall read, in its own component on purpose: the shell mounts the palette
 * on every desk page, and a palette nobody has opened must not start a poll.
 * `CommandDialog` renders nothing while closed, so this never mounts until the
 * box is on screen — and the gallery, which hands its own fixture in, never
 * mounts it at all.
 */
function LivePaletteBody(props: BodyProps) {
  const wall = useWall();
  return <PaletteBody assets={wall.data?.assets ?? []} {...props} />;
}

function PaletteBody({
  assets,
  query,
  onQueryChange,
  onClose,
}: BodyProps & { assets: AssetCard[] }) {
  const navigate = useNavigate();
  const preferences = useOwnerPreferences();
  const [recent, setRecent] = useState<string[]>(() => readRecent(preferences));
  const pages = useMemo(() => shownPages(PAGE_ITEMS), []);

  const destinations = useMemo(() => {
    const map = new Map<string, { to: string; label: string }>();
    for (const page of pages) {
      map.set(pageValue(page.label), { to: page.to, label: page.label });
    }
    for (const asset of assets) {
      map.set(assetValue(asset.id), { to: sitePath(asset), label: asset.displayName });
    }
    return map;
  }, [assets, pages]);

  /** Navigate, and remember it — unless it is a task, which is a one-off
   * lookup rather than a place, and would only push real destinations out. */
  const go = useCallback(
    (value: string, to: string, remember = true) => {
      if (remember) {
        const next = [value, ...recent.filter((v) => v !== value)].slice(0, RECENT_LIMIT);
        setRecent(next);
        writeRecent(preferences, next);
      }
      onClose();
      navigate(to);
    },
    [navigate, onClose, recent],
  );

  const trimmed = query.trim();
  // Recents answer "take me back", which is only a question while the operator
  // has not started typing. Once they do, cmdk's scoring is the better answer
  // and a duplicate row above it is noise — so a remembered item is lifted OUT
  // of its own group while it sits in Recent, and never rendered twice.
  const recentItems = trimmed === "" ? recent.filter((value) => destinations.has(value)) : [];
  const recentSet = new Set(recentItems);
  const beadId = BEAD_ID.test(trimmed) ? trimmed : null;

  return (
    <>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search pages and sites…"
      />
      <CommandList>
        {/* A bead id matches no page and no asset by design, and the row it DOES
            produce is force-mounted below — so the empty state would be a lie. */}
        {beadId ? null : <CommandEmpty>No page or site matches.</CommandEmpty>}

        {recentItems.length > 0 ? (
          <CommandGroup heading="Recent">
            {recentItems.map((value) => {
              const destination = destinations.get(value);
              if (!destination) return null;
              const page = pages.find((item) => pageValue(item.label) === value);
              const asset = assets.find((item) => assetValue(item.id) === value);
              return (
                <CommandItem
                  key={value}
                  value={value}
                  keywords={[destination.label]}
                  onSelect={() => go(value, destination.to)}
                >
                  {page ? <page.icon className="size-4" /> : null}
                  {asset ? (
                    <PropertyFavicon domain={asset.id} displayName={asset.displayName} />
                  ) : null}
                  <span className="text-foreground">{destination.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Pages">
          {pages.filter((page) => !recentSet.has(pageValue(page.label))).map((page) => (
            <CommandItem
              key={page.to}
              value={pageValue(page.label)}
              keywords={[page.label, ...(page.keywords ?? [])]}
              onSelect={() => go(pageValue(page.label), page.to)}
            >
              <page.icon className="size-4" />
              <span className="text-foreground">{page.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {assets.length > 0 ? (
          <CommandGroup heading="Sites">
            {assets
              .filter((asset) => !recentSet.has(assetValue(asset.id)))
              .map((asset) => (
                <CommandItem
                  key={asset.id}
                  value={assetValue(asset.id)}
                  keywords={[asset.displayName, asset.id]}
                  onSelect={() => go(assetValue(asset.id), sitePath(asset))}
                >
                  <PropertyFavicon domain={asset.id} displayName={asset.displayName} />
                  <span className="text-foreground">{asset.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{asset.id}</span>
                  {/* Identity is the favicon; a dot appears only for open
                      attention, exactly as on the cards (doc 10 principle 3). */}
                  {asset.worstSeverity === "error" || asset.worstSeverity === "warn" ? (
                    <SeverityDot severity={asset.worstSeverity} size="sm" className="ml-auto" />
                  ) : null}
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}

        {beadId ? (
          // A typed id is a task, and a task has a page (`/tasks/:id`, D19).
          // `forceMount` on both, because cmdk scores a row against the id the
          // operator typed and this row's own words are not that id.
          <CommandGroup heading="Open task" forceMount>
            <CommandItem
              forceMount
              value={`task:${beadId}`}
              onSelect={() => go(`task:${beadId}`, `/tasks/${beadId}`, false)}
            >
              <ListTodo className="size-4" />
              <span className="text-foreground">
                Open task <span className="font-mono">{beadId}</span>
              </span>
              <CommandShortcut>Enter</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  );
}

export default CommandPalette;

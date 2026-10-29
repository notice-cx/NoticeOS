import { useOwnerPreferences } from '@/lib/browser-context';
import { Eye, ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sitePath } from "@shared/first-run";
import { isRetired } from "@shared/asset-setup";
import { VIEW_LIBRARY } from "@shared/views";
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
import { useView } from "@/hooks/useView";
import { useWall } from "@/hooks/useWall";
import { storageKey } from "@/lib/browser-storage";

/** Where the palette remembers what the operator jumped to last. */
const PALETTE_RECENT_NAME = "palette-recent";
export const PALETTE_RECENT_KEY = storageKey(PALETTE_RECENT_NAME);

/** Five is the list you can take in without reading it — the point of recents. */
const RECENT_LIMIT = 5;

/**
 * A task id as the operator types it, e.g. `abc-12x` or `abc-12x.1`: two to
 * four letters of prefix, then digits, letters and dots.
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
    // A private window, a cleared store or hand-edited JSON: recents are a
    // convenience, and losing them is not an error worth showing.
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
   * backdrop. The ⌘K binding belongs to the shell, so it works before this
   * file is downloaded.
   */
  inline?: boolean;
  /** `/dev/kitchen-sink` only: the assets to list. */
  assets?: AssetCard[];
  /** `/dev/kitchen-sink` only: the query the demo opens with. */
  defaultQuery?: string;
}

/**
 * Go-to-anything for the desk. Navigation only: it moves the operator and never
 * acts for them. `AppShell` mounts it on every desk page and never on `/wall`,
 * and fetches it on first open (`lib/palette-launch.tsx`) so no page downloads
 * cmdk before somebody asks for it.
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
      <Command label="Search pages and assets" className="border border-border">
        {body}
      </Command>
    );
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search pages and assets">
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
 * The wall read, in its own component so a palette nobody has opened never
 * starts a poll: `CommandDialog` renders nothing while closed, and the gallery
 * passes its own fixture and never mounts this.
 */
function LivePaletteBody(props: BodyProps) {
  const wall = useWall();
  return <PaletteBody assets={wall.data?.assets ?? []} {...props} />;
}

function PaletteBody({
  assets: allAssets,
  query,
  onQueryChange,
  onClose,
}: BodyProps & { assets: AssetCard[] }) {
  const assets = useMemo(() => allAssets.filter((asset) => !isRetired(asset.status)), [allAssets]);
  const navigate = useNavigate();
  const preferences = useOwnerPreferences();
  const [recent, setRecent] = useState<string[]>(() => readRecent(preferences));
  const pages = useMemo(() => shownPages(PAGE_ITEMS), []);
  const { choice, setChoice } = useView();
  // Switching keeps the person on the page they are on and keeps their picks.
  const otherViews = VIEW_LIBRARY.filter((spec) => spec.id !== choice.view);

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
  // Recents answer "take me back" only until the operator types; after that a
  // remembered item is lifted out of its own group so it never renders twice.
  const recentItems = trimmed === "" ? recent.filter((value) => destinations.has(value)) : [];
  const recentSet = new Set(recentItems);
  const beadId = BEAD_ID.test(trimmed) ? trimmed : null;

  return (
    <>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search pages and assets…"
      />
      <CommandList>
        {/* Every typed query has a task destination, force-mounted below,
            so an empty state would be untrue. */}
        {trimmed ? null : <CommandEmpty>No page or asset matches.</CommandEmpty>}

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
                    <PropertyFavicon domain={asset.id} icons={asset.icons} displayName={asset.displayName} />
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
          <CommandGroup heading="Assets">
            {assets
              .filter((asset) => !recentSet.has(assetValue(asset.id)))
              .map((asset) => (
                <CommandItem
                  key={asset.id}
                  value={assetValue(asset.id)}
                  keywords={[asset.displayName, asset.id]}
                  onSelect={() => go(assetValue(asset.id), sitePath(asset))}
                >
                  <PropertyFavicon domain={asset.id} icons={asset.icons} displayName={asset.displayName} />
                  <span className="text-foreground">{asset.displayName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{asset.id}</span>
                  {/* Identity is the favicon; a dot appears only for open attention. */}
                  {asset.worstSeverity === "error" || asset.worstSeverity === "warn" ? (
                    <SeverityDot severity={asset.worstSeverity} size="sm" className="ml-auto" />
                  ) : null}
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Views">
          {otherViews.map((spec) => (
            <CommandItem
              key={spec.id}
              value={`view:${spec.id}`}
              // The row's shown words, so typing its label ("Switch to")
              // keeps every view row, not only those whose label has an "o".
              keywords={["view", "switch", "to", "switch to", spec.label, spec.detail]}
              onSelect={() => {
                setChoice({ view: spec.id, focus: choice.focus });
                onClose();
              }}
            >
              <Eye className="size-4" />
              <span className="text-foreground">Switch to · {spec.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {beadId ? (
          // A typed id opens its task page. `forceMount` on both, because cmdk
          // scores the row's own words, which are not the typed id.
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
        {trimmed && !beadId ? (
          <CommandGroup heading="Find tasks" forceMount>
            <CommandItem
              forceMount
              value="task-search"
              onSelect={() => go("task-search", `/tasks/all?${new URLSearchParams({ q: trimmed })}`, false)}
            >
              <ListTodo className="size-4" />
              <span className="text-foreground">Search tasks for “{trimmed}”</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  );
}

export default CommandPalette;

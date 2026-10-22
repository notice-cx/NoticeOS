import { useDemoReadonly, useOwnerMutation, useTowerApi } from "@/lib/browser-context";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import type {
  SiteIcons as CardIcons,
  SiteIconsReadRefusal,
  SiteIconsReadResult,
} from "@noticeos/contract/site-icons";
import { changesetSlug } from "@shared/changeset";
import { configRegister, fieldOf } from "@shared/config-registers";
import { ageMs, formatAge } from "@shared/freshness";
import {
  SITE_ICON_KEY,
  siteDisplayChange,
  siteDisplayOf,
  siteIconAddresses,
  type SiteIconScheme,
} from "@shared/site-display";
import { StateChip, type StateTone } from "@/components/StateChip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useStructuralSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useWall } from "@/hooks/useWall";
import { validateRegisterField } from "@/lib/knob-validators";
import { cn } from "@/lib/utils";

/** What the newest read of the home page found, in the card's words. */
type ReadStatus = "read" | "no-icon" | "unreachable" | "never";

const READ_STATUS: Readonly<Record<ReadStatus, { label: string; tone: StateTone }>> = {
  read: { label: "Icons declared", tone: "neutral" },
  "no-icon": { label: "Nothing declared", tone: "na" },
  unreachable: { label: "Page unreachable", tone: "caution" },
  never: { label: "Not read yet", tone: "na" },
};

/** Why a Read again read nothing, in one line beside it. */
const READ_REFUSAL: Readonly<Record<SiteIconsReadRefusal, string>> = {
  paused: "Schedule paused",
  "no-site": "Not read for this asset",
  "not-migrated": "Needs a database update",
  failed: "Read failed · try again",
};

const SCHEMES: readonly SiteIconScheme[] = ["light", "dark"];

type Addresses = Readonly<Record<SiteIconScheme, string | null>>;
const NO_ADDRESSES: Addresses = { light: null, dark: null };

interface ReadState {
  status: ReadStatus;
  /** When the newest read ran; null before the first. */
  at: string | null;
  /** The addresses the newest read that reached the page found. */
  read: Addresses;
}

/** The card's icons as one read state: an unreachable morning names its own
 * time and keeps the addresses read before it. */
function readStateOf(icons: CardIcons | null | undefined): ReadState {
  if (!icons) return { status: "never", at: null, read: NO_ADDRESSES };
  const read = icons.read ?? { light: icons.light, dark: icons.dark };
  if (icons.unreachableAt) return { status: "unreachable", at: icons.unreachableAt, read };
  if (icons.outcome === null || icons.readAt === null) return { status: "never", at: null, read };
  return { status: icons.outcome, at: icons.readAt, read };
}

/** The read a press just stored, over the card's: null when it stored none. */
function pressedState(card: ReadState, answer: SiteIconsReadResult | null): ReadState | null {
  if (answer === null || !answer.ok || answer.outcome === "unmeasured") return null;
  if (card.at !== null && Date.parse(card.at) >= Date.parse(answer.readAt)) return null;
  if (answer.outcome === "unreachable") return { status: "unreachable", at: answer.readAt, read: card.read };
  return { status: answer.outcome, at: answer.readAt, read: { light: answer.light, dark: answer.dark } };
}

/**
 * The site's icons on its Identity card: the light and the dark icon every
 * screen draws, each on a light and a dark swatch; when the home page was last
 * read and what it declared, with Read again; and the two addresses that
 * replace what was read, saved to the site's row of `config/tower.json`
 * `/sites` with Undo. A read-only Tower shows the icons without the fields.
 */
export function SiteIconsSection({ assetId, siteName, nowMs }: { assetId: string; siteName: string; nowMs: number }) {
  const { data } = useWall();
  const { writable } = useConfigWritable();
  const demoReadonly = useDemoReadonly();
  const { readSiteIcons } = useTowerApi();
  const cache = useQueryClient();
  const save = useStructuralSave();
  const [answer, setAnswer] = useState<SiteIconsReadResult | null>(null);
  // An address just saved is drawn until the read that follows its save lands.
  const [asked, setAsked] = useState<Partial<Record<SiteIconScheme, string | null>>>({});

  const display = siteDisplayOf(data);
  const set = siteIconAddresses(display, assetId);
  const setKey = JSON.stringify(set);
  useEffect(() => setAsked({}), [setKey]);

  const readAgain = useOwnerMutation({
    mutationFn: () => readSiteIcons(assetId),
    onSuccess: (result: SiteIconsReadResult) => {
      setAnswer(result);
      void cache.invalidateQueries({ queryKey: ["wall"] });
    },
  });

  if (data === undefined) return null;
  // `?? []`: a poll held from a restart, or a fixture built for another slice,
  // may carry no site list, and a card that threw would take the tab with it.
  const card = readStateOf((data.assets ?? []).find((site) => site.id === assetId)?.icons);
  const shown = pressedState(card, answer) ?? card;
  const status = READ_STATUS[shown.status];
  const register = configRegister("site-display");

  async function saveAddress(scheme: SiteIconScheme, value: string | null): Promise<boolean> {
    const field = fieldOf(register, SITE_ICON_KEY[scheme])!;
    const change = siteDisplayChange(display, assetId, SITE_ICON_KEY[scheme], value);
    if (change.ops.length === 0) return true;
    const landed = await save({
      ops: change.ops,
      undo: change.undo,
      label: `${field.label} for ${siteName}`,
      slug: changesetSlug(assetId, "icon", scheme),
    });
    if (landed) setAsked((current) => ({ ...current, [scheme]: value }));
    return landed;
  }

  return (
    <div className="flex flex-col gap-1 pt-3" data-site-icons={assetId}>
      <SectionLabel title="Icons" />
      <div className="flex flex-wrap items-center gap-2 py-1" data-site-icons-read>
        <StateChip tone={status.tone} label={status.label} subject={`icons:${assetId}`} />
        {shown.at !== null ? (
          <span className="text-xs tabular-nums text-muted-foreground" data-site-icons-read-at>
            Read {formatAge(ageMs(nowMs, shown.at))} ago
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={demoReadonly || readAgain.isPending}
          onClick={() => {
            setAnswer(null);
            readAgain.reset();
            readAgain.mutate();
          }}
        >
          {readAgain.isPending ? "Reading…" : "Read again"}
        </Button>
        <ReadAnswer assetId={assetId} answer={answer} failed={readAgain.isError} />
      </div>
      <div>
        {SCHEMES.map((scheme) => {
          const setHere = scheme in asked ? (asked[scheme] ?? null) : (set[scheme] ?? null);
          return (
            <IconRow
              key={scheme}
              assetId={assetId}
              scheme={scheme}
              label={fieldOf(register, SITE_ICON_KEY[scheme])!.label}
              address={setHere ?? shown.read[scheme]}
              setHere={setHere}
              readAddress={shown.read[scheme]}
              editable={writable}
              onSave={(value) => saveAddress(scheme, value)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** How a press ended when it stored no read, in one line beside Read again. */
function ReadAnswer({ assetId, answer, failed }: { assetId: string; answer: SiteIconsReadResult | null; failed: boolean }) {
  const words = failed
    ? READ_REFUSAL.failed
    : answer === null
      ? null
      : !answer.ok
        ? READ_REFUSAL[answer.error]
        : answer.outcome === "unmeasured"
          ? "No network · nothing read"
          : null;
  if (words === null) return null;
  return (
    <span role="status" data-status-for={`icons-read:${assetId}`} className="text-sm text-warn" data-site-icons-refusal>
      {words}
    </span>
  );
}

/**
 * One scheme's icon: drawn on a light and a dark swatch, its address and
 * where it comes from, and the field that sets an address in place of the
 * read one. An empty field saved takes the set address away.
 */
function IconRow({
  assetId,
  scheme,
  label,
  address,
  setHere,
  readAddress,
  editable,
  onSave,
}: {
  assetId: string;
  scheme: SiteIconScheme;
  label: string;
  /** What every screen draws for this scheme. */
  address: string | null;
  /** The address set here, or null when the read one is drawn. */
  setHere: string | null;
  readAddress: string | null;
  editable: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const fieldId = useId();
  const [draft, setDraft] = useState(setHere ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The address set here moved (this save landed, or another screen saved):
  // the field follows it.
  useEffect(() => {
    setDraft(setHere ?? "");
    setError(null);
  }, [setHere]);
  const field = fieldOf(configRegister("site-display"), SITE_ICON_KEY[scheme])!;
  const dirty = draft.trim() !== (setHere ?? "");

  async function commit() {
    const checked = validateRegisterField(field)(draft);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(typeof checked.value === "string" ? checked.value : null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-0" data-site-icon={scheme}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {editable ? (
          <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
            {label}
          </label>
        ) : (
          <span className="text-sm font-medium text-foreground">{label}</span>
        )}
        <Swatches address={address} />
      </div>
      <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground" data-site-icon-address>
        {address === null ? (
          "None"
        ) : (
          <span className="min-w-0 font-mono break-all">{address}</span>
        )}
        {setHere !== null ? (
          <StateChip tone="neutral" label="Set here" subject={`icons:${assetId}:${scheme}`} />
        ) : null}
      </span>
      {setHere !== null && readAddress !== null ? (
        <span className="text-xs text-muted-foreground" data-site-icon-read-address>
          From the page: <span className="font-mono break-all">{readAddress}</span>
        </span>
      ) : null}
      {editable ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={fieldId}
              type="url"
              inputMode="url"
              value={draft}
              placeholder="https://…"
              disabled={saving}
              aria-invalid={error !== null || undefined}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && dirty) void commit();
              }}
              className={cn(fieldClass, "min-w-0 flex-1 font-mono text-xs")}
            />
            <Button type="button" variant="outline" size="sm" disabled={saving || !dirty} onClick={() => void commit()}>
              Save
            </Button>
          </div>
          {error !== null ? (
            <span role="alert" className="text-xs text-error">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One icon on the white ground and on the Wall's black. */
function Swatches({ address }: { address: string | null }) {
  if (address === null) return null;
  return (
    <span className="inline-flex gap-1.5" data-site-icon-swatches>
      {(["light", "dark"] as const).map((ground) => (
        <span
          key={ground}
          className={cn(
            "grid size-10 place-items-center rounded-md border border-border",
            ground === "light" ? "bg-swatch-light" : "bg-swatch-dark",
          )}
          data-site-icon-swatch={ground}
        >
          {/* Decorative beside its printed address (doc 14). */}
          <img src={address} alt="" aria-hidden className="size-6 object-contain" referrerPolicy="no-referrer" />
        </span>
      ))}
    </span>
  );
}

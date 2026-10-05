import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import {
  type CounterCardDraft,
  type PullFormat,
  counterIssues,
  countersEntryOp,
  isFetchableUrl,
  pullEntryOp,
} from "@shared/asset-wizard";
import { type FileJsonDeleteOp, type JsonValue, toPointer } from "@shared/changeset";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { refreshConfigBackedQueries, useConfigSaveDelay } from "@/hooks/config-backed-queries";
import { refusalMessage, useLandmarkSave, warnConfigExport } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";

import { cn } from "@/lib/utils";
import { Panel } from "@/routes/asset-detail/shared";

// THE DEFAULTS ADD A SITE NO LONGER ASKS, CHANGEABLE HERE (bead
// `ro-ujb9.96.7.5`). The one-screen add writes the wizard's defaults: the
// asset sends its own nightly report, and its card carries no totals. The
// wizard's Data collection step was the only place either could be changed,
// so both come here, beside the rest of the asset's data collection — the same
// inserts the add would have sent (`pullEntryOp`, `countersEntryOp`), through
// the same write lane.

/**
 * An asset that sends its own reports, switched to being fetched: the
 * endpoint the OS reads nightly, and what it answers with. Once saved, the
 * endpoint and its Enabled/Paused switch are the Data collection card's own
 * fields; pausing is the way back.
 */
export function FetchEndpointEditor({ asset }: { asset: string }) {
  const toast = useOwnerToast();
  const { saveConfig } = useTowerApi();
  const queryClient = useQueryClient();
  const delayMs = useConfigSaveDelay();
  const writable = useConfigWritable();
  const urlId = useId();
  const formatId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<PullFormat>("envelope");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const bad = tried && !isFetchableUrl(url);

  async function save() {
    setTried(true);
    if (!writable.writable || !isFetchableUrl(url) || saving) return;
    setSaving(true);
    try {
      warnConfigExport(await saveConfig([pullEntryOp(asset, url, format)], "fetch-endpoint"));
      refreshConfigBackedQueries(queryClient, delayMs);
      toast.success("Saved — Metrics endpoint");
      setOpen(false);
    } catch (error) {
      toast.error(refusalMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="pt-2">
        <Button type="button" variant="outline" size="sm" disabled={!writable.writable} onClick={() => { if (writable.writable) setOpen(true); }} data-fetch-endpoint-open>
          Fetch from an endpoint
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 pt-3"
      noValidate
      data-fetch-endpoint
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={urlId} className="text-sm font-medium">Metrics endpoint</label>
        <input
          id={urlId}
          value={url}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          placeholder="https://example.com/api/metrics"
          aria-invalid={bad ? true : undefined}
          onChange={(event) => setUrl(event.target.value)}
          className={cn(fieldClass, "h-10 w-full px-3 font-mono", bad ? "border-error" : null)}
        />
        {bad ? <p className="m-0 text-xs text-error">A full https:// URL</p> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={formatId} className="text-sm font-medium">Answers with</label>
        <select
          id={formatId}
          value={format}
          onChange={(event) => setFormat(event.target.value === "prometheus" ? "prometheus" : "envelope")}
          className={cn(fieldClass, "h-10 w-full px-3")}
        >
          <option value="envelope">Nightly report envelope</option>
          <option value="prometheus">Prometheus metrics page</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || !writable.writable || url.trim() === ""}>
          {saving ? "Saving" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** One total as `config/counters.json` holds it. */
function storedCards(value: JsonValue | null): CounterCardDraft[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const cards = (value as { cards?: unknown }).cards;
  return Array.isArray(cards)
    ? cards.flatMap((card) => {
      const { metric, label } = (card ?? {}) as { metric?: unknown; label?: unknown };
      return typeof metric === "string" && typeof label === "string" ? [{ metric, label }] : [];
    })
    : [];
}

/**
 * This asset's Overview totals and selected Wall site metrics
 * (`config/counters.json`):
 * none by default, added here as one entry and taken away as one — each with
 * its Undo. Changing them is taking them away and adding the new set, because
 * the entry is written whole.
 */
export function CardTotalsCard({ asset, stored }: { asset: string; stored: JsonValue | null }) {
  const current = storedCards(stored);
  const writable = useConfigWritable();
  const saveLandmark = useLandmarkSave();
  const [draft, setDraft] = useState<CounterCardDraft[] | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const issues = draft ? counterIssues(draft) : [];
  const issueFor = (field: string) => (tried ? issues.find((issue) => issue.field === field)?.message ?? null : null);

  async function add() {
    setTried(true);
    if (draft === null || issues.length > 0) return;
    const op = countersEntryOp(asset, draft);
    if (op === null) return;
    setSaving(true);
    if (await saveLandmark({ op, label: "Card totals", slug: "card-totals" })) {
      setDraft(null);
      setTried(false);
    }
    setSaving(false);
  }

  async function remove() {
    if (stored === null) return;
    const op: FileJsonDeleteOp = { kind: "file-json-delete", file: "config/counters.json", pointer: toPointer(["assets", asset]), expect: stored };
    setSaving(true);
    await saveLandmark({ op, label: "Card totals", slug: "card-totals" });
    setSaving(false);
  }

  return (
    <Panel title="Card totals" count={current.length > 0 ? String(current.length) : undefined}>
      {current.length > 0 ? (
        <div className="flex flex-col gap-2" data-card-totals>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {current.map((card) => (
              <li key={card.metric} className="inline-flex items-baseline gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span className="font-medium">{card.label}</span>
                <code className="font-mono text-xs text-muted-foreground">{card.metric}</code>
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="outline" size="sm" disabled={saving || !writable.writable} onClick={() => void remove()}>
              <Trash2 aria-hidden /> Remove totals
            </Button>
          </div>
        </div>
      ) : draft === null ? (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={!writable.writable} onClick={() => setDraft([{ metric: "", label: "" }])} data-card-totals-add>
            <Plus aria-hidden /> Add totals
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          {draft.map((card, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <TotalField
                id={`counter-metric-${index}`}
                label="Metric"
                value={card.metric}
                placeholder="signups"
                mono
                error={issueFor(`counter-metric-${index}`)}
                onChange={(metric) => setDraft(draft.map((row, i) => (i === index ? { ...row, metric } : row)))}
              />
              <TotalField
                id={`counter-label-${index}`}
                label="Label"
                value={card.label}
                placeholder="Accounts"
                error={issueFor(`counter-label-${index}`)}
                onChange={(label) => setDraft(draft.map((row, i) => (i === index ? { ...row, label } : row)))}
              />
              {draft.length > 1 ? (
                <Button type="button" size="icon" variant="ghost" aria-label={`Remove total ${index + 1}`} onClick={() => setDraft(draft.filter((_, i) => i !== index))}>
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={saving || !writable.writable}>
              {saving ? "Saving" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft([...draft, { metric: "", label: "" }])}>
              <Plus aria-hidden /> Another
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(null); setTried(false); }} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function TotalField({
  id,
  label,
  value,
  placeholder,
  mono = false,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  mono?: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const inputId = `${useId()}-${id}`;
  return (
    <div className="flex min-w-[9rem] flex-1 flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        id={inputId}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(fieldClass, "h-10 w-full px-3", mono ? "font-mono" : null, error ? "border-error" : null)}
      />
      {error ? <p className="m-0 text-xs text-error">{error}</p> : null}
    </div>
  );
}

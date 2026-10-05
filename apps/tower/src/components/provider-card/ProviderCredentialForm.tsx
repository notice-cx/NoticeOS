import { ExternalLink, KeyRound, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { parseFieldValue, type CredentialAssetRow, type IntegrationField, type IntegrationLink } from "@shared/integrations-page";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { messageOf } from "./errors";

// --- the form --------------------------------------------------------------

/**
 * The credential form, rendered from the provider's field schema — never
 * hand-written per provider, so adding a provider to `packages/contract` adds
 * its form here for free (doc 14's crystallization rule).
 *
 * It opens EMPTY every time, including on Reconnect: the API returns no values,
 * so anything pre-filled would be invented. A field the operator leaves blank is
 * omitted from the request rather than sent as an empty string.
 */
export function ProviderCredentialForm({
  providerId,
  fields: declared,
  assetRows = [],
  submitLabel = "Save credential",
  onCancel,
  onSubmit,
}: {
  providerId: string;
  fields: readonly IntegrationField[];
  /** The assets an `asset-map` field draws a row for — the SAME merged list the
   * card lists above it (bead `ro-vu8d.9`), so the form cannot offer a
   * different set of assets from the one the card says are served. Ignored by
   * every other field kind. */
  assetRows?: readonly CredentialAssetRow[];
  /** What the button says. The default is a credential; the Google card's
   * companion form saves an OAuth app, and a button that promised "credential"
   * there would be naming the wrong thing. */
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  // A `managed` field is written by a FLOW, never typed (contract) — today the
  // Google refresh token. Drawing an input for it would invite an operator to
  // paste something that cannot work, and leaving it out is not hiding
  // anything: `StoredFields` above still reports whether the store holds it.
  const fields = declared.filter((field) => field.managed !== true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function submit() {
    const values: Record<string, string> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const raw = drafts[field.name] ?? "";
      if (raw.trim().length === 0) {
        if (field.required) nextErrors[field.name] = "This field is required.";
        continue;
      }
      const parsed = parseFieldValue(field.kind, raw);
      if (parsed.ok) values[field.name] = parsed.value;
      else nextErrors[field.name] = parsed.error;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setFailure(null);
    setSaving(true);
    void (async () => {
      try {
        await onSubmit(values);
      } catch (err) {
        const named = fieldOfRefusal(err);
        if (named) setErrors({ [named]: messageOf(err) });
        else setFailure(messageOf(err));
      } finally {
        setSaving(false);
      }
    })();
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
      data-connect-form={providerId}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          assetRows={assetRows}
          value={drafts[field.name] ?? ""}
          error={errors[field.name] ?? null}
          disabled={saving}
          onChange={(value) => {
            setDrafts((prev) => ({ ...prev, [field.name]: value }));
            setErrors((prev) => {
              if (!(field.name in prev)) return prev;
              const next = { ...prev };
              delete next[field.name];
              return next;
            });
          }}
        />
      ))}
      {failure ? (
        <p className="text-xs text-error" data-connect-failure>
          {failure}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        {/* What happens to what is typed here, once, for every field: the API
            stores it encrypted and never returns it. */}
        <span className="ms-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-connect-trust>
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
          Encrypted · never shown again
        </span>
      </div>
    </form>
  );
}

/** One field, drawn by its kind. Four kinds, four controls, and each says where
 * its value comes from in place (doc 15 principle 9). */
function FieldInput({
  field,
  assetRows = [],
  value,
  error,
  disabled,
  onChange,
}: {
  field: IntegrationField;
  assetRows?: readonly CredentialAssetRow[];
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const multiline = field.kind === "json" || field.kind === "url-list";

  if (field.kind === "asset-map") {
    return (
      <AssetKeyFields
        field={field}
        rows={assetRows}
        error={error}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <FieldHeader field={field} htmlFor={id} />
      {field.kind === "url-list" ? (
        <span className="text-xs text-muted-foreground">
          One per line · <code className="font-mono text-[11px] text-foreground">name = https://…</code>
        </span>
      ) : null}

      {multiline ? (
        <textarea
          id={id}
          rows={field.kind === "json" ? 6 : 3}
          value={value}
          placeholder={field.placeholder}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          data-field={field.name}
          data-field-kind={field.kind}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            fieldClass,
            "w-full font-mono text-xs",
            error ? "border-error" : "border-border",
          )}
          aria-invalid={error ? true : undefined}
          aria-required={field.required}
        />
      ) : (
        <input
          id={id}
          type={field.kind === "password" ? "password" : "text"}
          value={value}
          placeholder={field.placeholder}
          disabled={disabled}
          autoComplete="off"
          data-field={field.name}
          data-field-kind={field.kind}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            fieldClass,
            // A webhook address is far longer than an API key and is the one
            // value here an operator has to proof-read against another screen,
            // so it gets the full width rather than a box it scrolls inside.
            field.kind === "url" ? "w-full font-mono text-xs" : "w-72 max-w-full",
            error ? "border-error" : "border-border",
          )}
          aria-invalid={error ? true : undefined}
          aria-required={field.required}
        />
      )}

      {field.kind === "json" ? (
        <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Upload className="size-3.5" aria-hidden />
          <span>or upload the file</span>
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={disabled}
            data-field-upload={field.name}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset the input so choosing the SAME file twice fires again —
              // the second attempt is usually a corrected file.
              event.target.value = "";
              if (!file) return;
              setFileError(null);
              void readTextFile(file).then(onChange, () =>
                setFileError("That file could not be read."),
              );
            }}
          />
        </label>
      ) : null}

      {fileError ? <span className="text-xs text-error">{fileError}</span> : null}
      {error ? (
        <span className="text-xs text-error" data-field-error={field.name}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A per-asset credential's map: ONE INPUT PER ASSET (bead `ro-vu8d.9`).
 *
 * The stored value is a JSON object of `asset id -> key`, and asking an
 * operator to hand-write that is asking them to make a syntax error around a
 * secret — the same reason the calendar feed map is a line editor rather than a
 * JSON box. So the rows come from the assets the card already lists, the asset
 * ids are printed rather than typed, and this serializes what they filled in.
 *
 * IT OPENS EMPTY, LIKE EVERY OTHER FORM HERE, and a save REPLACES the whole
 * map — the API returns no values, so a pre-filled row would be invented. What
 * the card can honestly show is which assets a key is currently held for, and
 * each row says so beside its input, because "you are about to replace the
 * three you already have" is the one thing an operator needs to know before
 * typing the fourth.
 */
function AssetKeyFields({
  field,
  rows,
  error,
  disabled,
  onChange,
}: {
  field: IntegrationField;
  rows: readonly CredentialAssetRow[];
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const labelId = useId();
  const requirementId = useId();

  function update(asset: string, key: string) {
    const next = { ...keys, [asset]: key };
    setKeys(next);
    const filled = Object.entries(next).filter(([, value]) => value.trim().length > 0);
    onChange(filled.length === 0 ? "" : JSON.stringify(Object.fromEntries(filled)));
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-asset-map={field.name}
      data-field-kind={field.kind}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={field.required ? requirementId : undefined}
    >
      <FieldHeader field={field} labelId={labelId} />
      {field.required ? (
        <span id={requirementId} className="text-xs text-muted-foreground">
          At least one key is required.
        </span>
      ) : null}
      {rows.length === 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-xs" data-asset-map-empty>
          <StateChip tone="na" label="No sites yet" subject="portfolio:sites" />
          <Link to="/assets" className="inline-flex min-h-11 items-center underline underline-offset-4">
            View sites
          </Link>
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-asset-map-replaces>
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            Blank keys are removed on save
          </p>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="w-44 shrink-0 truncate text-xs text-foreground" title={row.id}>
                  {row.id}
                </span>
                <input
                  type="password"
                  value={keys[row.id] ?? ""}
                  placeholder={field.placeholder}
                  disabled={disabled}
                  autoComplete="off"
                  aria-label={`${field.label} — ${row.id}`}
                  aria-describedby={field.required ? requirementId : undefined}
                  data-asset-key-input={row.id}
                  onChange={(event) => update(row.id, event.target.value)}
                  className={cn(
                    fieldClass,
                    "w-64 max-w-full",
                    error ? "border-error" : "border-border",
                  )}
                />
                {row.held ? (
                  <span className="text-xs text-muted-foreground">a key is stored</span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {error ? (
        <span className="text-xs text-error" data-field-error={field.name}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A field's label, where its value comes from and the access it must carry —
 * as a label, a link and chips, never a sentence under the input (bead
 * `ro-ujb9.96.6.1`). The connect panel's layout (bead `ro-ujb9.96.7.1`): the
 * link sits at the end of the label's line; the grants are PostHog's own
 * pattern for a restricted key, listed beside the field.
 */
function FieldHeader({ field, htmlFor, labelId }: { field: IntegrationField; htmlFor?: string; labelId?: string }) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Label {...(htmlFor ? { htmlFor } : {})} id={labelId} className="text-xs font-medium text-foreground">
          {field.label}
          {field.required ? <span className="ml-1" aria-hidden="true">*</span> : null}
        </Label>
        {field.link ? <ProviderLink link={field.link} className="ms-auto" /> : null}
      </div>
      {field.grants && field.grants.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" data-field-grants={field.name} aria-label={`${field.label} access`}>
          {field.grants.map((grant) => (
            <li key={grant}>
              <StateChip tone="neutral" label={grant} glyph={<KeyRound className="size-3" />} subject={`access:${field.name}`} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A pasted service-account JSON usually arrives as a downloaded file, so the
 * upload path is the primary one for that field, not a convenience. */
function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("unreadable"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

// --- refusals --------------------------------------------------------------

/** The field a `422 invalid_credential` named, when it named one, so the reason
 * lands under the input rather than at the bottom of the card. Read
 * structurally rather than with an `instanceof`, so this component never has to
 * import the API layer to render a message. */
function fieldOfRefusal(err: unknown): string | null {
  if (err && typeof err === "object" && "field" in err) {
    const field = (err as { field?: unknown }).field;
    if (typeof field === "string" && field.length > 0) return field;
  }
  return null;
}

/** A deep link into the provider's own screen — where a value is issued, or
 * where a fix is made — in the connect panel's style (bead `ro-ujb9.96.7.1`):
 * the destination's name and the external-link glyph, nothing else. */
export function ProviderLink({ link, className }: { link: IntegrationLink; className?: string }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground max-sm:min-h-11",
        className,
      )}
      data-provider-link
    >
      {link.label}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

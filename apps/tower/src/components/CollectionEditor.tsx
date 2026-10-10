import {
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Loader2,
  Lock,
  Plus,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { FileOp, JsonValue } from "@shared/changeset";
import {
  blankRow,
  candidateRefusal,
  clusterSpellingRefusal,
  collectionColumns,
  collectionRows,
  configRegister,
  duplicateIssue,
  fieldFromDraft,
  fieldRefusal,
  fieldToDraft,
  fixedFieldLabel,
  holderOf,
  rowIssue,
  storedIsScalar,
  storedRow,
  type CollectionRow,
  type CollectionSource,
  type ConfigRegisterKey,
  type RegisterField,
  type RegisterParams,
  type RowIssue,
} from "@shared/config-registers";
import { EmptyState } from "@/components/EmptyState";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCollectionSave, useFieldCollectionSave } from "@/hooks/useCollectionSave";
import type { FieldSaveOutcome, FieldUndoOutcome } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { cn } from "@/lib/utils";

/**
 * An editable table over one list-shaped config register. Everything it draws
 * comes from the register's declaration (`scripts/config-registers.mts`): the
 * columns, the control per field type, the Add form and the refusal wording.
 * It never fetches; rows arrive as a prop from the page's own payload.
 *
 * Invariants it relies on:
 * - Every op addresses a row by its position in the file's array, so filtering
 *   and sorting happen here over `collectionRows`' own tokens, never in a page.
 * - `rows` absent (`null`/`undefined`) means the file has no entry for this
 *   asset; the first Add files the whole entry through `holderOf`. An entry
 *   holding an empty array appends. Loading also presents as absent rows, so
 *   nothing may be added or removed while `loading`.
 * - On a register declaring `emptyIsAbsent`, an empty list is a config error,
 *   so the last row out removes the entry (`unseed`), mirroring `seed`.
 */

/** One computed column. Nothing stores or addresses it. */
export interface DerivedColumn {
  name: string;
  label: string;
  describe?: string;
  render: (row: CollectionRow) => ReactNode;
}

/** From this many rows the table offers a filter, sortable headers and the
 * one-line fold on a phone. */
const NARROWS_FROM = 8;

export interface CollectionEditorProps {
  /** The key in `CONFIG_REGISTERS`. */
  register: ConfigRegisterKey;
  /** The asset a per-asset register is scoped to (`{asset}` in its container). */
  params?: RegisterParams;
  /** The rows as the page's payload holds them: the array for an array
   * register, the keyed object for an object one. */
  rows: CollectionSource;
  /** A shared per-asset holder already exists, but this list may not yet. */
  holderExists?: boolean;
  /** Renders the skeleton and offers no Add or Remove until rows arrive. */
  loading?: boolean;
  /** Overrides the register's own label as the section heading. */
  title?: ReactNode;
  /** Overrides the register's own one-line `describe`. */
  describe?: ReactNode;
  /** What an empty list means here: nothing declared yet, or nothing to declare. */
  emptyHint?: ReactNode;
  /** A subset of the declared fields, in this order. Defaults to all of them. */
  columns?: string[];
  /** Fields offered when creating a row. Defaults to all declared fields. */
  addFields?: string[];
  /**
   * Values a field may take that the declaration cannot know (they live in the
   * store), offered as a picker. Whether a value outside the list is refused is
   * the field's own declaration to say (`candidates`); an empty or absent list
   * means "the page does not know" and refuses nothing.
   */
  fieldOptions?: Readonly<Record<string, readonly string[]>>;
  /** Fires after an add lands, for registers that leave work outside the file. */
  onAdded?: (row: Record<string, JsonValue>) => void;
  /** The row's identity glyph, drawn beside the first (key) column. */
  rowGlyph?: (row: CollectionRow) => ReactNode;
  /** The changeset slug, and the commit subject. */
  slug?: string;
  /**
   * This surface shows one row in a file where membership is an invariant:
   * Add is offered only while the row is missing, and Remove never.
   */
  oneRow?: boolean;
  /** A rule about the list that no single row can express, checked before an
   * Add becomes a request. */
  refuseAdd?: (rows: CollectionRow[]) => string | null;
  /** A per-field rule whose fact lives in a file this component never opens.
   * Checked wherever a value becomes a request: a cell's Save and the Add form. */
  refuseField?: (field: RegisterField, value: JsonValue) => string | null;
  /** Columns the page computes from a row, drawn after the declared ones and
   * never editable. */
  derived?: readonly DerivedColumn[];
  /** Forces the read-only rendering. Defaults to what the deployment answers. */
  readOnly?: boolean;
  /** Whether this editor also states the read-only reason under itself. A
   * surface stacking several editors says it once above them and passes `false`. */
  statesReadOnly?: boolean;
  /**
   * When a cell edit is committed. `save` (the default) keeps a Save beside
   * each cell, Enter included; money registers keep it. `auto` has no Save: a
   * choice saves when picked, a typed value when the cell is left, and Escape
   * restores the stored value. Add and Remove keep their own controls either way.
   */
  commit?: "save" | "auto";
  /** Write the op somewhere else; the component gallery passes a fake. */
  onSave?: (ops: FileOp[]) => Promise<void>;
  className?: string;
}

export function CollectionEditor({
  register: registerKey,
  params = {},
  rows: source,
  loading = false,
  title,
  describe,
  emptyHint,
  columns,
  addFields,
  fieldOptions,
  derived,
  slug,
  oneRow = false,
  refuseAdd,
  refuseField,
  holderExists,
  readOnly,
  statesReadOnly = true,
  commit = "save",
  onSave,
  onAdded,
  rowGlyph,
  className,
}: CollectionEditorProps) {
  const register = configRegister(registerKey);
  const save = useCollectionSave();
  const saveCell = useFieldCollectionSave();
  const { writable, reason } = useConfigWritable();
  const locked = readOnly ?? !writable;

  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Filter and order are browser-only and never reach an op.
  const [narrow, setNarrow] = useState("");
  const [order, setOrder] = useState<{ field: string; descending: boolean } | null>(null);
  // Which rows are open in a folded (narrower than 40rem) table box.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  const declared = collectionColumns(register);
  const fields =
    columns === undefined
      ? declared
      : columns
          .map((name) => declared.find((f) => f.name === name))
          .filter((f): f is RegisterField => f !== undefined);
  const rows = collectionRows(register, source);
  const stored = register.shape === "array" && Array.isArray(source) ? source : [];

  // Why a fixed column cannot be edited, said once per table below `sm`: a
  // phone reaches neither the cell's hover title nor its sr-only text.
  const fixedReasons = [
    ...new Set(
      fields
        .map((field) => fixedFieldLabel(field))
        .filter((label): label is string => label !== null),
    ),
  ];

  // Rows keep the token `collectionRows` gave them from the file's own array;
  // filtering and sorting only choose which to draw and in what order.
  const narrowable = rows.length >= NARROWS_FROM;
  const matching = narrowable ? rows.filter((row) => matches(row, fields, narrow)) : rows;
  const shown = order === null ? matching : sortRows(matching, fields, order);
  // No entry for this asset in the file at all, so the first row files one.
  const unfiled = (source === null || source === undefined) && holderOf(register) !== null;

  // A refetch closes an open Add form: the seed-vs-append decision reads
  // `rows`, and loading presents as absent rows. A render-phase reset, so the
  // affordance cannot be outrun by a click the way an effect can.
  if (loading && adding) setAdding(false);

  /**
   * The declared rules that need the list rather than the row. `token` is the
   * row being edited, whose own spelling cannot clash with itself; `null` from
   * the Add form.
   */
  function listRefusal(field: RegisterField, value: JsonValue, token: string | null) {
    return (
      clusterSpellingRefusal(register, stored, token, field, value) ??
      refuseField?.(field, value) ??
      null
    );
  }

  /**
   * An object row edits the field's own pointer, guarded by that field's
   * previous value. A scalar row has nothing below it to address, and clearing
   * an optional field must remove the key rather than write `null`, so both
   * set the whole row guarded by the whole previous row.
   */
  function editChange(row: CollectionRow, field: RegisterField, value: JsonValue) {
    const scalarRow = storedIsScalar(row.stored);
    const clearing = value === null;
    const whole = scalarRow || clearing;
    return {
      kind: "edit" as const,
      token: row.token,
      field: whole ? null : field.name,
      expect: whole ? row.stored : (row.values[field.name] ?? null),
      value: whole ? storedRow(register, { ...row.values, [field.name]: value }) : value,
    };
  }

  async function commitEdit(
    row: CollectionRow,
    field: RegisterField,
    value: JsonValue,
  ): Promise<FieldSaveOutcome> {
    setPending(row.token);
    try {
      return await saveCell({
        register,
        params,
        change: editChange(row, field, value),
        label: `${register.label} · ${row.key}`,
        slug,
        onSave,
      });
    } finally {
      setPending(null);
    }
  }

  async function commitAdd(draft: Record<string, JsonValue>) {
    const row = storedRow(register, draft);
    setPending("+");
    try {
      const landed = await save({
        register,
        params,
        change: unfiled ? { kind: "seed", row, holderExists } : { kind: "add", row, count: rows.length },
        label: `${register.label} · added`,
        slug,
        onSave,
      });
      if (landed) {
        setAdding(false);
        onAdded?.(draft);
      }
      return landed;
    } finally {
      setPending(null);
    }
  }

  /** Remove a row, or, when it is the last one of an `emptyIsAbsent` register,
   * the asset's whole entry. */
  async function commitRemove(row: CollectionRow) {
    const unseeding = register.emptyIsAbsent === true && rows.length === 1;
    setPending(row.token);
    try {
      const landed = await save({
        register,
        params,
        change: unseeding
          ? { kind: "unseed", rows: stored }
          : { kind: "remove", token: row.token, expect: row.stored },
        label: `${register.label} · ${row.key}`,
        slug,
        onSave,
      });
      if (landed) setConfirming(null);
      return landed;
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className={cn("flex flex-col gap-2", className)}
      data-collection-editor={registerKey}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            {title ?? register.label}
            {locked && !statesReadOnly ? (
              // The page says why once; the table shows the state as a lock.
              <span className="inline-flex items-center text-muted-foreground" data-collection-locked>
                <Lock aria-hidden className="size-3.5" />
                <span className="sr-only">Saves paused</span>
              </span>
            ) : null}
          </h3>
          <span className="text-xs leading-snug text-muted-foreground">
            {describe ?? register.describe}
          </span>
        </div>
      </div>

      {fixedReasons.length > 0 && !locked ? (
        <p
          className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground sm:hidden"
          data-collection-fixed-note
        >
          <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>{fixedReasons.join(" · ")}</span>
        </p>
      ) : null}

      {loading ? (
        <SkeletonTable fields={fields} />
      ) : rows.length === 0 && !adding ? (
        <EmptyState size="sm" title="None yet" hint={emptyHint} />
      ) : (
        <div className="flex flex-col gap-2">
          {narrowable ? (
            <NarrowBox
              label={register.label}
              value={narrow}
              shown={shown.length}
              total={rows.length}
              onChange={setNarrow}
            />
          ) : null}
          {narrowable && shown.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-collection-none>
              No results for {JSON.stringify(narrow)}. Clear the filter to see all {rows.length} entries.
            </p>
          ) : (
        <>
          <Table stacked>
            <TableHeader>
              <TableRow>
                {fields.map((field) => (
                  <TableHead key={field.name} title={field.describe} aria-sort={ariaSort(order, field.name)}>
                    {narrowable ? (
                      <SortButton
                        label={field.label}
                        order={order?.field === field.name ? order : null}
                        onSort={() => setOrder(nextOrder(order, field.name))}
                      />
                    ) : (
                      field.label
                    )}
                  </TableHead>
                ))}
                {(derived ?? []).map((column) => (
                  <TableHead key={column.name} title={column.describe}>
                    {column.label}
                  </TableHead>
                ))}
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <Row
                  key={row.token}
                  row={row}
                  fields={fields}
                  derived={derived}
                  folds={narrowable}
                  open={opened.has(row.token)}
                  onToggle={() =>
                    setOpened((was) => {
                      const next = new Set(was);
                      if (!next.delete(row.token)) next.add(row.token);
                      return next;
                    })
                  }
                  fieldOptions={fieldOptions}
                  refuseField={(field, value) => listRefusal(field, value, row.token)}
                  glyph={rowGlyph?.(row)}
                  locked={locked}
                  removable={!oneRow}
                  saving={pending === row.token}
                  confirming={confirming === row.token}
                  onConfirm={() => setConfirming(row.token)}
                  onCancelConfirm={() => setConfirming(null)}
                  commit={commit}
                  onEdit={(field, value) => commitEdit(row, field, value)}
                  onRemove={() => commitRemove(row)}
                />
              ))}
            </TableBody>
          </Table>
        </>
          )}
        </div>
      )}

      {locked ? (
        statesReadOnly ? (
          <span className="text-xs leading-snug text-muted-foreground" data-collection-read-only>
            {reason ?? CONFIG_READ_ONLY_FALLBACK}
          </span>
        ) : null
      ) : loading ? null : oneRow && rows.length > 0 ? null : adding ? (
        <AddRow
          fields={addFields === undefined ? declared : declared.filter((field) => addFields.includes(field.name))}
          fieldOptions={fieldOptions}
          refuseField={(field, value) => listRefusal(field, value, null)}
          saving={pending === "+"}
          duplicate={(draft) => duplicateIssue(register, stored, storedRow(register, draft))}
          refuse={(draft) => {
            // The list's own rule first: when there is no room, naming a
            // missing field would send the operator to fix the wrong thing.
            const full = refuseAdd?.(rows) ?? null;
            return full !== null ? { field: null, message: full } : rowIssue(register, storedRow(register, draft));
          }}
          blank={blankRow(register)}
          onCancel={() => setAdding(false)}
          onAdd={commitAdd}
        />
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="size-3.5" />
            Add
          </Button>
        </div>
      )}
    </section>
  );
}

// --- one row ---------------------------------------------------------------

function Row({
  row,
  fields,
  derived,
  folds = false,
  open = false,
  onToggle,
  fieldOptions,
  refuseField,
  glyph,
  locked,
  removable,
  saving,
  confirming,
  onConfirm,
  onCancelConfirm,
  commit,
  onEdit,
  onRemove,
}: {
  row: CollectionRow;
  fields: RegisterField[];
  derived?: readonly DerivedColumn[];
  /** In a narrow box, this row is one summary line until it is opened. */
  folds?: boolean;
  open?: boolean;
  onToggle?: () => void;
  fieldOptions?: Readonly<Record<string, readonly string[]>>;
  refuseField?: (field: RegisterField, value: JsonValue) => string | null;
  glyph?: ReactNode;
  locked: boolean;
  removable: boolean;
  saving: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  commit: "save" | "auto";
  onEdit: (field: RegisterField, value: JsonValue) => Promise<FieldSaveOutcome>;
  onRemove: () => Promise<boolean>;
}) {
  const folded = folds && !open;
  return (
    <TableRow
      data-collection-row={row.key}
      foldedWhenStacked={folded}
      className={cn(saving && "opacity-60")}
    >
      {folds ? (
        <TableCell
          onlyWhenStacked
          className="p-0"
          data-collection-summary={row.key}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {glyph === undefined ? null : <span className="shrink-0">{glyph}</span>}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {row.key}
            </span>
            {fields[1] === undefined ? null : (
              <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                {displayValue(fields[1], row.values[fields[1].name] ?? null)}
              </span>
            )}
            <ChevronDown
              aria-hidden
              className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-180")}
            />
          </button>
        </TableCell>
      ) : null}
      {fields.map((field, index) => (
        <TableCell
          key={field.name}
          label={field.label}
          className="align-top"
          foldWhenStacked={folds}
        >
          <div className="flex items-start gap-2">
            {index === 0 && glyph ? <span className="mt-1.5 shrink-0">{glyph}</span> : null}
            <Cell
              rowKey={row.key}
              field={field}
              value={row.values[field.name] ?? null}
              options={fieldOptions?.[field.name]}
              refuse={refuseField}
              locked={locked}
              commit={commit}
              onCommit={(value) => onEdit(field, value)}
            />
          </div>
        </TableCell>
      ))}
      {(derived ?? []).map((column) => (
        <TableCell
          key={column.name}
          label={column.label}
          className="align-top text-sm text-foreground"
          foldWhenStacked={folds}
          data-collection-derived={column.name}
        >
          {column.render(row)}
        </TableCell>
      ))}
      <TableCell className="align-top" foldWhenStacked={folds}>
        {locked || !removable ? null : confirming ? (
          <div className="flex items-center gap-1" data-collection-confirm={row.key}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                void onRemove();
              }}
              aria-label={`Remove ${row.key}`}
            >
              <Check aria-hidden className="size-3.5 text-error" />
              {saving ? "Removing…" : "Remove"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={onCancelConfirm}
              aria-label={`Keep ${row.key}`}
            >
              <Undo2 aria-hidden className="size-3.5" />
              Keep
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onConfirm}
            aria-label={`Remove ${row.key}…`}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

// --- narrowing a long register ---------------------------------------------

/** The filter box. It says how many rows it draws out of how many the file
 * holds, so a narrowed table never looks like a shrunken one. */
function NarrowBox({
  label,
  value,
  shown,
  total,
  onChange,
}: {
  label: string;
  value: string;
  shown: number;
  total: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-collection-narrow>
      <div className="relative min-w-0 flex-1 sm:max-w-64">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={value}
          aria-label={`Filter ${label.toLowerCase()}`}
          placeholder={`Filter ${label.toLowerCase()}`}
          onChange={(e) => onChange(e.target.value)}
          className={cn(fieldClass, "w-full pl-7")}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {shown === total ? `${total} rows` : `${shown} of ${total}`}
      </span>
    </div>
  );
}

/** A column heading that orders the table: file order → up → down → file order. */
function SortButton({
  label,
  order,
  onSort,
}: {
  label: string;
  order: { descending: boolean } | null;
  onSort: () => void;
}) {
  const Glyph = order === null ? ChevronsUpDown : order.descending ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      onClick={onSort}
      className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <Glyph
        aria-hidden
        className={cn("size-3", order === null ? "opacity-40" : "text-foreground")}
      />
    </button>
  );
}

function nextOrder(
  order: { field: string; descending: boolean } | null,
  field: string,
): { field: string; descending: boolean } | null {
  if (order === null || order.field !== field) return { field, descending: false };
  return order.descending ? null : { field, descending: true };
}

function ariaSort(
  order: { field: string; descending: boolean } | null,
  field: string,
): "ascending" | "descending" | "none" | undefined {
  if (order === null || order.field !== field) return undefined;
  return order.descending ? "descending" : "ascending";
}

/** Searches the key and every declared column; a derived column is not
 * searched, because matching it would depend on the page's formatting. */
function matches(row: CollectionRow, fields: RegisterField[], query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  if (row.key.toLowerCase().includes(text)) return true;
  return fields.some((field) =>
    displayValue(field, row.values[field.name] ?? null)
      .toLowerCase()
      .includes(text),
  );
}

/** A number sorts as a number, everything else as the text the cell shows. A
 * row missing the value sorts last in both directions. */
function sortRows(
  rows: CollectionRow[],
  fields: RegisterField[],
  order: { field: string; descending: boolean },
): CollectionRow[] {
  const field = fields.find((f) => f.name === order.field);
  if (field === undefined) return rows;
  const numeric = field.type === "number" || field.type === "integer";
  const key = (row: CollectionRow) => row.values[field.name] ?? null;
  return [...rows].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    const cmp = numeric
      ? Number(left) - Number(right)
      : displayValue(field, left).localeCompare(displayValue(field, right));
    return order.descending ? -cmp : cmp;
  });
}

// --- one editable cell -----------------------------------------------------

/** The stored value under a lock where it cannot be edited (a locked
 * deployment, or a field the declaration fixes), otherwise `InlineCell`. */
function Cell({
  rowKey,
  field,
  value,
  options,
  refuse,
  locked,
  commit,
  onCommit,
}: {
  rowKey: string;
  field: RegisterField;
  value: JsonValue;
  options?: readonly string[];
  refuse?: (field: RegisterField, value: JsonValue) => string | null;
  locked: boolean;
  commit: "save" | "auto";
  onCommit: (value: JsonValue) => Promise<FieldSaveOutcome>;
}) {
  if (locked) {
    return <span className="text-sm text-foreground">{displayValue(field, value)}</span>;
  }

  // A key the declaration fixes: the Add form still asks for it, a row never offers it.
  if (field.readOnly === true) {
    const why = fixedFieldLabel(field) ?? undefined;
    return (
      <span
        className="flex items-baseline gap-1.5"
        data-collection-fixed={field.name}
        title={why}
      >
        <span className="text-sm text-foreground">{displayValue(field, value)}</span>
        <Lock aria-hidden className="size-3 shrink-0 self-center text-muted-foreground" />
        <span className="sr-only">{why}</span>
      </span>
    );
  }

  return (
    <InlineCell
      rowKey={rowKey}
      field={field}
      value={value}
      options={options}
      refuse={refuse}
      commit={commit}
      onCommit={onCommit}
    />
  );
}

/**
 * One editable cell, its outcome said under it. What landed stays on screen
 * until the page's read catches up: otherwise the cell would flick back to the
 * old value for the second a refresh takes, and a blur in that second would
 * send the same edit again against a stale guard.
 */
function InlineCell({
  rowKey,
  field,
  value,
  options,
  refuse,
  commit: when,
  onCommit,
}: {
  rowKey: string;
  field: RegisterField;
  value: JsonValue;
  options?: readonly string[];
  refuse?: (field: RegisterField, value: JsonValue) => string | null;
  commit: "save" | "auto";
  onCommit: (value: JsonValue) => Promise<FieldSaveOutcome>;
}) {
  const auto = when === "auto";
  const listId = useId();
  const current = fieldToDraft(value);
  // What a save or its Undo just wrote, while the read still says otherwise.
  const [landed, setLanded] = useState<{ draft: string; while: string } | null>(null);
  if (landed !== null && landed.while !== current) setLanded(null);
  const effective = landed !== null && landed.while === current ? landed.draft : current;

  const [draft, setDraft] = useState(effective);
  const [seed, setSeed] = useState(effective);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "saved"; undo: () => Promise<FieldUndoOutcome>; from: string }
    | { kind: "refused"; refusal: string }
    | null
  >(null);

  if (seed !== effective) {
    setSeed(effective);
    setDraft(effective);
    setError(null);
  }

  const choice = field.type === "enum" || field.type === "boolean";

  async function commit(next: string) {
    if (committing || next === effective) return;
    const parsed = fieldFromDraft(field, next);
    const refusal =
      fieldRefusal(field, parsed) ??
      candidateRefusal(field, options, parsed) ??
      refuse?.(field, parsed) ??
      null;
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setError(null);
    setOutcome(null);
    setCommitting(true);
    const from = effective;
    try {
      const result = await onCommit(parsed);
      if (!result.saved) {
        setOutcome({ kind: "refused", refusal: result.refusal });
        // A refused pick goes back to what is stored; a refused draft stays
        // so it can be corrected.
        if (choice && auto) setDraft(effective);
        return;
      }
      setOutcome({ kind: "saved", undo: result.undo, from });
      setLanded({ draft: fieldToDraft(parsed), while: current });
    } finally {
      setCommitting(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== "saved") return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      if (back.undone) {
        setLanded({ draft: outcome.from, while: current });
        setDraft(outcome.from);
        setOutcome(null);
      } else {
        setOutcome({ kind: "refused", refusal: back.refusal });
      }
    } finally {
      setUndoing(false);
    }
  }

  const save: InlineSave = committing
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };

  const dirty = draft !== effective;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-collection-cell={field.name}>
      <div className="flex items-center gap-1">
      {choice ? (
        <select
          value={draft}
          disabled={committing || undoing}
          aria-label={field.label}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            if (auto) void commit(e.target.value);
          }}
          className={fieldClass}
        >
          {field.type === "boolean" ? (
            <>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </>
          ) : (
            <>
              {!field.required ? <option value="" /> : null}
              {(field.values ?? []).map((option) => (
                <option key={option} value={option}>
                  {optionLabel(field, option)}
                </option>
              ))}
            </>
          )}
        </select>
      ) : (
        <>
          <input
            type={inputType(field)}
            inputMode={field.type === "number" || field.type === "integer" ? "decimal" : undefined}
            value={draft}
            disabled={committing || undoing}
            aria-label={field.label}
            list={options === undefined ? undefined : listId}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={auto ? () => void commit(draft) : undefined}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit(draft);
              } else if (e.key === "Escape" && auto) {
                setDraft(effective);
                setError(null);
              }
            }}
            className={cn(
              fieldClass,
              "w-full min-w-24",
              error ? "border-error" : "border-border",
            )}
            aria-invalid={error ? true : undefined}
          />
          <OptionList id={listId} options={options} />
        </>
      )}
      {auto ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={committing || undoing || !dirty}
          onClick={() => void commit(draft)}
        >
          Save
        </Button>
      )}
      </div>
      {error ? <span className="text-xs text-error">{error}</span> : null}
      <InlineSaveState save={save} subject={`field:${rowKey}:${field.name}`} />
    </div>
  );
}

// --- the Add form ----------------------------------------------------------

/** Built from the same field list the columns are. Refuses inline, so an
 * invalid row never becomes a request. */
function AddRow({
  fields,
  fieldOptions,
  refuseField,
  blank,
  saving,
  duplicate,
  refuse,
  onAdd,
  onCancel,
}: {
  fields: RegisterField[];
  fieldOptions?: Readonly<Record<string, readonly string[]>>;
  refuseField?: (field: RegisterField, value: JsonValue) => string | null;
  blank: Record<string, JsonValue>;
  saving: boolean;
  duplicate: (draft: Record<string, JsonValue>) => RowIssue | null;
  refuse: (draft: Record<string, JsonValue>) => RowIssue | null;
  onAdd: (draft: Record<string, JsonValue>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const listId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, fieldToDraft(blank[f.name] ?? null)])),
  );
  // The `defaultFrom` fields still following their source. A field leaves this
  // set the moment it is typed into, so an overruled default never comes back.
  const [mirroring, setMirroring] = useState<ReadonlySet<string>>(
    () => new Set(fields.filter((f) => f.defaultFrom !== undefined).map((f) => f.name)),
  );
  // The refusal under the form; only the one field it names is outlined.
  const [error, setError] = useState<RowIssue | null>(null);

  function type(field: RegisterField, value: string) {
    const next = { ...draft, [field.name]: value };
    for (const other of fields) {
      if (other.defaultFrom === field.name && mirroring.has(other.name)) next[other.name] = value;
    }
    if (mirroring.has(field.name)) {
      const kept = new Set(mirroring);
      kept.delete(field.name);
      setMirroring(kept);
    }
    setDraft(next);
    setError(null);
  }

  function parsed(): Record<string, JsonValue> {
    return Object.fromEntries(fields.map((f) => [f.name, fieldFromDraft(f, draft[f.name] ?? "")]));
  }

  function submit() {
    const row = parsed();
    const refusal =
      refuse(row) ??
      fields.reduce<RowIssue | null>((found, f) => {
        if (found !== null) return found;
        const message =
          candidateRefusal(f, fieldOptions?.[f.name], row[f.name] ?? null) ??
          refuseField?.(f, row[f.name] ?? null) ??
          null;
        return message === null ? null : { field: f.name, message };
      }, null) ??
      duplicate(row);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setError(null);
    void onAdd(row);
  }

  function refused(field: RegisterField): boolean {
    return error !== null && error.field === field.name;
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      data-collection-add
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        {fields.map((field) => (
          <label key={field.name} className="flex min-w-40 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center text-xs font-medium text-foreground">
              {field.label}
              {field.required ? null : (
                <span className="ml-1 font-normal text-muted-foreground">optional</span>
              )}
              {field.readOnly === true ? (
                <span
                  className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap font-normal text-muted-foreground"
                  data-collection-add-fixed={field.name}
                >
                  <Lock aria-hidden className="size-3 shrink-0" />
                  {fixedFieldLabel(field)}
                </span>
              ) : null}
            </span>
            {field.type === "enum" || field.type === "boolean" ? (
              <select
                value={draft[field.name] ?? ""}
                aria-label={field.label}
                aria-invalid={refused(field) || undefined}
                aria-describedby={refused(field) ? errorId : undefined}
                disabled={saving}
                onChange={(e) => type(field, e.target.value)}
                className={cn(fieldClass, refused(field) ? "border-error" : null)}
              >
                {field.type === "boolean" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : (
                  <>
                    <option value="" />
                    {(field.values ?? []).map((option) => (
                      <option key={option} value={option}>
                        {optionLabel(field, option)}
                      </option>
                    ))}
                  </>
                )}
              </select>
            ) : (
              <>
                <input
                  type={inputType(field)}
                  value={draft[field.name] ?? ""}
                  aria-label={field.label}
                  aria-invalid={refused(field) || undefined}
                  aria-describedby={refused(field) ? errorId : undefined}
                  disabled={saving}
                  list={fieldOptions?.[field.name] === undefined ? undefined : `${listId}-${field.name}`}
                  onChange={(e) => type(field, e.target.value)}
                  className={cn(fieldClass, refused(field) ? "border-error" : "border-border")}
                />
                <OptionList
                  id={`${listId}-${field.name}`}
                  options={fieldOptions?.[field.name]}
                />
              </>
            )}
            <span className="text-[11px] leading-snug text-muted-foreground">
              {field.describe}
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <span id={errorId} className="text-xs text-error" role="alert">
          {error.message}
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={saving}>
          {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
          {saving ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- the loading state -----------------------------------------------------

function SkeletonTable({ fields }: { fields: RegisterField[] }) {
  return (
    <div data-collection-loading>
      <Table stacked>
        <TableHeader>
          <TableRow>
            {fields.map((field) => (
              <TableHead key={field.name}>{field.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[0, 1, 2].map((n) => (
            <TableRow key={n}>
              {fields.map((field) => (
                <TableCell key={field.name} label={field.label}>
                  <span className="block h-4 w-full max-w-32 rounded bg-muted" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// --- the values only the page knows ----------------------------------------

/** A `datalist` rather than a `select`: a closed domain still has to refuse a
 * pasted value, and an open one is meant to be typed past. */
function OptionList({ id, options }: { id: string; options?: readonly string[] }) {
  if (options === undefined || options.length === 0) return null;
  return (
    <datalist id={id} data-collection-options={id}>
      {options.map((option) => (
        <option key={option} value={option} />
      ))}
    </datalist>
  );
}

// --- a control for a field -------------------------------------------------
// Draft <-> value conversion is `fieldFromDraft` / `fieldToDraft` in the
// declaration, beside the refusal that judges the result.

function inputType(field: RegisterField): string {
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "date") return "date";
  if (field.type === "url") return "url";
  return "text";
}

function displayValue(field: RegisterField, value: JsonValue): string {
  if (value === null || value === undefined) return "—";
  if (field.type === "boolean") return value === true ? "Yes" : "No";
  return typeof value === "string" ? optionLabel(field, value) : fieldToDraft(value);
}

function optionLabel(field: RegisterField, value: string): string {
  return field.valueLabels?.[value] ?? value;
}

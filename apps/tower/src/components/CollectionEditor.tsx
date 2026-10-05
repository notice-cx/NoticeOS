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
 * ONE LIST-SHAPED CONFIG REGISTER, EDITABLE (bead `ro-x5gu.1`).
 *
 * KnobEditor made a single setting two-way (D18); this is its plural. Epic
 * `ro-x5gu` puts a CRUD surface on every register at once — the recurring costs
 * and domain orders on /financials, an asset's GA4 value events and tracked
 * queries on its own tabs, the task-hub map and the data-source catalog on
 * /settings — and without one primitive each of those five surfaces would have
 * invented its own table, its own Add form, its own confirm and its own idea of
 * what a valid row is.
 *
 * IT KNOWS NOTHING ABOUT ANY REGISTER. Everything it renders comes from the
 * declaration in `scripts/config-registers.mjs` — the columns are the declared
 * fields in declared order, the control is chosen by the field's TYPE, the Add
 * form is built from the same list, and a refusal is the same sentence the write
 * lane would have answered with. So a register gains a column by gaining a
 * field, and no component changes.
 *
 * IT BORROWS KNOBEDITOR'S SEMANTICS RATHER THAN INVENTING ANY (doc 14): a cell
 * buffers a draft and commits it with Save (or Enter) — or, with
 * `commit="auto"`, as it is left or picked — an invalid draft never becomes a
 * request and says why under the input in `error` ink with an `error` border,
 * the outcome and its Undo are said under the cell (`InlineSaveState`, bead
 * `ro-ujb9.96.7.12`) rather than a confirm before the fact, and an unavailable
 * configuration store renders the whole table read-only with the lane's own
 * sentence. The one thing it adds is REMOVE, which is not invertible in place —
 * so it, alone, asks first, and its Undo rides the toast because the row it
 * was beside is gone.
 *
 * ONE ACTION, ONE GUARDED WRITE. Every Save goes through `useCollectionSave`, which
 * builds the op and its exact inverse from the same row — and the inverse of a
 * removal puts the row back WHERE IT WAS (bead `ro-asj9`), because a delete
 * splices and an undo that could only append would leave the neighbours in an
 * order nothing had asked for.
 *
 * ABSENCE AND EMPTINESS ARE DIFFERENT STATES of a per-asset list, and the first
 * Add is where that shows. `rows` arriving as `null`/`undefined` means the file
 * has no entry for this asset at all — the common case in every per-asset
 * register, since absence is "not declared" by design — and a pointer never
 * creates structure, so the first row files the asset's whole ENTRY through the
 * holder register beside the list (`holderOf`). An entry that exists and holds
 * an empty array appends normally. Both are one op, and both undo exactly.
 *
 * WHICH IS WHY LOADING IS A THIRD STATE, and offers nothing (bead `ro-x5gu.9`).
 * A page still fetching also has no rows, and the two are indistinguishable from
 * here — so an Add pressed during the fetch would file an asset's whole entry
 * against a file that may already hold one. It fails safely (the lane refuses an
 * insert at a key that exists) but the refusal is the operator meeting a race
 * rather than a rule, so the skeleton owns the whole surface: no Add below it,
 * no rows to Remove, and an Add form already open closes if a refetch starts.
 *
 * FOR SOME FILES THERE IS NO EMPTY STATE, and then the mirror is true too (bead
 * `ro-x5gu.4`): a register declaring `emptyIsAbsent` says an entry holding an
 * empty list is a CONFIG ERROR there rather than a declaration of nothing —
 * `config/serp-panel.json` refuses `queries: []` and skips an absent asset
 * silently — so the LAST row out takes the entry with it (`unseed`), exactly as
 * the first row in filed it. Which files those are is the declaration's to say,
 * not this component's; a register without the flag removes rows and leaves an
 * empty list behind, which is the right answer for a list that CAN be empty.
 *
 * IT DOES NOT FETCH. Rows arrive as a prop, from whatever payload the page
 * already reads, so this component never becomes a second reader of a file the
 * page is already showing. `fieldOptions` is the same rule for the values a
 * field may take when the DECLARATION cannot know them (the assets this OS has
 * live in the store): the page supplies the list, and this offers it as a
 * picker. WHETHER IT ALSO REFUSES EVERYTHING ELSE IS THE FIELD'S TO SAY (bead
 * `ro-g318`) — the two were one job until the tracked-query Bet column needed
 * the picker without the rule. A field's domain is CLOSED by default (an asset
 * id: the OS either has it or does not), and one declaring
 * `candidates: 'suggest'` is open — the values are what is already in use, and
 * naming a new one is a legitimate edit. The refusal itself is
 * `candidateRefusal`, in the declaration beside `fieldRefusal` — the apply
 * pipeline asks it the same question with the roster file's own keys (bead
 * `ro-x5gu.10`), so a typo cannot be refused here in one wording and there in
 * another.
 *
 * A FIELD MAY BE SET WHEN THE ROW IS CREATED AND NOT AFTERWARDS (bead
 * `ro-xhy5`). Three declared fields are join keys whose rename breaks something
 * no table can show — the data-source catalog's `id`, a recurring cost's `id`,
 * a domain order's `domain` — and each of them already carried that warning in
 * its `describe`, which is a tooltip on a control that still offers the edit. A
 * field declaring `readOnly` renders as the stored value under a lock, its
 * state ("Fixed once added", `fixedFieldLabel`) on it, and no Save to press;
 * the Add form still asks for it, because a new row must set its key, and marks
 * it with the same lock before it is typed (bead `ro-ujb9.96.6.17`). The write
 * lane refuses the same set, so this is a rule rather than a suggestion a
 * hand-written changeset can walk past.
 *
 * A LONG REGISTER NARROWS ITSELF, AND THE ADDRESS TRAVELS WITH THE ROW (bead
 * `ro-x5gu.11`). Every op addresses a row by its POSITION in the file's array,
 * which is why no page could hand over a filtered or sorted list — `/costs/0`
 * would have meant whichever row was first on screen, and /financials showed all
 * 22 domain orders flat because of it. Doing it HERE is what makes it safe:
 * `collectionRows` still reads the file's own array, so a row keeps the token it
 * had there, and the filter box and the sortable headers only choose which of
 * those rows to draw and in what order. Nothing about an op changes. Both appear
 * only past `NARROWS_FROM` rows, because a filter over five is chrome.
 *
 * ON A PHONE THAT SAME REGISTER FOLDS (bead `ro-c59x`). The `ro-md80` reflow
 * turns each row into a labelled card, which made every field reachable at 390px
 * and paid for it in height: 22 domain orders × 6 fields is 132 labelled lines,
 * and /financials measured 28,244px at 390×844. So past the same threshold a row
 * is ONE line — its key, its second column, a chevron — until it is opened, and
 * opening it gives back the whole card with every control at the 44px thumb
 * floor. Nothing is hidden that the wide table shows: the fold measures its
 * own box through `@max-[40rem]` in `ui/table.tsx`, beside the reflow. A wide
 * table does not fold, even when its screen holds another narrow table; the
 * filter above is the other half of the answer — finding a row is a search.
 *
 * AND A COLUMN MAY BE COMPUTED (the same bead). `derived` is a column the PAGE
 * works out from a row — a domain order's amortized monthly share — drawn beside
 * the declared ones and carrying no control, which is how a reader tells what the
 * file holds from what the page worked out. It is not a field: nothing stores it,
 * nothing addresses it, and a file holding a derived value is a file that can
 * disagree with itself.
 *
 * AND IT SAYS WHEN A ROW IS NOT THE WHOLE JOB. `onAdded` fires after an add
 * lands, because some registers leave work outside the file — a task-hub project
 * still needs its database created and its repo pointed at the hub — and only
 * the page knows which steps those are (bead `ro-x5gu.5`).
 */

/** One computed column. `name` is a key for React and for the stacked card's
 * label; nothing addresses it in a pointer, because nothing stores it. */
export interface DerivedColumn {
  name: string;
  label: string;
  /** One line, on the header the way a declared field's `describe` is. */
  describe?: string;
  render: (row: CollectionRow) => ReactNode;
}

/**
 * From how many rows a table offers to NARROW itself (bead `ro-x5gu.11`).
 *
 * Under this, a filter box is chrome above a list somebody can already read in
 * one glance. Over it, /financials' 22 domain orders are a flat list with no way
 * to ask "what does this asset cost me", and /settings' catalog is fourteen.
 * Eight is where a register stops being a paragraph and starts being a table.
 */
const NARROWS_FROM = 8;

export interface CollectionEditorProps {
  /** Which register — the key in `CONFIG_REGISTERS`. */
  register: ConfigRegisterKey;
  /** The asset a per-asset register is scoped to (`{asset}` in its container). */
  params?: RegisterParams;
  /** The rows as the page's payload holds them: the array for an array
   * register, the keyed object for an object one. */
  rows: CollectionSource;
  /** A shared per-asset holder already exists, but this list may not yet. */
  holderExists?: boolean;
  /**
   * The page is still fetching. Renders the table's own skeleton, never a
   * spinner — and offers NO Add and no Remove until the rows arrive (bead
   * `ro-x5gu.9`), because loading and "this asset has no entry" both present as
   * absent rows and they are different writes.
   */
  loading?: boolean;
  /** Overrides the register's own label as the section heading. */
  title?: ReactNode;
  /** Overrides the register's own one-line `describe`. */
  describe?: ReactNode;
  /** What an empty list means HERE — absence is a fact, and only the page knows
   * which one (nothing declared yet, or nothing to declare). */
  emptyHint?: ReactNode;
  /** A subset of the declared fields, in this order. Defaults to all of them. */
  columns?: string[];
  /** Fields offered when creating a row. Defaults to all declared fields;
   * legacy metadata may be retained in existing rows without a new input. */
  addFields?: string[];
  /**
   * The values a field may take that the DECLARATION cannot know — the assets
   * this OS actually has, which live in the store rather than in
   * `scripts/config-registers.mjs`. Offered as a picker beside the input.
   *
   * WHETHER A VALUE OUTSIDE THE LIST IS ALSO REFUSED is the field's own
   * declaration to say (bead `ro-g318`): a closed domain refuses one naming the
   * field, and a field declaring `candidates: 'suggest'` refuses nothing,
   * because the list is what is already in use rather than everything allowed.
   * The page hands over the same thing either way.
   *
   * An EMPTY or absent list is "the page does not know", never "nothing is
   * allowed": a page whose own source has not answered yet refuses nothing.
   */
  fieldOptions?: Readonly<Record<string, readonly string[]>>;
  /** A row landed. Some registers leave work OUTSIDE the file — a database to
   * create, a repo to point somewhere — and only the page knows what it is, so
   * this is where the surface says the rest out loud. */
  onAdded?: (row: Record<string, JsonValue>) => void;
  /** The row's own identity glyph, drawn beside the FIRST column (the key
   * field). An asset id is a domain and reads faster with its favicon than
   * without it (doc 14) — and a glyph is the one thing a generic table cannot
   * derive, because only the page knows what its keys ARE. */
  rowGlyph?: (row: CollectionRow) => ReactNode;
  /** The changeset slug, and the commit subject. */
  slug?: string;
  /**
   * This surface shows ONE row, in a file where membership is an invariant
   * rather than the operator's to grow.
   *
   * Add is offered only while the row is MISSING — which repairs a gap
   * (`config/signal-panels.README.md`: an asset with no roster row is an
   * undocumented gap, an asset with `enabled: false` is a decision) — and Remove
   * is never offered at all, because a roster row leaves with its asset, through
   * the Settings tab's Delete, and nowhere else.
   */
  oneRow?: boolean;
  /** A rule about the LIST that no single row can express, checked before an Add
   * becomes a request — the same place `duplicateIssue` is checked, for the same
   * reason. The panel's query ceiling is one: the collector refuses a whole
   * panel past it, so the 32nd term must be refused here rather than land in a
   * file and fail silently next Monday. */
  refuseAdd?: (rows: CollectionRow[]) => string | null;
  /**
   * `refuseAdd`'s per-FIELD equivalent: a rule the declaration states but cannot
   * check here, because the fact it turns on lives in a file this component
   * never opens (bead `ro-uko8`). The panel-refresh roster's `enabled` is one —
   * turning it on asserts the asset has a live search lane in
   * `config/integrations.json`, which the page already holds.
   *
   * Checked wherever a value becomes a request: a cell's Save and the Add form's
   * submit. The RULE belongs to the declaration; the page only hands it the
   * facts, exactly as it does for `fieldOptions`.
   */
  refuseField?: (field: RegisterField, value: JsonValue) => string | null;
  /**
   * Columns the page COMPUTES from a row, drawn after the declared ones and
   * never editable (bead `ro-x5gu.11`).
   *
   * A register's fields are what the file STORES, and some of what an operator
   * reads about a row is arithmetic over them — a domain order's amortized
   * monthly share, the months a subscription still has to run. Those are not
   * fields (nothing writes them, and a file holding a derived value is a file
   * that can disagree with itself), and before this the only place to put them
   * was a second read-only table beside the editable one, which is the same rows
   * rendered twice.
   *
   * The renderer takes the whole row, so the page decides; this only gives it a
   * cell. A derived column carries no control and no Save, which is what keeps
   * "editable" and "computed" apart on sight.
   */
  derived?: readonly DerivedColumn[];
  /** Forces the read-only rendering. Defaults to what the deployment answers. */
  readOnly?: boolean;
  /** Whether this editor also STATES the read-only reason under itself. A
   * surface stacking several editors under one heading says it once above them
   * and passes `false` — the same sentence twice is the same fact twice. */
  statesReadOnly?: boolean;
  /**
   * WHEN a cell edit is committed (bead `ro-ujb9.96.7.12`). Where its outcome is
   * said is not a choice: every cell says "Saved · Undo" — or "Not saved" and
   * why — under its own control (`InlineSaveState`), the one inline pattern
   * every setting uses (D30), after GitLab Pajamas
   * (docs/briefs/2026-09-23-inline-save.md#prior-art).
   *
   * `save` (the default) keeps a Save beside each cell, Enter included —
   * Pajamas' manual save, and what money registers keep (never autosave
   * financial data). `auto` has no Save button at all: a choice saves the
   * moment it is picked, a typed value when the cell is left (Enter, Tab or a
   * click elsewhere), the spreadsheet model every table editor shares; Escape
   * puts the stored value back. Same op, same inverse, same write either way.
   * Add and Remove are row moves, not cell edits, and keep their own controls.
   */
  commit?: "save" | "auto";
  /** Write the op somewhere else. The component gallery passes a fake, so the
   * demos are real controls that never touch the operator's repo. */
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
  /** What the operator typed into the filter box, and which column the table is
   * ordered by — both browser-only, both reset by a reload. Neither reaches an
   * op (see `shown` below). */
  const [narrow, setNarrow] = useState("");
  const [order, setOrder] = useState<{ field: string; descending: boolean } | null>(null);
  /** Which rows are open in a narrow table box (bead `ro-c59x`). A box at least
   * 40rem wide ignores this state and draws every cell: the fold uses
   * `@max-[40rem]`, independent of the viewport. */
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

  /**
   * WHY A FIXED COLUMN CANNOT BE EDITED, SAID ONCE FOR THE TABLE (bead
   * `ro-x5gu.12`).
   *
   * The cell renders the value, a lock, the reason in `title` and the same
   * reason `sr-only`. A desk pointer reaches the first; a screen reader reaches
   * the second; a sighted operator on a phone reaches NEITHER, and got a value,
   * a lock and no Save with nothing on screen saying why or what to do instead.
   * That is worse for that one reader than the `describe`-line warning
   * `ro-xhy5` replaced, which is the opposite of what that bead was for.
   *
   * Once per TABLE rather than once per row: every row of a register shares
   * this reason, so a line under each of 22 domain orders would be the same
   * sentence 22 times (doc 14, one fact one representation) on the surface
   * `ro-c59x` just spent a fold saving height on. Below `sm` only, because
   * above it the hover is already there and the desk owes no new prose.
   *
   * A KEY, NOT A SENTENCE (bead `ro-ujb9.96.6.17`): the lock and its state —
   * "Fixed once added" — the way a chart key names a mark. Why each key is
   * fixed is the declaration's comment; what to do instead is the row's own
   * Remove and the table's Add, both on screen.
   */
  const fixedReasons = [
    ...new Set(
      fields
        .map((field) => fixedFieldLabel(field))
        .filter((label): label is string => label !== null),
    ),
  ];

  /**
   * THE ROWS ON SCREEN, WHICH ARE NOT THE ROWS IN THE FILE (bead `ro-x5gu.11`).
   *
   * A register's rows were unfilterable and unsortable for one reason: every op
   * addresses a row by its POSITION in the array (`collectionRows`:
   * `token = String(index)`), so a page handing over a filtered or reordered
   * list would have made `/costs/0` mean whichever row happened to be first on
   * screen. /financials showed all 22 domain orders as one flat list because of
   * it.
   *
   * Narrowing HERE rather than in the page is what makes it safe, and it is the
   * whole design: `collectionRows` still reads the file's own array, so every
   * row carries the token it had there, and filtering and sorting only choose
   * which of those rows to draw and in what order. A row's address travels with
   * the row. Nothing about an op changes, and no page has to be trusted with an
   * index.
   */
  const narrowable = rows.length >= NARROWS_FROM;
  const matching = narrowable ? rows.filter((row) => matches(row, fields, narrow)) : rows;
  const shown = order === null ? matching : sortRows(matching, fields, order);
  /** No entry for this asset in the file at all — so the first row files one. */
  const unfiled = (source === null || source === undefined) && holderOf(register) !== null;

  /**
   * A REFETCH CLOSES AN OPEN ADD FORM (bead `ro-x5gu.9`).
   *
   * Add cannot be opened while `loading`, so this only fires when a page starts
   * loading with a form already open. The form has to go with it for the same
   * reason it cannot be opened: the seed-vs-append decision reads `rows`, and
   * loading presents as absent rows. Written as a render-phase reset — the
   * pattern `Cell` uses to re-seed a draft when the value moves underneath —
   * because the affordance follows reality rather than an effect a click can
   * outrun.
   */
  if (loading && adding) setAdding(false);

  /**
   * The declared rules that need the LIST rather than the row (bead `ro-cnsj`).
   *
   * Unlike `refuseField`, nothing outside these rows decides this one, so the
   * page is not asked for anything: a register naming a `clusterField` says that
   * grouping downstream is an exact string match, and two spellings of one
   * cluster are two groups in the readout and one in the operator's head. This
   * component still learns no register's name — the same way it reads
   * `emptyIsAbsent` and `scalarField`.
   *
   * `token` is the row being edited, whose own spelling cannot clash with
   * itself; `null` from the Add form, where every row belongs to somebody else.
   */
  function listRefusal(field: RegisterField, value: JsonValue, token: string | null) {
    return (
      clusterSpellingRefusal(register, stored, token, field, value) ??
      refuseField?.(field, value) ??
      null
    );
  }

  /**
   * One cell, one changeset.
   *
   * A row stored as an OBJECT edits the field's own pointer, guarded by that
   * field's own previous value — the tightest guard available, so two operators
   * editing different columns of the same row do not collide. Two cases cannot
   * take that pointer and set the WHOLE row instead, guarded by the whole
   * previous row: a row stored as a bare scalar (a string list, an unlabelled
   * tracked query) has nothing below it to address, and CLEARING an optional
   * field has to remove the key rather than write `null` into a config file.
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

  /** One cell, one changeset — its outcome handed back to the cell. */
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

  /**
   * Remove a row — or, when it is the LAST one of a list its file has no empty
   * state for, remove the asset's whole ENTRY.
   *
   * `unseed` is `seed`'s exact mirror and exists for the same reason: on a
   * register declaring `emptyIsAbsent`, `{ queries: [] }` is a config error the
   * collector refuses, so leaving one behind would turn "this asset stopped
   * buying a panel" into "this asset's panel fails every Monday". Still one op,
   * still exactly invertible — the undo files the entry back.
   */
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
              // The page says why once (`SavesPaused`, bead `ro-p8qq`); the
              // table shows the state as a lock, and says it to a screen reader.
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
        // THE LIST'S STATE, NOT A SENTENCE ABOUT IT (bead `ro-ujb9.96.6.22`):
        // the heading above already names the list and its describe line says
        // what it holds, so the empty state is the value "None yet" — "Nothing
        // in registered event parameters yet" was a six-word sentence, and the
        // describe line repeated here said the same thing twice. A page adds
        // `emptyHint` only for what the empty list DOES (a report it skips).
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
          {/* `stacked` (bead `ro-md80`): a register is as wide as it has fields,
              and /settings' widest ran 1361px past a 390px screen — three
              squeezed inputs visible and everything else, Remove included, off
              the right edge. In a box narrower than 40rem — a phone, or a
              site's Settings card on a tablet (bead `ro-ujb9.169`) — each row
              is a labelled card of its own fields, which is also the shape the
              Add form below already has; the table scrolls in its own box. */}
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
                  // A long register FOLDS its rows on a phone (bead `ro-c59x`),
                  // for the same reason it offers a filter: past eight rows the
                  // reflow's one-card-per-row spends more height than a thumb
                  // can scroll. Nothing folds on the desk.
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
            // The LIST's own rule first: when there is no room, no row an
            // operator could type would be accepted, and saying which field is
            // missing would send them back to fix the wrong thing. It is about
            // no one field, so it outlines none.
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
  /** Below `sm`, this row is one summary line until it is opened (`ro-c59x`). */
  folds?: boolean;
  open?: boolean;
  onToggle?: () => void;
  fieldOptions?: Readonly<Record<string, readonly string[]>>;
  refuseField?: (field: RegisterField, value: JsonValue) => string | null;
  glyph?: ReactNode;
  locked: boolean;
  /** False where a row is not the operator's to take out here (`oneRow`). */
  removable: boolean;
  saving: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  /** When a cell commits: its own Save, or on pick / on leaving it. */
  commit: "save" | "auto";
  /** The cell's edit, its outcome handed back so the cell can say it. */
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
          {/* The identity line the desk's header row and first column already
              give a reader. 44px is the thumb floor ro-md80 set. */}
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
      {/* Computed, so it carries no control and no Save — which is how a reader
          tells what the file holds from what the page worked out (ro-x5gu.11). */}
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

/**
 * The filter box (bead `ro-x5gu.11`).
 *
 * One control, matching across every column the table draws, because a register
 * has no privileged column to search: /financials' domain orders are looked up
 * by asset AND by name, and /settings' catalog by id AND by label. It says how
 * many rows it is drawing out of how many the file holds, so a narrowed table
 * never looks like a shrunken one — the count is the difference between "this
 * asset owns three domains" and "somebody deleted nineteen".
 */
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
          // Only the LEFT inset moves: the base already sets px-2, and the
          // search glyph displaces nothing on the right.
          className={cn(fieldClass, "w-full pl-7")}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {shown === total ? `${total} rows` : `${shown} of ${total}`}
      </span>
    </div>
  );
}

/** A column heading that also orders the table by itself: file order → up →
 * down → file order. File order is a state worth being able to get back to, so
 * it is a third press rather than a control nobody can undo. */
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

/** file order → ascending → descending → file order, on the pressed column. */
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

/** Does this row answer the filter? Every column the table draws is searched —
 * the declared values, and the row's own key, which is what an operator types
 * first. A derived column is not: it is the page's arithmetic, and a filter that
 * matched it would depend on how the page chose to format a number. */
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

/** Sort by one column, by its declared TYPE — a number sorts as a number, and
 * everything else compares as the text the cell shows, so `2026-09` and `2026-10`
 * order the way the calendar does. A row missing the value sorts last in both
 * directions: absence is not a small value. */
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

/** A cell: the stored value under a lock where it cannot be edited (a locked
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
  /** The row's key — with the field, the subject a save's state is about. */
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

  /**
   * A FIELD THE DECLARATION MARKS `readOnly` (bead `ro-xhy5`).
   *
   * The declared keys whose rename breaks something this table cannot show
   * once carried the warning in a sentence — a tooltip on a control that still
   * offered the edit. This is the control that does not: the stored value as
   * text, a lock, its state ("Fixed once added") on hover and to a screen
   * reader, and no Save to press. The Add form below still asks for it,
   * because a new row must set its key.
   */
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
 * ONE EDITABLE CELL, ITS OUTCOME UNDER IT (bead `ro-ujb9.96.7.12`).
 *
 * `commit="save"`: the cell buffers a draft and commits it with its Save (or
 * Enter) — KnobEditor's model. `commit="auto"`: no Save button; a choice (an
 * enum, a yes/no) saves the moment it is picked, and a typed value when the
 * operator leaves the cell — Enter, Tab or a click elsewhere — the way every
 * spreadsheet and table editor commits a cell. Escape puts the stored value
 * back without writing. Either way the outcome is said under the control
 * (`InlineSaveState`): "Saved · Undo", or "Not saved" with the refusal's own
 * words, and a refused pick goes back to the stored value rather than showing a
 * choice nothing holds.
 *
 * WHAT LANDED STAYS ON SCREEN until the page's read catches up: without it a
 * cell would flick back to the old value for the second a refresh takes, and a
 * blur in that second would send the same edit again against a stale guard.
 * Validation is unchanged and still runs first — a value the declaration
 * refuses never becomes a request, and says why in `error` ink.
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
        // A refused PICK (auto) goes back to what is stored; a refused draft
        // stays, so the operator can correct it rather than retype it.
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
        // Manual save (Pajamas' default, and money's rule): the cell's own
        // Save, dead until there is something to write.
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={committing || undoing || !dirty}
          onClick={() => void commit(draft)}
        >
          {/* "Saving…" is said once, by the state under the cell. */}
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

/** Built from the same field list the columns are: nothing here knows which
 * register it is filling in. Refuses inline — the row-level rule (a required
 * field, a key already in the list) beside the form, the field-level rule under
 * its own input — so an invalid row never becomes a request. */
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
  /** The `defaultFrom` fields still following their source. A field leaves this
   * set the moment it is typed into: a default the operator has overruled must
   * not come back on the next keystroke somewhere else. */
  const [mirroring, setMirroring] = useState<ReadonlySet<string>>(
    () => new Set(fields.filter((f) => f.defaultFrom !== undefined).map((f) => f.name)),
  );
  /** The refusal under the form and the one field it names (bead
   * `ro-ujb9.184`): only that input is outlined and marked invalid, so the red
   * says where to look; a refusal about the whole row or list outlines none. */
  const [error, setError] = useState<RowIssue | null>(null);

  /** One field changed — plus every field defaulting from it that is still
   * following along. */
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

  /** Is this the one control the refusal names? Only it is outlined, marked
   * invalid and pointed at the sentence that says why. */
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
              {/* A key the table will lock says so BEFORE it is typed, as the
                  same lock and state the row will wear (bead
                  `ro-ujb9.96.6.17`). */}
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

/** The table's own shape, greyed — never a spinner (doc 15 principle 2): the
 * columns are already known, so the wait shows what is arriving. */
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

/** The picker beside an input whose value domain is runtime, not declared. A
 * native `datalist` rather than a `select` in both cases: where the domain is
 * closed, the refusal below still has to work on a value somebody typed or
 * pasted; where the field declares `candidates: 'suggest'`, typing past the
 * list is the whole point (bead `ro-g318`). */
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

// --- draft <-> value -------------------------------------------------------
//
// NEITHER direction lives here any more. Turning what an operator TYPED back
// into a typed value is `fieldFromDraft`, beside the `fieldRefusal` that judges
// the result (bead `ro-7mef`); rendering a stored value as the text an input
// seeds with is `fieldToDraft`, beside the parse it inverts (bead `ro-hem5`).
// This component held both privately, and half of a pair kept where its other
// half cannot reach it is the second representation doc 14 exists to prevent:
// `KnobEditor` seeded with `String()` for four beads because the inverse was in
// here. What is below chooses a CONTROL for a field, which is this component's
// own business and nothing else's.

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

/** An enum value as it reads on screen (`valueLabels`, bead `ro-ujb9.135`):
 * the stored key only where the declaration names nothing plainer. */
function optionLabel(field: RegisterField, value: string): string {
  return field.valueLabels?.[value] ?? value;
}

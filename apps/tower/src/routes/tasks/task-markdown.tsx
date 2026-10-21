import { createContext, useContext, useId, useMemo, type ReactNode } from "react";
import { Check, Info, Lightbulb, Square, TriangleAlert, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

/**
 * A task's description, acceptance criteria and comments are Markdown written
 * by whoever filed them. No dependency and no raw HTML: the renderer parses
 * into blocks and emits React elements, so there is no `dangerouslySetInnerHTML`
 * on the path and a `<script>` in a description is text by construction. A link
 * is rendered only when its href is `http(s)`, `mailto:` or site-relative, and
 * an image only from an `http(s)` address; anything else renders as the
 * literal Markdown it was written as. What it draws: headings, paragraphs,
 * nested bullet and numbered lists, task lists, tables, block quotes and the
 * three callouts (Note, Warning, Tip), code, rules, and inline code, bold,
 * emphasis, strikethrough, links and images.
 */

/** What plain text may turn into: a task id of a known project into a link to
 * its page, a file path into a monospace chip (a link to the repository when
 * there is a web address for it and the path names a line). */
export interface TaskTextRefs {
  /** The task id prefixes of the projects this installation reads. */
  prefixes: readonly string[];
  taskHref: (id: string) => string;
  /** The repository's web address, when the project's configured repository
   * is one. */
  repoUrl: string | null;
}

const Refs = createContext<TaskTextRefs | null>(null);

/** Plain text under this provider draws its task ids and paths as chips. */
export function TaskTextRefsProvider({ value, children }: { value: TaskTextRefs; children: ReactNode }) {
  return <Refs.Provider value={value}>{children}</Refs.Provider>;
}

export function MarkdownText({ source, className, checklist = false, onToggleTask, toggleDisabled = false }: {
  source: string;
  className?: string;
  /** A bullet list as a list of things to make true: a box per line. */
  checklist?: boolean;
  /** Makes each task-list box a button that reports its source line, the
   * index `toggleTaskListLine` flips. Without it the boxes are read-only. */
  onToggleTask?: (line: number) => void;
  /** Holds the boxes still while a toggle is being written. */
  toggleDisabled?: boolean;
}) {
  const refs = useContext(Refs);
  const idBase = useId();
  const blocks = useMemo(() => parseBlocks(source), [source]);
  const pattern = useMemo(() => (refs ? refPattern(refs.prefixes) : null), [refs]);
  const draw: Draw = {
    text: (value, key) => inline(value, key, refs && pattern ? { ...refs, pattern } : null),
    checklist,
    onToggleTask,
    toggleDisabled,
    idBase,
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => drawBlock(block, `${block.kind}-${index}`, draw))}
    </div>
  );
}

/** What every block is drawn with: the inline renderer, and the task-list
 * boxes' behaviour. */
interface Draw {
  text: (value: string, key: string) => ReactNode[];
  checklist: boolean;
  onToggleTask: ((line: number) => void) | undefined;
  toggleDisabled: boolean;
  idBase: string;
}

/** `#` is the page's second level: the task's title is its one `h1`. */
const HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6"] as const;

const ALIGN_CLASS: Readonly<Record<"left" | "center" | "right", string>> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const CALLOUT_FACE: Readonly<Record<CalloutKind, { word: string; Icon: LucideIcon; icon: string; ink: string }>> = {
  note: { word: "Note", Icon: Info, icon: "text-muted-foreground", ink: "text-foreground" },
  tip: { word: "Tip", Icon: Lightbulb, icon: "text-muted-foreground", ink: "text-foreground" },
  warning: { word: "Warning", Icon: TriangleAlert, icon: "text-warn", ink: "text-warn" },
};

function drawBlock(block: Block, key: string, draw: Draw): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = HEADING_TAGS[Math.min(block.level, HEADING_TAGS.length) - 1] ?? "h6";
      return (
        <Tag key={key} className={cn("m-0 font-semibold text-foreground", block.level <= 2 ? "text-base" : "text-sm")}>
          {draw.text(block.text, key)}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={key} className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
          {draw.text(block.text, key)}
        </blockquote>
      );
    case "callout": {
      const face = CALLOUT_FACE[block.tone];
      return (
        <aside key={key} role="note" data-callout={block.tone} className="flex min-w-0 items-start gap-2 rounded-md bg-muted px-3 py-2">
          <face.Icon aria-hidden className={cn("mt-[0.2em] size-4 shrink-0", face.icon)} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className={cn("font-semibold", face.ink)}>{face.word}</strong>
            {block.text ? <div className="min-w-0">{draw.text(block.text, key)}</div> : null}
          </div>
        </aside>
      );
    }
    case "rule":
      return <hr key={key} className="my-1 w-full border-0 border-t border-border" />;
    case "table":
      return (
        <div key={key} className="min-w-0 overflow-x-auto" data-md-table="">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border">
                {block.head.map((cell, c) => (
                  <th
                    key={`${key}-h${c}`}
                    scope="col"
                    // Eyebrow size without the eyebrow's capitals: a header
                    // someone wrote ("p95 (ms)") keeps the case it was written in.
                    className={cn("px-2 py-1 align-bottom text-micro font-semibold text-muted-foreground first:ps-0 last:pe-0", ALIGN_CLASS[block.align[c] ?? "left"])}
                  >
                    {draw.text(cell, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${key}-r${r}`} className="border-b border-border/70 last:border-0">
                  {row.map((cell, c) => (
                    <td key={`${key}-r${r}c${c}`} className={cn("px-2 py-1.5 align-top first:ps-0 last:pe-0", ALIGN_CLASS[block.align[c] ?? "left"])}>
                      {draw.text(cell, `${key}-r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return drawList(block, key, draw, 0);
    case "paragraph": {
      // A figure cannot sit in a `<p>`: the parser would close the paragraph.
      const Tag = IMAGE_IN_TEXT.test(block.text) ? "div" : "p";
      return <Tag key={key} className="m-0">{draw.text(block.text, key)}</Tag>;
    }
  }
}

/** A list that holds a task-list item, or any bullet list under `checklist`,
 * draws a box per item; every other list its bullets or numbers. */
function drawList(list: ListBlock, key: string, draw: Draw, depth: number): ReactNode {
  const boxed = list.items.some((item) => item.done !== null) || (draw.checklist && !list.ordered);
  const items = list.items.map((item, i) => drawItem(item, `${key}-${i}`, draw, depth, boxed, list.ordered));
  if (boxed && !list.ordered) {
    return (
      <ul key={key} className={cn("m-0 flex list-none flex-col gap-1.5 p-0", depth > 0 && "ms-5.5 mt-1.5")} data-checklist="">
        {items}
      </ul>
    );
  }
  if (list.ordered) {
    return (
      <ol key={key} start={list.start === 1 ? undefined : list.start} className={cn("ml-5 list-decimal space-y-0.5", depth > 0 && "mt-0.5")}>
        {items}
      </ol>
    );
  }
  return (
    <ul key={key} className={cn("ml-5 space-y-0.5", depth % 2 === 0 ? "list-disc" : "list-[circle]", depth > 0 && "mt-0.5")}>
      {items}
    </ul>
  );
}

function drawItem(item: ListItem, key: string, draw: Draw, depth: number, boxed: boolean, ordered: boolean): ReactNode {
  const children = item.children.map((child, i) => drawList(child, `${key}-c${i}`, draw, depth + 1));
  if (!boxed) {
    return (
      <li key={key}>
        {draw.text(item.text, key)}
        {children}
      </li>
    );
  }
  const textId = `${draw.idBase}-l${item.line}`;
  return (
    // A numbered item stays a list item, or it loses its number.
    <li key={key} className={cn("min-w-0", !ordered && "flex flex-col")} data-task-item={item.done === null ? undefined : item.done ? "done" : "open"}>
      <span className="flex min-w-0 items-start gap-2">
        {item.done !== null ? (
          <TaskBox done={item.done} line={item.line} labelledBy={textId} draw={draw} />
        ) : draw.checklist ? (
          <Square aria-hidden className="mt-[0.3em] size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          // A plain item among task items keeps a bullet, not a box with no state.
          <span aria-hidden className="mx-[0.3125rem] mt-[0.6em] size-1 shrink-0 rounded-full bg-foreground/70" />
        )}
        <span id={item.done === null ? undefined : textId} className={cn("min-w-0", item.done && "text-muted-foreground line-through")}>
          {draw.text(item.text, key)}
        </span>
      </span>
      {children}
    </li>
  );
}

/** A task-list box: ticked is a filled check in the recorded-success green,
 * unticked an empty box. A button, named by its line, where it can be toggled. */
function TaskBox({ done, line, labelledBy, draw }: { done: boolean; line: number; labelledBy: string; draw: Draw }) {
  const glyph = done ? (
    <span className="grid size-3.5 place-items-center rounded-[3px] bg-healthy text-background">
      <Check aria-hidden strokeWidth={3} className="size-2.5" />
    </span>
  ) : (
    <Square aria-hidden className="size-3.5 text-muted-foreground group-enabled:group-hover:text-foreground" />
  );
  const toggle = draw.onToggleTask;
  if (toggle === undefined) {
    return (
      <span role="img" aria-label={done ? "Done" : "Not done"} data-task-box={done ? "done" : "open"} className="mt-[0.3em] inline-flex shrink-0">
        {glyph}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={done}
      aria-labelledby={labelledBy}
      disabled={draw.toggleDisabled}
      data-task-box={done ? "done" : "open"}
      onClick={() => toggle(line)}
      // The box stays 14px; the press target around it is a phone's thumb.
      className="group relative mt-[0.3em] inline-flex shrink-0 rounded-[3px] outline-none before:absolute before:-inset-2.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      {glyph}
    </button>
  );
}

// --- The task guide's grammar ---------------------------------------------------

/** The labels a task's description is written in (the task guide's grammar). */
const GUIDE_LABELS: Readonly<Record<string, string>> = {
  WHAT: "What",
  WHY: "Why",
  WHERE: "Where",
  FIX: "Fix",
  ORDER: "Order",
  CONSTRAINT: "Constraint",
};
const GUIDE_LINE = /^\s*(?:\*\*)?(WHAT|WHY|WHERE|FIX|ORDER|CONSTRAINT):(?:\*\*)?\s*(.*)$/;
const STEPS_LINE = /^#{1,4}\s*Steps to reproduce\s*:?\s*$/i;

export interface GuideSection {
  /** The section's word, or null for text before the first label. */
  label: string | null;
  body: string;
}

/**
 * A description split at the guide's labels (`WHAT:`, `WHY:`, … and a
 * `## Steps to Reproduce` heading), each label's text up to the next one.
 * Null when the description uses none of them, so it reads as it was written.
 */
export function guideSections(source: string): GuideSection[] | null {
  const sections: GuideSection[] = [];
  let current: GuideSection = { label: null, body: "" };
  let labelled = false;
  let fenced = false;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const label = fenced ? null : GUIDE_LINE.exec(line);
    const steps = fenced ? false : STEPS_LINE.test(line);
    if (label || steps) {
      if (current.label !== null || current.body.trim() !== "") sections.push(current);
      labelled = true;
      current = label
        ? { label: GUIDE_LABELS[label[1] ?? ""] ?? null, body: label[2] ?? "" }
        : { label: "Steps to reproduce", body: "" };
      continue;
    }
    current.body = current.body === "" ? line : `${current.body}\n${line}`;
  }
  if (current.label !== null || current.body.trim() !== "") sections.push(current);
  return labelled ? sections.map((section) => ({ ...section, body: section.body.trim() })) : null;
}

/** A description in the guide's grammar as labelled sections, each label the
 * one eyebrow and its text under it; any other description as written. */
export function GuideText({ source }: { source: string }) {
  const sections = useMemo(() => guideSections(source), [source]);
  if (sections === null) return <MarkdownText source={source} />;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-guide-sections="">
      {sections.map((section, index) => (
        <section
          key={`${section.label ?? "intro"}-${index}`}
          aria-label={section.label ?? undefined}
          data-guide-section={section.label ?? ""}
          className={cn("flex min-w-0 flex-col gap-1", section.label && "border-l-2 border-border/80 pl-3")}
        >
          {section.label ? <h3 className={cn("m-0", eyebrowClass)}>{section.label}</h3> : null}
          {section.body ? <MarkdownText source={section.body} /> : null}
        </section>
      ))}
    </div>
  );
}

// --- Task lists -----------------------------------------------------------------

/** One `- [ ]` / `- [x]` item: its line in the source (counting `\n`, `\r\n`
 * and `\r` as one break each), whether it is ticked, and its text. */
export interface TaskListLine {
  index: number;
  done: boolean;
  text: string;
}

export interface TaskList {
  total: number;
  done: number;
  lines: TaskListLine[];
}

/** The task-list items a source holds, nested ones included, in reading
 * order. Read off the same parse the renderer draws, so a marker inside code
 * or a quote is never counted. */
export function taskListItems(source: string): TaskList {
  const lines: TaskListLine[] = [];
  const visit = (list: ListBlock) => {
    for (const item of list.items) {
      if (item.done !== null) lines.push({ index: item.line, done: item.done, text: item.text });
      item.children.forEach(visit);
    }
  };
  for (const block of parseBlocks(source)) if (block.kind === "list") visit(block);
  return { total: lines.length, done: lines.filter((line) => line.done).length, lines };
}

/** The source with the task-list marker on line `index` flipped and every
 * other character as it was; unchanged when that line holds no marker. */
export function toggleTaskListLine(source: string, index: number): string {
  const line = taskListItems(source).lines.find((entry) => entry.index === index);
  if (line === undefined) return source;
  // Odd entries are the breaks themselves, so joining gives the source back.
  const parts = source.split(/(\r\n|\r|\n)/);
  const raw = parts[index * 2];
  if (raw === undefined) return source;
  parts[index * 2] = raw.replace(TASK_MARKER_IN_LINE, (_whole, lead: string) => `${lead}[${line.done ? " " : "x"}]`);
  return parts.join("");
}

// --- Blocks -------------------------------------------------------------------

type Align = "left" | "center" | "right" | null;
type CalloutKind = "note" | "warning" | "tip";

interface ListItem {
  text: string;
  /** The task-list marker: true ticked, false unticked, null a plain item. */
  done: boolean | null;
  /** The item's line in the source, the index `toggleTaskListLine` takes. */
  line: number;
  children: ListBlock[];
}

interface ListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | ListBlock
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "callout"; tone: CalloutKind; text: string }
  | { kind: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
const TASK_MARKER = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const TASK_MARKER_IN_LINE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\]/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const CALLOUT = /^(?:\[!(note|warning|tip)\]|\*\*(note|warning|tip)[.:]\*\*)[ \t]*(.*)$/i;

/** Columns of leading whitespace, a tab to the next multiple of four. */
function indentWidth(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/** A table row's cells: the outer pipes dropped, `\|` a pipe in the cell. */
function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function columnAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** Whether a line opens a block of its own, which ends a table's rows. */
function opensBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let paragraph: string[] = [];
  // The lists open at the current line, outermost first: an item indented two
  // or more columns past the innermost one's opens a child list under its
  // last item. Empty whenever the last block is not a list.
  let open: { indent: number; list: ListBlock; parent: ListItem | null }[] = [];
  let lastItem: ListItem | null = null;
  let blank = false;

  const endList = () => {
    open = [];
    lastItem = null;
  };
  const flush = () => {
    if (paragraph.length > 0) {
      out.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const push = (block: Block) => {
    flush();
    endList();
    out.push(block);
  };

  const addItem = (indent: number, ordered: boolean, start: number, rest: string, line: number) => {
    const task = TASK_MARKER.exec(rest);
    const item: ListItem = {
      text: (task ? task[2] ?? "" : rest).trim(),
      done: task ? task[1] !== " " : null,
      line,
      children: [],
    };
    lastItem = item;
    const fresh = (): ListBlock => ({ kind: "list", ordered, start, items: [item] });
    let top = open[open.length - 1];
    if (top === undefined) {
      const list = fresh();
      out.push(list);
      open = [{ indent, list, parent: null }];
      return;
    }
    const parent = top.list.items[top.list.items.length - 1];
    if (indent >= top.indent + 2 && parent !== undefined) {
      const list = fresh();
      parent.children.push(list);
      open.push({ indent, list, parent });
      return;
    }
    while (open.length > 1 && top !== undefined && indent < top.indent) {
      open.pop();
      top = open[open.length - 1];
    }
    if (top === undefined) return;
    if (top.list.ordered === ordered) {
      top.list.items.push(item);
      return;
    }
    // A bullet after numbers at the same depth starts a list beside them.
    const list = fresh();
    if (top.parent === null) out.push(list);
    else top.parent.children.push(list);
    open[open.length - 1] = { indent, list, parent: top.parent };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const wasBlank = blank;
    blank = false;
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      blank = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      push({ kind: "heading", level: (heading[1] ?? "#").length, text: (heading[2] ?? "").trim() });
      continue;
    }
    if (RULE.test(line)) {
      push({ kind: "rule" });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      const last = out[out.length - 1];
      if (last && last.kind === "quote" && !wasBlank && paragraph.length === 0) last.text = `${last.text} ${quote[1] ?? ""}`;
      else push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && TABLE_SEPARATOR.test(next)) {
      const head = tableCells(line);
      const separator = tableCells(next);
      if (separator.length === head.length) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && (lines[j] ?? "").trim() !== "" && !opensBlock(lines[j] ?? "")) {
          const cells = tableCells(lines[j] ?? "");
          rows.push(head.map((_, c) => cells[c] ?? ""));
          j += 1;
        }
        push({ kind: "table", align: separator.map(columnAlign), head, rows });
        i = j - 1;
        continue;
      }
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] === undefined;
      addItem(indentWidth(item[1] ?? ""), ordered, ordered ? Number(item[3]) : 1, item[4] ?? "", i);
      continue;
    }
    // An indented line straight under an item continues that item's text.
    if (lastItem !== null && !wasBlank && paragraph.length === 0 && /^[ \t]{2,}\S/.test(line)) {
      const continued: ListItem = lastItem;
      continued.text = `${continued.text} ${line.trim()}`;
      continue;
    }
    endList();
    paragraph.push(line.trim());
  }
  flush();
  return out.map((block) => {
    if (block.kind !== "quote") return block;
    const callout = CALLOUT.exec(block.text.trim());
    if (!callout) return block;
    const tone = (callout[1] ?? callout[2] ?? "note").toLowerCase() as CalloutKind;
    return { kind: "callout", tone, text: (callout[3] ?? "").trim() };
  });
}

// --- Inline spans -----------------------------------------------------------------

/** Inline spans: code, an image inside a link, an image, bold,
 * strikethrough, emphasis, links. Split on the token pattern so the
 * delimiters survive as their own parts, then each part becomes an element —
 * never a string of markup. */
const INLINE_TOKEN =
  /(`[^`]+`|\[!\[[^\]]*\]\([^)\s]+\)\]\([^)\s]+\)|!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]*\]\([^)\s]+\))/g;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const LINKED_IMAGE = /^\[(!\[[^\]]*\]\([^)\s]+\))\]\([^)\s]+\)$/;
/** Text that will draw a figure, which a paragraph cannot hold. */
const IMAGE_IN_TEXT = /!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/i;

/** A path with at least one slash and an extension, and its line; never part
 * of an address (`//host/a.js`) or a longer word. */
const PATH_SOURCE = String.raw`(?<![\w/.:@-])((?:[\w.@-]+/)+[\w@-][\w.@-]*\.[A-Za-z0-9]{1,6})(?::(\d+)(?:-\d+)?)?(?![\w/])`;

function refPattern(prefixes: readonly string[]): RegExp {
  const known = prefixes.filter((prefix) => /^[a-z0-9]+$/i.test(prefix));
  const ids = known.length > 0
    ? String.raw`|(?<![\w/.-])((?:${known.join("|")})-[a-z0-9]{3,}(?:\.\d+)*)(?![\w-])`
    : "";
  return new RegExp(PATH_SOURCE + ids, "g");
}

type Chips = TaskTextRefs & { pattern: RegExp };

function inline(text: string, keyPrefix: string, chips: Chips | null): ReactNode[] {
  return text.split(INLINE_TOKEN).map((part, index) => {
    const key = `${keyPrefix}-i${index}`;
    if (part === "") return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const linked = LINKED_IMAGE.exec(part);
    if (linked) return image(linked[1] ?? "", part, key);
    if (part.startsWith("![")) return image(part, part, key);
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) {
      return (
        <del key={key} className="line-through">
          {part.slice(2, -2)}
        </del>
      );
    }
    if (
      (part.startsWith("*") && part.endsWith("*") && part.length > 1) ||
      (part.startsWith("_") && part.endsWith("_") && part.length > 1)
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const label = link[1] ?? "";
      const href = safeHref(link[2] ?? "");
      if (href === null) return <span key={key}>{part}</span>;
      if (href.startsWith("/")) {
        return (
          <Link key={key} to={href} className="underline underline-offset-2 hover:decoration-2 hover:text-foreground">
            {label}
          </Link>
        );
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 hover:decoration-2 hover:text-foreground"
        >
          {label}
        </a>
      );
    }
    return <span key={key}>{chips ? refs(part, key, chips) : part}</span>;
  });
}

/** An image from an `http(s)` address as a figure captioned by its alt text;
 * anything else as the Markdown it was written as (`literal`). */
function image(markdown: string, literal: string, key: string): ReactNode {
  const match = IMAGE.exec(markdown);
  const src = match ? safeImageSrc(match[2] ?? "") : null;
  if (match === null || src === null) return <span key={key}>{literal}</span>;
  const alt = match[1] ?? "";
  return (
    <figure key={key} className="m-0 flex min-w-0 flex-col gap-1" data-md-image="">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        // A description can name any host; the viewer's page is not sent to it.
        referrerPolicy="no-referrer"
        className="h-auto max-w-full rounded-md border border-border"
      />
      {alt.trim() ? <figcaption className="text-xs text-muted-foreground">{alt}</figcaption> : null}
    </figure>
  );
}

const CHIP = "rounded-md bg-muted px-1.5 py-px font-mono text-[0.85em] text-foreground [overflow-wrap:anywhere]";

/** Plain text with its task ids and paths drawn as chips. */
function refs(text: string, keyPrefix: string, chips: Chips): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(chips.pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-r${at}`;
    const [whole, path, line, id] = match;
    if (id) {
      out.push(
        <Link key={key} to={chips.taskHref(id)} data-task-ref={id}
          className={cn(CHIP, "underline-offset-4 hover:bg-muted/70 hover:underline")}>
          {id}
        </Link>,
      );
    } else if (path) {
      const href = chips.repoUrl && line ? `${chips.repoUrl.replace(/\/+$/, "")}/blob/HEAD/${path}#L${line}` : null;
      out.push(href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener" data-path-ref={whole}
          className={cn(CHIP, "underline-offset-4 hover:underline")}>
          {whole}
        </a>
      ) : (
        <code key={key} data-path-ref={whole} className={CHIP}>{whole}</code>
      ));
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An allowlist, not a denylist: three shapes are safe to put in an `href` and
 * everything else — `javascript:`, `data:`, a protocol-relative `//host` — is
 * not a link this page will make. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}

/** An image loads from an `http(s)` address only: no `data:`, no
 * `javascript:`, and no path, which would resolve against the Tower itself. */
function safeImageSrc(raw: string): string | null {
  const src = raw.trim();
  return /^https?:\/\/\S+$/i.test(src) ? src : null;
}

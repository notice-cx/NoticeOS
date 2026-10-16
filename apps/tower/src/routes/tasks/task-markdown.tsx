import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Square } from "lucide-react";
import { Link } from "react-router-dom";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { cn } from "@/lib/utils";

/**
 * A task's description, acceptance criteria and comments are Markdown written
 * by whoever filed them. No dependency and no raw HTML: the renderer parses
 * into blocks and emits React elements, so there is no `dangerouslySetInnerHTML`
 * on the path and a `<script>` in a description is text by construction. A link
 * is rendered only when its href is `http(s)`, `mailto:` or site-relative;
 * anything else renders as the literal Markdown it was written as.
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

export function MarkdownText({ source, className, checklist = false }: {
  source: string;
  className?: string;
  /** A bullet list as a list of things to make true: a box per line. */
  checklist?: boolean;
}) {
  const refs = useContext(Refs);
  const blocks = useMemo(() => parseBlocks(source), [source]);
  const pattern = useMemo(() => (refs ? refPattern(refs.prefixes) : null), [refs]);
  const text = (value: string, key: string) => inline(value, key, refs && pattern ? { ...refs, pattern } : null);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm leading-relaxed", className)}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          return (
            <h3
              key={key}
              className={cn(
                "font-semibold text-foreground",
                block.level <= 2 ? "text-base" : "text-sm",
              )}
            >
              {text(block.text, key)}
            </h3>
          );
        }
        if (block.kind === "code") {
          return (
            <pre
              key={key}
              className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-xs"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "quote") {
          return (
            <blockquote
              key={key}
              className="border-l-2 border-border pl-3 text-muted-foreground"
            >
              {text(block.text, key)}
            </blockquote>
          );
        }
        if (block.kind === "list") {
          if (checklist && !block.ordered) {
            return (
              <ul key={key} className="m-0 flex list-none flex-col gap-1.5 p-0" data-checklist="">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`} className="flex min-w-0 items-start gap-2">
                    <Square aria-hidden className="mt-[0.3em] size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">{text(item, `${key}-${i}`)}</span>
                  </li>
                ))}
              </ul>
            );
          }
          const items = block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{text(item, `${key}-${i}`)}</li>
          ));
          return block.ordered ? (
            <ol key={key} className="ml-5 list-decimal space-y-0.5">
              {items}
            </ol>
          ) : (
            <ul key={key} className="ml-5 list-disc space-y-0.5">
              {items}
            </ul>
          );
        }
        return <p key={key}>{text(block.text, key)}</p>;
      })}
    </div>
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

// --- Blocks -------------------------------------------------------------------

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: (heading[1] ?? "#").length, text: (heading[2] ?? "").trim() });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = out[out.length - 1];
      if (last && last.kind === "quote") last.text = `${last.text} ${quote[1] ?? ""}`;
      else out.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = bullet ? null : /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = bullet === null;
      const item = ((bullet ?? numbered)?.[1] ?? "").trim();
      const last = out[out.length - 1];
      if (last && last.kind === "list" && last.ordered === ordered) last.items.push(item);
      else out.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out;
}

// --- Inline spans -----------------------------------------------------------------

/** Inline spans: code, bold, emphasis, links. Split on the token pattern so the
 * delimiters survive as their own parts, then each part becomes an element —
 * never a string of markup. */
const INLINE_TOKEN =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]*\]\([^)\s]+\))/g;

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
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
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

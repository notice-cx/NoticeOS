import { fireEvent, render, screen, within } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MarkdownText, TaskTextRefsProvider, taskListItems, toggleTaskListLine } from "@/routes/tasks/task-markdown";

// The task renderer on its own: Markdown in, React elements out, every shape
// allowlisted. Invented text throughout.

function draw(source: string, props: Partial<Parameters<typeof MarkdownText>[0]> = {}, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  return render(<MemoryRouter>{wrap(<MarkdownText source={source} {...props} />)}</MemoryRouter>);
}

const withRefs = (node: ReactNode) => (
  <TaskTextRefsProvider value={{ prefixes: ["os"], taskHref: (id) => `/tasks/${id}`, repoUrl: null }}>{node}</TaskTextRefsProvider>
);

describe("tables", () => {
  const source = [
    "| Page | Visits | Note |",
    "| :--- | ---: | :-: |",
    "| `/a` | 1,204 | **up** |",
    "| /b | 98 | a \\| b |",
  ].join("\n");

  it("draws a header row and body rows, in a box that scrolls sideways", () => {
    const { container } = draw(source);
    const box = container.querySelector("[data-md-table]") as HTMLElement;
    expect(box.className).toContain("overflow-x-auto");
    const table = within(box).getByRole("table");
    expect(table.className).toContain("tabular-nums");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Page", "Visits", "Note"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["/a", "1,204", "up"],
      ["/b", "98", "a | b"],
    ]);
    // Cells go through the inline renderer.
    expect(within(rows[0]!).getByText("/a").tagName).toBe("CODE");
    expect(within(rows[0]!).getByText("up").tagName).toBe("STRONG");
  });

  it("aligns a column the way its separator says", () => {
    draw(source);
    const [page, visits, note] = screen.getAllByRole("columnheader");
    expect(page!.className).toContain("text-left");
    expect(visits!.className).toContain("text-right");
    expect(note!.className).toContain("text-center");
    expect(screen.getByRole("cell", { name: "1,204" }).className).toContain("text-right");
    // Header cells are the eyebrow's size in the muted ink.
    expect(page!.className).toMatch(/text-micro/);
    expect(page!.className).toContain("text-muted-foreground");
  });

  it("keeps a script in a cell as text", () => {
    const { container } = draw("| a | b |\n| --- | --- |\n| <script>alert(1)</script> | <img src=x onerror=alert(1)> |");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("cell", { name: "<script>alert(1)</script>" })).toBeInTheDocument();
  });

  it("reads a pipe line without a separator as a paragraph", () => {
    const { container } = draw("a | b\nc | d");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("a | b c | d");
  });

  it("pads a short row, and ends at a blank line", () => {
    const { container } = draw("| a | b |\n|---|---|\n| 1 |\n\nAfter.");
    expect(within(container.querySelector("tbody") as HTMLElement).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["1", ""]);
    expect(screen.getByText("After.").closest("p")).not.toBeNull();
  });

  it("draws task ids and paths in a cell as chips", () => {
    const { container } = draw("| Task | File |\n|---|---|\n| os-8f7p.2 | apps/a/b.tsx |", {}, withRefs);
    expect(screen.getByRole("link", { name: "os-8f7p.2" })).toHaveAttribute("href", "/tasks/os-8f7p.2");
    expect(container.querySelector("td [data-path-ref]")?.textContent).toBe("apps/a/b.tsx");
  });
});

describe("task lists", () => {
  it("draws a ticked item as a filled check with its text struck through, an unticked one as an empty box", () => {
    const { container } = draw("- [x] Facts render\n- [ ] Undo works\n- [X] Shout ticks too");
    const items = [...container.querySelectorAll("[data-task-item]")];
    expect(items.map((item) => item.getAttribute("data-task-item"))).toEqual(["done", "open", "done"]);
    expect(items.map((item) => item.textContent)).toEqual(["Facts render", "Undo works", "Shout ticks too"]);
    const done = items[0] as HTMLElement;
    expect(done.querySelector('[data-task-box="done"] span')?.className).toContain("bg-healthy");
    const text = (item: Element) => item.querySelector("span[id]") as HTMLElement;
    expect(text(done)).toHaveTextContent("Facts render");
    expect(text(done).className).toMatch(/line-through/);
    expect(text(done).className).toContain("text-muted-foreground");
    expect(text(items[1]!).className).not.toMatch(/line-through/);
    // Read-only, the box states its state rather than offering a press.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Done" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Not done" })).toBeInTheDocument();
  });

  it("makes each box a button named by its line that reports the line it toggles", () => {
    const onToggleTask = vi.fn();
    draw("Intro.\n\n- [ ] First\n- [x] Second", { onToggleTask });
    const first = screen.getByRole("button", { name: "First" });
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Second" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(first);
    expect(onToggleTask).toHaveBeenCalledWith(2);
  });

  it("holds the buttons still while a toggle is written", () => {
    draw("- [ ] First", { onToggleTask: () => undefined, toggleDisabled: true });
    expect(screen.getByRole("button", { name: "First" })).toBeDisabled();
  });

  it("keeps a box per plain bullet under checklist, with no state", () => {
    const { container } = draw("- Facts render\n- Undo works", { checklist: true });
    const list = container.querySelector("[data-checklist]") as HTMLElement;
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Facts render", "Undo works"]);
    expect(list.querySelector("[data-task-item]")).toBeNull();
    expect(list.querySelectorAll("svg")).toHaveLength(2);
  });

  it("counts the ticked and unticked items, nested ones included, and skips markers in code and quotes", () => {
    const source = "- [x] One\n  - [ ] One a\n- Plain\n\n```\n- [ ] Not a task\n```\n\n> - [ ] Quoted\n\n1. [x] Numbered";
    expect(taskListItems(source)).toEqual({
      total: 3,
      done: 2,
      lines: [
        { index: 0, done: true, text: "One" },
        { index: 1, done: false, text: "One a" },
        { index: 10, done: true, text: "Numbered" },
      ],
    });
    expect(taskListItems("No list at all.")).toEqual({ total: 0, done: 0, lines: [] });
  });

  it("flips exactly the line it is given and nothing else", () => {
    const source = "Intro with [ ] brackets.\n\n- [ ] First\n- [x] Second\n- [ ] Third";
    expect(toggleTaskListLine(source, 2)).toBe("Intro with [ ] brackets.\n\n- [x] First\n- [x] Second\n- [ ] Third");
    expect(toggleTaskListLine(source, 3)).toBe("Intro with [ ] brackets.\n\n- [ ] First\n- [ ] Second\n- [ ] Third");
    expect(toggleTaskListLine(toggleTaskListLine(source, 4), 4)).toBe(source);
    // A line with no marker, a line past the end, and a marker inside code are left alone.
    expect(toggleTaskListLine(source, 0)).toBe(source);
    expect(toggleTaskListLine(source, 99)).toBe(source);
    const fenced = "```\n- [ ] code\n```";
    expect(toggleTaskListLine(fenced, 1)).toBe(fenced);
  });

  it("keeps the source's line breaks, indentation and an upper-case tick it unticks", () => {
    expect(toggleTaskListLine("- [X] a\r\n  * [ ] b\r\n", 0)).toBe("- [ ] a\r\n  * [ ] b\r\n");
    expect(toggleTaskListLine("- [X] a\r\n  * [ ] b\r\n", 1)).toBe("- [X] a\r\n  * [x] b\r\n");
    expect(toggleTaskListLine("1. [ ] step", 0)).toBe("1. [x] step");
  });
});

describe("nested lists", () => {
  it("nests an item indented two or more spaces under the item above, in order", () => {
    const { container } = draw("- one\n  - one a\n  - one b\n    1. deep\n- two\n\t- two a");
    const outer = container.querySelector("ul") as HTMLElement;
    const top = [...outer.children].map((item) => item.firstChild?.textContent);
    expect(top).toEqual(["one", "two"]);
    const one = outer.children[0] as HTMLElement;
    const child = one.querySelector("ul") as HTMLElement;
    expect([...child.children].map((item) => item.firstChild?.textContent)).toEqual(["one a", "one b"]);
    const deep = child.children[1]!.querySelector("ol") as HTMLElement;
    expect(within(deep).getByRole("listitem")).toHaveTextContent("deep");
    // A tab indents as far as two spaces do.
    expect((outer.children[1] as HTMLElement).querySelector("ul li")).toHaveTextContent("two a");
  });

  it("mixes numbers and bullets, a number keeping where it starts", () => {
    const { container } = draw("3. third\n   - a note\n4. fourth\n- loose bullet");
    const ordered = container.querySelector("ol") as HTMLElement;
    expect(ordered).toHaveAttribute("start", "3");
    expect([...ordered.children].map((item) => item.firstChild?.textContent)).toEqual(["third", "fourth"]);
    expect(ordered.querySelector("li ul li")).toHaveTextContent("a note");
    // A bullet after the numbers at the same depth is a list of its own.
    expect(container.querySelectorAll(":scope > div > ul")).toHaveLength(1);
    expect(container.querySelector(":scope > div > ul li")).toHaveTextContent("loose bullet");
  });

  it("nests task items and draws chips inside list items", () => {
    const { container } = draw("- [ ] parent os-ab12c\n  - [x] child in docs/x.md", {}, withRefs);
    const parent = container.querySelector('[data-task-item="open"]') as HTMLElement;
    expect(within(parent).getByRole("link", { name: "os-ab12c" })).toHaveAttribute("href", "/tasks/os-ab12c");
    expect(parent.querySelector('[data-task-item="done"] [data-path-ref]')?.textContent).toBe("docs/x.md");
  });

  it("keeps a numbered task item's number", () => {
    const { container } = draw("1. [x] Ship\n2. [ ] Read back");
    const items = [...container.querySelectorAll("ol > li")];
    expect(items.map((item) => item.getAttribute("data-task-item"))).toEqual(["done", "open"]);
    for (const item of items) expect(item.className).not.toMatch(/\bflex\b/);
  });

  it("continues an item's text on an indented line under it", () => {
    const { container } = draw("- first line\n  carries on\n- second");
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["first line carries on", "second"]);
  });
});

describe("headings, rules and strikethrough", () => {
  it("keeps each heading's level in its element, never as large as the page title", () => {
    draw("# One\n\n## Two\n\n### Three\n\n#### Four");
    const one = screen.getByRole("heading", { level: 2, name: "One" });
    expect(one.className).toContain("text-base");
    expect(screen.getByRole("heading", { level: 3, name: "Two" }).className).toContain("text-base");
    expect(screen.getByRole("heading", { level: 4, name: "Three" }).className).toContain("text-sm");
    expect(screen.getByRole("heading", { level: 5, name: "Four" }).className).toContain("text-sm");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("draws --- and *** as a thin rule, and a dashed bullet stays a bullet", () => {
    const { container } = draw("Above.\n\n---\n\nMiddle.\n\n***\n\n- item");
    const rules = container.querySelectorAll("hr");
    expect(rules).toHaveLength(2);
    expect(rules[0]!.className).toContain("border-border");
    expect(screen.getByRole("listitem")).toHaveTextContent("item");
  });

  it("strikes ~~text~~ through", () => {
    draw("Was ~~three days~~ two.");
    expect(screen.getByText("three days").tagName).toBe("DEL");
  });
});

describe("images", () => {
  it("draws an image from an https address as a lazy figure captioned by its alt", () => {
    const { container } = draw("Before.\n\n![The board at noon](https://example.com/board.png)");
    const figure = container.querySelector("figure") as HTMLElement;
    const img = within(figure).getByRole("img", { name: "The board at noon" });
    expect(img).toHaveAttribute("src", "https://example.com/board.png");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img.className).toContain("max-w-full");
    expect(figure.querySelector("figcaption")).toHaveTextContent("The board at noon");
    expect(figure.querySelector("figcaption")!.className).toContain("text-muted-foreground");
    // A paragraph cannot hold a figure.
    expect(figure.closest("p")).toBeNull();
  });

  it("writes any other scheme or a relative path out as the Markdown it was", () => {
    const sources = ["![x](javascript:alert(1))", "![x](data:image/png;base64,AAAA)", "![x](/files/a.png)", "![x](a.png)"];
    for (const source of sources) {
      const { container, unmount } = draw(source);
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toBe(source);
      unmount();
    }
  });

  it("draws an image inside a link as just the image", () => {
    const { container } = draw("[![Chart](https://example.com/c.png)](https://example.com/full)");
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByRole("img", { name: "Chart" })).toHaveAttribute("src", "https://example.com/c.png");
  });
});

describe("links stay allowlisted", () => {
  it("writes a javascript: link out as text, and makes the safe ones links", () => {
    const { container } = draw("[bad](javascript:alert(1)) [ok](https://example.com) [here](/tasks)");
    expect(container.textContent).toContain("[bad](javascript:alert(1))");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByRole("link", { name: "ok" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "here" })).toHaveAttribute("href", "/tasks");
  });
});

describe("callouts", () => {
  it.each([
    ["> **Note.** Read it twice.", "note", "Note", "Read it twice."],
    ["> **Note:** Read it twice.", "note", "Note", "Read it twice."],
    ["> **Warning.** It deletes rows.", "warning", "Warning", "It deletes rows."],
    ["> **Tip:** Press Enter.", "tip", "Tip", "Press Enter."],
    ["> [!NOTE]\n> Read it twice.", "note", "Note", "Read it twice."],
    ["> [!WARNING]\n> It deletes rows.", "warning", "Warning", "It deletes rows."],
    ["> [!TIP]\n> Press Enter.", "tip", "Tip", "Press Enter."],
  ])("draws %j as a %s aside", (source, tone, word, body) => {
    const { container } = draw(source);
    const note = screen.getByRole("note");
    expect(note.tagName).toBe("ASIDE");
    expect(note).toHaveAttribute("data-callout", tone);
    expect(note.className).toContain("bg-muted");
    expect(within(note).getByText(word).tagName).toBe("STRONG");
    expect(note).toHaveTextContent(`${word}${body}`);
    expect(note.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("draws a warning in the warn ink and a note in plain ink", () => {
    draw("> **Warning.** Careful.\n\n> **Note.** Fine.");
    const [warning, note] = screen.getAllByRole("note");
    expect(within(warning!).getByText("Warning").className).toContain("text-warn");
    expect(warning!.querySelector("svg")?.getAttribute("class")).toContain("text-warn");
    expect(within(note!).getByText("Note").className).not.toContain("text-warn");
  });

  it("leaves any other quote a quote", () => {
    const { container } = draw("> Just a quote.\n> **Bold** inside.");
    expect(screen.queryByRole("note")).toBeNull();
    expect(container.querySelector("blockquote")).toHaveTextContent("Just a quote. Bold inside.");
  });
});

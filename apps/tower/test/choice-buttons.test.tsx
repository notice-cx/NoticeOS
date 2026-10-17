import { fireEvent, render, screen, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import type { TaskChoices } from "@noticeos/contract/task-choices";
import { ChoiceButtons, choiceOrder } from "@/components/ChoiceButtons";

// ChoiceButtons on its own, with invented options: the order, the press, the
// record a pick leaves and the face a workspace that cannot pick sees.

const CHOICES: TaskChoices = {
  question: "What happens to the retired recipe page?",
  options: [
    { key: "a", label: "Keep the old page", detail: "It stays reachable at its address." },
    { key: "b", label: "Redirect to the new page", detail: "A permanent redirect keeps its search traffic.", recommended: true },
    { key: "c", label: "Remove it" },
  ],
};

const optionKeys = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-choice-option]")].map((node) => node.dataset.choiceOption);

describe("ChoiceButtons", () => {
  it("draws the question, then the recommended option first with a star and the word Recommended, the rest in key order", () => {
    const { container } = render(<ChoiceButtons choices={CHOICES} onChoose={() => undefined} />);
    const group = screen.getByRole("group", { name: CHOICES.question });
    expect(optionKeys(container)).toEqual(["b", "a", "c"]);
    expect(choiceOrder(CHOICES).map((option) => option.key)).toEqual(["b", "a", "c"]);
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "(b) Redirect to the new page", "(a) Keep the old page", "(c) Remove it",
    ]);
    const recommended = buttons[0]!;
    expect(recommended).toHaveAttribute("data-choice-recommended");
    expect(within(recommended).getByText("Recommended")).toBeInTheDocument();
    expect(recommended.querySelector("svg")).not.toBeNull();
    // The detail sits under its label and describes the button.
    expect(recommended).toHaveAccessibleDescription("Recommended A permanent redirect keeps its search traffic.");
    expect(buttons[1]).toHaveAccessibleDescription("It stays reachable at its address.");
    expect(within(buttons[1]!).queryByText("Recommended")).toBeNull();
  });

  it("is a 44 px target for each option, one column when the space is a phone's", () => {
    const { container } = render(<ChoiceButtons choices={CHOICES} onChoose={() => undefined} />);
    for (const button of screen.getAllByRole("button")) expect(button.className).toMatch(/\bmin-h-11\b/);
    // The columns are fitted to the box: none fit beside another under 13rem.
    expect(container.querySelector("ul")!.className).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))]");
  });

  it("hands back the pressed option with the note, then clears the note", () => {
    const onChoose = vi.fn();
    render(<ChoiceButtons choices={CHOICES} onChoose={onChoose} />);
    const note = screen.getByLabelText("Note");
    fireEvent.change(note, { target: { value: "  Keep the redirect for a year.  " } });
    fireEvent.click(screen.getByRole("button", { name: "(c) Remove it" }));
    expect(onChoose).toHaveBeenCalledWith("c", "Keep the redirect for a year.");
    expect(note).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "(b) Redirect to the new page" }));
    expect(onChoose).toHaveBeenLastCalledWith("b", undefined);
  });

  it("seats the caller's verbs beside the note, under the options", () => {
    render(<ChoiceButtons choices={CHOICES} onChoose={() => undefined} footer={<button type="button">Answer</button>} />);
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(answer.parentElement).toContainElement(screen.getByLabelText("Note").closest("span"));
  });

  it("draws a recorded pick as a record: nothing to press, the chosen option filled, the others muted", () => {
    const { container } = render(<ChoiceButtons choices={CHOICES} chosen="a" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Note")).toBeNull();
    expect(container.querySelector("[data-choice-buttons]")).toHaveAttribute("data-choice-buttons", "chosen");
    const chosen = container.querySelector<HTMLElement>('[data-choice-option="a"]')!;
    expect(chosen).toHaveAttribute("data-choice-chosen");
    expect(chosen).toHaveAttribute("aria-current", "true");
    expect(chosen.className).toContain("bg-accent-soft");
    expect(within(chosen).getByText("Chosen")).toHaveClass("sr-only");
    const other = container.querySelector<HTMLElement>('[data-choice-option="b"]')!;
    expect(other).not.toHaveAttribute("data-choice-chosen");
    expect(other.className).not.toContain("bg-accent-soft");
    expect(optionKeys(container)).toEqual(["b", "a", "c"]);
  });

  it("draws options it cannot send as disabled buttons, with the reason written under them", () => {
    const onChoose = vi.fn();
    render(<ChoiceButtons choices={CHOICES} onChoose={onChoose} disabledReason="Unavailable in this workspace." />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(expect.stringContaining("Unavailable in this workspace."));
    }
    expect(screen.queryByLabelText("Note")).toBeNull();
    fireEvent.click(buttons[0]!);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("points at a reason the page already writes instead of repeating it", () => {
    render(
      <>
        <p id="elsewhere">Make changes from the local NoticeOS.</p>
        <ChoiceButtons choices={CHOICES} onChoose={() => undefined} disabledReason="Make changes from the local NoticeOS." describedBy="elsewhere" />
      </>,
    );
    expect(screen.getAllByText("Make changes from the local NoticeOS.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "(c) Remove it" })).toHaveAccessibleDescription("Make changes from the local NoticeOS.");
  });
});

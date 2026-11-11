// @vitest-environment node
import { expect, it } from "vitest";
import { toLiveTask } from "../../../scripts/task-row.mjs";

/** One task row as a list read reports it, with every field the conversion reads. */
const LIST_ROW = {
  id: "ro-aaa",
  title: "A task the board renders",
  description: "why",
  acceptance_criteria: "how we know",
  status: "open",
  priority: 1,
  issue_type: "task",
  assignee: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  labels: ["tower", "tasks"],
  dependencies: [
    { issue_id: "ro-aaa", depends_on_id: "ro-epic", type: "parent-child" },
    { issue_id: "ro-aaa", depends_on_id: "ro-bbb", type: "blocks" },
  ],
  comment_count: 2,
  metadata: { reindex_kind: "finding", reindex_key: "item-openers" },
  parent: "ro-epic",
};

it("reads a parent off the dependency edge when the row sends no parent field", () => {
  const task = toLiveTask({ ...LIST_ROW, parent: undefined }, new Set<string>());
  expect(task.parent).toBe("ro-epic");
  // A list read's edge carries neither the other task's title nor its status;
  // a single-task read embeds the whole task and carries both. The null says
  // which read this one came from.
  expect(task.dependencies).toEqual([
    { id: "ro-epic", type: "parent-child", title: null, status: null },
    { id: "ro-bbb", type: "blocks", title: null, status: null },
  ]);
});

it("keeps what a single-task read knows that a list read does not", () => {
  // A blocker's own status decides whether it is still in the way, and a
  // claim is dated by when it was claimed.
  const task = toLiveTask(
    { id: "ro-aaa", started_at: "2026-09-03T08:00:00Z", dependencies: [{ id: "ro-bbb", title: "The lane", dependency_type: "blocks", status: "closed" }] },
    new Set<string>(),
  );
  expect(task.startedAt).toBe("2026-09-03T08:00:00.000Z");
  expect(task.dependencies).toEqual([{ id: "ro-bbb", type: "blocks", title: "The lane", status: "closed" }]);
});

it("titles a human gate with the ask it holds, the way the snapshot does", () => {
  // A gate's ask is in its description; its title is always "Gate: human".
  const gate = {
    id: "ro-g1",
    title: "Gate: human",
    issue_type: "gate",
    await_type: "human",
    description: "Ad-hoc gate blocking ro-aaa\n\nReason: Approve the price change",
  };
  expect(toLiveTask(gate, new Set<string>()).title).toBe("Approve the price change");
  expect(toLiveTask({ ...gate, description: "Ad-hoc gate blocking ro-aaa" }, new Set<string>()).title).toBe("Review approval for ro-aaa");
  // Only a human gate is an ask: a timer gate and a task that happens to
  // say "Reason:" keep their titles.
  expect(toLiveTask({ ...gate, await_type: "timer" }, new Set<string>()).title).toBe("Gate: human");
  expect(toLiveTask({ id: "ro-t", title: "Write the FAQ", await_type: null, description: "Reason: users ask" }, new Set<string>()).title)
    .toBe("Write the FAQ");
});

it("uses available blocked context for generic or absent approval titles without altering reasons", () => {
  const held = { id: "ro-held", title: "Publish the documentation", dependencies: [{ depends_on_id: "ro-gate", type: "blocks" }] };
  for (const title of [undefined, "", "  ", "Gate: human", "gate : HUMAN"]) {
    const gate = { id: "ro-gate", title, issue_type: "gate", await_type: "human", description: "Reason:   " };
    const shown = toLiveTask(gate, new Set<string>(), [held]);
    expect(shown.title).toBe("Review approval for Publish the documentation");
    expect(shown.description).toBe("Reason:");
    expect(shown.awaitType).toBe("human");
    expect(shown.ready).toBe(false);
  }
  expect(toLiveTask({ id: "ro-gate", issue_type: "gate", await_type: "human" }, new Set<string>()).title).toBe("Review approval request");
  expect(toLiveTask({ id: "ro-gate", title: "Approve the documented action", await_type: "human" }, new Set<string>()).title).toBe("Approve the documented action");
});

it("renders a task in a status this build has never seen", () => {
  const task = toLiveTask({ id: "ro-x", status: "marinating" }, new Set<string>());
  expect(task.status).toBe("marinating");
  expect(task.title).toBe("ro-x");
  expect(task.priority).toBe(2);
});

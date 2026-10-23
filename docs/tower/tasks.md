---
title: "Tasks"
description: "The shared board of work across your projects: what to do first and why, every project by asset, every task, and how to file one."
---

# Tasks

A **task** is one piece of work, for an asset or for the **System** (this installation's own NoticeOS), with its status, owner, blockers and the evidence it was closed with. People and AI agents share the same tasks, each asset in its own project. The **Tasks** page shows every project at once. How tasks connect to changes and outcomes is in [Tasks and agents](/concepts/tasks-and-agents).

The page has three tabs, in a strip named **Task views**:

- **Next**, at `/tasks`: the decision to take first and why, your other decisions ranked by what each is worth, what the agents take next, and what is held back.
- **Projects**, at `/tasks/projects`: every project of every asset, as cards or on one time axis.
- **All tasks**, at `/tasks/all`: the board, with its charts, filters and every task. The tab carries the number of open tasks across every project.

Each tab has its own address, so a link opens it. A link with a **Project**, **Status**, **Priority**, label, **Assignee** or epic in its query, such as `/tasks?project=example.com`, opens **All tasks** with the same query; `/work`, the page's older address, does the same. **New task** is in the page's header on every tab.

## What you see

### Next

The tab starts with one sentence. When a decision waits on you, it says what kind of decision comes first and the strongest fact behind it, and leaves the task's title to **Next for you** under it: **Answer one question first: it holds about $640 a month.** when the task carries a card ([How the lists are ranked](#how-the-lists-are-ranked)), else **… first: 3 tasks wait on it.**, else **… first: it has waited 9 days.** A gate reads **Approve one request first …** and a question with options **Choose one option first …**. With nothing waiting on you, the sentence is **Nothing waits on you. Rewrite recipe titles is next for the agents.**, or **Nothing is queued.** when the agents have nothing either. When a project could not be read, it is **Couldn't read your decisions**.

Under the sentence is one line: **3 decisions for you · oldest 12d**, or **No decisions for you**, or **decisions unknown** when nothing measured it; a lower bound reads **at least 12**. The urgent, blocked and done counts and **Working now** are on **All tasks** and **Projects**, not here.

**Read it as a brief** opens three to five sentences, each with one button:

- the first two decisions, such as **example.com has waited 9 days for your call: Pick the page.** followed by the first fact behind it, with **Approve** for a gate, or **Answer** or **Choose**, which open the decision in [Focus](#focus); the task's title is a link to its page;
- the urgent task in progress, such as **example.com: Fix the checkout is urgent; Ada has been on it for 3h.**, with **Open**;
- the next ready task, such as **example.com: Rewrite recipe titles is next for the agents.**, with **Open**;
- the week's done, such as **5 tasks done this week, 2 more than last week by today.**, with **Agents →**.

A sentence whose fact the board does not hold is left out. The brief ends **Everything else can wait.** and, when tasks are held back, **4 tasks are held back, each for one reason →**, which moves to **Not now, and why**. The brief opens the way you last left it in this browser.

**Next for you** is the raised panel under the sentence: the decision to take first, whole. Its top line shows the asset's mark and name, the epic the task sits in with its progress, such as **Checkout redesign 3 of 7**, the epic's title a link to its page, and the kind of decision with how long it has waited: **Needs your choice · waiting 12d**, **Needs your answer** or **Needs your approval**. The title, a link to the task's page, shows up to three lines. Under it is why it is first: the card's note, **3 tasks wait on this answer.**, **Top priority.** or **High priority.** When the task carries a card, its figures follow in one row:

- **At stake**: the predicted change a month, such as **≈ $640 /mo · est.**
- **Likely to pay off**: a percent, with ten bars filled to it.
- **Your time**: your minutes to review, with the hours of build when the card records them, or **none**.
- **Signal in**: the time until the ledger shows whether it worked, in days under two weeks and in weeks from two weeks.
- **Kill date**, when the card has one.
- **Rank**: its place among your decisions, such as **1 of 4 · policy v1.0**.

**Why first?** opens the rest of the card: **Rank**, **Predicted change**, **Fully loaded cost**, **Durability**, **Kill criterion**, **Measured as** and **Revenue family**, each where the card records it, then **Evidence** (the part of the asset's page the task was filed from) and **Open the task →**. A task without a card shows no figures and no **Why first?**; where the task can be edited, **Add why it ranks** under the title links to its page. Under the figures are the buttons its row in **Your decisions** has: **Approve** for a gate; **Answer** and **Close as** for a question; for a question with options, one button per option with **Note**, **Answer** and **Close as** under them.

**Then, for you** lists your other decisions, with **Focus →** beside the heading. Its caption is **ranked by what each decision is worth, against the minutes it takes** when any decision carries a card, else **by what each answer releases, then the longest wait**. Each row shows its rank, the asset's mark, the title up to two lines, and a line on why (the card's note, how many tasks wait on the answer, the priority). On the right are the money, such as **≈ +$640 /mo** over **70% likely · 10 min of you** (nothing for a task without a card), how long the decision has waited as a bar and a figure (**12d**, **today** or **age unknown**), and the row's one button: **Approve** or **Answer**; a question with options shows them under the row, one button per option with the recommended one first, with **Answer** under them. **Close as** is in **Next for you**, on the task's page and on **All tasks**, not on these rows. The bar fills over 60 days and is drawn in the warning colour from 30 days. The list shows five rows, then **Show all 9**, and ends **That's every decision for you.** with the age of the reading.

**Agents, next up** (**what the agents take next, and why · nothing here needs you**) lists the tasks in progress first, then the ready tasks in rank order. Each row shows a green dot for a task in progress or a ring for a ready one, the asset's mark, the title and its state: **In progress · Ada · 3h**, **Ready · Ada next** or **Ready · nobody yet**, then why, and the money when the task carries a card. The list shows three rows, then **Show all**.

**Not now, and why** (**4 open tasks are held back · each for one reason**) lists every open task that is neither your decision nor the agents' next work, each with one reason: **Waits on Fix the import**, with **and 2 more** when more tasks hold it, or **Waits on another task** when the read holds no title for the task it waits on, the task it waits on a link to its page; **Parked until Nov 3**, or **Parked**; or, for a ready task whose card expects less a month than reviewing it costs, **≈ $40 /mo, under the $50 its review costs**. A task held back is still on **All tasks**. The list shows three rows, then **Show all**.

#### How the lists are ranked

A task's **card** records what the work is worth: the predicted change in ledger value a month, how likely it is to pay off, your minutes to review it, the days until the ledger shows whether it worked, how the change is measured, and the state and date at which it is given up. Agents write it through the task tools; you write it in **New task** or on the task's page.

**Next for you**, **Then, for you** and the ready tasks in **Agents, next up** put the tasks that carry a card first, highest score first, by policy v1.0 ([doc 04, Decision policy](../04-decision-policy.md)): the likelihood × the predicted change a month × the durability (1 when the card records none), divided by the review cost (your review minutes, at least one, priced at **Value of your time** in [Settings](/tower/settings)), divided by the weeks to signal, never fewer than two. The tasks without a card follow in the board's own order: the highest priority among the task and the work its answer releases, then how many tasks it releases, an approval before a question, then the task untouched longest. The ranking is worked out again on every read of the tasks.

### Focus

**Focus →** opens `/tasks/focus`: your decisions one at a time, in rank order. **Answer** or **Choose** in the brief opens it at that decision, and from an asset's **Tasks** tab it holds only that asset's decisions. The top line shows **Focus · 2 of 6 for you** with one dot per decision, and **Leave focus**, which goes back to the page Focus was opened from.

Under it are the asset, the epic with its progress (its title a link to its page), the kind of decision and how long it has waited, the title, why it is first, and the card's figures. A question with options shows the question and one large button per option, lettered **A**, **B**, **C** and on, with **Recommended** under the recommended one's label, and **Note** under the buttons. A gate shows **Approve**. Any other question shows **Your answer** and **Send**. **Not now** passes over the decision without answering it, and **After this: Rewrite recipe titles · example.com · 10 min** names the decision after it, its title a link to its page, with your minutes when its card records them. The keys are written at the bottom: **B A C choose · → skip**, the option letters in the order the buttons show them, or **Enter approve · → skip**.

After the last decision the page shows **That's every decision for you.** with **Back to Tasks**, and **Start over** when you passed over any.

### Projects

A project is an epic and its tasks, on its asset. The tab starts with one sentence: **3 assets, 12 projects. 2 wait on you, 1 urgent, 1 blocked.**, with each clause that counts zero left out, or **3 assets, 12 projects. Nothing waits on you.** Under it one bar splits the work by state, and its legend is the figures: **5 done this week** with its change chip, **4 in progress**, **9 ready**, **2 blocked** and **3 parked**. **Working now** with **Agents →** sits beside the bar.

**Where the work sits** follows, with the order as three pills in a group named **Order**: **Needs attention first** (the projects that need you first, the oldest question first, then urgent, blocked, in progress, ready, not started, parked and done, each group by its open work), **Most open work** and **A–Z**. The view is **Cards** or **Timeline**, in a group named **View**; **Timeline** is kept in the address as `?view=timeline`.

**Cards** shows one row per asset. On the left are the asset's mark and name, a link to its page, with **2 for you** (its projects that wait on you) and **14 open**, or **Couldn't read its tasks**. On the right is one card per project. An asset with no epics shows **No projects yet · 6 tasks**, and an asset's open tasks outside any epic show as **Not in a project · 3 open**; both open **All tasks** narrowed to the asset.

Each card shows:

- the kind of change the project makes, as an icon, and its title;
- a state chip: **Needs you · 7d** (a question or an approval in it waits on you, or an approval outside it holds one of its tasks), **Urgent** (an open task at top or high priority), **Blocked** (every task in it that could move is blocked or waits on another task), **In progress**, **Ready**, **Not started**, **Parked** or **Done**;
- a bar with one segment per task: done filled, in progress half filled, needs you outlined in the warning colour, blocked filled in the warning colour, ready and waiting as the empty track, parked and unplaced tasks hatched. A screen reader reads it as **9 tasks: 6 done, 1 needs you, 2 blocked**;
- the facts, such as **6 of 9 done · 2 blocked · ≈ $1,200 /mo at stake**: **No tasks yet** for a project with none, **stuck 21 days on one question** in place of the blocked count when its question is over 14 days old, the money its open tasks' cards add up to, and **Closed Oct 3** for a finished project;
- the next thing in it: the question that waits on you with its buttons (**Approve**, **Answer** with **Close as**, or **Choose**, which opens the options), or the next task with who holds it, such as **Rewrite recipe titles · Ada**, or **Rewrite recipe titles · nobody yet**.

A card that needs you has a rule along its top in the warning colour, an urgent one in the urgent colour, and a parked or unstarted one in grey. A card is wider the more open work it holds, and pressing it opens the project's page. The list ends **That's every project.** and, when open tasks hang off no epic, **5 open tasks sit in no project →**, which opens **All tasks**.

**Timeline** draws every project on one time axis, four weeks back and four ahead (**Every project, four weeks back and four ahead** for a screen reader). A line through every row marks today, labelled **Today · Oct 21**; a thin line marks each Monday with its date; the weeks ahead are tinted. Each row shows the project's title with the asset's mark, its state line, and its marks:

- a dot for each task closed in these weeks;
- a green span from a task's start to today for each task in progress;
- a span in the warning colour from the day a question was asked to today, labelled **Pick the page · waiting 12d**;
- hollow circles just past today, labelled **2 blocked**;
- a hatched circle on the day a parked task is due back, labelled **parked until Nov 3**;
- a dashed circle on the earliest kill date its tasks' cards name, labelled **Kill date Nov 18**.

A dashed line runs from today to the last mark ahead. A label with no room above or below the line is left out; its words stay in the row's description for a screen reader. The legend under the axis lists **Done**, **In progress**, **Waiting on you, from the day it was asked**, **Blocked**, **Planned** and **Parked**. On a narrow screen the axis scrolls sideways.

### All tasks

**Search task titles or ids** filters the available tasks by title or id, with the search kept as `q` in the address, such as `/tasks/all?q=retry+API%3A`. Matching ignores case, splits on whitespace and requires every term to occur in the title or id, in any order. Punctuation is literal: `API:` matches that punctuation, and an exact task id matches its row. Descriptions and comments are not searched.

Search runs over the records read before the table's 25-row display limit and combines with **Project**, **Status**, **Priority**, label and **Assignee**. Changing the search starts the table at its first page. Refreshing the page or returning from a task keeps the search and filters; **Clear filters** clears them together. An asset's **Tasks** tab keeps its project fixed during search and after clearing.

Live reads include closed tasks from the last 7 days. Saved snapshots include only the tasks listed in the snapshot, so search cannot cover the full task history. With no matches in a complete live read, the table shows **No task matches these filters.** A limited read shows **No matches in available records. The search is limited to the tasks read.** A failed project read shows **Search is incomplete: some projects could not be read.**, with the project failure and retry control above the table.

In the command palette, ordinary text offers **Search tasks for “…”**, which opens **All tasks** with that search. A task id still offers **Open task**. The palette does not fetch project task lists.

**All tasks** is the board: how big the queue is, and which tasks in it cannot move forward without you.

![The Tasks page in the synthetic demo: three decisions waiting for you, tasks closed and filed a day over 14 days, and work done this week and still open by project.](../images/tower-tasks.webp)

The board starts with a one-line summary: **No decisions for you**, or **3 decisions for you**, and under it a change chip against a week ago (an arrow, **2 vs a week ago** and **· 3 added** for how many new decisions arrived), **1 needs your approval** and how many tasks are open. Three figures follow: **Urgent**, **Blocked** and **Done this week**, each with its change chip: **vs a week ago** for **Urgent** and **Blocked** (the count now against seven days before, with how many entered it), **vs last week by today** for **Done this week** (this week so far against last week up to the same day and time). **Done this week** counts every closed task whose close time falls in this calendar week, Monday to Sunday in the installation's time zone, regardless of close reason; **Done last week** counts the same way over the week before. A week still running does not make its count a lower bound; **6 days in** under **In and out** is how far the week has run. A figure that did not move shows **level with a week ago**. More done is green; more decisions, urgent or blocked is red, and the arrow carries the direction without the colour. **Urgent** and **Blocked** a week ago come from the task history. **Done this week** and **Done last week** are counted from each closed task's own close time. All of them are the counts the Wall's **Work this week** shows, whether the board reads the task database live or from the saved snapshot; a board whose history holds no week yet shows the counts it read, with no chips.

**Your decisions** is the queue: how many decisions are waiting, the oldest one's age, and one bar splitting them by age (under 7 days, 7–30, 30–60, over 60). Each decision is a row with its age drawn as a length and its buttons: **Approve** for a gate that blocks work until you approve it, **Answer** or **Close as** for a question. A question that offers choices shows, under its title, the question and one button per option: the recommended option first, with a star and **Recommended**, then the others in the order a, b, c, each with its detail under its label. Under the options are **Note**, **Answer** and **Close as**. On a phone the options stack full width. A row's caption names the project and, for a gate, **needs your approval**, or, for a question with choices, **needs your choice**. Pressing the row opens its details in place. Under each row, **After your answer:** names the first two tasks the answer releases, each a link to its page, and counts the rest, such as **6 more tasks**. The queue ends with **That's every decision for you.**

**In and out** draws the last 14 days: tasks closed a day and tasks filed a day, each with a dashed line at its daily average, and one line stating whether more tasks were closed or filed over the days both were counted. Today is drawn hatched while it is still being counted. Under the strips, one bar draws **Done this week** against last week, as the Wall draws it: the bar filled to this week's done, a tick where **Done last week by today** stood and a thin line at **Done last week total**, beside how many days into the week today is (**6 days in**). A second line under the first states how the weeks compare, such as **3 more done this week than last week by today**. The strips count every close, whatever its resolution, by its UTC day.

**Work by project**, when the board shows more than one project, compares each project's week: done this week extending left over last week's done as a dashed outline, still open extending right, split into in progress, ready to start and blocked, with each project's high-priority count under its name.

**Epic** draws one epic's tasks as a graph under the epic's title, a link to its page: each task in its state (**Done**, **In progress**, **Ready**, **Waiting**, **Blocked**, **Needs attention**, **Parked**) and an arrow from each task to the task it blocks. **Done** nodes use neutral grey styling and keep their completion label and close age. An arrow from a blocked or parked task is drawn broken; an arrow from a decision of yours is labelled **needs attention**. The epic with the most blocked or parked tasks that block other tasks is shown first.

When the board draws more than one epic, a row of project cards above the graph, named **Epics**, picks which one it draws. Each card shows the kind of change as an icon, the title, a ring with one segment per task and the done count in its middle, labelled **6 of 9 done**, a state line such as **Needs you · 7d**, **Urgent**, **In progress · Ada**, **Ready**, **Parked** or **Done**, and the asset's mark and name. The picked card is outlined in the accent colour. The cards are in **Needs attention first** order; the row scrolls sideways, and **More projects** scrolls it on while more cards lie to the right.

![An epic drawn as a graph: tasks in their states, a moving dashed arrow from a task in progress to the task it blocks, and an arrow labelled needs attention from a decision.](../images/tasks-flow.webp)

**Filters**: **Project** (**Every project** or one), **Status** (**Any status**, then **Open**, **In progress**, **Blocked**, **Parked**, **Closed, last 7 days**, each with its count), **Priority**, **Assignee** and a label. The filters narrow the list, not the charts above it.

When filters hide every decision on **All tasks**, the queue shows **No decisions match these filters.** and keeps the whole board’s count; clearing the filters restores the rows. **No decisions for you.** is reserved for a fully read empty queue. **No decision details read.** means the count includes decisions but no row details were read. An unread project keeps **Waiting work is unknown for unread projects.**

**Working now**, under the summary, lists who holds tasks in progress and how many each holds, with a link, **Agents →**, to the [Agents](/tower/agents) page.

The table, headed **All tasks**, shows **Id**, **Project**, **Who** (the agent or person holding it, or **nobody**), **Age** and **State**, and **Close as** at the end of every row that is not closed, drawn faint until the row is pointed at; on a phone it is inside the opened row. **Select** sits beside the heading when two or more rows can be closed. Each row opens its task page at `/tasks/<id>`, with the full description and the evidence attached when it was closed. An opened row shows **Part of** and its epic's title, a link to the epic's page.

The board works on a new installation because it ships with the **System** project.

### A task's page

A task's page starts with where the task sits: **Tasks**, its project and its epic, each a link. **Tasks** keeps the filters the board had when the task was opened; a page opened from Home or an asset also shows **Back to Home** or **Back to asset**. Over the title are the type (**Task**, **Bug**, **Feature**, **Chore**, **Epic**, **Decision**, or **Approval** for a task that waits on your approval) and the id, and beside the title is the type's mark. The header of an open bug is tinted in the alert colour; every other header is neutral. Under the title are the state, the priority, who holds the task with the model they named and how long ago they claimed it, an epic's progress, and, for a decision of yours, **Needs your approval**, **Needs your answer** or **Needs your choice**. The actions sit beside the title, the next one first: **Approve**, or **Answer** and **Close as**, for a decision; **Claim** while nobody holds the task; **Close** once somebody does. A question with choices shows them directly under the header instead, as its row in **Your decisions** does: the question, one button per option with the recommended one first, then **Note**, **Answer** and **Close as**. Once an option is chosen, the header shows the choice in its place, such as **Chose (b) Redirect to the new page**, with who chose it, how long ago and their note, and the options with the chosen one filled and none of them pressable. A closed task shows **Close reason** directly under the header: who closed it, the model they named, how long ago, and the reason they gave. A task closed with nothing shipped shows its resolution there instead, such as **Closed as Won't do**, with who closed it, how long ago and their note; **Closed as Duplicate of** links the other task's page. A decision closed by a choice shows the choice and no **Close reason**, because its reason is the same words.

On a laptop **Why it ranks** (when the task carries a card), the description, **Done when**, the tasks it waits on, **Related**, an epic's tasks and **Activity** fill the left column, and the facts fill the right: **Project**, **Parent epic**, **Status**, **Priority**, **Kind**, **Assignee**, **Labels**, **Parked until**, **Came from** and **Ages**. On a phone the facts wrap as one row of chips under the header. **Kind** is the kind of change the task makes: **Content data**, **Copy**, **Template**, **Feature**, **Infrastructure**, or **Not recorded**.

**Why it ranks** shows the card's figures as **Next for you** does (**At stake**, **Likely to pay off**, **Your time**, **Signal in** and **Kill date**), then who recorded the card and when, such as **recorded by Ada · Oct 20**, and the card's note. A task without a card shows **Not ranked: no card says what it is worth.** beside **Description**, with **Add why it ranks** where the task can be edited.

Once a task with a card closes as done, **Why it ranks** shows the card as it was at that close, with **as shipped · Oct 21** beside the heading in place of **Edit**. The section shows no later card, also after the task is reopened, and the card stays as it shipped ([What a task is worth](../../config/beads.README.md#what-a-task-is-worth)).

The description, **Done when** and every comment are drawn as Markdown: headings at every level, paragraphs, nested bulleted and numbered lists, `- [ ]` task lists, tables, quotes, code, horizontal rules, bold, italics, strikethrough, links and images. An image from an `http` or `https` address is drawn with its alt text as its caption. A quote that starts with a bold **Note.**, **Warning.** or **Tip.**, or with `[!NOTE]`, `[!WARNING]` or `[!TIP]`, is drawn as a callout with that word and its icon, a warning in the warning colour. Raw HTML shows as text; a link is made only to an `http` or `https` address, a `mailto:` address or an address on this asset, and anything else shows as written. A description written in the task guide's labels (`WHAT:`, `WHY:`, `WHERE:`, `FIX:`, `ORDER:`, `CONSTRAINT:` and a `## Steps to Reproduce` heading) shows each label over its text; a description without them shows as written. File paths show as code chips, and a task id of a known project links to its page.

**Done when** draws each `- [ ]` and `- [x]` line as a box with its text, and beside the heading how many are ticked, such as **2 of 5**. A ticked box is a green check with its text struck through. Any other line that starts with a dash has an empty box beside it.

When the task waits on other tasks, or other tasks wait on it, a graph shows them: **Blocked by** on the left, **This task** in the middle and **Blocks** on the right, each card in its task's state with an arrow along each link. An arrow from a blocked or parked task is drawn broken, and one from a task in progress moves. Each card opens its task's page. The graph counts only the links that keep a task from being ready (blocks, waits-for and conditional-blocks). **Related** lists every other task linked to this one, such as a related task or the task this one was discovered from, whichever task recorded the link, each row opening its task's page.

**Activity** draws when the task was filed, claimed, commented on and closed on a time axis that ends at **Now**, then lists the same moments in time order: who did each, with the model they named and their agent's mark, each comment's text, and a close's reason with its commits as chips. A close with nothing shipped reads with its resolution, such as **Closed as Won't do by Dana**. The comment box is the last item; it shows **Comment · Markdown: tables, images and checklists work; task ids and paths become links** until you type.

An epic's page lists the epic's tasks under **Tasks**, grouped by the states the **Epic** graph draws (**Needs attention**, **In progress**, **Ready**, **Waiting**, **Not started**, **Blocked**, **Parked**, **Done**) and sorted by priority inside each group. Each row shows the task's state mark, id, title, who holds it with the model they named, and its priority mark, and opens the task's page. The header shows a bar with one segment per task, and **2 of 7 closed**: the epic's closed tasks against all its tasks. Closed tasks are filled, a task in progress is half filled, a blocked task is in the warning colour, and a task the page cannot place is hatched. The list holds the tasks closed in the last 7 days; a line under it, such as **3 more, closed over 7 days ago**, counts the older ones. **Epic graph →** opens this page's epic in the **Epic** graph, and appears only when the board draws a graph for it. A task in an epic shows the same bar under **Parent epic**, with this task ringed and the first task in the epic that can be claimed now marked with a dot; **Next ready:**, after the same dot, names that task.

## What you can do

- Answer the first decision in **Next for you**, with the same buttons as its row in **Your decisions**, or any other from its row in **Then, for you**, with its one button; to decline one of those, use **Close as** on its row in **All tasks** or on its page. An answered decision leaves every list on the page at once, and the message that follows carries **Undo**, as on the board.
- **Read it as a brief** opens and closes the brief; each sentence's button runs its action, and **Answer** or **Choose** opens Focus at that decision.
- **Why first?** opens the rest of the first decision's card. **Show all** shows every row of a list.
- **Focus →** opens Focus. Press an option, or its letter key; **Approve**, or Enter; or type **Your answer** and press **Send** or Enter (Shift and Enter starts a new line). What you type in **Note** first is sent with the option. **Not now**, or →, passes over the decision. Each answer carries the same **Undo** as on the board. **Leave focus** goes back, and **Start over** goes through the decisions you passed over.
- On **Projects**, pick an order and switch between **Cards** and **Timeline**. Answer a project's question from its card with the same buttons. Press a card, or a project's title on the timeline, to open the project's page.
- **Approve** a gate from its row.
- **Answer** a question: the box opens on the row, you type **Your answer** and select **Send**. On a task of type **Decision** the answer text becomes the note and the task closes. On any other task the answer is added as a comment that starts **Answered:**, the **human** label comes off, the assignee is cleared and the task goes back to ready work, where an agent claims it again.
- Close a task with nothing shipped: **Close as**, on a row in **Your decisions** or **All tasks**, lists **Won't do**, **Duplicate**, **Can't reproduce** and **Already handled**. Picking one opens one line under the row: **Note**, and for **Duplicate** first **Duplicate of**, the other task's id in the same project. Enter or **Close task** sends it; nobody has to hold the task. The message that follows names it, such as **Closed as Won't do**, and carries **Undo**, and the row leaves the list until the Undo window ends. The note becomes the close reason; with no note the reason is the resolution's words, such as **Duplicate of ex-a1b**. On a question, **Close as** declines it, as **Dismiss** did, and records the resolution picked. A duplicate is linked to the other task. Every close reason counts on [Agents](/tower/agents).
- Choose an option of a question with choices: press the option's button, on its row or on the task's page. What you type in **Note** before the press is sent with the choice. The message that follows names the option, such as **Chose (b) Redirect to the new page**, and carries **Undo**; until the Undo window ends the page shows the pressed option filled. The choice is recorded on the task with a comment that starts **Chose**. On a task of type **Decision** the task closes with the choice as its reason. On any other task the **human** label comes off, the assignee is cleared and the task goes back to ready work, where an agent claims it again. **Answer** under the options sends a typed answer instead.
- Decide several at once: **Select** beside **Your decisions** puts a checkbox on every row you can answer and shows every row. Tick rows, or **Select all**, then **Approve** sends every selected gate, **Answer** every selected question, and **Close as** with the count, such as **Close 3 as**, closes every selected question with one resolution and one note, as described for **All tasks** below. Each button shows how many rows it sends. **Answer** leaves out the questions with choices, and the count beside the selection names them, such as **4 selected · 2 need a choice**; each of those is chosen on its own row. **Close 3 as** includes them. One **Undo** takes the whole batch back. After the Undo window the rows are sent one at a time, and any that are refused are named in a message and return to the queue; a message naming one task carries **Open**, which opens its page. **Done** leaves without sending.
- Close several tasks at once: **Select** beside the **All tasks** table puts a checkbox on every row this workspace can close, and shows every row the filters match. The filters stay in force while you select, so **Status: Open**, a label and a project, then **Select all**, ticks exactly the rows they show. **Close as** with the count, such as **Close 3 as**, lists **Won't do**, **Duplicate**, **Can't reproduce** and **Already handled**; a batch never closes as **Done**. Picking one opens one line under the bar: one **Note** for every selected task, and for **Duplicate** first **Duplicate of**, one task id that every selected task becomes a duplicate of, with the line **All 3 become duplicates of this one task, which is rarely right.** under it. Enter or **Close 3 tasks** sends it. The message that follows names the resolution and the count, such as **Closed as Already handled · 3**, and carries one **Undo** for every selected task; the rows leave the table until the Undo window ends. Each task then gets the close its row's **Close as** sends, one at a time. A selected task that is already closed is counted beside the selection, such as **4 selected · 1 closed already**, left as it is and named in the message. A task whose close is refused is named in a **Not sent** message, with **Open** when it names one task, and returns to the table. **Done** leaves without closing anything. A question waiting on you is listed in **Your decisions**, not in this table, and is closed from that list's **Select**.
- Select a project's name in **Work by project** to narrow the list to it.
- Pick another epic by pressing its card in the **Epics** row; the arrow keys move the pick, and Home and End go to the first and last card. The choice is kept in the page's address. Select a task in the graph to open its page.
- On a task's page, **Claim** assigns the task to you. **Close** opens one row of five choices, **Done**, **Won't do**, **Duplicate**, **Can't reproduce** and **Already handled**, with **Done** picked. With **Done**, **What shipped, and the commit** takes the reason and **Close task** closes the task with it. With any other, one line takes a **Note**, and for **Duplicate** the other task's id, and **Close task** sends it with the same **Undo** a row's close has. When an action cannot run, the reason is written under it, such as **Unavailable in this workspace.** **Edit** beside **Description** or **Done when** edits it in place, and **Comment** adds what you type in the comment box.
- Record why a task ranks: **Edit** beside **Why it ranks**, or **Add why it ranks** on a task without a card, opens the card's form in place. A task that shipped its card shows **as shipped** there and no **Edit**. Its fields are **Predicted change a month** (USD), **Likely to pay off** (**30%**, **55%**, **75%**, **90%**, or a percent), **Your minutes to review**, **Signal in** (**2 weeks**, **4 weeks**, **8 weeks**, or a number of days), **Measured as** (**Cohort test**, **Holdout** or **Not measurable**), **Revenue family** (**Not recorded**, **Ads**, **Affiliate**, **Subscriptions** or **Licensing**), **Kill criterion** with **Kill if still true** and **Kill date**, and **Note**. **Save** writes the card; **Cancel** or Escape leaves it as it was. Once **Save** is pressed, a field at fault shows its rule under it, such as **Required** or **Must be between 1 and 99**, and the rule follows the typing from then on. The message that follows a save, **Saved — why it ranks**, carries **Undo**. The card's build minutes and durability, which the form does not show, stay as they were.
- Tick a box in **Done when**: where the task can be edited, each box is a button that writes its line back flipped, `- [ ]` to `- [x]` or back. The message that follows, **Saved — the acceptance criteria**, carries **Undo**.
- Each fact on the right is drawn as its value. Pressing **Status**, **Priority**, **Kind**, **Assignee** or the arrow beside **Parent epic** opens its choices; **Assignee** also takes a typed name under **Someone else**, and **Parent epic** a task id under **Another task id**. **Parked until** offers **Tomorrow**, **In a week**, **In a month**, a date, and **Not parked** while the task is parked. The dashed **Label** chip takes a new label, and the **×** on a label removes it. A choice or Enter saves at once, and the message that follows, such as **Saved — the kind**, carries **Undo**; Escape closes the choices without a change. Where the task cannot be edited, the facts show their values and nothing opens.
- **New task** opens the composer in place, on any tab. It has fields for a **Title** (**What should be true when this is done**), a **Project** and a **Priority**. **More** opens the rest:
  - **Type** and **Parent epic**;
  - **Kind of change**: **Not recorded**, **Content data**, **Copy**, **Template**, **Feature** or **Infrastructure**;
  - **Labels**;
  - a **Description** (**What, why with the numbers, where**), with **Write** and **Preview** beside it in a group named **Write or preview**: **Preview** draws the Markdown, or **Nothing to preview**, and the line under the field reads **Markdown: tables, images and checklists work; task ids and paths become links**;
  - **Done when** as lines (**The proof that it is done**): Enter adds a line under the current one, Backspace on an empty line removes it, and **Another line** adds one at the end. Each line is filed as a `- [ ]` line;
  - **Why it is worth doing** (**ranks the task · an agent can fill it in later**): **Predicted change, a month** in $ marked **est.**, **Likely to pay off** (**30%**, **55%**, **75%**, **90%**, or a percent), **Your minutes to review** (min), **Signal in** (**2 wk**, **4 wk**, **8 wk**, or days), **Measured as** (**Choose…**, **Cohort test**, **Holdout** or **Not measurable**), **Revenue family**, **Kill criterion** (a state and **Kill date**) and **Note**. Once the five figures are filled and pass their rules, the line under them shows the score, such as **Score 4.2 · policy v1.0**, with the figures as **Next for you** draws them; until then it shows **Fill the five figures to rank it.** A field at fault shows **Required**, **Must be between 1 and 99** or another **Must be …** rule under it. A task filed with this section left empty carries no card.

  **File task** files it.
- **File task** on a finding, from an asset's Overview, opens the same composer prefilled from the finding; the finding then shows a link to the filed task.
- **Add a task project**, on an asset's Tasks tab, opens **Settings** > **Task projects**.

## Answers and task maintenance

An owner answer applies to the proposal and scope the owner reviewed. An agent
can record an existing answer from the task or an explicitly linked
conversation with `reconcile_task`. A short reply such as **A** or **yes, your
recommendation** selects the matching option. A clear direction is recorded
as written. An uncertain reply leaves the decision open for one focused
clarification. A batch answer applies only to the tasks the owner named.

An answered question leaves **Your decisions**. A decision closes; unfinished
implementation returns to agent work without the old human label or
assignment. The answer does not mark implementation complete. The inbox opens
with five decisions and keeps the rest accessible. An open approval appears
once for its blocked task; epic containers and recorded choices are excluded.

Agents can retire completed, obsolete, explicitly superseded or duplicate
requests with concrete evidence and a plain explanation, or return routine
implementation work to agents. History retains the evidence and tasks can be
reopened. Retiring an approval grants no permission to perform the action.
Production reads and changes, spending, external messages, destructive actions
and material business or policy commitments require explicit approval of the
specific action and scope.

An agent can release an abandoned assignment after checking that its holder
stopped working and preserving its progress. Age alone does not release it.
Blocked and parked work retain that state when an assignment is released.

## States and labels

- A figure shown as **—** means the board could not read that project; it is never a zero. The summary line then shows **Couldn't read your decisions**.
- A count shown as **at least 12** is a lower bound: a project could not be read, or the snapshot holds only the first items of each list. Lower bounds use **at least N** throughout Tasks, such as **at least 12 decisions for you** or **at least 0**. **—** means nothing measured the count; **0** is a measured zero. A lower bound has no change chip.
- A task without a card is listed, not ranked: its row shows **small · not ranked**, **Next for you** and its page show **Not ranked: no card says what it is worth.**, and it follows the ranked tasks in the board's own order. It is never given a score.
- **age unknown** in place of a wait means the task records neither when it was filed nor when it last changed. It is never **today**.
- The task history counts a day from midnight to midnight UTC. The week starts on Monday in the installation's time zone; a close counts in the week its own close time falls in there.
- On a hosted view the board shows a **Read-only snapshot** banner: the rows are the last snapshot and the actions are off. **Filed a day** then shows **not in the saved snapshot**, and no epic graph is drawn, because the snapshot holds only the first tasks of each list. The snapshot records each listed task's links to other tasks and lists the first blocked tasks, those that wait on one of your decisions first: **Not now, and why** names the task a blocked task waits on where the snapshot lists that task, else **Waits on another task**, and what an answer releases counts only the tasks the snapshot lists. An epic's page there lists the epic's tasks the snapshot holds and counts the others, such as **4 tasks not in the saved snapshot**.
- On the read-only snapshot, **Next** shows the same **Read-only snapshot** banner. The buttons in **Next for you** and in Focus are drawn and cannot be pressed, with the reason under them: **Make changes from the local NoticeOS.**, or **Read only in this synthetic demo.** in the demo. The brief's **Approve** cannot be pressed either. The rows of **Then, for you** and the project cards show no buttons.
- A hatched day in **In and out** was not counted. It is never a zero.
- An asset with no project of its own shows **No task project for this asset** on its Tasks tab.

## Related guides

- [Connect a task project](/guides/connect-a-task-project)
- [Tasks and agents](/concepts/tasks-and-agents)
- [Home](/tower/home)
- How work is filed, verified and closed, in [doc 05, Execution, autonomy & accountability](../05-execution-and-accountability.md)

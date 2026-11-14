// Dated synthetic work, shared by the real hub import and its history seed.
import { createHash } from 'node:crypto';
import { TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';
import { TASK_CHOICE_KEYS, type TaskChoiceOption, type TaskChoices } from '../packages/contract/src/task-choices.mjs';
import type { TaskCard, TaskRevenueFamily } from '../packages/contract/src/task-card.mjs';
import type { TaskChangeClass } from '../packages/contract/src/task-change-class.mjs';

export type DemoTaskStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed';
/** `assignee` is null while nobody holds the task. */
export interface DemoTaskEvent { at: string; status: DemoTaskStatus; assignee: string | null; }
export interface DemoTaskFact {
  id: string; asset: string; prefix: string; title: string; description: string;
  acceptance: string; issueType: 'task' | 'bug' | 'decision' | 'epic' | 'gate'; priority: number;
  events: DemoTaskEvent[]; parent?: string; blocks?: string; dependsOn?: string;
  human?: boolean; deferUntil?: string;
  closeEvidence?: string;
  /** The model the holder named, recorded with its claim and, if it closed the task, its close. */
  model?: string;
  /** The kind of change the task makes; on an epic, the kind of project. */
  changeClass: TaskChangeClass;
  /** Recorded at its own `at`, after the task was filed. */
  card?: TaskCard & { readonly by: string; readonly at: string };
  /** Filed with the question it offers options for. */
  choices?: TaskChoices;
  steps?: readonly { text: string }[];
  comments: { author: string; text: string; at: string }[];
}
/** The demo's agents connect under these names: one builds, and a different
 * one checks the work before it counts. Mara is the operator. */
export const DEMO_BUILDER = 'claude';
export const DEMO_VERIFIER = 'codex';
const OPERATOR = 'Mara';
type Asset = { id: string; prefix: string; name: string; createdAt: string; revenueFamily?: TaskRevenueFamily | null; adRpm?: number };
const DAY = 86_400_000;
const HOUR = 3_600_000;
type TaskBrief = readonly [context: string, acceptance: string, opening: string, evidence: string];
/** When a task moved: days from the reference day, or hours before the
 * cutoff for work that moved within the last day. */
type When = number | `${number}h`;
type Owner = typeof DEMO_BUILDER | typeof DEMO_VERIFIER | typeof OPERATOR;
interface Plan {
  title: string; brief: TaskBrief; status: DemoTaskStatus; opened: When;
  started?: When; finished?: When; owner?: Owner;
  /** The builder's handoff note and the check its verifier ran. */
  note?: string; check?: string;
  /** Where on the site the change shows, after its domain. */
  path?: string;
  model?: string;
  /** Index of the task in the same project this one waits for. */
  dependsOn?: number;
  /** A human gate holding the task at this index. */
  gate?: number;
  steps?: readonly { text: string }[];
  request?: string;
  /** A question waiting on the operator. */
  human?: boolean;
  priority?: number;
  /** The key of the project's epic this task belongs to; none when it fits no theme. */
  epic?: string;
  change: TaskChangeClass;
  card?: CardPlan;
  question?: string;
  reproduce?: string;
  /** A question's options in the order shown, keyed a, b, c…. */
  options?: readonly Omit<TaskChoiceOption, 'key'>[];
}
/** A card as filed: the revenue family defaults to the site's own, and the
 * kill date counts days after the reference day. */
type CardPlan = Omit<TaskCard, 'kill' | 'by' | 'at'> & { by: Owner; kill?: readonly [state: string, days: number] };
const task = (title: string, brief: TaskBrief, plan: Omit<Plan, 'title' | 'brief'>): Plan => ({ title, brief, ...plan });

function workDescription(action: string, why: string, fix: string, where: string, reproduce?: string): string {
  return `${action}\n\n## Why\n\n${why}${reproduce ? `\n\n## Steps to Reproduce\n\n${reproduce}` : ''}\n\n## Fix\n\n${fix}\n\n## Where\n\n${where}`;
}

function checklist(criterion: string): string {
  return `- [ ] ${criterion}`;
}

/** Each project's themes: the epics its planned work is grouped under. */
const EPICS: Record<string, readonly { key: string; title: string; kind: TaskChangeClass; about: string }[]> = {
  lb: [
    { key: 'library', title: 'Brief library regrouping', kind: 'template', about: 'The brief library has grown hard to scan, so its briefs are being grouped by project. These tasks regroup the library, check every grouped route and add the agency template it links to; the template filter waits until the regrouped library is accepted.' },
    { key: 'onboarding', title: 'Onboarding emails', kind: 'copy', about: 'New trials get no guidance after they sign up. These tasks write the three onboarding emails, settle which one is sent first, and hold the agency template announcement until the sequence is live.' },
  ],
  pw: [
    { key: 'saving', title: 'Source saving repair', kind: 'feature', about: 'Source saves dropped for two days while visits continued. These tasks reproduce the failure, restore saving, verify the repair and check the saved-source links, so the libraries licensed customers build keep every source they save.' },
    { key: 'reader', title: 'Reader features', kind: 'feature', about: 'Researchers ask to save and cite sources without leaving the reader. These tasks add a save shortcut and citation export for reference managers; shared research folders stay parked until saving is stable.' },
  ],
  wp: [
    { key: 'holiday', title: 'Holiday recipe season', kind: 'copy', about: 'Holiday recipe searches rise from mid-October and peak in December. These tasks choose and publish the holiday collection, review the seasonal pages, refresh the pumpkin roundup and plan the December cookie series before those searches peak.' },
    { key: 'speed', title: 'Faster recipe pages', kind: 'template', about: 'Slow recipe pages lose readers before they reach the recipe. These tasks measured the slowest pages, made them faster, compressed their photos and verify the result against the baseline; the recipe card data waits on that verification.' },
    { key: 'cleanup', title: 'Recipe page code cleanup', kind: 'template', about: 'The latest codebase report lists the recipe card copied in four places and a recipe page function with too many branches to change safely. These two tasks remove both findings, so a later recipe page change touches one place.' },
  ],
  tn: [
    { key: 'redesign', title: 'Trail redesign: keep or roll back', kind: 'template', about: 'Sessions fell after the trail page redesign, while the season fell too. These tasks shipped and read the redesign, ask whether to roll it back, and hold the work that depends on the answer: the interactive maps, the slow map pages and the old templates.' },
    { key: 'search', title: 'Search recovery for trail guides', kind: 'content-data', about: 'Search clicks to the trail guides have fallen since July. These tasks find the guides losing clicks, fix their broken links and refresh their access, parking and season details.' },
  ],
  fr: [
    { key: 'rules', title: 'Saved validation rules', kind: 'feature', about: 'Early users rerun the same checks on every visit and ask to keep their rules. These tasks decide whether saved rules belong to a paid plan and publish the pricing page that follows from that decision; the feature itself stays parked until then.' },
    { key: 'imports', title: 'CSV import quality', kind: 'feature', about: 'A check reports the right errors only when it reads the file correctly. These tasks cover input handling, sample files, delimiters, drag-and-drop upload, keyboard use, row numbers in errors and the cleaned-file export.' },
  ],
  no: [
    { key: 'board', title: 'Task board accuracy', kind: 'feature', about: 'The task board is where the operator reads the agents’ work. These tasks check that a refresh keeps every project’s identity, record who closed each task and with which model, and chart each agent’s closed work a week.' },
  ],
};

/** Each project's work as the board shows it on the reference day: some
 * finished this week, some moving, some blocked, the asks waiting on Mara. */
const WORK: Record<string, readonly Plan[]> = {
  lb: [
    task('Restore brief navigation', ['Brief exports fell despite continued visits; inspect index navigation.', 'Link reproduction, navigation verification, repair annotation, and registered follow-up.', 'Search works. Returning through the brief library breaks exporting.', 'The repair annotation links verification and readback.'], { status: 'closed', opened: -60, finished: -42, priority: 1, change: 'feature' }),
    task('Reproduce the navigation failure', ['Exporting fails after returning through the brief library.', 'Record the brief, index action, and failed export for repair.', 'Start from the index return path, not search.', 'The index return failure is recorded.'], { status: 'closed', opened: -59, finished: -45, change: 'feature' }),
    task('Verify the navigation repair', ['Returning to the index must preserve usable brief navigation.', 'Verify entry, return navigation, and exporting; record the dated result.', 'Check returning to the index as well as fresh entry.', 'Entry, return and exporting pass.'], { status: 'closed', opened: -58, finished: -43, owner: 'codex', change: 'feature' }),
    task('Read the repair follow-up', ['The shipped repair has a registered 28-day comparison.', 'Record report days, sessions delta, and outcome after the deadline.', 'Use the registered window. Keep revenue attribution separate.', 'Registered window and evaluator outcome recorded.'], { status: 'closed', opened: -57, finished: -13, owner: 'codex', change: 'feature' }),
    task('Group the brief library', ['Accumulating briefs make the brief library difficult to scan.', 'Draft project groups and a route checklist for separate verification.', 'Group by projects. Keep the template filter parked.', 'Project groups and route checklist shipped.'], { status: 'closed', opened: -21, started: -9, finished: -4, epic: 'library', change: 'template' }),
    task('Check the completed subscription report', ['The completed subscription month needs its own ledger check.', 'Check subscription income and reconciled state separately from usage.', 'Use the subscription entry, not combined revenue.', 'Subscription month and booking state match.'], { status: 'closed', opened: -9, started: -7, finished: -6, owner: 'Mara', change: 'content-data' }),
    task('Verify the refreshed brief library', ['The grouped library needs its routes checked before announcing.', 'Check every grouped route; record missing links.', 'Grouped draft shipped; checking routes from the library index.', ''], { status: 'in_progress', opened: -21, started: -3, owner: 'codex', dependsOn: 4, epic: 'library', change: 'template' }),
    task('Explore a template filter', ['A template filter remains an unselected proposal.', 'At the wake-up date, choose a bounded discovery task.', 'Keep this parked until the brief library is accepted.', ''], { status: 'deferred', opened: -30, finished: -20, owner: 'Mara', epic: 'library', change: 'feature' }),
    task('Restore the nightly report', ['Light Brief missed two nightly reports, so its recent figures are stale.', 'The next scheduled run delivers a report, and the two missed days remain absent in history.', 'Find why the report job exits before sending and restore the scheduled delivery.', ''], { status: 'in_progress', opened: '30h', started: '5h', priority: 1, change: 'infra' }),
    task('Fix the export button on mobile', ['The release made the export button unreachable on narrow phones.', 'Export works at 360, 390 and 430 px, with a result recorded for each width.', 'Keep the export button above the sticky footer.', 'Exports pass on all three phone widths.'], { status: 'closed', opened: -5, started: '30h', finished: '20h',
      reproduce: '1. Open a brief at 360 px wide.\n2. Scroll to the export button.\n\n**Actual:** The sticky footer covers the button.\n\n**Expected:** The export button is visible and can be pressed.',
      note: 'The sticky footer hid the export button below 380 px.', check: 'export works at 360, 390 and 430 px', path: '/briefs', model: 'Opus 5.5', change: 'template' }),
    task('Add a brief template for agencies', ['Agency customers keep rebuilding the same brief by hand.', 'Ship one agency template; link it from the library.', 'Drafted from the three most copied briefs.', 'Agency template published and linked.'], { status: 'closed', opened: -14, started: -4, finished: -2, path: '/templates/agency', epic: 'library', change: 'content-data' }),
    task('Write the onboarding email sequence', ['New trials receive no guidance after signing up.', 'The sequence contains three emails and starts with the draft selected in the onboarding decision.', 'Prepare the drafts while the owner chooses the first email.', ''], { status: 'open', opened: -9, epic: 'onboarding', change: 'copy' }),
    task('Choose the first onboarding email', ['New trials get no guidance after signing up. The product tour converted better in testing.', 'The first email is recorded and the sequence uses that order.', 'The trial can begin with either draft.', ''], { status: 'open', opened: -2, owner: 'Mara', human: true, epic: 'onboarding', change: 'copy',
      question: 'Which onboarding email goes out first?',
      request: 'Mara, select the first email on this task so the team can schedule the three-email sequence.',
      card: { valuePerMonth: 240, likelihood: 0.6, reviewMinutes: 10, buildMinutes: 30, daysToSignal: 21, measurability: 'cohort',
        note: 'A first email that shows the product converts more trials into paid subscriptions.', by: DEMO_BUILDER },
      options: [{ label: 'The product tour', detail: 'The tour converted better in tests.', recommended: true },
        { label: 'The templates', detail: 'Opens with the six templates a new brief can start from.' }] }),
    task('Speed up large brief exports', ['Large briefs take twelve seconds to export.', 'Exports of the largest briefs finish under four seconds.', 'Profiling shows image resizing dominates export time.', ''], { status: 'open', opened: -9, change: 'infra',
      card: { valuePerMonth: 40, likelihood: 0.4, reviewMinutes: 30, buildMinutes: 180, daysToSignal: 21, measurability: 'cohort',
        note: 'Only a few accounts export briefs this large, so few subscriptions depend on it.', by: DEMO_BUILDER } }),
    task('Send the agency template launch email', ['The agency template launch needs the email sequence first.', 'Send the launch email once the sequence is live.', 'Waiting for the onboarding sequence before announcing.', ''], { status: 'blocked', opened: -5, dependsOn: 11, owner: 'Mara', epic: 'onboarding', change: 'copy' }),
  ],
  pw: [
    task('Restore source saving', ['Source saves dropped for two days while visits continued.', 'Saving from the preview adds the source to the library. The task links to the original alert and verification.', 'Pass the save request through the source preview.', 'Saving restored; tonight’s report confirms recovery.'], { status: 'closed', opened: -2, started: -2, finished: '3h', priority: 1,
      reproduce: '1. Open a source preview.\n2. Press Save and reopen the library.\n\n**Actual:** The source is absent.\n\n**Expected:** The saved source appears in the library.',
      note: 'The preview step dropped the save request.', path: '/sources', epic: 'saving', change: 'feature' }),
    task('Reproduce the source-save failure', ['The source-save alert needs a repeatable failing action.', 'Record the source, preview, and failed save for repair.', 'Sources open. Saving fails after the source preview.', 'The preview-save failure is reproduced.'], { status: 'closed', opened: -2, finished: -1, epic: 'saving', change: 'feature' }),
    task('Revise the collection labels', ['Customers need familiar labels to find their saved collections.', 'The collections show the reviewed labels and this task links to the before-and-after list.', 'Proposed labels are “Papers” for academic sources and “Reading list” for sources to read next. Apply the terms Mara confirms in her checklist.', ''], { status: 'open', opened: -12, change: 'copy' }),
    task('Verify restored source saving', ['Source-save verification follows the shipped repair.', 'Run the failing save flow, reopen it, and record results.', 'Use the reported route now the restore task is closed.', ''], { status: 'in_progress', opened: -2, started: '2h', owner: 'codex', dependsOn: 0, epic: 'saving', change: 'feature' }),
    task('Check the saved-source links', ['Saved-source links can be checked during the repair.', 'Open each index link; file broken targets against named sources.', 'This check needs neither save repair nor label approval.', 'Saved-source links reach their named routes.'], { status: 'closed', opened: -12, started: -6, finished: -5, epic: 'saving', change: 'content-data' }),
    task('Reconcile the completed licensing report', ['Monthly licensing reconciliation remains separate from the missing day.', 'Check monthly corrections and reconciled state; retain the daily gap.', 'Use the completed month. The recent gap remains visible.', 'Monthly corrections reconcile; the gap stays visible.'], { status: 'closed', opened: -9, started: -7, finished: -6, owner: 'Mara', change: 'content-data' }),
    task('Verify the recovered daily report', ['Pinwell has a report from the day after collection resumed. The previous day is still missing.', 'The recovered report opens, and the missing day appears as a gap in the daily series.', 'Compare the recovered report with the collection history and check the missing day on the chart.', 'The recovered report opens and the earlier gap remains.'], { status: 'closed', opened: -4, finished: -2, owner: 'codex', change: 'infra' }),
    task('Explore shared research folders', ['Shared research folders remain a discovery proposal.', 'At the wake-up date, decide a bounded discovery scope.', 'Park shared-folder exploration while existing source saving is repaired.', ''], { status: 'deferred', opened: -30, finished: -20, owner: 'Mara', epic: 'reader', change: 'feature' }),
    task('Confirm the terms customers use for collections', [
      'Mara, review the proposed collection labels so the team can use the terms customers already know. You have the renewal call notes.',
      'The linked copy task has a confirmed replacement for each label under review.',
      'The draft covers the labels customers asked about during renewals.', '',
    ], { status: 'open', opened: '3h', gate: 2, owner: 'Mara', change: 'copy', steps: [
      { text: 'Read the draft labels on the linked copy task.' },
      { text: 'Compare the proposed labels with the wording in the renewal call notes.' },
      { text: 'Record the confirmed wording for each label in a note on this step.' },
    ], request: '## What it changes\n\n- **Collection labels** The confirmed wording will appear in the saved-source library. Existing collections keep their contents.\n\n## How we’ll confirm\n\nAfter the final tick, the agent will read the recorded wording before applying it and check the resulting labels against the list.' }),
    task('Add a save shortcut to the reader', ['Readers want to save a source without leaving the page.', 'Ship a keyboard save shortcut; record it in help.', 'Shortcut drafted; waits for saving to be stable.', ''], { status: 'open', opened: -12, epic: 'reader', change: 'feature' }),
    task('Renew the university license', ['The largest university license renews next month.', 'Send renewal terms; record the signed license.', 'Usage summary prepared for the renewal call.', ''], { status: 'in_progress', opened: -9, started: -3, owner: 'Mara', change: 'content-data',
      card: { valuePerMonth: 260, likelihood: 0.85, reviewMinutes: 60, daysToSignal: 30, measurability: 'unmeasured',
        note: 'The largest licence is half of Pinwell’s licensing income; renewing keeps it.', by: OPERATOR } }),
    task('Stop duplicate sources after import', ['Importing a library creates duplicate sources.', 'Imports skip existing sources; record counts before and after.', 'Duplicates share a URL but differ in title.', 'A second import created no duplicates.'], { status: 'closed', opened: -12, started: -5, finished: -3, change: 'feature' }),
    task('Add citation export for reference managers', ['Researchers retype citations into their reference managers.', 'Export saved sources as citations in two common formats.', 'Format list agreed; export reuses saved metadata.', ''], { status: 'open', opened: -5, epic: 'reader', change: 'feature',
      card: { valuePerMonth: 300, likelihood: 0.2, reviewMinutes: 25, buildMinutes: 360, daysToSignal: 60, measurability: 'unmeasured',
        note: 'Universities ask for citation export at renewal; it may keep a licence that would lapse.', by: OPERATOR } }),
  ],
  wp: [
    task('Speed up the recipe pages', ['Slow recipe pages lose visits before readers reach a recipe.', 'Link page timings before and after; keep ad income claims separate.', 'Start with the ten most visited recipe pages.', 'Measured recipe pages beat their baseline.'], { status: 'closed', opened: -21, started: -12, finished: -7, priority: 1, epic: 'speed', change: 'template' }),
    task('Measure the slow recipe pages', ['Recipe page timings need a measured baseline first.', 'Record load timings for the most visited recipe pages.', 'Measure before changing images or ad placement.', 'Baseline timings recorded for top pages.'], { status: 'closed', opened: -21, finished: -12, epic: 'speed', change: 'template' }),
    task('Schedule the holiday recipe collection', ['The final recipe list is needed to plan publishing dates ahead of the holiday search peak.', 'Each selected recipe has a publishing date in the holiday calendar.', 'Use the shortlist Mara marks up to build the calendar.', ''], { status: 'open', opened: -12, epic: 'holiday', change: 'content-data' }),
    task('Verify the faster recipe pages', ['The speed work changed the ten most visited recipe pages. The baseline covers those same pages.', 'The comparison contains timings before and after for all 10 pages and identifies any page that slowed down.', 'Repeat the baseline measurements on the same pages and compare each result.', ''], { status: 'open', opened: -9, owner: 'codex', dependsOn: 0, epic: 'speed', change: 'template' }),
    task('Check the printable recipe cards', ['Printable recipe cards can be checked independently.', 'Print each card layout; file problems against named recipes.', 'This check needs neither speed work nor the holiday selection.', 'Printable cards render on every checked recipe.'], { status: 'closed', opened: -12, started: -4, finished: -3, change: 'template' }),
    task('Check the completed ad payment', ['The completed month’s ad payment needs its own check.', 'Compare the payment with the month’s daily estimates; keep both labelled.', 'Use the stored daily estimates, never traffic, for the comparison.', 'Payment and daily estimates are both recorded.'], { status: 'closed', opened: -9, started: -7, finished: -6, owner: 'Mara', change: 'content-data' }),
    task('Review the seasonal recipe pages', ['Seasonal recipe pages need review before the holidays.', 'List seasonal pages with falling search clicks; propose updates.', 'Use the last four weeks of search clicks.', ''], { status: 'in_progress', opened: -12, started: -2, epic: 'holiday', change: 'content-data' }),
    task('Explore a weekly meal plan', ['A weekly meal plan remains a discovery proposal.', 'At the wake-up date, scope a bounded meal-plan discovery.', 'Park this until the faster pages are verified.', ''], { status: 'deferred', opened: -30, finished: -20, owner: 'Mara', change: 'feature' }),
    task('Mark recipes ready for the holiday collection', [
      'Mara, mark which of the 20 shortlisted recipes are ready to schedule. You have the kitchen test notes and final photo list.',
      'The linked scheduling task has the final recipe list.',
      'The shortlist is ready for review.', '',
    ], { status: 'open', opened: -9, gate: 2, owner: 'Mara', change: 'content-data', steps: [
      { text: 'Open the holiday shortlist in the editorial calendar.' },
      { text: 'Check the kitchen test notes and photos for each shortlisted recipe.' },
      { text: 'Mark each recipe that can be published and add the final list to a note on this step.' },
    ], request: '## What it changes\n\n- **Holiday calendar** The marked recipes get publishing dates. Recipes that still need testing or photography stay in the draft list.\n\n## How we’ll confirm\n\nAfter the final tick, the agent will match scheduled recipes to the confirmed list before sharing the calendar.' }),
    task('Fix the recipe save button', ['Recipe saves failed for a day after a plugin update.', 'Saving works again on recipe pages; record the cause.', 'The plugin update broke the save request; rolling back.', 'Saves restored; the plugin version is pinned.'], { status: 'closed', opened: -2, started: -2, finished: -1, priority: 1,
      note: 'A plugin update broke saving; version now pinned.', check: 'saves work on ten recipes', path: '/recipes', change: 'feature' }),
    task('Publish ten Thanksgiving recipes', ['Thanksgiving searches start rising in mid-October.', 'Publish ten tested recipes before the search rise.', 'Ten recipes tested; photos ready for six.', 'Ten Thanksgiving recipes published with photos.'], { status: 'closed', opened: -14, started: -6, finished: -4, epic: 'holiday', change: 'copy' }),
    task('Compress the recipe photos', ['Recipe photos are the heaviest part of every page.', 'Serve compressed photos on every recipe page.', 'Starting with the hundred most visited recipes.', 'Every recipe page serves compressed photos.'], { status: 'closed', opened: -14, started: -5, finished: -2, epic: 'speed', change: 'infra' }),
    task('Add a printable shopping list', ['Readers copy ingredients by hand into shopping lists.', 'Each recipe offers a printable shopping list.', 'The list groups ingredients by store section.', 'Shopping lists print from every recipe.'], { status: 'closed', opened: -9, started: '30h', finished: '6h', check: 'prints from twelve recipes', path: '/print', change: 'feature' }),
    task('Write the pumpkin recipe roundup', ['A pumpkin roundup ranked well last autumn.', 'Refresh the roundup with this year’s recipes.', 'Twelve recipes chosen; writing the introductions now.', ''], { status: 'in_progress', opened: -9, started: '26h', epic: 'holiday', change: 'copy',
      card: { valuePerMonth: 220, likelihood: 0.75, reviewMinutes: 5, buildMinutes: 120, daysToSignal: 14, measurability: 'cohort', kill: ['The roundup is outside the top ten for pumpkin recipes', 12],
        note: 'Last autumn’s roundup ranked well; a refreshed one catches this year’s pumpkin searches.', by: OPERATOR } }),
    task('Move the newsletter signup below recipes', ['The newsletter signup interrupts recipes before the ingredients.', 'Move the signup below each recipe; compare weekly signups.', 'Placement drafted; waits for the holiday pages.', ''], { status: 'open', opened: -9, change: 'template',
      card: { valuePerMonth: 150, likelihood: 0.65, reviewMinutes: 10, buildMinutes: 60, daysToSignal: 14, measurability: 'holdout',
        note: 'Readers who reach the recipe without the signup in the way see more ads.', by: OPERATOR } }),
    task('Plan the December cookie series', ['December cookie searches peak in the second week.', 'Outline twelve cookie posts with dates and photos.', 'Outline started from last year’s best cookie posts.', ''], { status: 'open', opened: -5, epic: 'holiday', change: 'copy',
      card: { valuePerMonth: 1200, likelihood: 0.5, reviewMinutes: 30, buildMinutes: 600, daysToSignal: 120, measurability: 'cohort', durability: 0.8,
        note: 'Cookie searches peak each December; a series published early also ranks the next year.', by: OPERATOR } }),
    task('Add cooking times to recipe cards', ['Recipe cards lack cooking times in search results.', 'Recipe cards carry valid cooking time and rating data.', 'Waiting for the page speed verification first.', ''], { status: 'blocked', opened: -5, dependsOn: 3, epic: 'speed', change: 'content-data' }),
    // The two findings the Codebase tab leads with for this site's growth.
    task('Merge the repeated recipe card components', ['The recipe card is copied in four places.', 'One shared card replaces the four; none listed as repeated.', 'The copies differ only in image size.', ''], { status: 'open', opened: -4, epic: 'cleanup', change: 'template' }),
    task('Split the recipe page’s largest function', ['RecipePage has so many branches each change risks another.', 'RecipePage split into parts; off the hard-to-change list.', 'Start with the ingredient and nutrition branches.', ''], { status: 'open', opened: -3, epic: 'cleanup', change: 'template',
      card: { valuePerMonth: 20, likelihood: 0.5, reviewMinutes: 45, buildMinutes: 240, daysToSignal: 30, measurability: 'unmeasured',
        note: 'Later recipe page changes get cheaper; no reader sees a difference.', by: DEMO_BUILDER } }),
  ],
  tn: [
    task('Ship the trail page redesign', ['Trail pages looked dated beside newer guide assets.', 'Ship the redesigned trail pages; record the changed routes.', 'The redesign covers trail, region and map pages.', 'Redesign live; comparison registered on sessions.'], { status: 'closed', opened: -50, started: -40, finished: -36, priority: 1, epic: 'redesign', change: 'template' }),
    task('Read the redesign comparison', ['The redesign’s 28-day comparison has ended, and the team needs the result to decide whether to roll back.', 'The result records sessions for both periods, explains the seasonal change and links the rollback decision.', 'Read the registered comparison and record what changed across the two periods.', 'Sessions fell over the comparison period. The rollback decision is open.'], { status: 'closed', opened: -37, started: -8, finished: -7, owner: 'codex', epic: 'redesign', change: 'template' }),
    task('Decide whether to roll back the trail redesign', ['Sessions fell in the 28-day comparison. Seasonal traffic fell over the same period, so the comparison leaves the cause uncertain.', 'The chosen direction is recorded and the map work follows that direction.', 'The comparison and search positions are attached for review.', ''], { status: 'open', opened: -7, owner: 'Mara', human: true, priority: 1, epic: 'redesign', change: 'template',
      question: 'Should Trail Notes roll back the trail page redesign?',
      request: 'Mara, choose a direction on this task so the team can plan the interactive maps and decide whether to keep the old templates.',
      options: [{ label: 'Roll back', detail: 'Restore the previous trail pages and compare sessions over another 28 days.', recommended: true },
        { label: 'Keep the redesign', detail: 'Keep the new layout and fix the slowest map pages first.' }],
      card: { valuePerMonth: 520, likelihood: 0.55, reviewMinutes: 25, buildMinutes: 180, daysToSignal: 28, measurability: 'cohort', durability: 0.9,
        note: 'Sessions fell after the redesign; if the redesign caused it, rolling back regains their ad income.', by: DEMO_VERIFIER } }),
    task('Find the trail pages losing search clicks', ['Search clicks to trail pages have fallen since July.', 'List the pages with the largest click losses.', 'Comparing positions for the fifty biggest trail pages.', 'Forty pages listed with their lost positions.'], { status: 'closed', opened: -9, started: -6, finished: -4, epic: 'search', change: 'content-data' }),
    task('Refresh the twenty biggest trail guides', ['The biggest trail guides have outdated access details.', 'Update access, parking and season notes on twenty guides.', 'Eight guides refreshed; parking details take longest.', ''], { status: 'in_progress', opened: -9, started: -3, epic: 'search', change: 'content-data',
      card: { valuePerMonth: 180, likelihood: 0.6, reviewMinutes: 10, buildMinutes: 300, daysToSignal: 28, measurability: 'cohort', kill: ['The refreshed guides have not regained their search clicks', 33],
        note: 'Current access and parking details win back the clicks these guides lost.', by: DEMO_BUILDER } }),
    task('Bring back interactive trail maps', ['The redesign replaced interactive maps with static images.', 'Restore interactive maps on every trail page.', 'Waiting for the rollback decision before changing maps.', ''], { status: 'blocked', opened: -7, dependsOn: 2, epic: 'redesign', change: 'feature' }),
    task('Reconcile the trail ad payment', ['The outdoor asset’s monthly ad payment has arrived.', 'Compare the payment with its daily estimates; keep both.', 'The payment sits slightly above the estimates’ sum.', 'Payment and estimates recorded side by side.'], { status: 'closed', opened: -9, started: -7, finished: -6, owner: 'Mara', change: 'content-data' }),
    task('Plan the winter trail series', ['Winter hiking guides could soften the seasonal drop.', 'Outline ten winter trail guides with publishing dates.', 'Parked until the redesign decision is made.', ''], { status: 'deferred', opened: -30, finished: -20, owner: 'Mara', change: 'copy' }),
    task('Fix broken links in trail guides', ['Trail guides link to closed park pages.', 'Replace or remove every broken outbound link.', 'Two hundred links checked; thirty-one are broken.', 'Every broken outbound link replaced or removed.'], { status: 'closed', opened: -12, started: '44h', finished: '20h', check: 'no broken links in 200 checked', epic: 'search', change: 'content-data' }),
    task('Speed up the trail map pages', ['Map pages became the slowest pages after the redesign.', 'Map pages load in under three seconds on phones.', 'Map scripts load before the page text.', ''], { status: 'open', opened: -9, epic: 'redesign', change: 'template',
      card: { valuePerMonth: 260, likelihood: 0.7, reviewMinutes: 15, buildMinutes: 240, daysToSignal: 21, measurability: 'cohort', kill: ['Map pages still take over three seconds on phones', 19],
        note: 'Map pages became the slowest after the redesign; faster maps keep phone readers and their ad views.', by: DEMO_BUILDER } }),
    task('Add trail difficulty filters', ['Readers ask to filter trails by difficulty.', 'Ship difficulty filters on every region page.', 'Difficulty labels exist on most trails already.', ''], { status: 'open', opened: -12, change: 'feature',
      card: { valuePerMonth: 400, likelihood: 0.15, reviewMinutes: 20, buildMinutes: 480, daysToSignal: 42, measurability: 'unmeasured',
        note: 'Filtered region pages might rank for difficulty searches; nothing yet shows they would.', by: DEMO_BUILDER } }),
    // The redesign's leftovers, which the Codebase tab lists as unused files.
    task('Remove the old templates left in legacy/', ['The redesign left old trail templates unused in legacy/.', 'Unused legacy/ files deleted; the next codebase report lists none.', 'A rollback needs these files; waits for that decision.', ''], { status: 'blocked', opened: -6, dependsOn: 2, epic: 'redesign', change: 'template' }),
  ],
  fr: [
    task('Check CSV input handling', ['The examples depend on how the CSV checker handles blank cells and numeric data.', 'The input checklist records the actual result for an empty file, a blank cell, zero and a decimal value.', 'Run each input and record any mismatch between the expected and actual result.', ''], { status: 'in_progress', opened: -22, started: -3, epic: 'imports', change: 'feature' }),
    task('Verify the first usage reports', ['First usage reports cover only the short post-launch period.', 'Verify launch bounds and identify provisional recent days.', 'Check available days before interpreting a change.', 'Usage begins at launch; recent days stay provisional.'], { status: 'closed', opened: -21, finished: -14, owner: 'codex', change: 'infra' }),
    task('Review sample CSV files', ['Sample files must match accepted CSV inputs.', 'Check examples against accepted inputs; hold unsupported cases.', 'Waiting for the input checklist before accepting examples.', ''], { status: 'open', opened: -20, owner: 'Mara', epic: 'imports', change: 'content-data' }),
    task('Verify keyboard CSV use', ['CSV acceptance includes keyboard operation.', 'After input acceptance, complete those cases using the keyboard.', 'Reuse accepted input cases; record every unreachable control.', ''], { status: 'blocked', opened: -19, owner: 'codex', dependsOn: 0, epic: 'imports', change: 'feature' }),
    task('Check the published help links', ['Published help links need checking while CSV work continues.', 'Open named help routes; separate failures from missing usage days.', 'These links can be checked before CSV input acceptance.', 'Published help links open their named routes.'], { status: 'closed', opened: -18, started: -6, finished: -5, change: 'content-data' }),
    task('Record the initial operating costs', ['Operating costs exist; monetization is unconfigured.', 'Check initial costs; leave unconfigured subscription and licensing revenue absent.', 'Record operating costs without inventing disconnected revenue.', 'Initial costs recorded; no revenue invented.'], { status: 'closed', opened: -17, started: -7, finished: -6, owner: 'Mara', change: 'content-data' }),
    task('Review the next coverage comparison', ['The next comparison must begin no earlier than launch.', 'Choose available days and retain provisional indicators.', 'A mature-asset window would fabricate this asset’s earlier history.', 'The comparison uses only post-launch days.'], { status: 'closed', opened: -16, started: -3, finished: -2, owner: 'codex', change: 'content-data' }),
    task('Explore saved validation rules', ['Saved validation rules remain a discovery proposal.', 'At the wake-up date, define evidence for bounded discovery.', 'Keep this parked until input and keyboard checks finish.', ''], { status: 'deferred', opened: -15, finished: -10, owner: 'Mara', epic: 'rules', change: 'feature' }),
    task('Choose the plan for saved validation rules', ['A third of returning users rerun the same checks. They have asked to keep rules between visits.', 'The pricing task reflects the recorded decision before it publishes.', 'The pricing page waits on this choice.', ''], { status: 'open', opened: -20, owner: 'Mara', human: true, epic: 'rules', change: 'feature',
      question: 'Should saved validation rules be part of a paid plan?',
      request: 'Mara, select a pricing direction on this task so the team knows what to put on the pricing page.',
      card: { valuePerMonth: 600, likelihood: 0.3, reviewMinutes: 20, daysToSignal: 45, measurability: 'cohort', revenueFamily: 'subs',
        note: 'A third of returning users rerun the same checks; a paid tier for saved rules starts subscription income.', by: DEMO_BUILDER },
      options: [{ label: 'A paid tier', detail: 'Saved rules join a paid plan; checking files stays free.', recommended: true },
        { label: 'Keep it free', detail: 'Saved rules stay free and bring users back.' },
        { label: 'Ask the five largest customers first', detail: 'Decide after hearing what they would pay.' }] }),
    task('Add a drag-and-drop upload', ['Users paste CSV text because uploading is hidden.', 'Upload a file by dropping it onto the page.', 'The drop zone covers the whole input panel.', 'Dropping a file uploads and checks it.'], { status: 'closed', opened: -12, started: -5, finished: -3, epic: 'imports', change: 'feature' }),
    task('Detect the delimiter automatically', ['Semicolon files fail the check without warning.', 'Detect comma, semicolon and tab delimiters automatically.', 'Testing with twenty real-world sample files.', 'All three delimiters detected on every sample.'], { status: 'closed', opened: -9, started: '28h', finished: '6h', check: 'twenty sample files pass', epic: 'imports', change: 'feature' }),
    task('Write the launch post', ['Fresh Rows has no public launch announcement yet.', 'Publish a launch post with three worked examples.', 'Draft written; the examples need final screenshots.', ''], { status: 'in_progress', opened: -9, started: '22h', owner: 'Mara', change: 'copy' }),
    task('Show row numbers in error messages', ['Error messages do not say which row failed.', 'Every error names its row and column.', 'Row numbers added; column names come next.', 'Errors name their row and column.'], { status: 'closed', opened: -12, started: -5, finished: -3, epic: 'imports', change: 'feature' }),
    task('Add a pricing page', ['Visitors cannot see what the paid plan includes.', 'Publish a pricing page with the free and paid plans.', 'Waiting for the saved-rules pricing decision.', ''], { status: 'blocked', opened: -9, dependsOn: 8, epic: 'rules', change: 'copy',
      card: { valuePerMonth: 250, likelihood: 0.3, reviewMinutes: 20, buildMinutes: 120, daysToSignal: 45, measurability: 'cohort', revenueFamily: 'subs',
        note: 'Visitors who can see what the paid plan includes can buy it.', by: DEMO_BUILDER } }),
    task('Export the cleaned CSV', ['Users want the corrected file, not only the errors.', 'Download the cleaned CSV after fixing its errors.', 'The export reuses the rows already checked.', ''], { status: 'open', opened: -5, epic: 'imports', change: 'feature',
      card: { valuePerMonth: 120, likelihood: 0.45, reviewMinutes: 15, buildMinutes: 240, daysToSignal: 35, measurability: 'cohort', revenueFamily: 'subs',
        note: 'Users who download the corrected file come back, and a paid plan can include it.', by: DEMO_BUILDER } }),
  ],
  no: [
    task('Verify the portfolio backup restore', ['Portfolio recovery must preserve operational records and task history.', 'Verify restored databases, task history, and configuration on isolated resources.', 'Server startup alone is insufficient; inspect restored task history.', 'Recovery checks include task history readbacks.'], { status: 'closed', opened: -390, finished: -7, change: 'infra' }),
    task('Check the task-board refresh', ['Task-board refresh must retain identity, empty queues, and failures.', 'Compare snapshot identities and counts; distinguish unavailable from empty.', 'An unavailable project must never appear as an empty queue.', 'Board refresh keeps identities and unavailable counts.'], { status: 'closed', opened: -359, finished: -8, epic: 'board', change: 'infra' }),
    task('Record the next operating-cost budget', ['The next budget needs the owner’s approval before it can guide operating costs.', 'The next month has an approved limit for each operating-cost category.', 'Record the approved limits against the new budget period.', ''], { status: 'open', opened: -328, owner: 'Mara', change: 'content-data' }),
    task('Verify the refreshed task projects', ['A project refresh can mislabel work or leave a project’s task counts missing.', 'All six project identities match their task snapshots.', 'Verification uses the existing project map after the budget review clears.', ''], { status: 'blocked', opened: -297, finished: -10, owner: 'codex', dependsOn: 2, epic: 'board', change: 'infra' }),
    task('Inspect the recorded collection recovery', ['Collection history includes a failed attempt and later recovery.', 'Inspect both recorded attempts; never recollect to rewrite history.', 'Read the recorded attempts, rather than starting another collection.', ''], { status: 'open', opened: -266, change: 'infra' }),
    task('Reconcile the shared operating costs', ['Shared costs belong to the OS, separate from asset revenue.', 'Check OS cost entries, booking states, and recorded periods.', 'Keep portfolio overhead separate; use the ledger’s recorded amounts.', 'Shared costs keep OS ownership and periods.'], { status: 'closed', opened: -235, finished: -12, owner: 'Mara', change: 'content-data' }),
    task('Check the portfolio report links', ['Portfolio report links must preserve task-board asset identities.', 'Open five asset links and the OS; check target identities.', 'Compare with the six-project map, not display names.', 'All six portfolio links open their identities.'], { status: 'closed', opened: -204, finished: -13, owner: 'codex', change: 'content-data' }),
    task('Explore the next portfolio import', ['A further portfolio import needs bounded discovery first.', 'At the wake-up date, choose scope without copying an installation.', 'Park this until task, recovery, and report checks finish.', ''], { status: 'deferred', opened: -173, finished: -1, owner: 'Mara', change: 'infra' }),
    task('Approve the next operating-cost budget', [
      'Mara, approve the next month’s operating budget here so the team can record the approved costs.',
      'The approved budget is recorded against the next month.', 'The draft budget is ready for the owner to review.', '',
    ], { status: 'open', opened: -1, gate: 2, owner: 'Mara', change: 'content-data',
      request: '## Why this needs you\n\nThe owner sets the operating budget. The review task needs your approval to record it.\n\n## What the agent will do\n\nRecord the approved categories and limits in the next month’s budget.\n\n## What it changes\n\n- **Budget period** The new limits apply to the next month.\n\n## How we’ll confirm\n\nCompare the saved limits with the approved draft.\n\n## If you decline\n\nThe team will revise the draft before recording new limits.' }),
    task('Show who closed each task', ['Closed tasks name no closer, so agent work reads anonymous.', 'Task pages name who closed each task, and with which model.', 'Agents already send their name; models come with the claim.', 'Task pages name the closer and model.'], { status: 'closed', opened: -6, started: -2, finished: '9h',
      note: 'Closes now record the closer and model.', check: 'closer shown on ten closed tasks', model: 'Opus 5.5', epic: 'board', change: 'feature' }),
    task('Chart each agent’s weekly velocity', ['Nobody can see how fast agent work is closing.', 'One chart shows each agent’s closed work a week, eight weeks.', 'Reading eight weeks of closed tasks per project first.', ''], { status: 'in_progress', opened: -4, started: '6h', model: 'Sonnet 5.5', epic: 'board', change: 'feature' }),
  ],
};

/** Earlier work each project finished before the reference week: an agent's
 * builds, read by the velocity chart. Each line is a title and the evidence
 * the close carries; the path is where the change shows. None belongs to a
 * themed epic. */
const EARLIER: Record<string, readonly (readonly [title: string, done: string, path: string, change: TaskChangeClass])[]> = {
  lb: [
    ['Add keyboard shortcuts to the brief editor', 'Shortcuts listed in help and tested', '/editor', 'feature'],
    ['Stop duplicate briefs on double click', 'One brief per click in every browser', '/briefs', 'feature'],
    ['Show word counts on every brief', 'Word counts match the export', '/briefs', 'feature'],
    ['Speed up the brief library search', 'Search answers under 300 ms', '/briefs', 'infra'],
    ['Fix broken images in shared briefs', 'Shared briefs show every image', '/share', 'template'],
    ['Let teams rename brief folders', 'Renamed folders keep their briefs', '/briefs', 'feature'],
    ['Add undo to brief deletion', 'Deleted briefs restore within ten seconds', '/briefs', 'feature'],
    ['Fix the trial countdown on billing', 'Countdown matches the trial end date', '/billing', 'feature'],
    ['Compress brief export files', 'Exports are 40% smaller', '/briefs', 'infra'],
    ['Add brief version history', 'Every save restorable from history', '/editor', 'feature'],
    ['Fix the login redirect after signup', 'New accounts land on their first brief', '/signup', 'feature'],
    ['Add a template picker to new briefs', 'New briefs offer six templates', '/editor', 'feature'],
    ['Speed up large brief libraries', 'Libraries of 500 briefs open in a second', '/briefs', 'infra'],
    ['Export brief details as CSV', 'CSV export opens in spreadsheets', '/briefs', 'feature'],
    ['Add dark mode to the brief editor', 'Editor follows the system dark mode', '/editor', 'template'],
    ['Fix pasted tables in briefs', 'Pasted tables keep their columns', '/editor', 'feature'],
    ['Add a brief duplicate action', 'Briefs duplicate with their sections', '/briefs', 'feature'],
    ['Fix the team invite email link', 'Invite links open the team page', '/team', 'content-data'],
    ['Show the last edit time on briefs', 'Every brief shows when it was edited', '/briefs', 'feature'],
  ],
  pw: [
    ['Fix citation dates for undated sources', 'Undated sources cite their access date', '/sources', 'feature'],
    ['Add tags to saved sources', 'Tags filter the library', '/sources', 'feature'],
    ['Speed up the source preview', 'Previews open under half a second', '/sources', 'infra'],
    ['Fix PDF titles in the library', 'PDFs show their document titles', '/sources', 'content-data'],
    ['Add bulk delete for saved sources', 'Fifty sources delete in one action', '/sources', 'feature'],
    ['Fix the share link for collections', 'Shared collections open for guests', '/collections', 'feature'],
    ['Show source counts per collection', 'Counts match each collection', '/collections', 'template'],
    ['Fix highlights lost after reload', 'Highlights survive a reload', '/reader', 'feature'],
    ['Add search within a collection', 'Search stays inside the open collection', '/collections', 'feature'],
    ['Fix the browser extension sign-in', 'Extension signs in on first try', '/extension', 'feature'],
    ['Add notes to saved sources', 'Notes save beside each source', '/sources', 'feature'],
    ['Export saved sources to Markdown', 'Markdown export keeps links and notes', '/sources', 'feature'],
    ['Fix duplicate tags after merging', 'Merged tags leave no duplicates', '/sources', 'content-data'],
    ['Add a reading time to saved sources', 'Each source shows its reading time', '/sources', 'content-data'],
    ['Fix the collection cover images', 'Collections show their cover images', '/collections', 'template'],
    ['Add keyboard navigation to the reader', 'Arrow keys move between highlights', '/reader', 'feature'],
    ['Fix citation export for web pages', 'Web page citations export with their URLs', '/sources', 'feature'],
  ],
  wp: [
    ['Add jump-to-recipe buttons', 'Every recipe page jumps to its card', '/recipes', 'template'],
    ['Fix ingredient scaling for fractions', 'Scaled fractions read as kitchen measures', '/recipes', 'feature'],
    ['Add nutrition panels to soup recipes', 'Forty soup recipes carry nutrition panels', '/soups', 'content-data'],
    ['Compress the slow-cooker photos', 'Slow-cooker pages are half the weight', '/slow-cooker', 'infra'],
    ['Fix the print layout for long recipes', 'Long recipes print on two pages', '/recipes', 'template'],
    ['Add metric units to baking recipes', 'Baking recipes switch to grams', '/baking', 'content-data'],
    ['Refresh the sheet-pan dinner roundup', 'Roundup lists twelve tested dinners', '/sheet-pan', 'copy'],
    ['Fix pins on recipe images', 'Pins carry the right image and title', '/recipes', 'content-data'],
    ['Add a weeknight dinners hub page', 'Hub links forty weeknight dinners', '/weeknight', 'copy'],
    ['Fix recipe ratings not saving', 'Ratings save and show their count', '/recipes', 'feature'],
    ['Stop layout shift from ad slots', 'Recipe pages hold still while ads load', '/recipes', 'template'],
    ['Add related recipes under each post', 'Three related recipes under every post', '/recipes', 'template'],
    ['Fix the search page on phones', 'Search works at every phone width', '/search', 'template'],
    ['Add allergy notes to dessert recipes', 'Desserts list their common allergens', '/desserts', 'content-data'],
    ['Add cook time filters to search', 'Search filters by cook time', '/search', 'feature'],
    ['Fix the recipe card on tablets', 'Recipe cards fit every tablet tested', '/recipes', 'template'],
    ['Add a freezer-friendly label', 'Freezer-friendly recipes carry a label', '/recipes', 'content-data'],
    ['Refresh the pumpkin recipes roundup', 'Roundup lists eighteen tested pumpkin recipes', '/pumpkin', 'copy'],
    ['Fix the newsletter signup on recipes', 'Signup form saves every address', '/recipes', 'feature'],
  ],
  tn: [
    ['Add elevation charts to trail guides', 'Every guide shows its climb', '/trails', 'template'],
    ['Fix map pins for coastal trails', 'Coastal pins sit on their trailheads', '/coast', 'content-data'],
    ['Refresh parking notes for park trails', 'Thirty park guides list current parking', '/parks', 'content-data'],
    ['Add dog-friendly labels', 'Dog-friendly trails carry a label', '/trails', 'content-data'],
    ['Fix route downloads on phones', 'Routes download on every phone tested', '/trails', 'feature'],
    ['Add seasonal closures to alpine trails', 'Alpine guides show their closure dates', '/alpine', 'content-data'],
    ['Fix the region filter on search', 'Region filter narrows search results', '/search', 'feature'],
    ['Add trail length to listing cards', 'Cards show length and climb', '/trails', 'template'],
    ['Refresh the waterfall hikes roundup', 'Roundup lists fifteen checked waterfalls', '/waterfalls', 'copy'],
    ['Add trailhead directions links', 'Every trailhead opens its directions', '/trails', 'content-data'],
    ['Merge duplicate trail pages', 'Duplicates redirect to one page each', '/trails', 'content-data'],
    ['Add sunrise times to summit guides', 'Summit guides list sunrise times', '/summits', 'content-data'],
    ['Fix the trail difficulty filter', 'Difficulty filter matches each guide', '/search', 'feature'],
    ['Add water sources to desert trails', 'Desert guides mark their water sources', '/desert', 'content-data'],
    ['Fix GPX files missing elevation', 'GPX downloads include elevation', '/trails', 'content-data'],
    ['Refresh the fall foliage hikes list', 'List names twenty checked foliage hikes', '/foliage', 'copy'],
  ],
  fr: [
    ['Add a sample file to the homepage', 'Sample file checks in one click', '/', 'content-data'],
    ['Fix the upload limit message', 'Oversized files name the limit', '/', 'copy'],
    ['Show progress for large files', 'Large files show a progress bar', '/', 'feature'],
    ['Add a copy button to error lists', 'Errors copy as plain text', '/', 'feature'],
    ['Read day-first dates correctly', 'Day-first files check without false errors', '/', 'feature'],
    ['Fix the empty file error', 'Empty files explain what is missing', '/', 'copy'],
  ],
  no: [
    ['Speed up the task board read', 'Board reads in under a second', '', 'infra'],
    ['Add snooze presets to alerts', 'Alerts snooze for a day or a week', '', 'feature'],
    ['Fix the backup status line', 'Status names the last good backup', '', 'feature'],
    ['Retry the search collector once', 'A failed collection retries after ten minutes', '', 'infra'],
    ['Add a stale mark to asset rows', 'Stale assets show their data age', '', 'feature'],
    ['Fix the time zone label in Settings', 'Settings names the zone in use', '', 'copy'],
    ['Keep the TV clock in step', 'TV clock matches the server within a second', '', 'infra'],
    ['Show evidence on closed tasks', 'Closed tasks show their evidence', '', 'feature'],
    ['Show the last read time on Tasks', 'Tasks shows when the board was last read', '', 'feature'],
    ['Fix the alert count on Home', 'Home counts match the alert list', '', 'feature'],
    ['Retry the revenue report once', 'A failed revenue read retries once', '', 'infra'],
    ['Add the backup size to System health', 'System health shows each backup size', '', 'feature'],
  ],
};

/** Closed work a week, oldest of the seven earlier weeks first: the builder's
 * pace picking up as more of the backlog reaches it. */
const EARLIER_PACE = [7, 8, 10, 12, 14, 17, 20] as const;
/** Earlier weeks this close to the reference week also carry quick
 * low-priority fixes, the work the builder's smallest model takes. */
const QUICK_WEEKS = 3;

/** Quick fixes the builder closed through the reference week, each within
 * hours of its claim: a project, a title, the evidence, where it shows, and
 * hours before the cutoff, spread so every day of the week has agent closes. */
const QUICK: readonly (readonly [prefix: string, title: string, done: string, path: string, when: When, change: TaskChangeClass])[] = [
  ['lb', 'Fix the footer link to the changelog', 'Footer opens the changelog', '/', '150h', 'content-data'],
  ['wp', 'Fix a broken link in the soup roundup', 'Every soup roundup link opens', '/soups', '140h', 'content-data'],
  ['wp', 'Fix the jump link on tablet recipes', 'Jump link reaches the card on tablets', '/recipes', '128h', 'template'],
  ['pw', 'Fix the save button tooltip', 'Tooltip names the save shortcut', '/sources', '125h', 'copy'],
  ['tn', 'Fix the map legend colours', 'Legend colours match the trail lines', '/trails', '100h', 'template'],
  ['fr', 'Rename the sample file download', 'Sample file downloads as sample.csv', '/', '52h', 'content-data'],
  ['lb', 'Fix the pricing page typo', 'Pricing page spelling corrected', '/pricing', '30h', 'copy'],
];
/** The verifier's daily check of the day before's changes, newest last: days
 * from the reference day, or hours before the cutoff. The last is still running. */
const CHECKS: readonly (readonly [prefix: string, when: When, running?: true])[] = [
  ['pw', -4], ['lb', -3], ['fr', -2], ['wp', -1], ['pw', '4h'], ['lb', '1h', true],
];
/** A check, a release verification or a weekly review changes no page of its
 * own; it is filed under the release process it is part of. */
const PROCESS: TaskChangeClass = 'infra';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const sentence = (text: string) => text.replace(/[.!]$/u, '');
const sentenceEnding = (text: string) => /[.!?]$/u.test(text) ? text : `${text}.`;

function plannedDescription(plan: Plan, where: string, linkedWork?: string): string {
  const [why, , fix] = plan.brief;
  if (linkedWork) return `${why}\n\n${plan.request}\n\n## Where\n\n${linkedWork}`;
  if (plan.question) return `${plan.request}\n\n## Why\n\n${why}\n\n## What happens next\n\n${plan.brief[1]}\n\n## Where\n\n${where}`;
  return workDescription(sentenceEnding(plan.title), why, fix, where, plan.reproduce);
}

/** Facts describe fictional work, never provider execution or causal returns. */
export function generateDemoTaskFacts({ assets, seed, referenceDate, cutoff }: { assets: readonly Asset[]; seed: string; referenceDate: string; cutoff: string }) {
  const digest = (asset: Asset, key: string) => createHash('sha256').update(`${seed}\0${asset.id}\0${key}`).digest('hex');
  const id = (asset: Asset, key: string) => `${asset.prefix}-${digest(asset, key).slice(0, 6)}`;
  const commitOf = (asset: Asset, key: string) => digest(asset, `${key}\0commit`).slice(0, 7);
  /** The builder runs three models: urgent work goes to Opus, quick
   * low-priority fixes to Haiku, and the rest to Sonnet or Opus by the task
   * alone, not the seed, so every demo's week is the same close contest. */
  const modelOf = (asset: Asset, key: string, owner: Owner, priority = 2) => owner === DEMO_VERIFIER ? 'GPT-5-Codex'
    : owner !== DEMO_BUILDER ? undefined
    : priority <= 1 ? 'Opus 5.5' : priority >= 3 ? 'Haiku 5.5'
    : createHash('sha256').update(`${asset.prefix}\0${key}\0model`).digest()[0]! % 4 < 3 ? 'Sonnet 5.5' : 'Opus 5.5';
  const linkOf = (asset: Asset, path = '') => asset.id.includes('.') ? `${asset.id}${path}` : null;
  const at = (when: When, hour: number) => typeof when === 'number'
    ? new Date(Date.parse(`${referenceDate}T00:00:00Z`) + when * DAY + hour * HOUR).toISOString()
    : new Date(Date.parse(cutoff) - Number(when.slice(0, -1)) * HOUR).toISOString();
  /** A task with no stated claim was claimed a day or three before it finished. */
  const claimedBefore = (finished: When, days: number): When => typeof finished === 'number' ? finished - days : `${Number(finished.slice(0, -1)) + days * 24}h`;
  /** A card is recorded an hour after its task is filed, in the site's own
   * revenue family unless it names one; its kill date is a calendar day. */
  const cardOf = ({ kill, ...figures }: CardPlan, asset: Asset, filed: string): NonNullable<DemoTaskFact['card']> => {
    const family = figures.revenueFamily ?? asset.revenueFamily ?? (asset.adRpm ? 'ads' : undefined);
    return { ...figures, ...(family ? { revenueFamily: family } : {}),
      ...(kill ? { kill: { state: kill[0], date: new Date(Date.parse(`${referenceDate}T00:00:00Z`) + kill[1] * DAY).toISOString().slice(0, 10) } } : {}),
      at: new Date(Date.parse(filed) + HOUR).toISOString() };
  };
  const tasks: DemoTaskFact[] = [];
  const projects = assets.map(asset => ({ asset: asset.id, prefix: asset.prefix, database: `demo_${asset.prefix}` }));
  for (const asset of assets) {
    const plans = WORK[asset.prefix], themes = EPICS[asset.prefix];
    if (!plans || !themes) throw new Error('The task scenario needs every declared project.');
    const epics = new Map(themes.map(theme => [theme.key, id(asset, `epic-${theme.key}`)]));
    const where = `[${asset.name} in NoticeOS](/assets/${asset.id})`;
    if (plans.some(plan => plan.epic !== undefined && !epics.has(plan.epic))) throw new Error('A planned task names an epic its project does not have.');
    for (const theme of themes) {
      const members = plans.filter(plan => plan.epic === theme.key);
      if (!members.length) throw new Error('Every demo epic needs planned work.');
      const [why, ...scope] = theme.about.split(/(?<=\.) /u);
      tasks.push({ id: epics.get(theme.key)!, asset: asset.id, prefix: asset.prefix, title: theme.title,
        description: workDescription(sentenceEnding(theme.title), why!, scope.join(' '), where),
        acceptance: members.filter(member => member.status !== 'deferred').map(member => checklist(member.brief[1])).join('\n'), issueType: 'epic', priority: 2, changeClass: theme.kind,
        events: [{ at: at(Math.min(...members.map(plan => typeof plan.opened === 'number' ? plan.opened : 0)) - 1, 9), status: 'open', assignee: OPERATOR }], comments: [] });
    }
    // Times of day vary by task so a day's work does not all land at once; a
    // task waiting on another is filed after it, so no import sees the edge
    // before its target.
    const openedAt = plans.map((plan, index) => Date.parse(at(plan.opened, 8 + (index * 3) % 7)));
    for (let pass = 0; pass < plans.length; pass++) {
      plans.forEach((plan, index) => {
        if (plan.dependsOn !== undefined) openedAt[index] = Math.max(openedAt[index]!, openedAt[plan.dependsOn]! + HOUR);
      });
    }
    for (const [index, plan] of plans.entries()) {
      const owner: Owner = plan.owner ?? DEMO_BUILDER;
      const key = `task-${index}`;
      const opened = new Date(openedAt[index]!).toISOString();
      // Open work waits unclaimed unless someone already owns it.
      const history: DemoTaskEvent[] = [{ at: opened, status: 'open', assignee: plan.status === 'open' ? plan.owner ?? null : null }];
      const later = (when: When | undefined, hour: number) => {
        const previous = Date.parse(history.at(-1)!.at);
        return new Date(Math.max(previous + HOUR, Date.parse(at(when ?? plan.opened, hour)))).toISOString();
      };
      const started = plan.started ?? (plan.finished === undefined ? undefined : claimedBefore(plan.finished, 1 + index % 3));
      if (plan.status === 'closed' || plan.status === 'in_progress') history.push({ at: later(started, 10 + (index * 2) % 5), status: 'in_progress', assignee: owner });
      if (plan.status !== 'open' && plan.status !== 'in_progress') history.push({ at: later(plan.finished, 13 + (index * 5) % 7), status: plan.status, assignee: owner });
      const gateFor = plan.gate === undefined ? undefined : id(asset, `task-${plan.gate}`);
      const commit = commitOf(asset, key), link = linkOf(asset, plan.path);
      const built = plan.status === 'closed' && owner === DEMO_BUILDER;
      const fact: DemoTaskFact = { id: id(asset, key), asset: asset.id, prefix: asset.prefix, title: plan.title,
        description: plannedDescription(plan, where, plan.gate === undefined ? undefined : `[${plans[plan.gate]!.title}](/tasks/${gateFor})`),
        acceptance: checklist(plan.brief[1]),
        issueType: gateFor ? 'gate' : plan.question ? 'decision' : plan.reproduce ? 'bug' : 'task',
        priority: plan.priority ?? 2, events: history, comments: [], changeClass: plan.change,
        ...(gateFor ? { human: true, blocks: gateFor } : plan.epic ? { parent: epics.get(plan.epic)! } : {}),
        ...(plan.human ? { human: true } : {}),
        ...(plan.steps ? { steps: plan.steps } : {}),
        ...(plan.card ? { card: cardOf(plan.card, asset, opened) } : {}),
        ...(plan.options && plan.question ? { choices: { question: plan.question, options: plan.options.map((option, index) => ({ key: TASK_CHOICE_KEYS[index]!, ...option })) } } : {}),
        ...(plan.dependsOn === undefined ? {} : { dependsOn: id(asset, `task-${plan.dependsOn}`) }),
        ...(plan.status === 'deferred' ? { deferUntil: at(14, 12) } : {}),
        // An agent's close carries its evidence as pointers: the commit and where the change shows.
        ...(plan.status === 'closed' ? { closeEvidence: built ? [sentence(plan.brief[3]), commit, ...(link ? [link] : [])].join(' · ') : plan.brief[3] } : {}),
        ...(history.some(event => event.status === 'in_progress') && modelOf(asset, key, owner, plan.priority) ? { model: plan.model ?? modelOf(asset, key, owner, plan.priority) } : {}) };
      if (plan.note || plan.check || plan.human || gateFor) {
        fact.comments.push({ author: plan.human || gateFor ? DEMO_BUILDER : OPERATOR, at: opened, text: plan.brief[2] });
      }
      const closedAt = history.at(-1)!.at, claimedAt = history.find(event => event.status === 'in_progress')?.at;
      const before = (hours: number) => new Date(Math.max(Date.parse(claimedAt ?? opened) + HOUR / 2, Date.parse(closedAt) - hours * HOUR)).toISOString();
      if (plan.status === 'in_progress') fact.comments.push({ author: owner, at: closedAt, text: plan.brief[2] });
      if (fact.dependsOn && plan.status === 'blocked') fact.comments.push({ author: owner, at: closedAt, text: `Work resumes when [the prerequisite](/tasks/${fact.dependsOn}) is complete.` });
      if (built) {
        fact.comments.push({ author: DEMO_BUILDER, at: before(2), text: plan.note ? `${plan.note} Fixed in \`${commit}\`.` : `The change in \`${commit}\` is ready for verification.` });
        // Work with its own verification task is checked there instead.
        if (!plans.some(other => other.dependsOn === index && other.owner === DEMO_VERIFIER)) {
          fact.comments.push({ author: DEMO_VERIFIER, at: before(1), text: sentenceEnding(plan.check ? `Checked that ${plan.check}` : plan.brief[3]) });
        }
      } else if (plan.status === 'closed') {
        fact.comments.push({ author: owner, at: closedAt, text: `${plan.brief[3]} See [${asset.name} in NoticeOS](/assets/${asset.id}).` });
      }
      tasks.push(fact);
    }
  }

  // The reference week beside the planned work: quick fixes closed within
  // hours of their claim, and the verifier's daily check of the day before's
  // changes, so every day of the week has closes and a check is running now.
  QUICK.forEach(([prefix, title, done, path, when, change], index) => {
    const asset = assets.find(entry => entry.prefix === prefix);
    if (!asset) return;
    const key = `quick-${index}`;
    const closed = at(when, 0), claimed = new Date(Date.parse(closed) - (1 + index % 3) * HOUR).toISOString();
    const opened = new Date(Date.parse(claimed) - DAY).toISOString();
    const commit = commitOf(asset, key), link = linkOf(asset, path);
    tasks.push({ id: id(asset, key), asset: asset.id, prefix, title,
      description: `${title} on ${asset.name}.\n\n## Where\n\n\`${path}\``,
      acceptance: checklist(sentenceEnding(done)), issueType: 'task', priority: 3, changeClass: change,
      events: [{ at: opened, status: 'open', assignee: null }, { at: claimed, status: 'in_progress', assignee: DEMO_BUILDER },
        { at: closed, status: 'closed', assignee: DEMO_BUILDER }],
      closeEvidence: [done, commit, ...(link ? [link] : [])].join(' · '), model: modelOf(asset, key, DEMO_BUILDER, 3)!,
      comments: [{ author: DEMO_BUILDER, at: new Date(Date.parse(closed) - HOUR / 2).toISOString(), text: `The change in \`${commit}\` is ready for verification.` }] });
  });
  CHECKS.forEach(([prefix, when, running], index) => {
    const asset = assets.find(entry => entry.prefix === prefix);
    if (!asset) return;
    const finished = at(when, 10), claimed = new Date(Date.parse(finished) - (running ? 0 : 2) * HOUR).toISOString();
    const label = dayLabel(new Date(Date.parse(finished) - DAY).toISOString());
    const opened = new Date(Date.parse(claimed) - 3 * HOUR).toISOString();
    const key = `check-${index}`;
    tasks.push({ id: id(asset, key), asset: asset.id, prefix, title: `Check the ${label} changes on ${asset.name}`,
      description: workDescription(`Verify what shipped to ${asset.name} on ${label}.`,
        'An independent check confirms whether the release behaves as expected.',
        'Open each shipped change from that day and record the result of its acceptance checks.', `[${asset.name} in NoticeOS](/assets/${asset.id})`),
      acceptance: checklist(`Each change from ${label} has a recorded result for its acceptance checks.`),
      issueType: 'task', priority: 2, changeClass: PROCESS,
      events: [{ at: opened, status: 'open', assignee: DEMO_VERIFIER }, { at: claimed, status: 'in_progress', assignee: DEMO_VERIFIER },
        ...(running ? [] : [{ at: finished, status: 'closed' as const, assignee: DEMO_VERIFIER }])],
      ...(running ? {} : { closeEvidence: [`${label} changes pass on ${asset.name}`, ...(linkOf(asset) ? [linkOf(asset)!] : [])].join(' · ') }),
      model: modelOf(asset, key, DEMO_VERIFIER)!,
      comments: [{ author: DEMO_BUILDER, at: opened, text: `${asset.name} changes from ${label} are ready to check.` }] });
  });

  // The seven weeks before the reference week: what each project finished,
  // so the velocity chart has a history. The verifier checks each project's
  // week, and Mara reviews the portfolio's.
  const byPrefix = new Map(assets.map(asset => [asset.prefix, asset]));
  const queues = new Map(Object.entries(EARLIER).map(([prefix, items]) => [prefix, items.map((item, index) => ({ item, index }))]));
  let sequence = 0;
  EARLIER_PACE.forEach((count, slot) => {
    const weeksAgo = EARLIER_PACE.length + 1 - slot;
    const weekEnd = -7 * (weeksAgo - 1);
    const shipped = new Map<string, number>();
    for (let taken = 0, turn = 0; taken < count && turn < 200; turn++) {
      const prefix = Object.keys(EARLIER)[turn % Object.keys(EARLIER).length]!;
      const asset = byPrefix.get(prefix), queue = queues.get(prefix);
      if (!asset || !queue?.length) continue;
      const closeDay = weekEnd - 1 - (sequence % 6);
      // A project only finishes work after it exists, with room to file and claim it first.
      if (Date.parse(`${referenceDate}T00:00:00Z`) + (closeDay - 3) * DAY < Date.parse(asset.createdAt)) continue;
      const { item: [title, done, path, change], index } = queue.shift()!;
      const key = `earlier-${index}`, j = sequence++;
      // Some urgent work every week; the last weeks also clear quick fixes.
      const priority = j % 5 === 0 ? 1 : weeksAgo <= QUICK_WEEKS && j % 4 === 1 ? 3 : 2;
      const closed = new Date(Date.parse(`${referenceDate}T00:00:00Z`) + closeDay * DAY + (9 + (j * 5) % 9) * HOUR).toISOString();
      const claimed = new Date(Date.parse(closed) - (priority === 3 ? 1 + j % 3 : 6 + (j * 7) % 60) * HOUR).toISOString();
      const opened = new Date(Math.max(Date.parse(asset.createdAt) + HOUR, Date.parse(claimed) - (1 + j % 9) * DAY)).toISOString();
      const commit = commitOf(asset, key), link = linkOf(asset, path);
      const where = path ? `\`${path}\` on ${asset.name}` : `[${asset.name} in NoticeOS](/assets/${asset.id})`;
      tasks.push({ id: id(asset, key), asset: asset.id, prefix: asset.prefix, title,
        description: `${title}.\n\n## Where\n\n${where}`,
        acceptance: checklist(sentenceEnding(done)), issueType: 'task', priority, changeClass: change,
        events: [{ at: opened, status: 'open', assignee: null }, { at: claimed, status: 'in_progress', assignee: DEMO_BUILDER },
          { at: closed, status: 'closed', assignee: DEMO_BUILDER }],
        closeEvidence: [done, commit, ...(link ? [link] : [])].join(' · '), model: modelOf(asset, key, DEMO_BUILDER, priority)!,
        comments: [{ author: DEMO_BUILDER, at: new Date(Date.parse(closed) - 2 * HOUR).toISOString(), text: `The change in \`${commit}\` is ready for verification.` },
          { author: DEMO_VERIFIER, at: new Date(Date.parse(closed) - HOUR).toISOString(), text: sentenceEnding(done) }] });
      shipped.set(prefix, (shipped.get(prefix) ?? 0) + 1);
      taken++;
    }
    const monday = new Date(Date.parse(`${referenceDate}T00:00:00Z`) + weekEnd * DAY);
    const label = dayLabel(monday.toISOString());
    // The verifier's weekly check of every project's release, busiest first.
    [...shipped.entries()].filter(([prefix]) => prefix !== 'no').sort((a, b) => b[1] - a[1]).forEach(([prefix, changes], rank) => {
      const asset = byPrefix.get(prefix)!;
      // Early on the Monday, before the new week's work starts.
      const closed = new Date(monday.getTime() + (7 - rank) * HOUR).toISOString();
      const opened = new Date(monday.getTime() - 2 * DAY).toISOString();
      const claimed = new Date(Date.parse(closed) - 3 * HOUR).toISOString();
      tasks.push({ id: id(asset, `release-${weeksAgo}`), asset: asset.id, prefix, title: `Verify the ${label} release`,
        description: workDescription(`Verify the ${asset.name} release for the week ending ${label}.`,
          `The release includes ${changes} ${changes === 1 ? 'change that needs' : 'changes that need'} an independent check.`,
          'Run each shipped task’s acceptance checks and record any follow-up.', `[${asset.name} in NoticeOS](/assets/${asset.id})`),
        acceptance: checklist(`The release record includes a check result for all ${changes} ${changes === 1 ? 'change' : 'changes'}.`),
        issueType: 'task', priority: 2, changeClass: PROCESS,
        events: [{ at: opened, status: 'open', assignee: DEMO_VERIFIER }, { at: claimed, status: 'in_progress', assignee: DEMO_VERIFIER },
          { at: closed, status: 'closed', assignee: DEMO_VERIFIER }],
        closeEvidence: `${changes} ${asset.name} ${changes === 1 ? 'change' : 'changes'} verified for ${label}`, model: modelOf(asset, `release-${weeksAgo}`, DEMO_VERIFIER)!,
        comments: [{ author: OPERATOR, at: opened, text: `${asset.name}'s ${label} release is ready to check.` }] });
    });
    // Mara's Monday review of the portfolio's week.
    const os = assets.find(asset => asset.prefix === 'no');
    if (os) {
      const closed = new Date(monday.getTime() + 15 * HOUR).toISOString();
      tasks.push({ id: id(os, `review-${weeksAgo}`), asset: os.id, prefix: os.prefix, title: `Review the week to ${label}`,
        description: workDescription(`Review portfolio results for the week ending ${label}.`,
          'The review sets the work the team will pick up next.',
          'Read the week’s reports and file a task for each finding that needs action.', `[${os.name} in NoticeOS](/assets/${os.id})`),
        acceptance: checklist('The review records its findings and links each follow-up task.'),
        issueType: 'task', priority: 2, changeClass: PROCESS,
        events: [{ at: new Date(monday.getTime() - DAY).toISOString(), status: 'open', assignee: OPERATOR },
          { at: new Date(monday.getTime() + 9 * HOUR).toISOString(), status: 'in_progress', assignee: OPERATOR },
          { at: closed, status: 'closed', assignee: OPERATOR }],
        closeEvidence: `Week to ${label} reviewed with follow-ups filed`,
        comments: [{ author: OPERATOR, at: new Date(monday.getTime() - DAY).toISOString(), text: `The week to ${label} is ready to review.` }] });
    }
  });

  // Each epic is filed before any of its work, so no dated import holds a
  // child whose parent does not exist yet.
  for (const epic of tasks.filter(task => task.issueType === 'epic')) {
    const first = Math.min(...tasks.filter(task => task.parent === epic.id).map(task => Date.parse(task.events[0]!.at)));
    if (first - HOUR < Date.parse(epic.events[0]!.at)) {
      epic.events[0]!.at = new Date(Math.max(Date.parse(assets.find(asset => asset.id === epic.asset)!.createdAt), first - HOUR)).toISOString();
    }
  }
  if (tasks.some(task => task.events.some(event => event.at > cutoff || event.at < assets.find(asset => asset.id === task.asset)!.createdAt) || task.comments.some(comment => comment.at > cutoff) || (task.card?.at ?? '') > cutoff)) throw new Error('Task history falls outside its declared asset lifetime or cutoff.');
  const story = (prefix: string, index: number) => id(assets.find(asset => asset.prefix === prefix)!, `task-${index}`);
  return { projects, tasks, storyIds: { repair: story('lb', 0), readback: story('lb', 3), problem: story('pw', 0), ship: story('wp', 0), shipReadback: story('wp', 3), slide: story('tn', 0), slideReadback: story('tn', 1) } };
}

/** Import the dated facts through bd; no task-table SQL writer exists here. */
export function demoTaskIssuesAt(tasks: readonly DemoTaskFact[], instant: string): Record<string, unknown>[] {
  if (!Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant) throw new Error('An exact task-history instant is required.');
  return tasks.flatMap(task => {
    const events = task.events.filter(event => event.at <= instant);
    const state = events.at(-1);
    if (!state) return [];
    const comments = task.comments.filter(comment => comment.at <= instant);
    const card = task.card && task.card.at <= instant ? task.card : undefined;
    const updated = [...events.map(event => event.at), ...comments.map(comment => comment.at), ...(card ? [card.at] : [])].sort().at(-1)!;
    const dependencies = [
      ...(task.parent ? [{ issue_id: task.id, depends_on_id: task.parent, type: 'parent-child' }] : []),
      ...(task.dependsOn ? [{ issue_id: task.id, depends_on_id: task.dependsOn, type: 'blocks' }] : []),
      ...tasks.filter(gate => gate.blocks === task.id && gate.events[0]!.at <= instant).map(gate => ({ issue_id: task.id, depends_on_id: gate.id, type: 'blocks' })),
    ];
    // What NoticeOS records beside the task client's own fields: the kind of
    // change, the card once it is recorded, a question's options, the
    // claimer's model, and once it is closed, who closed it.
    const claimed = events.find(event => event.status === 'in_progress');
    const attribution = {
      ...(claimed && task.model ? { [TASK_METADATA.claimedModel.name]: task.model } : {}),
      ...(state.status === 'closed' && state.assignee ? { [TASK_METADATA.closedBy.name]: state.assignee, [TASK_METADATA.closedAt.name]: state.at,
        ...(task.model ? { [TASK_METADATA.closedModel.name]: task.model } : {}) } : {}),
    };
    return [{ id: task.id, title: task.title, description: task.description, acceptance_criteria: task.acceptance,
      issue_type: task.issueType, priority: task.priority, status: state.status, ...(state.assignee ? { assignee: state.assignee } : {}),
      owner: OPERATOR, created_by: OPERATOR, created_at: task.events[0]!.at, updated_at: updated,
      ...(claimed ? { started_at: claimed.at } : {}),
      ...(state.status === 'closed' ? { closed_at: state.at, close_reason: task.closeEvidence } : {}),
      ...(state.status === 'deferred' ? { defer_until: task.deferUntil } : {}),
      ...(task.issueType === 'gate' ? { await_type: 'human', ephemeral: true } : {}),
      labels: ['synthetic-demo', ...(task.human ? ['human'] : [])],
      metadata: { synthetic: true, [TASK_METADATA.changeClass.name]: task.changeClass,
        ...(card ? { [TASK_METADATA.card.name]: card } : {}),
        ...(task.choices ? { [TASK_METADATA.choices.name]: task.choices } : {}), ...attribution }, dependencies,
      comments: comments.map(comment => ({ author: comment.author, text: comment.text, created_at: comment.at })),
    }];
  });
}

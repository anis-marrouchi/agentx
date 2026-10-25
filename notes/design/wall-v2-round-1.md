# Wall v2 designs, round 1 (#1355)

Design proposals for review. Nothing here is built. Per #1316 and #1355, a page gets built only after Anis accepts its design.

Canvas with all seven screens: https://claude.ai/artifact/3BNWrdXG6BXQr6bW5NPEDU (comment on any screen there, or on #1355).

All data on the screens is made up. The look reuses the Wall space as it ships today: its tokens in `src/daemon/ui/pages/wall-space.ts`, system font, white or black page, blue accent.

## The screens

| # | Screen | What it proposes |
|---|---|---|
| 1 | Wall feed | Closer to take B (below). |
| 2 | List | The table, grouped by what blocks each task. |
| 3 | Projects | One card per project, then capacity per owner. |
| 4 | Creator | A page to give an agent a task, which becomes its post. |
| 5 | Jobs | Recurring jobs per machine, with today's outcomes and stale signals. |
| 6 | Reviews | Classifications waiting for review, as a feed. |
| 7 | Phone, dark | The feed on a phone in dark mode. |

## 1. Wall feed: what changes to match take B

Take B and the build differ the most in four places. The canvas proposes:

1. **The view tabs move to the nav.** Today Feed, List, Projects, Failures, Jobs and Reviews are tabs above the posts. Take B has none there. The proposal gives Projects, Jobs, Reviews and Failures a nav item each, with its count, and keeps Feed / List as a small switch beside the title.
2. **Status tabs, as in take B.** Under the title: All, Working, Waiting, Done, Failed, plus a search button. The Filters panel opens from the search button, not from a bar that is always shown.
3. **A composer at the top**, as in take B: "Ask the fleet… use @agent to pick who" and **Post**. It is a short form of the Creator page (screen 4).
4. **Compact posts.** Each post shows the author line, the result in at most three lines, one amber line when it waits on someone, and one row of icons: thread replies, runs, minutes and project. The opened and last move times, the asker, the group, GitLab time and the links move into the opened post, where #1320 already shows them.

The side column follows take B: **Happening now** (one line per machine: who runs what), **Agents** with **Show all**, and **Quiet by design**. The classic page links move to the nav (**Dashboard**) and a link in the last box.

## 2. List

- Quick view buttons over the table: Open, Blocked, Stalled, Mine, My view and Filters.
- **Group by**: none, blocked by, project or owner. Each group has a header row with a count and the oldest wait.
- Seven columns by default (status, post, owner, project, days with no move, waits on, time against estimate); a **Columns** button shows the rest (machine, runs, group, GitLab state).
- Old waits and a time over the estimate are amber, so they stand out without a flag column.

## 3. Projects

- One card per project: a bar split into in progress, blocked, stalled and not started; the four counts (each opens the List with that filter); closed per week as four small bars; the project's rhythm and its agents.
- The card's corner says the worst state: stalled, blocked or moving.
- **Capacity per owner** stays a table, with a load bar against the threshold.

## 4. Creator (new page)

The issue names "Creator" without a definition. Round 1 reads it as **a page to create a post**: give an agent a task from the Wall.

- Pick the agent (cards with machine and load; over capacity is marked, not hidden), or type `@name`.
- The request (Markdown), **Done when** (the proof it should close with), project, where replies go, and an estimate.
- A preview of the post, and **What happens**: the agent gets it as a message, as a mention in a chat would; a post opens on the Wall; the thread fills in.
- It says plainly that this page sends a message, while every other Wall page only reads.

## 5. Jobs

- Today's totals at the top: ran, worked, failed, skipped, look stale.
- Jobs grouped by machine (or by agent). Each row: name, agent, value line (or **no value line** in amber), schedule in words, next run, the last 7 runs as squares, and its state.
- Opening a row shows the last run's short summary and a link to the full log. Full output stays on the log page, so the list stays short and holds no sensitive text.
- **Look stale**: off for 14 days or more, failed 3 times in a row, or no value line.
- **Pause** and **Archive** are drawn but marked "Phase 2, not built" (CLAUDE.md, delivery phase 2).
- A machine that does not answer keeps its jobs, marked "as of" its last answer.

Data: the fleet snapshot already carries each job's next run, last outcome and error streak (`src/daemon/app-fleet.ts`). The 7-run strip needs the persisted cron run files, which hold the real run status.

## 6. Reviews

- A feed, like the Wall: Pending, Approved and Rejected tabs.
- Each item: the proposed path, the message it came from, the proposed axes, a confidence bar, and links to decide on the graph page, the wiki results and the thread.
- The side column: what the graph filed by itself this week, how many went to review and were approved or rejected, and the paths it is least sure about.
- It still only reads. Deciding stays on the graph page and `agentx graph review`.

## 7. Phone, dark

The feed comes first, with the status tabs. The bottom bar has Wall, Needs you, Running now, Projects and **More** (Agents, Jobs, Reviews, Failures, Dashboard). A round **+** button opens the Creator.

## Questions for Anis

1. **Creator**: is it "create a post / give an agent a task"? Or did you mean something else, such as creating an agent or a job?
2. **Nav**: nine items plus **New post**. Should Failures stay its own item, or become the **Failed** tab of the feed?
3. **Composer on the feed**: is writing from the Wall fine now that #1316 added comments and calls? Until #1316 the Wall only read.
4. **Compact posts**: is it fine to move times, asker, group and GitLab time into the opened post?
5. **Pages not built yet**: which ones do you want next? Candidates are Needs you and Running now as full pages, an agent's profile, and the Space from #1316.

## Next round

Comments on the canvas or on #1355 become round 2. Once a screen is accepted, it gets its own issue and is built on the Wall space as it is today: server-rendered HTML, shared tokens and plain browser JavaScript, no build step.

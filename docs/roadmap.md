# Roadmap

What is being built now, what comes next, and what was done recently. The live list is on GitHub: the [milestones](https://github.com/anis-marrouchi/agentx/milestones) and the issues labelled `priority: p1` and `priority: p2`. This page follows them; the weekly maintainer review checks the two match.

Last checked: 16 November 2026.

## Now

- One job ledger, so assigned work is visible and keeps going (`priority: p1`, milestone [2026-11](https://github.com/anis-marrouchi/agentx/milestones); [#1861](https://github.com/anis-marrouchi/agentx/issues/1861)).
- Workflow step proof: ownership check, environment exposure and log leak (milestone Phase 3; [#1852](https://github.com/anis-marrouchi/agentx/issues/1852)).

## Next

The other open `priority: p2` issues:

- A workflow step can close its own approval card ([#1849](https://github.com/anis-marrouchi/agentx/issues/1849)).
- A phone voice assistant that acts in apps, Android first ([#1848](https://github.com/anis-marrouchi/agentx/issues/1848)).
- Edge routing: read work a message implies but does not ask for ([#1862](https://github.com/anis-marrouchi/agentx/issues/1862)), and a confident edge answer beats a downgrade ([#1864](https://github.com/anis-marrouchi/agentx/issues/1864)).
- Build on native apps and existing conventions ([#1062](https://github.com/anis-marrouchi/agentx/issues/1062)).

## Done recently

**Phase 1** ([milestone](https://github.com/anis-marrouchi/agentx/milestone/1)):

- A first reply in under five minutes from one command, timed in CI on Linux and macOS ([#1286](https://github.com/anis-marrouchi/agentx/issues/1286)).
- Money budgets per project, prices for other model providers, and pauses that survive a restart ([#1290](https://github.com/anis-marrouchi/agentx/issues/1290)).
- Ready-made teams for support, sales, content and dev, chosen in `agentx start` ([#1293](https://github.com/anis-marrouchi/agentx/issues/1293)).
- Schedules that report only exceptions, and named events that wake listeners ([#1289](https://github.com/anis-marrouchi/agentx/issues/1289), [#1284](https://github.com/anis-marrouchi/agentx/issues/1284)).

**Phase 2** ([milestone](https://github.com/anis-marrouchi/agentx/milestone/2)):

- Sales: lead research with a source for every fact, a daily brief and a competitor watch ([#1288](https://github.com/anis-marrouchi/agentx/issues/1288)).
- Content: drafts in your voice, a weekly calendar, and approval before posting ([#1291](https://github.com/anis-marrouchi/agentx/issues/1291)).

**Phase 3** ([milestone](https://github.com/anis-marrouchi/agentx/milestone/3)):

- Email as a channel, and a support queue that drafts replies from your documents ([#1287](https://github.com/anis-marrouchi/agentx/issues/1287)).
- An org chart in the dashboard, and owner approval before an agent-created agent starts ([#1169](https://github.com/anis-marrouchi/agentx/issues/1169)).

**Also done:** tracked numbers with readings, a Hub page and a funnel view ([#1826](https://github.com/anis-marrouchi/agentx/issues/1826)); a design study for the wiki query as the first place agents look ([#1820](https://github.com/anis-marrouchi/agentx/issues/1820)) and for agents that emit and listen to events ([#1817](https://github.com/anis-marrouchi/agentx/issues/1817)); an edge model per job and sub-agents ([#1858](https://github.com/anis-marrouchi/agentx/issues/1858)); urgent messages between agents no longer wait behind the admission gate ([#1807](https://github.com/anis-marrouchi/agentx/issues/1807)); the approvals popup records only answers the owner gave ([#1788](https://github.com/anis-marrouchi/agentx/issues/1788)); the claude-code tier's guard hook fails closed when it cannot check a call ([#1710](https://github.com/anis-marrouchi/agentx/issues/1710)); a fix for live status leaving a reopened issue open ([#1719](https://github.com/anis-marrouchi/agentx/issues/1719)); an [upgrade promise](reference/releases.md#upgrade-promise), an install matrix with its pass rate, and this roadmap; AgentX stays on 0.x for now, and 1.0 will get its own issue ([#1294](https://github.com/anis-marrouchi/agentx/issues/1294)); a worktree per coding task, a review gate on GitLab, and Linear and Jira ([#1292](https://github.com/anis-marrouchi/agentx/issues/1292)); the Hub view of every project; monthly budgets per agent; stop-all with resume after a restart; the CI checks are required before anything merges into `main` ([#989](https://github.com/anis-marrouchi/agentx/issues/989)); fewer same-day fixes on agent pull requests ([#987](https://github.com/anis-marrouchi/agentx/issues/987)); and a wiki with typed pages and links ([#811](https://github.com/anis-marrouchi/agentx/issues/811)). Place reminders closed without the real-phone check ([#681](https://github.com/anis-marrouchi/agentx/issues/681)).

Every change, release by release, is in [CHANGELOG.md](https://github.com/anis-marrouchi/agentx/blob/main/CHANGELOG.md). What a release may change, and how it is checked, is in [Releases, upgrades and security](./reference/releases.md).

## Check it worked

1. **Browser:** open the [milestones](https://github.com/anis-marrouchi/agentx/milestones). Each milestone that still has open issues is under **Now** above.
2. The **Last checked** date at the top is less than two weeks old.

## If something is wrong

- **This page and the milestones disagree:** the milestones are right. Open an issue, or a pull request that updates this page.
- **Something you need is not on the roadmap:** open an issue that says what you want to get done, not how. New issues are triaged on weekdays and get a priority label.

# Keep wiki pages up to date on a schedule

![You pick the agent, the kinds of pages, where it may read, and a cap per run. On schedule, the run finds the pages whose sources changed. The agent reads each page, the messages that mention it and the contact records, then writes the story in full, typed facts with a source each, and a History that links to event pages. Old text is kept.](/diagrams/wiki-enrich.svg)

Your agents keep looking up the same facts about the same people again and again. With **scheduled enrichment**, one agent goes through the wiki on a timer and brings each page up to the level of your best hand-written one. Then any agent finds what it needs in one lookup.

It works on every kind of page about a real thing: **people**, **organisations**, **projects**, **places** and **assets** (devices, servers, apps, domains, accounts). For each page it writes:

- **An overview**: the page's story in a few full sentences. For a person: who they are to us, how it started, what changed, and where it stands now. It shows at the top of the page, in full.
- **Typed facts**, called **statements**: "role at Example Org, finance lead, since 2026-01", "contact for Website Rebuild", "located in Sample City Office". Each one names its **source**: the message, record or page it comes from. They fill the panels that were empty before, such as **Roles over time**, **Relations** and **Projects**.
- **A History** whose items link to their event pages. Click an event to open it, then click a project to open the project with its own story and events. When an event has no page yet, the run can write a short one, with its date and source.

![A person page before and after. Before: a two-sentence summary, 0 statements, Roles over time empty, Relations and Belongings that only say related to, and an agent listed as a belonging. After: a four-sentence overview with what it rests on, Roles over time showing finance lead at Example Org, typed relations marked proposed, no agent, and a History of linked events](/screenshots/wiki-enrich/person.jpg)

Each History item opens its event page, which says who was involved and where the fact comes from:

![An event page written by the run: its summary, the source message, and the person it involves](/screenshots/wiki-enrich/event.jpg)

Organisations, projects and places get the same treatment:

![A second person page before and after: Roles over time shows office manager at Example Org, Relations shows who they work with, Roles and relations lists where they work and what they are the contact for, and History links the event the run wrote](/screenshots/wiki-enrich/person-2.jpg)

![An organisation page before and after: People and roles now lists two people with their roles, Relations shows the project, Key facts shows where it is, and History links three events](/screenshots/wiki-enrich/organization.jpg)

![A project page before and after: Client and people shows the client organisation and the contact person, and History links two events](/screenshots/wiki-enrich/project.jpg)

![A place page before and after: What is here lists the person and the organisation located there, and History links one event](/screenshots/wiki-enrich/place.jpg)

What it will not do:

- **It never writes a fact without a source.** A statement must cite a message, a contact record, a wiki page or (when you allow it) a web page the run can check. A relation must point to a page that exists. Anything else is left out, and the run says so.
- **It never names an agent as a person's relation.** Agents are not people.
- **It only refreshes pages that changed.** A page is redone when a new message mentions it, a page about it changed, or a new page links to it.
- **It writes no personal analysis**, and every statement keeps the access level of the page it is on. A page written from a private page stays private.
- **It never overwrites your text.** The agent writes into its own page for each thing, which the wiki merges with the other pages of the same name. Each change keeps the old text as a past version. New statements are marked **proposed** until you confirm them.

Enrichment is off until you turn it on.

## Before you start

- Pick the agent that will run it, for example a wiki agent. The run uses that agent's model and costs what its calls cost.
- Run the commands below on the machine where that agent runs, in the folder that holds `agentx.json`.

## Turn it on

1. **Terminal:** run `agentx wiki enrich config --agent wiki-agent --enable`, with your own agent id. The command prints the settings.
2. **Terminal:** run `agentx wiki enrich config --schedule "0 3 * * *" --timezone Europe/Paris` to run it every night at 03:00. Use your own time zone. This adds a schedule called `wiki-enrich`.
3. **Terminal:** restart AgentX with `agentx daemon restart`, so the schedule starts.

The schedule also shows in the dashboard under **Settings**, on the **Schedules** tab, where you can pause it.

## Choose what it reads and how much it spends

Each setting is one flag on `agentx wiki enrich config`:

| What | Flag | Default |
|---|---|---|
| Kinds of pages | `--types person,organization,project,place` | people, organisations, projects, places and all assets except agents |
| Where it may read | `--sources entries,contacts,web` | `entries,contacts` |
| Most pages per run | `--max-pages 10` | `10` |
| Spending cap per run, in US dollars | `--max-spend 2` | `2` (`0` means no cap beyond the page count) |
| Most messages read per page | `--max-entries 40` | `40` |
| Most new event pages per page | `--max-events 5` | `5` |
| Model | `--model <name>` | the agent's own model |

The sources are:

- `entries`: the messages and notes your agents saved (WhatsApp, email, chats).
- `contacts`, `wacli`, `gitlab`, `gog`: the contact book and the contact tools AgentX already knows (WhatsApp, GitLab, Google).
- `web`: lets the agent search the web for public facts. Each fact from the web cites its address.

The run stops before a page that would likely go over the spending cap. Pages it did not reach wait for the next run. People come first, then organisations, then the other kinds, in the order you list them.

If you set a model, pick one the agent's runtime can run, the same family the agent already uses.

## Try it on one page first

1. **Terminal:** run `agentx wiki enrich run --page "Sample Person" --dry-run`, with a page title from your wiki. The agent reads the page and prints what it would write: the overview, each statement with its source, the History, and what it left out and why. Nothing is saved.
2. **Terminal:** run `agentx wiki enrich run --page "Sample Person"` to write it.
3. **Browser:** open the dashboard wiki and search for the page. The overview, the panels and the History show the new content.

`--page` works even while enrichment is off. To cap one run's spending without changing the setting, add `--max-cost 0.50`.

## See what each run did

1. **Terminal:** run `agentx wiki enrich status`. It lists the last runs: how many pages were refreshed, failed or unchanged, what it spent, and for each page what it got.
2. **Terminal:** run `agentx wiki enrich status --json` for the full record.

The record is kept in `.agentx/wiki/_enrich.json`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `wikiEnrich.enabled` | `false` | Turns scheduled enrichment on for this machine. Needs `wikiEnrich.agent`. |
| `wikiEnrich.agent` | — | The agent that reads the sources and writes the pages. |
| `wikiEnrich.types` | person, organization, project, place, device, server, app, domain, account | Kinds of pages refreshed, in order. Agents are never refreshed. |
| `wikiEnrich.sources` | `["entries", "contacts"]` | Where a run may read: `entries`, `contacts`, `wacli`, `gitlab`, `gog`, `web`. |
| `wikiEnrich.maxPages` | `10` | Most pages refreshed in one run (1 to 200). |
| `wikiEnrich.maxSpendUsd` | `2` | Spending cap per run in US dollars. `0` leaves only `maxPages`. |
| `wikiEnrich.maxEntriesPerPage` | `40` | Most messages given for one page (1 to 200). |
| `wikiEnrich.maxNewEvents` | `5` | Most new event pages one page may create in a run (0 to 20). |
| `wikiEnrich.model` | — | Model for the agent's calls. Unset, the agent's own model is used. |

## Check it worked

1. **Terminal:** run `agentx wiki enrich config`. It shows `wiki enrichment: on`, your agent and the schedule `wiki-enrich`.
2. **Terminal:** run `agentx wiki enrich run --page "<a page title>"`. It prints `1 refreshed`.
3. **Browser:** open that page in the dashboard wiki. The overview is complete, at least one panel shows a typed statement marked **proposed**, and its History items open event pages.
4. **Browser:** click a statement's **Z4** link. It shows the source the statement came from.
5. **Terminal:** the next day, run `agentx wiki enrich status`. The night's run is listed.

## If something is wrong

- **`wiki enrichment is off on this node`:** run `agentx wiki enrich config --enable`, or name one page with `--page`.
- **`no enrichment agent set`** or **`no agent "<id>" on this node`:** run `agentx wiki enrich config --agent <id>` with an agent from `agentx.json`.
- **`<agent>'s pages are copied from <machine>`:** that agent's pages come from another machine and are read-only here. Run the enrichment on that machine.
- **Nothing is refreshed and it says `unchanged`:** no source changed since the last run. Use `--page "<title>"` to redo one page anyway, or add `--force` to redo all.
- **It stops with `stopped by spend cap` or `stopped by max pages`:** the run reached its cap. The rest waits for the next run. Raise `--max-spend` or `--max-pages` if you want more per night.
- **A statement you expected is missing:** run with `--dry-run` and read the `left out` lines. A fact is left out when it has no source the run can check, when its page does not exist yet, or when it names an agent.
- **`the reply held no JSON object`:** the agent answered in prose instead of the expected format. Try again, or set `--model` to a stronger model.
- **An agent still shows as a person:** see [Wiki › If something is wrong](../dashboard/wiki.md#if-something-is-wrong).
- **You want the old text back:** each page keeps its past versions under `.agentx/wiki/agents/<agent>/graph/_versions/`. A statement's **Z4** page lists them by date.

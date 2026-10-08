# Bring entity pages up to a full story

Agents write a page about a person, a company, a project or a server when it comes up in their work. Several agents can write about the same thing, so the wiki merges their pages into one **entity**. Those pages tell you a lot, but they rarely tell you the whole story in one place. The overview often stops mid-sentence, the **Roles** and **Relations** panels stay empty, and the history is a list of events with nothing that ties them together.

`agentx wiki enrich` fixes that, one entity at a time. It reads every agent's page about the entity, the event and project pages linked to it, other pages that mention it, and the conversations the pages were written from. From that, it writes:

- **An overview**: who they are to you, how it started, what changed, and where it stands now, with dates. You see it in full at the top of the entity page.
- **Typed facts**, each with its **source**: role at, member of, works with, works on, owns, located in, and so on. They fill the panels of the page's type. Click **Z4** on any fact to see where it came from.
- **History links**: the event and project pages it belongs with. Open one to zoom in a level.

It works for people, organizations, projects, places, devices, servers, apps, domains and accounts.

- **Nothing is invented.** A fact needs a property the page's type shows, a value, and a source the run was shown. Anything else is dropped, and the run tells you why.
- **Agents are not people.** The fleet's own agents never show up as a person's relations. See [Agents are kept out of People](#agents-are-kept-out-of-people).
- **Old text is kept.** Each write saves the previous version of the page, so you can see what changed.
- **Spending has a cap.** Each entity costs one model call. A run stops before the next call once it has spent `--max-cost`.
- **Only what changed is redone.** An entity is done again only when it has a new source, page, linked event or mentioning page. `--force` redoes it anyway.

## Before you start

- The [typed wiki view](../dashboard/wiki.md) shows the pages you will enrich. Open `/admin/wiki/` to see them.
- The machine runs the `claude` command line tool, which the agents already use.

## Try it on one page

1. **Terminal:** in the folder with `agentx.json`, run `agentx wiki enrich "<page title>" --dry-run`. It prints the overview, the facts with their sources, and what it dropped. Nothing is written.
2. Run it again without `--dry-run` to write it.
3. **Browser:** open the entity page under `/admin/wiki/`. The overview is at the top, the panels list the new facts, and **History** links to the events.

To run every changed entity of some types, leave out the title:

```bash
agentx wiki enrich --types person,organization --max 20 --max-cost 2
```

## Add a page for something only mentioned

Sometimes the wiki names a company in many pages, but none of them is about the company itself. To create its page and fill it in one step, run:

```bash
agentx wiki enrich --create "<name>" --as organization --owner <agent>
```

The page goes into that agent's wiki, typed as you asked, and the run writes it from the pages that mention it. Pick an agent that runs on this machine. Pages copied from another machine can't be changed here.

## Run it on a schedule

Add a job with a `command` to `crons` in `agentx.json`. The `agent` field picks the agent that runs it. This job runs every night and spends at most $2:

```json
{
  "crons": {
    "wiki-enrich": {
      "schedule": "0 3 * * *",
      "agent": "<agent>",
      "command": "agentx wiki enrich --max 20 --max-cost 2"
    }
  }
}
```

## Settings

| Flag | Default | What it does |
|---|---|---|
| `--types <list>` | every type it handles | Which entity types to do, comma-separated. |
| `--max <n>` | `10` | Most entities per run. |
| `--max-cost <usd>` | `1` | The run stops before the next call once it has spent this much. |
| `--model <m>` | `sonnet` | The model that writes. |
| `--force` | — | Redo entities that did not change. |
| `--dry-run` | — | Show what would be written. Writes nothing. |
| `--create <title>` | — | First create a page for this name. Needs `--as` and `--owner`. |
| `--json` | — | Print the run as JSON. |

The run remembers what it did in `.agentx/wiki/_enrich/state.json`. Delete that file to start over.

## Agents are kept out of People

Old pages about an agent are often typed `person`, and titled with just the agent's name. The wiki treats a person or untyped page as an agent when its title matches one of these:

- an agent id in the wiki, or a `name` in this machine's `agentx.json`. An agent named `<id> Agent` is named after a person, so only its full name counts;
- the persona name in the agent's workspace (`**Name:** …` in `IDENTITY.md` or `persona.md`);
- a name you list under `agent_names` in `ontology.yaml`. Use this for agents that run on another machine:

  ```yaml
  agent_names:
    - Nova
  ```

When that name is also the first name of a real person page (for example "Nova" next to "Nova Reyes"), the page stays a person. The page then shows **Check the type**. Add `class: agent` or `class: person` to its header to decide.

## Check it worked

1. **Terminal:** run `agentx wiki enrich "<page title>" --dry-run`. It prints an overview and at least one fact with a source.
2. **Browser:** open the entity page. The overview is complete, at least one panel lists a typed fact, and its **Z4** link shows the source.
3. Open a **History** item. It opens the event's own page.
4. **Terminal:** run the same command without `--dry-run` a second time. It prints `nothing to do`, because nothing changed.

## If something is wrong

- **`dropped: source not among those given`:** the model cited something the run did not show it. The fact is left out. Nothing to fix; a later run can find it when a source mentions it.
- **`dropped: value is a project, expected organization`:** the name points at a page of another type. Give the real organization its own page (see [Add a page for something only mentioned](#add-a-page-for-something-only-mentioned)), then run it again with `--force`.
- **`write refused`:** the page belongs to another agent or was copied from another machine. Run the job on the machine that holds the page.
- **`stopped at the cap`:** the run reached `--max-cost`. The rest wait for the next run, or raise the cap.
- **An agent still shows under People:** its name is not in the list above. Add it under `agent_names` in `ontology.yaml`.
- **A fact is wrong:** open the page's header and remove it from `statements`. Facts this job wrote carry `"by":"wiki-enrich"`, and the next run replaces all of them.

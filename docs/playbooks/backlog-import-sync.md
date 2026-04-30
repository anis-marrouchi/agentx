---
title: "Backlog import + upstream sync"
---

# Backlog import + upstream sync

When `business.workSource.type=backlog`, agents pull work from a structured store at `.agentx/backlog.json` instead of querying GitLab/GitHub directly. Importing existing issues into the backlog avoids the "day-cycle flood" pattern (where enabling business with `workSource.type=gitlab` floods agents with every open issue) while keeping a stable link to the upstream — mutations the agents make on backlog items push back to the source automatically.

## Why use the backlog source

| | `workSource: gitlab` | `workSource: backlog` |
|---|---|---|
| Pulls every assigned issue | Yes | No — only what you import |
| Survives the source going down | No | Yes |
| Mutations sync back to source | One-way (claim/done update labels) | Two-way (assignee, labels, title, description, milestone, state) |
| Right when… | The team lives on GitLab; agents are new | You want fine-grained control over what agents see |

## Import from GitLab

```bash
agentx backlog import
```

The interactive flow:

1. **Source picker** — choose `gitlab` (offered when `channels.gitlab.token` is configured)
2. **Project picker** — autocomplete from `channels.gitlab.routes[]` + `business.workSource.projects` + `business.projects[].id`. Pick `__CUSTOM__` to type a path that isn't pre-configured
3. **Search filter** — optional text query for the GitLab `search` parameter; leave empty to fetch all open
4. **Issue picker** — autocomplete-multiselect of open issues. Already-imported ids are visible but disabled (no double-imports). Space toggles, Enter confirms
5. **Save** — selected issues land in `.agentx/backlog.json` with `source: { type, host, project, iid, url }` + `importedAt`

Non-interactive form (e.g. for cron-driven imports):

```bash
agentx backlog import --source gitlab --project mtgl/mtgl-system-v2 --assignee mtgl-v2
```

The `--assignee` flag pre-fills the assignee for every imported item — useful when you're seeding work for one specific agent.

## Import from GitHub

Same flow, source = `github`:

```bash
agentx backlog import --source github --project owner/repo
```

For text search, GitHub uses its `search/issues` endpoint with `repo:<owner/repo> is:issue is:open <query>` — the same syntax you'd type into the GitHub UI search box. Without a query, the lister uses the plain `repos/{owner/repo}/issues` endpoint and filters out PRs (which appear under the same path).

## Mutation sync upstream

Once imported, `agentx backlog claim <id> <agent>` and `agentx backlog done <id>` push changes back to the source automatically:

| Local action | Pushed upstream |
|---|---|
| `claim` | Add `Doing` label, remove `To Do` label, set assignee to the agent's mapped `gitlab/githubUsernames[0]` |
| `done` | Add `Done` label, remove `Doing` label. With `--close`, also close the issue |
| `done --note "<text>"` | Same as above plus a comment on the source issue |

The username resolution uses `channels.gitlab.agentMappings[].gitlabUsernames` (or the `github` equivalent). When no mapping is found, the upstream call falls through with the agentId verbatim — works fine when your agent ids match GitLab usernames.

## Conflict resolution

The backlog stores `source.iid` + `source.project`, so the same upstream issue cannot be imported twice (the `import` picker disables already-imported rows). When an agent mutates a backlog item that no longer exists upstream (closed, deleted), the sync call returns `404` and the local mutation still lands — the backlog tracks divergence locally and the agent keeps working.

To force a re-pull from upstream (e.g. after renaming the project), remove the local item and re-import:

```bash
agentx backlog remove gitlab:old/project:42
agentx backlog import --source gitlab --project new/project
```

## Cron-driven sync

For continuously keeping the backlog in step with upstream, add a cron:

```bash
agentx schedule "every weekday at 8am" \
  --agent ops-agent \
  --do "Run agentx backlog import --source gitlab --project mtgl/mtgl-system-v2 non-interactively for any new triaged issues since yesterday. Use the search filter 'label:triaged' to only catch ones that are ready to work on."
```

The agent runs the import (in dry-run-style — it can't accept interactive prompts, so wrap it in a script that pipes selections), or you can write a small wrapper that reads from the GitLab API directly and calls `agentx backlog import` per issue.

For the simplest setup, just have the agent run `agentx backlog import` every morning manually — humans pick what makes the cut.

## Inspecting the backlog

```bash
agentx backlog list
agentx backlog list --status doing
agentx backlog list --assignee mtgl-v2
agentx backlog list --source gitlab
```

Shape of an item (`.agentx/backlog.json`):

```json
{
  "id": "gitlab:mtgl/mtgl-system-v2:142",
  "title": "User profile page crash on null avatar",
  "description": "...",
  "assignee": "mtgl-v2",
  "labels": ["bug", "frontend"],
  "milestone": "v2.1",
  "status": "doing",
  "source": {
    "type": "gitlab",
    "host": "gitlab.noqta.tn",
    "project": "mtgl/mtgl-system-v2",
    "iid": 142,
    "url": "https://gitlab.noqta.tn/mtgl/mtgl-system-v2/-/issues/142"
  },
  "importedAt": "2026-04-30T18:30:00.000Z",
  "createdAt": "...",
  "updatedAt": "..."
}
```

The store regenerates `.agentx/backlog.md` (a human-readable markdown view) on every save — useful for git diffs.

## Next

- [`agentx backlog` CLI reference](/reference/cli#backlog)
- [Business config schema](/reference/config-schema#business-optional)
- [Journey 7 — Business layer](/journey/07-business-layer) for the work-pool framework that backlogs feed into

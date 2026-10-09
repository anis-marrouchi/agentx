# Get wiki answers checked at the source

A wiki page records what was true when it was written. An issue that was open then may be closed now, and the version a page names may no longer be the one that runs. An agent that asks the wiki gets the page's answer, stated with confidence, even when it is out of date.

With **page summaries** and a **live read**, a wiki question is answered in four steps:

1. Every page has a one-line summary: its main fact, the status it gives and the date of that status. The pages that share words with the question are found from these lines, with no model.
2. A small model picks up to 3 pages from those lines, or none when no line fits.
3. A small model names what should be confirmed at the source: an issue, a merge request, a repository's newest releases, where a change is deployed, the AgentX version on each machine. AgentX then reads those, from the systems you listed.
4. The answer is written from the pages and what was just read. Where they disagree, what was just read wins, and the answer marks those facts with "(live)".

The same steps run for `agentx wiki query` in a terminal and for the `agentx_wiki_query` tool agents use.

Everything on this page happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`.

## What a live read can and can't do

A live read only reads.

- The model names a read as data: a kind, a repository from your list, and a number or a few search words. It is given no shell, no command and no tool.
- AgentX checks each named read against your settings. A repository you did not list is refused.
- Each read is made of HTTP `GET` requests that AgentX builds itself. Nothing is sent, changed or closed.
- A token goes only to the host it was set for, and only over `https://`. A redirect to another address is refused.
- Issue titles, labels, release names and environment names are passed to the answer as plain data. On a public repository anyone can write them, so the answer model is told not to follow anything they say, and long or numerous labels are cut.
- A read that fails or takes too long is left out. The answer is still given from the pages.

The six kinds of read:

| Kind | What it reads |
|---|---|
| Issue | One issue of a listed repository: title, state, labels, date of the last change. |
| Merge request | One merge request or pull request: title, state, date it was merged or closed. |
| Search | Up to 8 issues of a listed repository that match two or three words. |
| Release | The 3 newest releases or tags of a listed repository. |
| Deploy | Where a merged merge request (or pull request) is deployed: for each environment of a listed repository, whether the version running there holds the change. Without a number, what each environment runs now. |
| Fleet | The AgentX version, build and start time of this machine and of each machine connected to it. |

A fleet read first asks the AgentX daemon in the source's `url` which machines are connected to it, then asks each of those machines for its version. No token is sent. Still, list only a daemon you run yourself: that daemon decides which addresses this machine asks.

Until you list a source, no live read runs and questions are answered from the pages alone.

## Know whether a change is deployed

A closed issue or a merged merge request does not mean the change is running. A **deployment** is the record your GitHub or GitLab project keeps each time a version is sent to an **environment**, such as `staging` or `production`. When a question asks whether something is live, the model names a deploy read with the number of the merge request that made the change. AgentX then:

1. Reads the merge request. One that is not merged is reported as not deployed, and nothing more is read.
2. Reads the newest deployments of the repository (30 on GitLab, 10 on GitHub) and, for each environment, the newest one that succeeded. That is the version running there.
3. Asks the host whether that version holds the merge request's commit.

The answer then gets a line such as:

```text
!7 in example-group/billing (merged 2026-10-07 as 1a2b3c4d): production: deployed (runs 5e6f7a8b deployed 2026-10-08); staging: not deployed (runs 9c0d1e2f deployed 2026-10-06)
```

- **deployed:** the version running in that environment holds the change.
- **not deployed:** it does not hold it yet.
- **not known:** the environment has no successful deployment in the list, or the host did not answer.
- `newest deploy failure …` (or `failed`, `running`) after an environment means a newer deployment to it has not succeeded, so it still runs the version named before it.

This only works when your pipeline records deployments: GitLab does when a CI job names an `environment`, and GitHub when a workflow job names an `environment` or a tool calls the deployments API. When nothing is recorded, the line says so, and the answer says it can't tell where the change runs. It never says "not deployed" for that reason.

The read needs no new setting: any repository listed under `sources` can be read this way. A GitLab token with the `read_api` scope is enough. On GitHub, a fine-grained token needs read access to **Deployments**, **Contents** and **Pull requests**.

## Write the summaries

1. **Terminal:** run `agentx wiki summarize --all --dry-run`. It prints, for each agent, how many pages it has and how many are due. Nothing is written.
2. **Terminal:** run `agentx wiki summarize --all`. Pages are summarised 20 at a time. Expect about half a minute for each 20 pages.
3. Read the last line for each agent, for example `support-agent: 240 pages, 240 written`.

The summaries are saved in a file named `_summaries.json` beside each agent's pages. No page is edited.

Run the command again at any time. It summarises only pages that are new or whose text changed, and it removes the line of a page that no longer exists. A run that was stopped half-way keeps what it had written.

To do one agent only, run `agentx wiki summarize --agent <agent>`.

## Keep the summaries current

1. Open `agentx.json`.
2. Add a schedule under `wiki`:

   ```json
   {
     "wiki": {
       "summaries": { "schedule": "30 23 * * *", "timezone": "UTC" }
     }
   }
   ```

3. Restart the daemon.
4. **Terminal:** run `agentx schedule list`. A job named `wiki-summarize` appears.

Pick a time after the jobs that write wiki pages have finished. A night with no changed page costs nothing.

## List where to read live

1. Open `agentx.json`.
2. Under `wiki.query.live`, list each system to read from. Use your own repositories and hosts:

   ```json
   {
     "wiki": {
       "query": {
         "live": {
           "sources": [
             { "type": "github", "repos": ["example-org/app"] },
             {
               "type": "gitlab",
               "url": "https://gitlab.example.com",
               "tokenEnv": "WIKI_GITLAB_READ_TOKEN",
               "repos": [
                 { "repo": "example-group/billing", "about": "invoices and the customer portal" }
               ]
             },
             { "type": "agentx" }
           ]
         }
       }
     }
   }
   ```

3. Give each source a token that can only read. For GitLab, a token with the `read_api` scope is enough. Put it in `.env` under the name you gave in `tokenEnv`.
4. **Terminal:** run `agentx config check`. It prints `✓ Config valid`.

`about` is a short note on what lives in a repository. The model reads it when choosing which repository to name, so add it when the repository's name does not say what it holds.

When a source names no token, AgentX uses the token of the matching channel (`channels.github` or `channels.gitlab`), and only when the source points at that channel's address over `https://`. A source with an `http://` address, another port or another host gets no channel token. A GitLab source with no `url` uses the channel's own host and its token. A public GitHub repository needs no token.

## Settings

All under `wiki` in `agentx.json`.

| Key | Default | What it does |
|---|---|---|
| `query.method` | `"auto"` | How pages are picked. `summaries`: from the summary lines, then the live read. `catalog`: from page titles, then along the links between pages (the earlier method). `auto`: `summaries` once at least 80% of the agent's own pages have a summary, `catalog` until then. |
| `query.candidates` | `12` | How many of the agent's own pages the picking model sees. |
| `query.sharedCandidates` | `4` | How many of other agents' pages it sees beside them. `0` shows none. |
| `query.maxPages` | `3` | Most pages opened for one answer. |
| `query.linkedPages` | `0` | Also open up to this many pages that the picked pages link to (each page's related pages). `0` opens none. Try `3` when the answer often sits one link away from the page picked. |
| `query.pageChars` | `4000` | Characters of each opened page given to the answer. |
| `query.navigatorModel` | `"haiku"` | Model that picks the pages. |
| `query.answerModel` | `"sonnet"` | Model that writes the answer. |
| `query.live.enabled` | `true` | Set to `false` to switch the live read off. |
| `query.live.maxReads` | `6` | Most reads for one question. |
| `query.live.timeoutMs` | `15000` | How long one read may take, in milliseconds. |
| `query.live.plannerModel` | `"haiku"` | Model that names the reads. |
| `query.live.sources` | `[]` | Where to read from. Empty: no live read. |
| `summaries.model` | `"haiku"` | Model that writes the summaries. |
| `summaries.batchSize` | `20` | Pages per model call. |
| `summaries.maxWords` | `35` | Longest summary, in words. |
| `summaries.schedule` | unset | When `agentx wiki summarize --all` runs on its own. Unset: no job. |
| `summaries.timezone` | `"UTC"` | Time zone of the schedule. |
| `summaries.agent` | unset | Agent the job is listed under. Unset: `node.defaultAgent`, else the first agent. |

Each entry of `query.live.sources` has a `type` and these keys:

| Type | Key | Default | What it does |
|---|---|---|---|
| `github` | `repos` | — | Repositories that may be read, as `owner/name`, or `{ "repo": "owner/name", "about": "…" }`. At least one. |
| `github` | `apiUrl` | `"https://api.github.com"` | The API address, for GitHub Enterprise. |
| `gitlab` | `repos` | — | Projects that may be read, as their full path (`group/project`), or with `about` as above. At least one. |
| `gitlab` | `url` | `channels.gitlab.host` | The GitLab host. |
| `github`, `gitlab` | `tokenEnv` | unset | Name of the environment variable that holds the read token. |
| `github`, `gitlab` | `tokenFile` | unset | A file whose first line is the read token. |
| `agentx` | `url` | this machine | The AgentX daemon to ask. |
| `agentx` | `peers` | `true` | Also ask each machine connected to that daemon. |

## Ask one question a different way

- `agentx wiki query "…" --no-live` answers from the pages alone.
- `agentx wiki query "…" --linked 3` also opens up to 3 pages that the picked pages link to, for that one question.
- `agentx wiki query "…" --method catalog` uses the earlier method for that one question.
- `agentx wiki query "…" --trace` also prints how many reads were asked and answered, and how long each step took.

## Check it worked

1. **Terminal:** run `agentx wiki query "<a question about something that has an issue>" --agent <agent> --trace`.
2. Under the answer and its citations, look for **Read live at the source**, with one line for each read, such as `#12 in example-org/app: "Add export" is closed since 2026-10-08`.
3. **Terminal:** run `agentx wiki query "Is merge request <number> deployed, and where?" --agent <agent> --trace` for a repository that records deployments. A line starting with `#<number> in` or `!<number> in` lists each environment as deployed, not deployed or not known.
4. The trace line starts with `method: summaries` and gives the reads asked and answered.

## If something is wrong

- **The trace has no `method: summaries` line:** fewer than 80% of the agent's own pages have a summary, for example after a run with `--agent` for another agent or with `--limit`. Run `agentx wiki summarize --all`.
- **No "Read live at the source" block:** `query.live.sources` is empty, `query.live.enabled` is `false`, or the picked pages named nothing that changes. Run with `--trace`: "0 asked" means the model named no read.
- **Reads are asked but none is answered:** the token is missing or can't read the repository, or the host can't be reached. Check the name in `tokenEnv` against `.env`, and that the repository is spelled exactly as on the host.
- **`(no answer) No page was picked for the question`:** no summary line fits the question. Nothing is read live in that case.
- **The answer misses a fact that sits on a page linked from the one it cites:** set `query.linkedPages` to `3`, or try `--linked 3` on one question first.
- **An answer says "closed" but not "deployed":** a closed issue does not say the change is running. Ask about the merge request that made the change, or name its number in the question, so a deploy read can be made.
- **A deploy line says "no deployment is recorded at the source":** your pipeline does not record deployments for that repository. See [Know whether a change is deployed](#know-whether-a-change-is-deployed).
- **A deploy line says "not known" for every environment:** the token can't read deployments or compare commits. Give it the read access listed above.
- **`config check` says `expected owner/name`:** a repository in `repos` is not written as `owner/name` or `group/project`.
- **`config check` says `wiki.summaries.schedule: expected a cron of 5 fields`:** write the schedule as minute, hour, day of the month, month and day of the week, for example `"30 23 * * *"` for 23:30 every day.
- **`config check` says `wiki.summaries.timezone: expected a time zone`:** use a name such as `"UTC"` or `"Europe/Paris"`.

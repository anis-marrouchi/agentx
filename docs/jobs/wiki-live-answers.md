# Get wiki answers checked at the source

A wiki page records what was true when it was written. An issue that was open then may be closed now, and the version a page names may no longer be the one that runs. An agent that asks the wiki gets the page's answer, stated with confidence, even when it is out of date.

With **page summaries** and a **live read**, a wiki question is answered in four steps:

1. Every page has a one-line summary: its main fact, the status it gives and the date of that status. The pages that share words with the question are found from these lines, with no model.
2. A small model picks up to 3 pages from those lines, or none when no line fits.
3. A small model names what should be confirmed at the source: an issue, a merge request, a repository's newest releases, the AgentX version on each machine. AgentX then reads those, from the systems you listed.
4. The answer is written from the pages and what was just read. Where they disagree, what was just read wins, and the answer marks those facts with "(live)".

The same steps run for `agentx wiki query` in a terminal and for the `agentx_wiki_query` tool agents use.

Everything on this page happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`.

## What a live read can and can't do

A live read only reads.

- The model names a read as data: a kind, a repository from your list, and a number or a few search words. It is given no shell, no command and no tool.
- AgentX checks each named read against your settings. A repository you did not list is refused.
- Each read is one HTTP `GET` that AgentX builds itself. Nothing is sent, changed or closed.
- A token goes only to the host it was set for. A redirect to another address is refused.
- A read that fails or takes too long is left out. The answer is still given from the pages.

The five kinds of read:

| Kind | What it reads |
|---|---|
| Issue | One issue of a listed repository: title, state, labels, date of the last change. |
| Merge request | One merge request or pull request: title, state, date it was merged or closed. |
| Search | Up to 8 issues of a listed repository that match two or three words. |
| Release | The 3 newest releases or tags of a listed repository. |
| Fleet | The AgentX version, build and start time of this machine and of each machine connected to it. |

Until you list a source, no live read runs and questions are answered from the pages alone.

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

When a source names no token, AgentX uses the token of the matching channel (`channels.github` or `channels.gitlab`), and only when the source points at that channel's host. A public GitHub repository needs no token.

## Search the agent's own notes

An agent's **notes** are the short memories it writes for itself, one fact each (see [Check which notes say where and when they were checked](/jobs/agent-memory#_10-check-which-notes-say-where-and-when-they-were-checked)). A fact an agent wrote only in a note is not on any wiki page, so a wiki question misses it. You can let the question search the agent's notes too.

- Each note's one-line `description` is its summary line. The picking model sees it beside the page lines, marked `note` with the date the note was checked.
- Only the asking agent's own notes are searched. A note is private to the agent that wrote it, so another agent never sees it, not even its summary line.
- Only `project` and `reference` notes are searched. Notes about a person (`user`) or about the agent's own working rules (`feedback`) stay out.
- A note that holds what looks like a password, key or token is left out.
- Notes are searched by the summaries method only, not by the `catalog` method.

1. **Terminal:** turn it on:
   ```sh
   agentx config set wiki.query.notes.enabled true
   ```
2. By default the notes are read from the AgentX note store, `.agentx/agent-memory/<agent>/`. If an agent keeps its notes in another folder (a `claude-code` agent can), **Terminal:** name that folder:
   ```sh
   agentx config set agents.<agent>.wiki.notes.dir <notes folder>
   ```
3. **Terminal:** ask a question whose answer is only in a note:
   ```sh
   agentx wiki query "<question>" --agent <agent>
   ```
   A note the answer used is listed under **Citations** with `[note]` and a path that starts with `note:`.

To ask one question without the notes, add `--no-notes`. To compare answers with and without notes, run `agentx wiki score` twice, the second time with `--no-notes`.

## Settings

All under `wiki` in `agentx.json`.

| Key | Default | What it does |
|---|---|---|
| `query.method` | `"auto"` | How pages are picked. `summaries`: from the summary lines, then the live read. `catalog`: from page titles, then along the links between pages (the earlier method). `auto`: `summaries` as soon as summaries exist, `catalog` until then. |
| `query.candidates` | `12` | How many of the agent's own pages the picking model sees. |
| `query.sharedCandidates` | `4` | How many of other agents' pages it sees beside them. `0` shows none. |
| `query.maxPages` | `3` | Most pages opened for one answer. |
| `query.pageChars` | `4000` | Characters of each opened page given to the answer. |
| `query.navigatorModel` | `"haiku"` | Model that picks the pages. |
| `query.answerModel` | `"sonnet"` | Model that writes the answer. |
| `query.notes.enabled` | `false` | Also search the asking agent's own notes. See [Search the agent's own notes](#search-the-agent-s-own-notes). |
| `query.notes.types` | `["project", "reference"]` | Note types searched. |
| `query.notes.candidates` | `4` | How many of the agent's notes the picking model sees beside its pages. |
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

Per agent, under `agents.<agent>` in `agentx.json`:

| Key | Default | What it does |
|---|---|---|
| `wiki.notes.dir` | the AgentX note store, `.agentx/agent-memory/<agent>/` | The folder the agent's notes are read from. A relative path is read from the folder that holds `agentx.json`. |

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
- `agentx wiki query "…" --method catalog` uses the earlier method for that one question.
- `agentx wiki query "…" --no-notes` leaves the agent's notes out.
- `agentx wiki query "…" --trace` also prints how many reads were asked and answered, and how long each step took.

## Check it worked

1. **Terminal:** run `agentx wiki query "<a question about something that has an issue>" --agent <agent> --trace`.
2. Under the answer and its citations, look for **Read live at the source**, with one line for each read, such as `#12 in example-org/app: "Add export" is closed since 2026-10-08`.
3. The trace line starts with `method: summaries` and gives the reads asked and answered.
4. With notes on, ask a question only one of the agent's notes answers. The note is listed under **Citations** as `[note]`, with a path that starts with `note:`.

## If something is wrong

- **The trace has no `method: summaries` line:** no summaries exist for the pages in reach. Run `agentx wiki summarize --all`.
- **No "Read live at the source" block:** `query.live.sources` is empty, `query.live.enabled` is `false`, or the picked pages named nothing that changes. Run with `--trace`: "0 asked" means the model named no read.
- **Reads are asked but none is answered:** the token is missing or can't read the repository, or the host can't be reached. Check the name in `tokenEnv` against `.env`, and that the repository is spelled exactly as on the host.
- **`(no answer) No page was picked for the question`:** no summary line fits the question. Nothing is read live in that case.
- **A note is never picked:** check that `wiki.query.notes.enabled` is `true`, that the note's `type` is in `wiki.query.notes.types`, and that you asked as the agent that wrote it (`--agent <agent>`). **Terminal:** run `agentx memory check --agent <agent>` (add `--dir <notes folder>` if you set `wiki.notes.dir`) to see which notes AgentX finds. A note with no `description` line is found by the first line of its text.
- **A note shows `not checked`:** its header has no `checked:` date. Add `source:` and `checked:` to the note, as in [Check which notes say where and when they were checked](/jobs/agent-memory#_10-check-which-notes-say-where-and-when-they-were-checked).
- **An answer says "closed" but not "deployed":** a closed issue does not say the change is running. The live read reports what the source holds and no more.
- **`config check` says `expected owner/name`:** a repository in `repos` is not written as `owner/name` or `group/project`.

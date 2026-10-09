# Answer wiki questions with a live check

![You summarise every wiki page once and list what AgentX may read. When an agent asks the wiki a question, AgentX picks pages by their summary, reads the live state of what they name, and answers from both, marking each fact that came from the live read.](/diagrams/wiki-live-read.svg)

Agents ask the wiki questions with `agentx wiki query` (in a terminal) or the `agentx_wiki_query` tool (inside a conversation). A wiki page says what was true when it was written. An issue it mentions may have closed since, or a new release may be out.

This page sets up two things that make those answers better:

- **Page summaries.** One short line per page, written by a small model. The query reads these lines to pick the pages that answer a question, instead of the page titles alone. The pages themselves are never changed.
- **The live read.** Before it answers, the query reads the current state of what the picked pages name: an issue, a merge request (on GitHub, a pull request), the newest releases of a repository, or the AgentX version on each of your machines. It reads only from the places you list. The answer marks each fact that came from the live read, like `[live 1]`.

## How a question is answered

1. AgentX ranks every page the agent may read by the words it shares with the question, over its title, tags and summary. It keeps the 12 best of the agent's own pages and the 4 best of other agents' pages.
2. A small model picks up to 3 of those pages, or none.
3. A small model names up to 6 live reads that would show what changed since the pages were written. It only names them.
4. AgentX checks each named read against your list and drops anything else. It then runs the reads at the same time, each with a time limit.
5. A larger model answers from the pages and the live lines. Where they disagree about the current state, the live line wins.

**What stays safe:** each live read is one plain web request that only reads (an HTTP `GET`), built by AgentX itself against a host you listed. No model gets a shell or a tool. A repository you did not list is never read. A source's access key (its **token**) is sent only to that source.

A read that fails or takes too long is left out, and the answer still comes from the pages.

## Before you start

- You have a wiki with pages. See [Let agents keep the wiki up to date](./wiki-contributions.md).
- The `claude` command works on the machine (the summaries and the query use it).
- For private repositories: a token that can read them, saved in the `.env` file next to `agentx.json`, for example `GITHUB_TOKEN=…`.

## Write the page summaries

1. **Terminal:** in the folder with `agentx.json`, see how many pages need a summary:

   ```bash
   agentx wiki summarize --dry-run
   ```

2. **Terminal:** write them:

   ```bash
   agentx wiki summarize
   ```

   Each wiki prints a line such as `support-agent: 140 written, 0 unchanged (140 pages)`. The lines are saved in a file named `_summaries.json` in each agent's wiki folder.

3. Run the same command again after the wiki changes. It only summarises pages that are new or changed since the last run, and drops the lines of deleted pages. If a run stops halfway, the next run carries on.

To keep summaries current without running the command yourself, give them a schedule:

1. **Terminal:** run `agentx config set wiki.summaries.schedule "15 3 * * *"` (every day at 03:15).
2. **Terminal:** restart the daemon: `agentx daemon restart`.
3. **Terminal:** run `agentx schedule list`. A job named `wiki-summarize` appears.

## List what the live read may read

Nothing is read live until you list at least one **source**. Add the sources under `wiki.query.live.sources` in `agentx.json`:

```json
{
  "wiki": {
    "query": {
      "live": {
        "sources": [
          { "kind": "github", "name": "github", "repos": ["example-org/app"], "tokenEnv": "GITHUB_TOKEN" },
          { "kind": "gitlab", "name": "gitlab", "host": "gitlab.example.com", "repos": ["team/backend"], "tokenEnv": "GITLAB_TOKEN" },
          { "kind": "agentx", "name": "fleet" }
        ]
      }
    }
  }
}
```

1. **Editor:** open `agentx.json` and add the sources you need, as above. Use your own repositories and host.
2. **Terminal:** run `agentx config check`. It prints `✓ Config valid`.

No restart is needed: each query reads the list again.

The three kinds of source:

| Kind | Reads | Settings |
|---|---|---|
| `github` | One issue, one pull request, an issue search, the newest releases (or tags when there are no releases). | `name`, `repos` (the repositories that may be read, `owner/name`), `host` (default `github.com`; set it for GitHub Enterprise), `apiUrl` (only when the API is not at the usual address), `tokenEnv` (the name of the variable in `.env` that holds the token; leave it out for public repositories). |
| `gitlab` | One issue, one merge request, an issue search, the newest releases (or tags). | `name`, `host` (for example `gitlab.example.com`), `repos` (`group/project`, or `group/subgroup/project`), `apiUrl`, `tokenEnv`. |
| `agentx` | The AgentX version, running time and status of this machine and each machine under `mesh.peers`. | `name` (default `agentx`), `peers` (default `true`; `false` reads this machine only). |

## Ask a question

1. **Terminal:** ask as one of your agents:

   ```bash
   agentx wiki query "Is the login fix released?" --agent support-agent
   ```

2. Read the answer. The second line names the method (`summaries`) and how many live lines were read. After the citations, a **Live read** list shows each line with its label and the page to check it on:

   ```
     Live read:
       [live 1] github: example-org/app#12 "Login fails on the phone app": closed (completed), closed 2026-10-08  (https://github.com/example-org/app/issues/12)
       [live 2] github: example-org/app newest releases: v2.1.0 2026-10-05  (https://github.com/example-org/app/releases)
   ```

3. To see what the small models chose, add `--trace`.

Agents get the same answer through the `agentx_wiki_query` tool, with the live lines after the citations.

## Settings

All under `wiki` in `agentx.json`:

| Key | Default | What it does |
|---|---|---|
| `query.method` | `"auto"` | `auto`: use the summaries when the agent's wiki has them, else the older method. `summaries`: always use them. `catalog`: the older method, which picks from page titles and follows the links between pages. |
| `query.shortlist` | `12` | Pages of the agent's own wiki ranked high enough to be offered for picking. |
| `query.sharedShortlist` | `4` | Pages of other agents' wikis offered too. |
| `query.maxPages` | `3` | Pages that may be picked. |
| `query.pageChars` | `6000` | Characters of each picked page given to the answer. |
| `query.models.selector` | `"haiku"` | Model that picks the pages. |
| `query.models.planner` | `"haiku"` | Model that names the live reads. |
| `query.models.answer` | `"sonnet"` | Model that writes the answer. |
| `query.live.enabled` | `true` | Switch for the live read. `false` turns it off for every query. |
| `query.live.sources` | `[]` | What may be read (see above). Empty: nothing is read. |
| `query.live.maxReads` | `6` | Live reads per question. |
| `query.live.timeoutMs` | `8000` | Time limit of each read, in milliseconds. |
| `summaries.model` | `"haiku"` | Model that writes the summaries. |
| `summaries.batchSize` | `20` | Pages per model call. |
| `summaries.schedule` | unset | When the `wiki-summarize` job runs (a cron schedule). Unset: only when you run the command. |
| `summaries.timezone` | `"UTC"` | Time zone of that schedule. |

To turn the live read off:

- **For one question:** add `--no-live` to `agentx wiki query`, or pass `live: false` to the `agentx_wiki_query` tool.
- **For everyone:** **Terminal:** run `agentx config set wiki.query.live.enabled false`.

To compare the methods on your own question set, run `agentx wiki score` twice, once with `--method catalog` and once with `--method summaries`, and compare the two reports. See [Measure the difference](./wiki-contributions.md#measure-the-difference).

## What it does not do yet

- A closed issue or a merged merge request does not prove the change is released or deployed. The answer says so only when a page or a live line states it.
- When no page is picked, no live read runs.
- Facts kept only in an agent's own memory notes are not in the pages it picks from.

## Check it worked

1. **Terminal:** run `agentx wiki summarize --dry-run`. It prints `0 of N pages need a summary` for each wiki.
2. **Terminal:** run `agentx wiki query "<a question about an issue a page names>" --agent <agent-id>`. The second line shows `method: summaries` and `live: 1` or more.
3. The answer marks at least one fact with `[live 1]`, and the **Live read** list shows that line.

## If something is wrong

- **The second line shows `method: catalog`:** the agent's wiki has no summaries yet. Run `agentx wiki summarize --agent <agent-id>`.
- **No Live read list:** check that `wiki.query.live.sources` lists a source, that `wiki.query.live.enabled` is not `false`, and that the repository the page names is in that source's `repos`. Run with `--trace` to see which reads the model named.
- **A live line you expected is missing:** the read failed or took too long, and was left out. Check the token named in `tokenEnv` is in `.env` and can read the repository, and that the host is reachable from this machine. For an `agentx` source, check the machine answers on its address under `mesh.peers`.
- **`agentx wiki summarize` reports pages that got no summary:** the model call failed. Run the command again; it only retries the missing pages.
- **The wrong pages are picked:** a summary may be out of date after a big edit. Run `agentx wiki summarize` again, or use `--method catalog` to compare.

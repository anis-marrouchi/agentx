# Contributing

AgentX is usable but experimental, and is not yet stable. Settings and configuration flows especially need testing, fixes, and polish.

## Where help matters most

1. **Testing and issue reporting.** Try the [demo](docs/see-it-first.md) or follow the [installation guide](docs/install.md). Test setup, Settings, and a real task. Report broken behavior and confusing instructions; no code contribution is required.
2. **Triage and workflow/pipeline management.** Reproduce issues, check for duplicates, record affected versions, and help prioritize fixes. Help track work from a report through a PR, CI checks, and a release; include failing run links when reporting pipeline problems.
3. **Code and documentation.** Fix reproducible bugs, polish Settings, improve guides, or contribute tests that cover reported failures. Discuss larger changes before implementing them.

**Mesh-level and agent-level role-based access control (RBAC) are still missing.** Use cases and design contributions are welcome: describe who needs access to which nodes or agents, what actions they should be allowed to take, and what must be denied. This is planned capability, not an existing multi-user authorization guarantee.

The guide below covers the repo layout, how to run tests, and the PR conventions.

## Support and triage

Read the [support guide](.github/SUPPORT.md) for supported environments, reporting routes, and upgrade expectations. Questions belong in Discussions; reproducible problems belong in issues. Support is best effort.

The [maintainer runbook](.github/maintainer/TRIAGE.md) defines priorities and the agent-assisted triage process. The agent gathers context before planning; public replies start as drafts, and humans own merges, releases, and closure decisions. We do not automatically close old issues.

`node scripts/maintainer-context.mjs` gathers a read-only repository snapshot. `node scripts/smoke-package.mjs` installs a packed build in a temporary directory and checks the installed CLI and SQLite binding. The package smoke workflow also checks the published package on Linux and macOS.

## Repo layout

```
src/
├── agent/ · agents/      # registry, runtime, landscape, heartbeat, bootstrap
├── a2a/                  # mesh client + server
├── business/             # day-cycle, work-pool, KPI, reporter (optional layer)
├── channels/             # Telegram, WhatsApp, GitLab, GitHub, webhooks, router
├── commands/             # Commander CLI subcommands
├── crons/                # scheduler, retry, onError pipeline
├── daemon/               # main HTTP server, SSE, config loader
├── git/                  # git-log / commit helpers
├── hooks/                # hook registry + types
├── mcp/                  # MCP server (exposes agentx as an MCP to Claude Code / Cursor)
├── memory/               # Haiku-based cross-session memory
├── observability/        # SSE events, debug mode, usage tracker
├── permissions/          # permission manager for Claude Code
├── services/             # deterministic pre-LLM matcher
├── wiki/                 # ingest/absorb/query/sync (Karpathy flat + graph)
├── cli.ts · index.ts     # entry points
```

An agent has a workspace directory and a configured model — see [What it is](docs/what-it-is.md).

## Prerequisites

- Node 22.x
- pnpm 10+

## Setup

```bash
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
pnpm install
pnpm build          # tsup → dist/
pnpm typecheck
pnpm test           # vitest
```

Hot-reload during development:

```bash
pnpm dev            # tsup --watch
```

## Running the docs site locally

```bash
pnpm docs:dev       # http://localhost:5173
pnpm docs:build     # static site → docs/.vitepress/dist/
pnpm docs:preview
```

## Commit style

Conventional Commits — `<type>(<scope>): <subject>` with a body that explains **why** over **what**.

```
feat(daemon): business layer + multi-value cron onError
fix(voice): use claude-haiku-4-5 alias
refactor(wiki): split absorb prompt per mode
```

See [`.claude/CLAUDE.md`](https://github.com/anis-marrouchi/agentx/blob/main/.claude/CLAUDE.md) in your fork for the full convention.

## Writing a channel adapter

Each channel lives under `src/channels/`. Use the current `ChannelAdapter` interface in [src/channels/types.ts](src/channels/types.ts) and an existing adapter as a starting point. The following sketch illustrates the lifecycle; the interface defines the complete contract:

```ts
export class MyAdapter implements ChannelAdapter {
  name = "my-channel"
  async start() { /* open sockets */ }
  async stop() { /* cleanup */ }
  onMessage(cb: (msg: InboundMessage) => void) { /* register */ }
  async send(chatId: string, text: string, opts?: SendOpts) { /* outbound */ }
}
```

Wire the adapter into `src/daemon/index.ts` and add its Zod schema under `channelsConfigSchema` in `src/daemon/config.ts`.

## Docs conventions

Every docs change follows these rules.

- Write for a non-technical reader. Use plain words, and explain a term the first time it appears (or avoid it).
- Write procedures as numbered steps, one action per step. Label terminal and browser steps explicitly.
- Show, don't only tell: add a screenshot wherever a step touches a screen (dashboard, System Settings, a phone app). Store them under `docs/public/screenshots/<page>/`.
- Document everything we ship. Every feature, setting, CLI command and integration has a page or section; no setting exists only in code. A change that adds or renames a setting or command updates the docs in the same PR.
- End every page with a **Check it worked** section and an **If something is wrong** section.
- Use neutral examples only: no real company, people, agent names, hosts, IPs or tokens. Take screenshots from a demo instance, never a live fleet.
- Keep reference pages concise and validate examples against the current code.
- Run `pnpm docs:check` before submitting a documentation change.

### Diagrams

A page that describes a flow between two people or two machines opens with one diagram: who does what, in which order, and what happens when it fails. Every diagram shares one look (white ground, black text, the AgentX blue; steps appear in order, then stay), and that look lives in one file, `docs/.scripts/diagrams/kit.mjs`. Never draw one by hand or in another tool.

To add a diagram (in a terminal, from the repo root):

1. Copy `docs/.scripts/diagrams/teammate-join.mjs` to `docs/.scripts/diagrams/<name>.mjs`.
2. Edit the copy: the title, the rows of steps, and the extras (`callout` for the exception, `window` for what the reader ends up seeing, `list` for what to do when it fails). Put three steps on a row. Keep a step's title and its note to three lines in all.
3. Build it: `pnpm docs:diagrams`. It writes `docs/public/diagrams/<name>.svg`.
4. Open the file in a browser and watch it build once. Check that no text leaves its card and nothing overlaps.
5. Add it to the page, with a sentence of alt text that says what the picture shows: `![…](/diagrams/<name>.svg)`.
6. Run `pnpm docs:dev`, open the page, and read the diagram there: every line must be readable at the page's width without zooming.
7. Commit the spec and the built file together. When you rename or remove a spec, delete its built file too: `pnpm docs:check` fails on a built file that has no spec.

The rules of the look:

- Blue numbers are the reader of the page; black numbers are the other person. Say so in the legend.
- Motion explains order and nothing else: steps rise in one after the other, a line draws from one row to the next, then each number pulses in turn. Nothing loops back to an empty picture. A reader who turned on reduced motion sees the finished diagram, still.
- Colours come from `C` in the kit. A new colour or shape goes into the kit first, so every diagram gets it.
- Neutral examples only, as on every page.
- The kit's width and type sizes go together. Keep the width; a diagram up to 1300 high also prints on one A4 page.

`pnpm docs:check` fails when a built file no longer matches its spec, and names the file.

### Docs gate

Every pull request runs the **Docs gate** check (`.github/workflows/docs-gate.yml`). It enforces the rules above without any AI: the same input always gives the same result. All paths, patterns and lists live in one file, `scripts/docs-gate.config.json`.

The gate runs three checks:

1. **Code changes come with docs.** If the PR changes something users see (CLI commands, the config schema, `agentx.example.json`, dashboard pages, `skills/`, `apps/`, or a new `process.env.` variable) and adds or edits no page under `docs/`, the check fails. Tests, CI files and internal code do not count. PRs titled `refactor:`, `test:` or `ci:` pass.
2. **Removed things leave the docs.** The gate reads every CLI command, flag and setting before and after the PR. If the PR removes or renames one that a page still mentions, the check fails and names the page and line. This applies even when docs are skipped.
3. **Changed pages follow the docs rule.** Every page the PR adds or edits must end with **Check it worked** then **If something is wrong**, use numbered lists for steps, point only at images that exist, and contain no tokens, personal home paths or real company hosts.

A fourth step lists every command, flag and setting that no page mentions. It only warns for now; it will block once the docs catch up.

**Skip docs for one PR.** Use this when a user-facing file changed but users see no difference, such as a reworded help string:

1. In the browser, ask a maintainer to add the `no-docs-needed` label to the PR.
2. Add a line of its own to the PR description: `Docs: not needed because <reason>`.
3. Wait for the check to run again; editing the description or the labels restarts it.

The label without a reason still fails, and so does a reason without the label.

**Older pages.** Pages written before the gate are listed in `rules.baseline` in the config file. On those pages, missing ending sections and unnumbered steps show as warnings instead of errors. Images and private data are always errors. When you fix a listed page, remove it from the list; the gate reminds you, so the list only shrinks.

**Organisation names.** Checks for a team's own host and agent names go in the `DOCS_GATE_EXTRA_FORBIDDEN` repository secret, as a JSON list of `{ "pattern": "…", "why": "…" }`. They never go in the public config file.

**Run it locally** (in a terminal, from the repo root):

1. Check your branch's changed pages: `node scripts/docs-gate.mjs rules --base origin/main --head HEAD`
2. Check every page: `node scripts/docs-gate.mjs rules --all`
3. Check the docs change: `PR_TITLE="feat: my change" node scripts/docs-gate.mjs impact --base origin/main --head HEAD`
4. List undocumented commands and settings: `pnpm exec tsx scripts/docs-surface.mts > /tmp/surface.json`, then `node scripts/docs-gate.mjs coverage --surface /tmp/surface.json`

#### Check it worked

The **Docs gate** check on your PR is green. Its log ends with `Checked N page(s) against the docs rule: 0 error(s)`.

#### If something is wrong

- **It says users see a change but you only refactored.** Title the PR `refactor: …`, or use the label and reason above.
- **It names a page that mentions a removed setting.** Edit that line of the page; the log gives the file and line.
- **It flags a word that is fine.** Adjust the pattern in `scripts/docs-gate.config.json` in the same PR and say why in the description.

### Reproduce the screenshots

With Node 22 and Chrome or Chromium installed:

```sh
pnpm build
pnpm docs:demo
# In a second terminal:
pnpm docs:seed
pnpm docs:shots
```

The demo uses scripted replies and fictional review fixtures. Its channels and
schedules stay disabled. The seed switches one schedule on for a single run and
then off again, so it can take up to two minutes. The last shot, a running task
on the Live tab, starts a scripted task that takes a minute. The capture script only accepts the isolated dashboard
at `http://127.0.0.1:18931`. Set `CHROME_PATH` if your browser is elsewhere, or
`DOCS_SHOTS=live,operations` to capture a subset. Stop the demo with Ctrl-C.

## Filing issues

People are the heart of this project, and every contribution is equally welcome, however it was written. There are two ways to open an issue.

**Write it yourself**

1. Open the [new issue page](https://github.com/anis-marrouchi/agentx/issues/new/choose).
2. Pick a form: Bug report, Enhancement, Feature, Integration (channel, MCP server, skill or model provider), Idea, or Docs.
3. Fill it in and press **Create**.

**Let your agent help**

1. Install the skill in your agent's workspace: `agentx skill install anis-marrouchi/agentx/agentx-contribute`
2. Ask your agent to help you file an AgentX issue.
3. Review the draft together. The agent checks for duplicates and gives you a link to a filled-in form.
4. Open the link, check it, and press **Create** yourself. Nothing is posted for you.

The helper drafts only with a model from [`contrib/models.json`](contrib/models.json), which keeps drafts clear and consistent. With another model it kindly points you to the web form. The [contribute guide](docs/guides/contribute.md) has the details.

For a bug, include your AgentX version (`agentx --version`), operating system, installation method, steps to reproduce, and what you expected. Remove secrets and private data from logs and config first.

### Voting

The community decides together what matters most.

1. Open the [open requests, most voted first](https://github.com/anis-marrouchi/agentx/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc).
2. Add a 👍 reaction under the first message of each request you care about. That is your vote; comments do not count, so discussion stays free.
3. Before you open a new request, you are warmly invited to vote on a few open ones. It is never required.

The issue author's own reaction, bots, and accounts younger than 7 days are not counted. Bugs are fixed by severity, as described in the [maintainer runbook](.github/maintainer/TRIAGE.md), not by votes. Every day a GitHub Action updates the **Most requested** list in the README (top 5 with at least 5 votes) and the [full ranked list](docs/community/most-requested.md). The numbers live in [`contrib/voting.json`](contrib/voting.json). Votes help guide the roadmap; maintainers make the final decisions and explain them.

## Security

Do **not** open public issues for vulnerabilities. Follow the [security reporting instructions](SECURITY.md#reporting-a-vulnerability).

## Releases

Use Conventional Commits (`fix:`, `feat:`, and `!` / `BREAKING CHANGE:` for incompatible changes). Release Please opens a PR on `main` with the next package version and generated `CHANGELOG.md`. Merge that release PR to create the tag and start npm publication in the same workflow. The publish job checks types, tests, docs, build output, and package contents first.

Configure npm trusted publishing for package `agentix-cli`, repository `anis-marrouchi/agentx`, workflow `release.yml`, using [npm's setup guide](https://docs.npmjs.com/trusted-publishers/). The workflow uses OIDC and does not require an npm token secret. A failed publication can be retried by dispatching **Release** with the existing `vX.Y.Z` tag. The workflow checks that the tag matches the package version and belongs to `main`.

Release Please uses the built-in GitHub token unless `RELEASE_PLEASE_TOKEN` is configured. With the built-in token, release PR checks may be suppressed or require approval. Inspect Actions: approve the individual generated-PR runs when they show `action_required`, or dispatch checks on the release branch when no run exists. Do not weaken repository-wide protections just to make checks run. Publication always runs its own validation. [Release Please documentation](https://github.com/googleapis/release-please-action).

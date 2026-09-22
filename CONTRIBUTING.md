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

- Write for an operator first. Label terminal and browser steps explicitly.
- Keep reference pages concise and validate examples against the current code.
- Keep screenshots sourced from a demo instance, never a live fleet.
- Run `pnpm docs:check` before submitting a documentation change.

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
schedules stay disabled. The capture script only accepts the isolated dashboard
at `http://127.0.0.1:18931`. Set `CHROME_PATH` if your browser is elsewhere, or
`DOCS_SHOTS=live,operations` to capture a subset. Stop the demo with Ctrl-C.

## Filing issues

- **Bug or confusing behavior** — [open an issue](https://github.com/anis-marrouchi/agentx/issues/new) with:
  - AgentX version (`agentx --version`), operating system, and installation method (npm, source, or Docker).
  - Steps to reproduce, expected behavior, and actual behavior.
  - Relevant logs, screenshots, or a minimal config excerpt, with secrets and private data removed.
  - Whether it happens consistently and any workaround you found.
- **Feature** — describe the real-world scenario first; the API second.

## Security

Do **not** open public issues for vulnerabilities. Follow the [security reporting instructions](SECURITY.md#reporting-a-vulnerability).

## Releases

Use Conventional Commits (`fix:`, `feat:`, and `!` / `BREAKING CHANGE:` for incompatible changes). Release Please opens a PR on `main` with the next package version and generated `CHANGELOG.md`. Merge that release PR to create the tag and start npm publication in the same workflow. The publish job checks types, tests, docs, build output, and package contents first.

Configure npm trusted publishing for package `agentix-cli`, repository `anis-marrouchi/agentx`, workflow `release.yml`, using [npm's setup guide](https://docs.npmjs.com/trusted-publishers/). The workflow uses OIDC and does not require an npm token secret. A failed publication can be retried by dispatching **Release** with the existing `vX.Y.Z` tag. The workflow checks that the tag matches the package version and belongs to `main`.

Release Please uses the built-in GitHub token unless `RELEASE_PLEASE_TOKEN` is configured. With the built-in token, release PR checks may be suppressed or require approval. Inspect Actions: approve the individual generated-PR runs when they show `action_required`, or dispatch checks on the release branch when no run exists. Do not weaken repository-wide protections just to make checks run. Publication always runs its own validation. [Release Please documentation](https://github.com/googleapis/release-please-action).

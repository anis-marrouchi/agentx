# Contributing

Thanks for contributing. The guide below covers the repo layout, how to run tests, and the PR conventions.

## Repo layout

```
src/
├── agent/ · agents/      # registry, runtime, landscape, heartbeat, bootstrap
├── a2a/                  # mesh client + server
├── business/             # day-cycle, work-pool, KPI, reporter (optional layer)
├── channels/             # Telegram, WhatsApp, Discord, GitLab, webhooks, router
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

Agent is a directory, not a class — see [Concepts](/concepts).

## Prerequisites

- Node 20+
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

See [`.claude/CLAUDE.md`](https://github.com/anis-marrouchi/agentx/blob/master/.claude/CLAUDE.md) in your fork for the full convention.

## Writing a channel adapter

Each channel lives under `src/channels/` and exports an adapter implementing the common shape (see `src/channels/router.ts` for the interface). Minimum:

```ts
export class MyAdapter implements ChannelAdapter {
  name = "my-channel"
  async start() { /* open sockets */ }
  async stop() { /* cleanup */ }
  onMessage(cb: (msg: InboundMessage) => void) { /* register */ }
  async send(chatId: string, text: string, opts?: SendOpts) { /* outbound */ }
}
```

Register it in `src/channels/index.ts` and add a Zod schema under `channelsConfigSchema` in `src/daemon/config.ts`.

## Docs conventions

- Journey pages follow the template: **Scenario → Prereqs → Config → Commands → Verify → What's next**.
- Reference pages stay reference-y. No tutorial prose.
- Code examples should validate against the Zod schemas — copy-paste must work.
- Prefer Mermaid over ASCII art for diagrams.
- No emojis in content except where they're part of a log line example.

## Filing issues

- **Bug** — include daemon version (`agentx --version`), config diff (secrets redacted), and a minimal repro.
- **Feature** — describe the real-world scenario first; the API second.

## Security

Do **not** open public issues for vulnerabilities. Email the maintainer via the contact in `package.json`.

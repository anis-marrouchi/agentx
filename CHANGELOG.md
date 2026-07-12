# Changelog

Notable changes per release. Older releases are summarized; see `git log` for the full record.

## Unreleased

### Security
- Mesh endpoints (`/task`, `/mesh/task`, `/workflow/event`, `/workflow/transition`, `/channel/send`, `/webrtc/signal`) now verify the Bearer token mesh peers have always sent. Loopback callers are exempt; installs without a configured `MESH_TOKEN` keep working with a warning for one release. `AGENTX_MESH_AUTH=off` opts out.

### Changed
- **Dashboard nav is now minimal and mesh-first**: Live · Ledger · Cost · Settings. Boards, Workflows, and Inbox tabs appear only when those surfaces are configured (`boards`, `workflows.enabled`); the Team/Business Settings sub-tabs require `business.enabled`. Every previous page stays reachable at its URL — only the top chrome slimmed down.
- `agentx demo` now starts the board dashboard alongside the three daemons, so the printed `/live` URL shows the whole mesh from one page (previous builds printed daemon-port URLs that had no live view).

## 0.24.1 — 2026-07

- **Chat REPL overhaul** — Claude-Code-style Ink interface: live streaming with tool badges (`● Read(app.ts)`), markdown + syntax highlighting, slash menu, `@agent` / `@file` autocomplete, multiline compose, esc-to-interrupt.
- **Procedures** — user-perspective SOP mining: episode clustering and distillation from recurring activity, daily extraction cadence, promote/reject/match CLI, fresh-session injection.
- **Memory → wiki promotion** — recurring agent memories get clustered, judged, and promoted into the compounding wiki (`agentx wiki promote`).
- **Rich channel messages** — buttons, polls, and media via the in-band `agentx:ui` directive on Telegram and WhatsApp; fixed Telegram streaming-edit truncation.
- **Session continuity** — tier-2 rotation now uses real per-request context size instead of cumulative usage (fixes long-conversation amnesia), with deterministic memo handover into fresh sessions.
- **MCP** — HTTP/SSE transport for MCP servers in the orchestrator tier and `.mcp.json`.
- Fixes: Telegram group self-loop guard, GitLab mesh-aware bot identity, workflow trigger `noteableType` filter.

## 0.24.0 — 2026-05

- Workflow YAML round-trips preserve comments; workflow trace + retry.
- Business layer: plan-driven standup ticks with day → week → month fallback.

## 0.23.0 / 0.22.0 — 2026-05

- Lexical RAG (BM25) for retrieval; workflow run tracing and retries.

## 0.21.0 / 0.20.0 — 2026-05

- Action registry with CLI + admin UI; business-layer scheduling.

## 0.19.0 — 2026-05

- ESM cleanup; Node floor raised to 22.

## 0.18.0 and earlier — 2026-04

- The "architectural rescue": append-only intent ledger with replay, SQLite storage via event-bus subscribers (task history, usage, route traces), dataflow DAG workflow engine with visual editor, WhatsApp in-browser QR pairing, natural-language cron (`agentx schedule`), BM25 retrieval + token cost dashboards, SMB repositioning.

# Changelog

Notable changes per release. Older releases are summarized; see `git log` for the full record.

## [0.32.0](https://github.com/anis-marrouchi/agentx/compare/v0.31.0...v0.32.0) (2026-09-24)


### Features

* **bench:** run agentx on Terminal-Bench ([dc06ca8](https://github.com/anis-marrouchi/agentx/commit/dc06ca8265aa89e2dafce6c22dd9e8dbd760d283))

## [0.31.0](https://github.com/anis-marrouchi/agentx/compare/v0.30.0...v0.31.0) (2026-09-24)


### Features

* **activity-graph:** attach live issue/MR/pipeline state to snapshots ([2add936](https://github.com/anis-marrouchi/agentx/commit/2add936c3e44bd4f914577537b0e48ed8deddcf5))
* **activity-graph:** Fleet Map tab ([9221a47](https://github.com/anis-marrouchi/agentx/commit/9221a471189c61429695fd1365f3411d9b519bf3))
* **activity-graph:** rework the Map tab as a transit map ([816e409](https://github.com/anis-marrouchi/agentx/commit/816e409716e16f095ffa31f0b481ab3a65654a5d))
* **activity:** fold the fleet map into /activity and retire Activity Graph ([4817f16](https://github.com/anis-marrouchi/agentx/commit/4817f1635aa6e7b1d10447ea0473e530a8fb8c52))
* **decisions:** hold out 10% of turns from Jev preprocessing ([03f572d](https://github.com/anis-marrouchi/agentx/commit/03f572d035f3138f6e0c8bbb489fdf703de613f9))
* **traces:** record tier-2 tokens and the resume decision per turn ([bf766eb](https://github.com/anis-marrouchi/agentx/commit/bf766ebac852598f4fd3165b7b24b4b1c5586840))

## [0.30.0](https://github.com/anis-marrouchi/agentx/compare/v0.29.0...v0.30.0) (2026-09-23)


### Features

* **daemon:** stream OpenAI-compatible replies per OpenCode session ([4a830c9](https://github.com/anis-marrouchi/agentx/commit/4a830c93ac58930ae87ea596682f80439e0b0327))
* **decisions:** shadow seats for stuck turns and turn handoffs ([fc7adb8](https://github.com/anis-marrouchi/agentx/commit/fc7adb8bce97e4a57ee325d10e504170c4cdbb92))
* **demo:** add --reuse and --bind for a persistent, reachable demo ([4ccb2f2](https://github.com/anis-marrouchi/agentx/commit/4ccb2f2a6c9425d153a3459fa1942b3a223b97cc))
* **docker:** add a persistent scripted demo image for lessons ([ff99972](https://github.com/anis-marrouchi/agentx/commit/ff99972a5aa0a00e48136356a6e118f6e343faf6))
* **teach:** add a dashboard tour lesson for the Docker demo ([5f961ef](https://github.com/anis-marrouchi/agentx/commit/5f961efa4befa72cedc8fbeb1d823ee23e0649ad))
* **teach:** tour-guide lesson safety and Docker demo stage ([56b15ae](https://github.com/anis-marrouchi/agentx/commit/56b15ae82860a58db36dbe288b9a1e85a7be70ad))


### Bug Fixes

* **look:** report why the helper's screen capture failed ([a2d61e0](https://github.com/anis-marrouchi/agentx/commit/a2d61e0257cb7254cfe1918cbd091012a08c3a37))
* **routing:** keep the selected model for OpenCode requests ([283272f](https://github.com/anis-marrouchi/agentx/commit/283272fc1e7921debcf0ea92265e3be9539dcc2c))
* **runtime:** honour maxExecutionMinutes on persistent Claude turns ([4a32013](https://github.com/anis-marrouchi/agentx/commit/4a32013032ff502aa045b418a10b892581b38e87))
* **runtime:** stream text from persistent Claude turns ([64b9101](https://github.com/anis-marrouchi/agentx/commit/64b9101c126948e24b36c6011abc4a2ee8b14aae))
* **teach:** gate every action on a verified screen and stop on failure ([b409b93](https://github.com/anis-marrouchi/agentx/commit/b409b9300ad4f107a207ac513bfc5b589c70985b))

## [0.29.0](https://github.com/anis-marrouchi/agentx/compare/v0.28.0...v0.29.0) (2026-09-22)


### Features

* add contributor support and context-driven maintenance routines ([148c803](https://github.com/anis-marrouchi/agentx/commit/148c803b0ff024bcb0d7fef65d8b1dfcf93963d5))
* gate request preprocessing and protect desktop model selection ([c1c01c0](https://github.com/anis-marrouchi/agentx/commit/c1c01c05d62d11a1b43fa9d1353f5343871b7738))
* **runtime:** reuse Codex app-server processes across requests ([b753b52](https://github.com/anis-marrouchi/agentx/commit/b753b524799ea84e0fb5b0b59d2798e673e106e3))
* **runtime:** reuse isolated OpenCode servers and add launch badge ([93cd9be](https://github.com/anis-marrouchi/agentx/commit/93cd9befcdc1721e77660ed3326b4d25dee655ce))

## 0.28.0 (2026-09-22)

### Features
- Add `agentx desktop install/start/stop/status` for the macOS assistant and computer-use helper.
- Open AgentX agents in OpenCode v2, with a built-in TUI fallback for missing or older installations.
- Add operator-first documentation, annotated screenshot tours, prerequisites, Jev architecture, A2A and terminal guides.
- Seed isolated documentation demos with scripted workflows and review fixtures.

### Fixes
- Include the postinstall script and desktop build sources in npm packages.
- Build Docker from source on Node 22, initialize shared configuration, and connect dashboard and daemon containers.
- Keep scripted demos from calling the live session reviewer.
- Report upstream model errors correctly from the OpenAI-compatible endpoint.
- Correct sorted test expectations and use a pinned local CLI test runner; require opt-in for paid Claude integration tests.

### Release automation
- Generate future versions and changelogs with Release Please, then validate and publish npm releases through GitHub Actions.

## Historical development notes


### Added
- **Attach mode — wearable agents.** A Claude Code session you already have open can register with the daemon and wear an agent's identity, so channel messages for that agent are answered in the session in front of you instead of spawning a subprocess. `agentx attach install` once, then `agentx attach <agent>` inside any session. Three delivery modes: `manual` (never interrupts), `notify` (default — a note at the end of your turn), `auto` (takes the turn and drains until the inbox is empty, bounded at 5 messages). Unclaimed messages atomically expire after 90s and fall back to spawning, so nothing is lost and nothing is answered twice. See [Attach mode](/reference/attach) and [Journey 14](/journey/14-wearable-agent).
- `agentx attach install` also lays down the `PreToolUse` guard hook at user scope: an attached session runs under your permissions rather than the agent workspace's `settings.json`, so without it an attached production identity would be *less* guarded than a spawned one.
- MCP tools `agentx_attach_next` and `agentx_attach_answer`. Both take the session id from the environment, never from the model.

### Changed
- **Dashboard design system ported from the agentina console**: four-colour brand palette (blue/green/amber/red), 2px borders, 16–20px radii, pill chips and badges, the signature un-blurred offset shadow (`0 4px 0 <darker>`) that collapses on press, and Outfit / Roboto Mono. Both light and dark are written out in full — dark is not a derived tint, because derived dark themes are how contrast bugs ship. The `crt` theme is removed; a stored `crt` preference migrates to dark. See [Design system](/architecture/design-system).

### Removed
- **Discord and Slack channel adapters**, their `channels.discord` / `channels.slack` config schema, the Slack user-task renderer, and the Slack reference page. Neither has carried a single task in the entire history of `task_history` on either node, and neither is configured anywhere in the fleet. This shortens the marketed channel list — a deliberate trade, on the grounds that an adapter which has never delivered a message is a claim rather than a feature. Re-adding is contained: two adapter files, two registration blocks, one schema entry. See [Surface reduction](/architecture/surface-reduction).

### Deprecated
- `agentx chat` and `agentx tui` — no recorded use on any node in the fleet since 2026-07-03. Use [`agentx attach <agent>`](/reference/attach) instead, which wears the identity in the Claude Code session you already have open. Both commands still work and print a notice; removal follows the process in [Surface reduction](/architecture/surface-reduction).

### Added (observability)
- `surface_usage` table (schema v11) + `agentx usage surfaces [--unused]` — counts which CLI commands and dashboard pages actually get opened. Names only, never arguments or payloads. Fills the gap `task_history` cannot: it records agent dispatches, not operator behaviour across 268 registered commands and 19 pages.

### Documentation
- New [Surface reduction](/architecture/surface-reduction) — fleet usage baseline across both nodes, the two-part bar (usage AND impact) a surface must fail before removal, and the staged hide-then-remove process.
- New [Attach mode](/reference/attach) reference and [Journey 14 — Wearable agents](/journey/14-wearable-agent).
- New [Guardrails](/reference/guard) reference — the guard subsystem shipped without a docs page or sidebar entry.
- `agentx guard` and `agentx attach` added to the CLI reference; the attach + guard HTTP endpoints documented as loopback-only.

### Security
- Mesh endpoints (`/task`, `/mesh/task`, `/workflow/event`, `/workflow/transition`, `/channel/send`, `/webrtc/signal`) now verify the Bearer token mesh peers have always sent. Loopback callers are exempt; installs without a configured `MESH_TOKEN` keep working with a warning for one release. `AGENTX_MESH_AUTH=off` opts out.
- The peer-identity forward endpoints (`/gitlab/react`, `/gitlab/send-note`, `/gitlab/log-time`, `/github/send-comment`) joined the protected set — previously an unauthenticated non-loopback caller could make the daemon post as its GitLab/GitHub bot.

### Fixed
- Daemon-level peer forwards (workflow trigger broadcast/transition, cross-node `channel/send`, GitLab/GitHub identity forwards, chat listing fan-out) now attach the peer's mesh token via `A2AMesh.authHeaders()` — previously only `a2a/mesh.ts` task calls sent it, so these paths 401'd against enforcing peers.
- Persistent claude processes are no longer idle-killed mid-turn. The handle now reports `busy` while a turn streams (it used to stay `idle`, so any turn longer than the pool's idle window was reaped mid-work — surfacing as `claude process … is dead (idle (Ns))`), `acquire()` claims reused handles to close the acquire→first-write race, and a handle that dies before the first stream event falls back to spawn-per-task instead of failing the task.

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

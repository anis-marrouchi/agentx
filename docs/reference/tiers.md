# Agent execution tiers

AgentX routes every inbound message, cron, workflow node, webhook, and public API call through the same registry path before it reaches a model. That shared path is the tier contract:

- channel metadata, sender identity, group scope, reply context, media hints, memories, handover notes, and rendered history are assembled before dispatch
- `freshSession`, stale-session rotation, max-turn rotation, tier-2 rotation, queueing, concurrency limits, task history, traces, token usage, and final channel delivery are handled by AgentX
- `toolUseRequired`, typed capability checks, delegation-depth checks, mesh forwarding, and workflow resolution run outside the model tier

The tier changes only the execution backend. A tier should not change which channel can reach the agent, how sessions are keyed, how tasks are queued, or whether the final reply is delivered.

## Tier matrix

| Tier | Runtime | Auth | Session continuity | Tool surface | Best fit |
|---|---|---|---|---|---|
| `claude-code` | `claude` CLI | Claude Code subscription/OAuth | Native Claude session id, optional persistent process, rotation on stale/max-turn/tier-2 | Claude Code tools, workspace files, MCP, skills/hooks from the workspace | Primary tool-using production agents |
| `codex-cli` | `codex exec` / `codex exec resume` | Codex CLI auth | Native Codex `thread_id` persisted as `codexSessionId`; compact AgentX context to avoid prompt bloat | Codex CLI tools, workspace files, AgentX MCP config override | Coding agents that should use OpenAI Codex models |
| `sdk` | `@anthropic-ai/claude-agent-sdk` `query()` | Provider API key, currently Anthropic-shaped | AgentX text history only; no native persisted CLI session | SDK-supported agent behavior; currently less integrated with AgentX usage/session metadata | API-key deployments that want Anthropic Agent SDK without spawning `claude` |
| `orchestrator` | AgentX `generate()` loop | Configured provider API key | AgentX text history only | AgentX provider abstraction; can target non-Claude providers supported by the local generator | Provider-flexible chat or automation where CLI-native tools are not required |

## `sdk` vs `orchestrator`

`sdk` is a direct call into Anthropic's Agent SDK. In code, AgentX imports `@anthropic-ai/claude-agent-sdk`, builds the same prompt/context string, and calls `query({ prompt, options: { model, cwd, permissionMode } })`. It is provider-specific and is intended for teams that want Anthropic's programmatic agent runtime with an API key instead of the Claude Code CLI.

`orchestrator` calls AgentX's own `generate()` function. That path is provider-abstracted: the agent's `provider` selects the configured backend (`openai`, `ollama`, `mistral`, `claude-code`, etc. depending on local provider support). It is useful when the model backend should be swappable, but it does not currently have the same native CLI session semantics as `claude-code` or `codex-cli`.

In short: use `sdk` when you specifically want Anthropic Agent SDK behavior; use `orchestrator` when you want AgentX's provider-agnostic loop.

## Parity rules

All tiers must preserve these AgentX-level behaviors:

| Behavior | Requirement |
|---|---|
| Routing | Same channels, mentions, public API, cron, workflow, and mesh paths |
| Context | Same `buildAgentContext()` contract, with tier-specific budgets allowed only to reduce cost/latency |
| Session reset | `freshSession` must clear any native backend session plus AgentX-rendered history |
| Continuity | If a backend has native sessions, AgentX must persist and resume them; otherwise AgentX must render bounded text history |
| Observability | Task history, trace lifecycle, duration, errors, usage when available, and final reply must be recorded consistently |
| Delivery | Channel adapters receive the same final `AgentResponse` shape |
| Safety | Concurrency, queueing, typed capabilities, delegation depth, and required-tool checks stay outside the tier and apply equally |

## Current implementation status

Implemented:

- `claude-code` native session persistence via `claudeSessionId`
- `claude-code` persistent process option
- `codex-cli` native session persistence via `codexSessionId`
- `codex-cli` compact context path, AgentX MCP config override, stderr capture, usage extraction, and no-output watchdog
- shared registry routing, queueing, channel delivery, task history, traces, and session storage
- setup/admin UI support for all four tier values

Known gaps:

- `sdk` and `orchestrator` do not currently return native session ids, cache-read tokens, or model billing metadata with the same fidelity as the CLI tiers
- `orchestrator` token reporting is `tokensUsed` only when the generator returns it, not normalized `TokenUsage`
- `sdk` is Anthropic-specific despite the generic name
- workspace-native MCP/skills/hooks are strongest on CLI tiers; API tiers depend on what their runtime/provider supports

## Implementation plan

1. Normalize `AgentResponse` for `sdk` and `orchestrator`: return `usage`, `billedModel`, and typed errors whenever the backend exposes them.
2. Add a provider capability map so the dashboard can show which tiers support native sessions, MCP, file tools, images, streaming, and usage accounting.
3. Add parity tests that run the same fake task through all tiers and assert the shared registry behavior: session reset, task completion event, task history, queueing, and final response delivery.
4. Add optional native provider transports where they are clearly better than CLI spawning. For Codex, the larger follow-up is an OpenClaw-style `openai-codex` Responses transport that reuses Codex OAuth instead of spawning `codex`.
5. Keep CLI tiers as the high-fidelity tool-using path until API tiers can prove equivalent tool and workspace behavior.

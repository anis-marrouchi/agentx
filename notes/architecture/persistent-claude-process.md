# Persistent Claude Process — Design Note

**Status:** draft, public (`docs/architecture/`, allowlist-tracked in `.gitignore`)
**Author:** Claude Opus 4.7 (1M context), 2026-05-03
**Plan reference:** improvement plan #5 ("`claude-api` tier") + user-stated framing on persistent process reuse with `/clear`, `/compact`, `--resume`
**Last updated:** 2026-05-03 (post-CLI-doc-review — see "Gating question resolved" below)

---

## Gating question resolved (added 2026-05-03)

The CLI reference + headless docs (https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/headless) confirm two things that change the implementation:

1. **Slash commands DO NOT work in `claude -p` mode.** Verbatim from the headless docs:

   > User-invoked skills like `/commit` and built-in commands are only available in interactive mode. In `-p` mode, describe the task you want to accomplish instead.

   The original design's "When to use `/compact` vs `/clear` vs `--resume`" table assumed slash commands would work via stdin in non-interactive mode. They won't. Every AgentX invocation runs in `-p`. The `/compact`-in-place lever does not exist for us.

2. **`--input-format stream-json` is the documented multi-turn primitive in `-p` mode.** Combined with `--output-format stream-json --verbose`, this keeps stdin open and accepts multiple turns as JSON messages on stdin without a TTY. **This** is what makes the persistent-process design viable — not slash commands.

**Architecture pivots (kept what was right, dropped what was wishful):**

- ✅ Process-per-session (Option B in §"Architecture options considered") still wins.
- ✅ `--resume` for cross-spawn continuity unchanged.
- ✅ Concurrency model unchanged — agent × chat × channel = independent processes.
- ❌ "Send `/clear` between chats" → drop. We'd never reuse a process across chats anyway (process-per-session means one process binds to one chat for its lifetime).
- ❌ "Send `/compact` for tier-2 / max-turns rotation" → drop. Replace with **kill + respawn**, optionally seeding the new process with an application-level summary via `--append-system-prompt`.
- ➕ New primitive: `--input-format stream-json` for in-session multi-turn.
- ➕ New rotation primitive: `--fork-session` — resumes a session but allocates a new session_id. Cleaner than "clear `claudeSessionId` and let next call spawn without `--resume`".

The §"When to use `/compact` vs `/clear` vs `--resume`" table is rewritten below in §"Session-management, post-CLI-doc-review". The original table is preserved for historical context but should not guide implementation.

---

---

## Why this doc exists

A benchmark against Hexabot scored AgentX at 115/155, with **per-request latency** as one of the load-bearing gaps. The cause is concrete: every `POST /task` spawns a fresh `claude-code` subprocess. On observed traffic:

- Graph-agent answering `Reply with the word: alpha` (no tools, sonnet): **6.5s end-to-end**
- Of that 6.5s, the model's actual inference is sub-second; the rest is Claude Code startup + cache rebuild (`cache_create_input_tokens` ≈ 25K on the cold dispatch, dropping to ≈ 1.3K with `--resume`).

The improvement plan's #5 proposed a different fix — a `claude-api` tier that calls Anthropic's SDK directly, in-process, no subprocess. That eliminates the latency but loses tool use. The user proposed a third path: **keep Claude Code, but reuse one persistent process per session and drive it with the slash commands Claude Code already has** (`/clear`, `/compact`, `--resume`).

This doc designs that third path. It is **not** a recommendation to deprecate `claude-api` — both options have merit on different agents.

---

## Goals (in priority order)

1. **Correctness — same outputs as spawn-per-task.** No regressions on multi-turn agents, no leaked state between unrelated chats, no race between rotation and reuse.
2. **Concurrency — multiple agents running at the same time, no head-of-line blocking.** Atlas answering a Telegram message must not stall while DevOps is mid-deploy. Even within a single agent, two unrelated chats must not serialize through one process.
3. **Latency reduction.** Target: 5–10× speedup on chat-shaped workloads (the same speedup the improvement plan predicted for `claude-api`, while keeping tools).
4. **Lifecycle clarity.** Operator must be able to answer "is process X alive, what is it bound to, when will it die" without grepping logs.
5. **Operability under failure.** Hung child, crashed child, stuck stream — all recoverable without restarting the whole daemon.

Non-goals for v1:

- Cross-host process pooling (mesh agents stay subprocess-local).
- Pre-warmed process pools (just-in-time spawn is acceptable; pre-warm is a v2 optimization).
- Streaming response for HTTP `/task` endpoints (already supported via stream-json — orthogonal).

---

## Architecture options considered

### A. Pool-per-agent, N warm processes shared across chats
Each agent has a pool of N persistent processes. Tasks dispatch to any idle one. Process death triggers respawn.

- **Pro:** small process count, warm cache.
- **Con:** state isolation is leaky. Claude Code carries CWD, recent-file context, hook state inside the process. A pool member that just helped chat A then handles chat B sees A's residue.
- **Verdict:** rejected. Isolation cost too high for the multi-tenant chat case.

### B. Process-per-session — one subprocess per `(agentId, channel, chatId)`, idle timeout kills it
A subprocess is bound to a single session for its lifetime. Tasks for the same chat reuse the process; tasks for different chats spawn new ones (or reuse the warm one for that chat). Idle for N minutes → kill.

- **Pro:** perfect isolation; warm within a chat (the latency case that matters most); maps directly onto the existing SessionStore primary key.
- **Con:** process count scales with active chats. On a busy daemon: 50+ chats × 8 agents could mean hundreds of processes. Each Claude Code subprocess is ~50–80 MB resident.
- **Verdict:** **Pick this** for v1. Process count is the right thing to spend on; chat-isolation correctness is non-negotiable.

### C. Process-per-agent, control channel for `/clear` between chats
One subprocess per agent, all of an agent's tasks serialize through it. Use `/clear` between chats, `--resume <session_id>` to restore.

- **Pro:** minimal process count (one per agent).
- **Con:** **serializes every task for an agent across chats.** Atlas-on-Telegram-with-Bob blocks Atlas-on-Telegram-with-Alice. Directly violates Goal #2.
- **Verdict:** rejected — fails the concurrency goal.

### D. Hybrid pool with dynamic sizing
Per-agent pool, default size 1, scales up under load. Members track which chats they've handled and route by affinity.

- **Pro:** can match B's latency at lower process count.
- **Con:** affinity routing + process recycling is the complex part of every pool implementation that ever shipped wrong. Not worth it for v1.
- **Verdict:** v2 candidate, not v1.

---

## Recommended architecture — process-per-session

### Lifecycle states for a session-bound process

```
   spawn ──► warm-cold ──► warm-hot ──► idle ──► reaped
              ▲                ▲          │
              │                └──turn────┘
              └──────────/clear or kill───┘ (chat closed or stale-rotation)

   warm-cold:  process alive, no claudeSessionId yet (cache_create coming)
   warm-hot:   process alive, claudeSessionId set, --resume seeds future turns
   idle:       last task completed > N seconds ago (default 30s for v1)
   reaped:     killed by idle timeout or explicit close, slot freed
```

State carried per process:

| Field | Type | Set when |
|---|---|---|
| `pid` | `number` | spawn |
| `agentId` | `string` | spawn |
| `channel` | `string` | spawn |
| `chatId` | `string` | spawn |
| `claudeSessionId` | `string?` | first turn's `result.session_id` |
| `lastTurnAt` | `number` (ms epoch) | each turn end |
| `turnCount` | `number` | each turn end |
| `lastInputTokens` | `number` | each turn end (drives tier-2 detection) |
| `state` | enum | each transition |
| `pendingTaskId` | `string?` | turn start, cleared at end |

Key: `(agentId, channel, chatId)`. Stored in `ProcessRegistry` (new), keyed on the same composite the existing `SessionStore` uses.

### When to spawn vs reuse

```
incoming task for (agent, channel, chatId):
  let proc = registry.get(agent, channel, chatId)

  # Stale rotation — older than 45min idle: kill + respawn fresh
  if proc and (now - proc.lastTurnAt) > STALE_TIMEOUT:
    proc.send("/clear")
    proc.claudeSessionId = undefined
    # OR: proc.kill(); proc = undefined  (see "kill vs /clear" below)

  # Tier-2 rotation — last turn pushed input past 180K: compact in-place
  if proc and proc.lastInputTokens > TIER_TWO_THRESHOLD:
    proc.send("/compact")
    # process keeps same claudeSessionId after compact; future turns
    # reuse the cache-friendlier transcript

  # Max-turns rotation — > 15 turns: also compact (preferred over /clear
  # because we want continuity)
  if proc and proc.turnCount >= MAX_TURNS:
    proc.send("/compact")
    proc.turnCount = 0  # reset window

  if not proc:
    proc = spawn(agent, channel, chatId, resumeSessionId=stored claudeSessionId)
    registry.put(proc)

  return proc.runTurn(task.message)
```

### Kill vs `/clear` for stale rotation

`/clear` keeps the process alive but resets the conversation. Saves the spawn cost on the next turn.

`kill + respawn` is heavier but is the only way to:
- Pick up changed `CLAUDE.md` (the process reads it at startup; in-flight processes hold the prior version)
- Pick up changed `.claude/settings.json` hooks
- Recover from an in-process bug (memory leak, file-descriptor exhaustion)
- Bind to a different `permissionMode` (changing this requires CLI re-launch)

**Heuristic:** prefer `/clear` for routine stale rotation; `kill+respawn` when the agent's workspace files have changed (detected via the managed-marker hash from improvement plan fix #1) or when the operator forces it.

### Session-management, post-CLI-doc-review (supersedes the table below)

After confirming slash commands don't work in `-p`, the operative table is:

| Scenario | Action | CLI primitive |
|---|---|---|
| First turn in a chat | spawn process, no `--resume` | `claude -p --input-format stream-json --output-format stream-json --verbose [--append-system-prompt …]` |
| Subsequent turn, same chat, process alive | write a JSON message to the existing process's stdin | (no new spawn) |
| Subsequent turn, same chat, process gone | spawn process with `--resume <stored sessionId>` | `--resume` |
| Stale rotation (idle > 45min) | kill process; next turn spawns fresh | process kill + clear stored sessionId |
| Max-turns rotation (turns ≥ 15) | kill process; before next spawn, summarize last N turns at the application layer and seed via `--append-system-prompt` (and use a fresh session) | `--append-system-prompt` |
| Tier-2 rotation (input ≥ 180K) | same as max-turns — kill + summarize + fresh start | `--append-system-prompt` |
| Workspace files changed (CLAUDE.md hash mismatch) | kill process; next spawn picks up new files | process kill |
| `permissionMode` changed | kill process; next spawn passes new flag | process kill |
| Operator force-rotate | kill process | process kill (or `--fork-session` flag if we want continuity-with-new-id) |
| Chat ended | kill process | process kill |

**Mnemonic update:** `--resume` preserves *what was said and the cache*; kill+respawn preserves *who said it* (workspace + permission); kill+respawn+`--append-system-prompt` simulates compact (preserves the gist while resetting the cache). There is no in-place `/compact` available to us.

The "simulate `/compact`" path needs design before we ship — composing a summary requires a secondary call. Two options: (a) reuse the same agent for self-summary (cheap, but mid-task), (b) run a dedicated tiny summarizer model. Per-agent benchmark before we default to either.

---

### Original table — superseded by the section above, kept for reference

The next subsection assumes slash commands work in `-p`. **They do not.** Reading this only to understand what the original design proposed:

#### When to use `/compact` vs `/clear` vs `--resume` (DEPRECATED)

| Scenario | Action | Rationale |
|---|---|---|
| First turn in a chat | spawn fresh, no flags | No prior session to resume |
| Subsequent turns, same chat, same process alive | reuse process directly (no slash needed) | The process IS the session — slash commands are for state mutations, not for "continue" |
| Daemon restart, chat had a stored `claudeSessionId` | spawn with `--resume <id>` | Restores conversational state from disk |
| Tier-2 rotation (input > 180K) | `/compact` | Compresses transcript, keeps cache below tier-2 threshold, preserves continuity |
| Max-turns rotation (turns ≥ 15) | `/compact` | Same — preserve continuity, cap cache size |
| Stale rotation (idle > 45min) | `/clear` (or kill+respawn) | User's mental model has reset; conversational continuity isn't valuable |
| Chat-ended signal (e.g. user types `/end` in Telegram) | `kill` | Free the slot |
| Workspace files changed (CLAUDE.md hash mismatch) | `kill+respawn` | Process holds stale config |
| `permissionMode` changed in agentx.json | `kill+respawn` | CLI flag, not runtime-changeable |
| Operator force-rotate via `agentx session rotate <id>` | `/clear` for soft, `--hard` for kill | Honour intent |

**Mnemonic:** `/compact` preserves *what was said*; `/clear` preserves *who said it* (i.e. the process, the model, the workspace); `kill+respawn` preserves *nothing* but is the only safe response to config changes.

### Concurrency model

Process-per-session naturally gives concurrency across:

- **Different agents** (atlas + devops simultaneously): always concurrent, separate process pools per agent
- **Different chats per agent** (atlas-with-Alice + atlas-with-Bob): concurrent — each has its own subprocess
- **Different channels per chat** (atlas-Telegram + atlas-WhatsApp for the same person): concurrent — different chatIds in our key

Concurrency limits *within* a chat: still serialized (Claude conversation state is intrinsically sequential). Existing `MessageQueue.markRunning()` already enforces this.

Process-count budget per daemon:

- Cap: `MAX_PROCESSES = 64` global. Soft target.
- Eviction policy: LRU on `lastTurnAt`. When at cap and a new chat starts, kill the oldest idle process.
- Pre-spawn priority: cron-driven dispatches for the same agent often arrive in bursts; mark those tasks `priority: high` so they don't get evicted by chatty Telegram traffic.
- Per-agent fairness: cap per-agent at `MAX_PROCESSES_PER_AGENT = 16` to prevent one rogue chat-stream from starving other agents.

### Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Process crashed (exit code non-zero) | `child.on("exit")` handler | mark process gone, registry entry removed; next task respawns |
| Process hung mid-stream (no output for 60s) | per-turn watchdog timer | `child.kill("SIGTERM")`, mark dead, respawn |
| Stream-json output unparseable | parser error | log, kill child, respawn (data corruption indicates Claude CLI bug or process state damage) |
| Child stdin pipe broken | write throws | mark dead, respawn |
| Daemon process restart | n/a | all children die with parent (default child handling); registry cleared on boot |
| Hard daemon kill (SIGKILL) | n/a | orphaned children get reaped by init/launchd; on restart, traces table has them as `in-flight` and `cleanupOrphanedTraces` retires them (already shipped) |

Watchdog detail: each turn opens a per-turn timer for `agent.maxExecutionMinutes` (default 20) for the whole turn, plus a 60s no-output timer that resets on each stream-json event. Either expiring → kill the child.

---

## Interaction with already-shipped pieces

### Improvement plan #1 — CLAUDE.md managed-marker
The marker hash already lets us detect workspace-file drift. Tie process eviction to it: on daemon startup or config-reload, walk every active process and compare its workspace's CLAUDE.md hash with what was current at process spawn. Mismatch → graceful kill (let the in-flight task finish, then reap before next task).

Implementation note: `setupWorkspace` already returns `created`/`skipped` arrays; extend it to surface "refreshed" entries with the new hash so the registry can compare.

### Improvement plan #2 — task_traces (just shipped)
Already integrates correctly with persistent processes. `task:started` fires per turn (allocating a fresh ULID); per-step events fire from the streaming parser; `task:completed` fires per turn. No change needed — the trace is per-task, not per-process.

One enhancement worth doing alongside: add `process_id` (the daemon-internal process key, not pid) to the trace row so traces can be grouped by which subprocess produced them. Useful for debugging "all turns from this process timed out".

### Rescue plan Phase 1 — intent ledger
Independent. Dispatch decisions are recorded before any process is touched; the ledger doesn't care which process the task ends up running on.

### Rescue plan Phase 4 — meta-loop
Strengthens this design. Meta-loop reads trace patterns; with persistent processes, traces include `process_id` so the meta-loop can answer "which processes are too long-lived (memory pressure?), which die early (config bug?)".

### Existing SessionStore
This is the closest existing primitive. SessionStore tracks `claudeSessionId` per `(agent, channel, chatId)`. The new ProcessRegistry is the *runtime* analogue — same key, but tracks a live subprocess instead of just an id. They sit alongside each other, not in conflict; SessionStore stays authoritative for the *id*, ProcessRegistry adds the *handle*.

---

## Migration path

Same shadow-rollout pattern the rescue plan used for the intent ledger.

### Stage 1 — additive, opt-in per agent
- New `agentx.json` field: `agents.<id>.persistentProcess: boolean` (default `false`)
- New CLI tier name: keep `tier: "claude-code"`; the `persistentProcess` flag layers on top
- Implementation lives behind the flag; default codepath untouched

### Stage 2 — single agent per host, observe
- Pick one cron-heavy agent (marketing-agent — daily news / blog crons), flip flag
- Soak ≥ 7 days, watch trace data: per-turn latency, failure rate, process churn
- Define success: latency P50 drops by ≥ 3×; failure rate within ±1% of baseline

### Stage 3 — staged broaden
- Flip to one chatty interactive agent (cx-agent), soak ≥ 3 days
- Then bypassPermissions agents (devops, coder), with extra watchdog tuning

### Stage 4 — make it the default
- After all agents have run persistent for ≥ 14 days with no measurable degradation: flip default to `true`, leave the flag for opt-out

Rollback: at any stage, flip the flag → next dispatch uses spawn-per-task path. No state migration needed (SessionStore is shared between modes).

---

## Open questions for the user

1. **Process-count budget.** I propose `MAX_PROCESSES = 64`, `MAX_PROCESSES_PER_AGENT = 16`. These are guesses; what's the actual ceiling on the production daemon? Memory? FDs? Operator preference?

2. **Default idle timeout.** I propose 30s for "warm idle" (process kept alive between turns of the same chat) and 45min for stale rotation (consistent with current SessionStore). Reasonable?

3. ~~`/compact` vs `/clear` for max-turns rotation.~~ **RESOLVED 2026-05-03 → v1 ships with `--resume` cold-respawn, no application-level summary.** Reasoning: `--resume <stored claudeSessionId>` already restores conversational state at cost of a single cache_create on the next turn. Rotation is rare by definition (after 15+ turns or 180K input). One cache_create per rotation is much cheaper than running an extra summarization inference per rotation. If the soak shows rotations are frequent enough that the cache_create cost matters, revisit with the summary-on-rotate option (per-agent flag, dedicated haiku summarizer) as a step-6.5 follow-up.

4. **Workspace-file drift detection.** Should CLAUDE.md changes trigger a kill+respawn, or is "reload at next stale rotation" good enough? The conservative choice (kill on drift) is a few minutes of extra work; the relaxed choice means stale config rides for up to 45 min.

5. **Pre-warm pool for the very first task on cold-start daemon?** A boot-time spawn of one process per `permissionMode=bypassPermissions` agent could absorb the cold-start cost so the first user-visible task isn't 6s slow. Worth it, or YAGNI?

6. **Visibility surface.** Should I add `agentx process list` / `agentx process kill <id>` CLI commands as part of the v1 ship? Without them, operators have no way to inspect the registry or force-rotate without a full daemon restart. I'd lean toward yes — the trace CLI proved its worth in the live smoke test 30 minutes ago.

7. **Persistent-process tier vs `claude-api` tier — both?** They solve different problems. Persistent process keeps tools and is the right answer for tool-using agents. `claude-api` (in-process SDK call) is the right answer for chat-only agents that never need tools (cx-agent first-line replies, simple FAQ bots). Both can coexist — a per-agent `tier` field already routes between them. Want me to ship persistent-process first and revisit `claude-api` as a separate effort once we have data?

---

## Implementation rough order (when we proceed)

For estimation only — actual commit splitting decided when we start.

| Step | Effort | Risk |
|---|---|---|
| Read `/en/agent-sdk/streaming-input` upstream — confirm stream-json input wire format | ½ hr | — |
| ProcessRegistry skeleton + tests (in-memory, no real subprocess) | 1 day | low |
| Real subprocess wrapper (spawn with stream-json input/output, stdin write helper, stdout reader, exit handler) | 2 days | medium (concurrency bugs are subtle) |
| Per-turn driver (build JSON message, write to stdin, read events, parse) | 1 day | low (existing stream-json parser at `registry.ts` is reusable) |
| Watchdog timers (per-turn budget + no-output stall detection) | ½ day | low |
| ~~Slash-command driver~~ **CUT** — slash commands don't work in `-p`. Replaced by: | | |
| Application-level summary-on-rotate (compose summary, kill + respawn with `--append-system-prompt`) | 1 day | medium (which agent does the summary? same agent self-summary or dedicated summarizer?) |
| Eviction (idle timeout, LRU, per-agent cap, global cap) | 1 day | low |
| Workspace-drift detection wiring (CLAUDE.md managed-marker hash check) | ½ day | low |
| `agentx process list/kill` CLI | ½ day | low |
| `agents.<id>.persistentProcess` config flag + routing in `executeTask` | ½ day | low |
| Documentation + migration playbook | ½ day | — |

Rough total: **~8 engineer-days** for v1 ship (was 8.5; the slash-command driver is gone; summary-on-rotate replaces a portion of it). Stage 2 / 3 soaks add calendar time, not engineering time.

---

## Risk register

1. ~~Slash commands may not work in `claude -p` non-interactive mode.~~ **RESOLVED 2026-05-03** by upstream docs. They don't, and `--input-format stream-json` is the documented multi-turn alternative. Design adapted; see "Gating question resolved" at the top of this doc.
2. **Long-running children can leak memory.** Claude Code is a Node process; node's GC is fine but custom modules / hooks may have their own state. Operator-visible memory monitoring (`agentx process list` showing RSS) should ship in v1.
3. **Stream parsing under sustained traffic might miss events under back-pressure.** If the daemon falls behind reading the child's stdout, the kernel pipe buffer fills, child stalls. Need a non-blocking reader and dropped-event detection.
4. ~~`/compact` cost is non-trivial.~~ **MOOT** — `/compact` not available in `-p` mode. Application-level summary-on-rotate is the replacement; its cost characteristics are different (one extra inference call per rotation rather than transcript compression). Benchmark before defaulting which agents enable it.
5. **`--resume` semantics on a long-stored session_id.** If the daemon was off for a week and a user sends a new turn, we resume a session whose last activity was a week ago. Claude Code is fine with this in principle, but anomalous in practice. Tier-2 detection should still kick in based on stored `lastInputTokens`.
6. **Stream-json input wire format is documented at `/en/agent-sdk/streaming-input` — not yet read.** Need to confirm the exact JSON message shape before implementation. Should be a 30-minute task. **First implementation step.**
7. **`--bare` is "the recommended mode for scripted/SDK calls" and "will become the default for `-p` in a future release."** AgentX relies on per-agent `CLAUDE.md` being read at startup; bare skips that. We need to either explicitly opt out of bare, or replicate CLAUDE.md content via `--append-system-prompt-file`. The eventual default-flip is a breaking change to plan for.

---

## What's *not* in this doc

- A side-by-side comparison with `claude-api` (improvement plan #5). Both options should ship; this is design for one of them.
- Anything about non-`claude-code` tiers (sdk, orchestrator, future `claude-api`). Each tier has its own latency story.
- Pre-warm strategies, dynamic pool sizing, cross-host pooling — v2.
- Per-agent compaction tuning (e.g., adaptive thresholds based on observed token usage). Phase 4 (meta-loop) is the right home for adaptive heuristics; this design uses static thresholds for v1.

---

*End of document. Update the open-questions list as the user answers them, and create a sibling kickoff doc when we start implementation.*

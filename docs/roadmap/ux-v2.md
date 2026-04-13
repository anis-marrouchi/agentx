# UX v2 — zero manual config edits

> **Goal:** make AgentX usable end-to-end without ever opening `agentx.json` or `.env` by hand.
> **Shape:** 7 PRs, each independently shippable. PR 1 has landed; PR 2–7 are queued.

## Why

Every onboarding session in the past quarter has ended with a step like "now paste your token into `.env`", "edit `agentx.json` and add this cron block", or "find your Telegram chat ID from `getUpdates`". These manual edits are the single biggest source of friction — and the only way to recover from a bad edit today is to read the daemon log and guess at the Zod error.

UX v2 eliminates those moments. Every change flows through a validated CLI command; the daemon hot-reloads safe changes and tells you clearly when a restart is required.

## Design principles

1. **Every mutation is a command.** If a user needs to change something, there is a verb for it — no file-level instructions.
2. **Validate before persist.** A failed `agentx config set` leaves the on-disk state untouched.
3. **Interactive by default, flags for automation.** Each command works with zero args (prompts the user) or fully scripted (all flags provided).
4. **Read like English.** `agentx schedule "every morning at 9" --agent devops --notify me` over `cron add` + cron-syntax memorization.
5. **Short to type.** One-letter aliases for every top-level verb, zsh/bash completion installed in one command.
6. **Fix > explain.** `agentx doctor` finds what's broken and `agentx fix` applies a remedy — both beat "grep the daemon log."

## PR inventory

| # | Title | Status | Depends on | Approx LOC |
|---|---|---|---|---|
| 1 | Config mutator + daemon reload | **shipped** (`10bc216`) | — | ~400 |
| 2 | `agentx config get/set/unset` | **shipped** (`06e00a3`) | PR 1 | ~200 |
| 3 | Natural-language scheduling | **shipped** (`ffd1ef5`) | PR 1 | ~400 |
| 4 | `agentx connect <channel>` | **partial** — 4a telegram + 4c whatsapp + 4d discord + 4e mesh shipped; gitlab (4b) pending | PR 1 | ~700 (split-able) |
| 5 | `agentx setup` unified wizard | queued | PR 4 | ~300 |
| 6 | `agentx doctor` + `agentx fix` | queued | PR 1 | ~400 |
| 7 | Aliases + tab completion | queued | — | ~150 |

### Dependency graph

```
PR 1 (foundation) ──┬── PR 2 (config set)
                    ├── PR 3 (nl schedule)
                    ├── PR 4 (connect) ─── PR 5 (setup wizard)
                    └── PR 6 (doctor/fix)
PR 7 (aliases + completion) ── independent
```

---

## PR 1 — Config mutator + daemon reload ✓ shipped

**Landed:** commit `10bc216`

Files:

- `src/daemon/config-mutator.ts` — `applyConfigMutation(fn, opts)` + `setAtPath` / `getAtPath` / `unsetAtPath`
- `src/utils/dotenv-mutator.ts` — `readDotEnv` / `setDotEnv` / `appendDotEnv` / `getDotEnv` / `unsetDotEnv`
- `src/daemon/config.ts` — `expandEnvVars` exported for reuse
- `src/daemon/index.ts` — `POST /reload` endpoint, debounced `fs.watch` on `agentx.json`, `reload()` hot-swaps crons and flags sections that still need a restart
- `src/commands/manage.ts` — `saveConfig()` routed through the mutator so every existing add-wizard gains pre-save Zod validation + auto-reload
- `test/config-mutator.test.ts` — 11 tests covering validation rejection, dry-run, `${VAR}` round-trip, reload signal, and `.env` comment preservation

Acceptance:

- ✓ Editing `agentx.json` while the daemon is running triggers `[reload] applied: crons`
- ✓ `curl -X POST http://localhost:18800/reload` returns `{ ok, applied, restartRequired }`
- ✓ All existing add wizards (agent/channel/cron/mesh/hook) now validate pre-write
- ✓ `AGENTX_AUTO_RELOAD=false` disables the watcher
- ✓ Unit tests green on CI

---

## PR 2 — `agentx config get/set/unset` ✓ shipped

**Landed:** commit `06e00a3`

### UX (as shipped)

```bash
agentx config get crons.wiki-absorb-midnight.onError
# => ["notify","disable"]

agentx config set crons.wiki-absorb-midnight.onError "notify,disable"
# ✓ Validated. Daemon hot-reloaded.

agentx config set agents.devops.model claude-sonnet-4-6
# ✓ Validated. Agents require a restart to pick up model changes.

agentx config unset crons.test-cron
# ✓ Removed crons.test-cron. Daemon hot-reloaded.

agentx config get crons.wiki-absorb-midnight   # prints the full object as JSON
```

### Implementation

- Extend `src/commands/manage.ts` `config` command group with `get / set / unset` subcommands
- Use `setAtPath` / `getAtPath` / `unsetAtPath` from `config-mutator.ts`
- For `set`: parse value as JSON first (so `"notify,disable"` → string, `[1,2]` → array, `true` → bool); fallback to raw string
- Pretty-print the path + new value on success; print full Zod error on failure
- `--json` flag: emit machine-readable output for `get`

### Acceptance (verified live)

- ✓ `config set` rejects Zod violations and leaves on-disk file untouched
- ✓ `config unset` is a no-op on missing paths
- ✓ `config get --raw` preserves `${VAR}` tokens; default view env-expands
- ✓ Valid writes trigger `POST /reload`; output notes "Daemon hot-reloaded."
- ✓ 16 unit tests green

---

## PR 3 — Natural-language scheduling ✓ shipped

**Landed:** commit `ffd1ef5`
**Dep added:** `cronstrue` (for human-readable rendering)

### UX (as shipped)

```bash
agentx schedule "every morning at 9" \
  --agent devops \
  --do "Post morning standup" \
  --notify me

# ✓ Parsed as: 0 9 * * * (Africa/Tunis)
#   "At 09:00 AM, daily"
# Added cron 'morning-standup-devops' and hot-reloaded.

agentx schedule "weekdays at 6pm" --agent marketing --do wrap-up
agentx schedule "every monday at noon" --agent pm --do weekly-plan

agentx schedule list
# morning-standup-devops   0 9 * * *   devops      "At 09:00 AM, daily"
# wrap-up-marketing        0 18 * * 1-5 marketing  "At 06:00 PM, Mon–Fri"

agentx schedule off wiki-absorb-midnight
agentx schedule on wiki-absorb-midnight
agentx schedule remove morning-standup-devops
```

### "me" resolution

`--notify me` reads `notifications.destination` from the config (set once by `agentx connect notify` in PR 4 or `agentx config set notifications.destination.*` today). If unset, the command prompts interactively.

### Implementation

- `src/commands/schedule.ts` — new verb; registers alongside existing `cron`
- `src/utils/nl-cron.ts` — `parseEnglishToCron(text, timezone): string` using `chrono-node` heuristics + handcoded patterns for the common cases (`every morning at X`, `weekdays at X`, `every N minutes`, `every monday`)
- Each generated cron gets a deterministic id: `<slug-of-prompt>-<agent>`
- `cron` command stays as low-level alias for ops who want raw cron syntax

### Acceptance (verified live)

- ✓ 24 English → cron mappings green, plus am/pm + unknown-phrase null tests
- ✓ Unknown phrasing prints suggestion list instead of guessing
- ✓ `schedule list` renders cronstrue text for every job
- ✓ `schedule off/on/remove` hot-reload via PR 1
- ✓ Tested end-to-end against live daemon with `--id nl-test` round-trip

---

## PR 4 — `agentx connect <channel>`

**Depends on:** PR 1
**Can split into:** 4a Telegram, 4b GitLab, 4c WhatsApp, 4d Discord, 4e Mesh

### Unified flow

```bash
agentx connect telegram
# 1. Opens https://t.me/BotFather in browser
# 2. Prompts: "Paste your token"
# 3. Verifies via GET /bot<token>/getMe
# 4. Prompts: "Bind this bot to which agent?"
# 5. Writes channels.telegram.accounts.<label> + stores token in .env
# 6. Prompts: "Send 'hi' to your bot from the chat you want to use"
#    Polls /getUpdates until it sees a message → auto-detects chatId
# 7. Stores as `notifications.destination.chatId` so --notify me works

agentx connect gitlab
# 1. Opens https://gitlab.com/-/user_settings/personal_access_tokens?name=agentx&scopes=api,read_api
# 2. Prompts: "Paste your PAT"
# 3. Verifies via GET /user
# 4. Prompts: "Which projects? (comma-separated ids or paths)"
# 5. Auto-registers webhooks via POST /projects/<id>/hooks
# 6. Stores PAT + webhook secret + routes

agentx connect whatsapp
# 1. Serves QR at http://localhost:18801/pair + prints to terminal
# 2. Waits for pair; persists Baileys session
# 3. Prompts for default agent + routes interactively

agentx connect discord
# 1. Prompts for bot token + client_id
# 2. Prints OAuth install URL: https://discord.com/oauth2/authorize?...
# 3. Waits for first inbound message → auto-binds guild/channel

agentx connect mesh
# 1. On Node A: `agentx mesh invite` emits agentx-mesh://join/<base64>
# 2. On Node B: `agentx mesh join <link>` auto-provisions MESH_TOKEN in .env,
#    adds the peer, confirms health
```

### Implementation

- `src/commands/connect.ts` — top-level dispatcher
- `src/connect/telegram.ts`, `src/connect/gitlab.ts`, `src/connect/whatsapp.ts`, `src/connect/discord.ts`, `src/connect/mesh.ts`
- `src/daemon/pairing-server.ts` — short-lived HTTP listener on a free port for QR + OAuth callback + first-message capture
- Reuses PR 1 mutator for all writes + reload
- Reuses `src/utils/dotenv-mutator.ts` for token persistence

### Tests

- Mock each channel's auth API and verify config + `.env` are updated
- Telegram first-message detection unit test (fake `getUpdates` payload)
- `connect mesh` round-trip: invite on A, join on B, verify both sides have matching peer + token

---

## PR 5 — `agentx setup` unified wizard

**Depends on:** PR 4 (at least Telegram + mesh)

### UX

```
$ agentx setup
? What are you building?  (↑↓)
  > Solo assistant (just me)
    Team on Telegram (2–5 agents, shared bot accounts)
    Services business (KPIs, work-pool, daily reports)
    Multi-machine mesh (agents across servers)
    Custom

? Pick a name for your first agent: support
? Personality (short — what should it do?): Concise technical assistant, 2-4 sentences max

? Connect a channel now? (y/N) y
  → runs `agentx connect telegram`

? Schedule anything? (skip / standup / custom)
  → runs `agentx schedule "..." --agent support`

? Turn on the business layer? (y/N)
? Start the daemon now? (Y/n)

✓ Setup complete. DM @your_bot to test, or `agentx daemon watch` for live activity.
```

### Implementation

- `src/commands/setup.ts` — composes `agent add` + `connect <channel>` + `schedule "..."` internally
- Presets for each "what are you building" choice pre-fill sensible defaults
- Every sub-step can be skipped; setup saves progress so users can resume with `agentx setup --resume`

---

## PR 6 — `agentx doctor` + `agentx fix`

**Depends on:** PR 1

### UX

```bash
agentx doctor
# Checking config...                    ✓ valid
# Checking agents...                    ✓ 3/3 workspaces exist
# Checking channels...
#   telegram.default                    ✓ token valid (@support_bot)
#   telegram.devops                     ✗ token rejected (401)
# Checking crons...
#   morning-standup                     ✓ last ran 2h ago
#   wiki-absorb-midnight                ⚠ 3 consecutive failures
# Checking mesh peers...
#   clawd-server                        ✓ healthy (agents: devops, qa)
# Checking disk...
#   .agentx/sessions/                   ⚠ 2.1 GB (consider pruning)
#
# 1 error, 2 warnings. Run `agentx fix` to remedy interactively.

agentx fix
# [1/3] telegram.devops token rejected. Rotate?
#   > open BotFather and revoke + reissue
#     enter a new token now
#     skip
# ...
```

### Implementation

- `src/commands/doctor.ts` — orchestrator
- `src/doctor/checks/*.ts` — one file per check (config, agents, channels, crons, mesh, disk, tokens, dotenv drift)
- Each check returns `{ id, status: "ok"|"warn"|"error", message, fixable: boolean, fix: () => Promise<void> }`
- `src/commands/fix.ts` — interactive loop over fixable checks

---

## PR 7 — Aliases + tab completion + help polish

**Depends on:** nothing (can ship anytime)

### Aliases

| Alias | Verb |
|---|---|
| `agentx a` | agent |
| `agentx c` | channel |
| `agentx x` | cron |
| `agentx m` | mesh |
| `agentx w` | wiki |
| `agentx s` | schedule (PR 3) |
| `agentx d` | doctor (PR 6) |

Added via Commander's native `.alias()`.

### Completion

```bash
agentx completion install       # auto-detects shell, writes the right file
agentx completion install --shell zsh
agentx completion print         # emit the script to stdout for manual install
```

Generates from live Commander metadata so completions stay in sync with the CLI surface.

### Help polish

- `agentx help <topic>` renders a short tutorial per top-level verb, not just `--help`
- Man-page-style sections: Synopsis, Examples, See also
- Re-uses text from the journey docs so the CLI help and the website stay aligned

---

## Metrics to judge success

We'll know UX v2 is working when:

- `agentx setup` takes a new user from `npm i -g agentix-cli` to a working Telegram bot in **under 3 minutes** with zero file edits
- Every doc example in `docs/journey/` can be reproduced with only CLI commands (no "open `agentx.json` and add …" steps)
- The wiki-absorb pattern from this session — cron + onError + notify block — becomes a single `agentx schedule "daily at midnight" --agent devops --do wiki-absorb --notify me --on-error notify,disable`
- `agentx doctor` catches at least the 5 pitfalls we hit manually this quarter (bad token, stale mesh peer, cron stuck, .env drift, missing workspace)

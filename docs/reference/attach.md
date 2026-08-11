# Attach mode — wear an agent in the session you already have open

Normally AgentX owns the loop. A message arrives, the daemon spawns a `claude`
subprocess, feeds it a prompt, collects the result, replies on the channel.

Attach mode inverts that. A Claude Code session that is **already open** — the
one you are typing into — registers with the daemon and becomes addressable as
an agent. Channel traffic for that identity is offered to your session instead
of spawning anything.

AgentX keeps doing the part it is actually good at: identity, routing, memory,
guardrails, channels. The loop is the one already in front of you.

```bash
agentx attach install      # once per machine
agentx attach cx-agent     # inside a Claude Code session
```

## Why this exists

If you find yourself reaching for Claude Code by default and only opening
AgentX when you need Telegram or GitLab, attach mode is for you. The answer to
"my CLI chat surface is worse than Claude Code" is not to build a better REPL.
It is to stop having one.

## How it works

Your session's stdin belongs to you. Nothing can push into it. So the daemon
never initiates — it queues, and Claude Code's own hooks pull:

| Hook | What AgentX does with it |
|---|---|
| `SessionStart` | Register the session; tell it which identity it is wearing |
| `UserPromptSubmit` | Mention the backlog alongside *your* prompt. Never blocks it |
| `Stop` | The drain point — see below |
| `SessionEnd` | Deregister; anything queued falls back to spawned agents |

`Stop` does two things. First it **harvests**: if the session was handed a
message last turn, the text it just produced *is* the answer — Claude Code
passes it as `last_assistant_message`, so a reply costs no tool call and no
special prompting. Then it **decides** what happens next, according to the
session's delivery mode.

## Delivery modes

```bash
agentx attach cx-agent --mode notify
```

| Mode | Behaviour | Use it when |
|---|---|---|
| `manual` | Nothing ever interrupts you. Drain with `/inbox` | Deep work; you'll check when ready |
| `notify` *(default)* | A one-line note at the end of your turn | Normal use |
| `auto` | Takes the turn and answers until the inbox is empty | You're on call |

`auto` is the drain loop: `Stop` returns `{"decision":"block"}` with the next
message, the session answers, `Stop` fires again, and so on until nothing is
left. It is bounded by `maxDrainPerTurn` (default 5) so a burst of queued
messages cannot own an entire turn — when the budget runs out you get a note
saying how many are still waiting.

The default is `notify` on purpose. An attached session is a good **node**, not
necessarily a good **worker**: it should be addressable without hijacking your
context in the middle of a refactor.

## Nothing is lost, nothing is answered twice

This is the part that makes attach mode safe in front of production traffic.

```
inbound message → agent "cx-agent"
  │
  ├─ no session attached → spawn a provider, exactly as before
  │
  └─ session attached → queue it, start a 90s claim deadline
        ├─ session drains it  → it answers → reply goes to the channel
        └─ deadline passes    → atomically expired → spawn a provider
```

The expiry is atomic, so a session that drains late finds an empty inbox.
Attach is a **preference**, never a black hole: if you walk away mid-task, the
message is answered by a spawned agent the normal way, just 90 seconds later
than usual.

The same applies when you close the terminal (`SessionEnd`), when the session
goes quiet for 15 minutes, and when the daemon restarts.

## Commands

| Command | What it does |
|---|---|
| `agentx attach install [--port <n>] [--no-guard]` | Wire the hooks into `~/.claude/settings.json`. Once per machine |
| `agentx attach <agent> [--mode <m>]` | Bind this session to an identity |
| `agentx attach detach [--agent <id>]` | Stop wearing it; queued work falls back to spawning |
| `agentx attach list` (alias `status`) | Every attached session on this machine |
| `agentx attach uninstall [--remove-guard]` | Remove the hooks |

`--session <id>` is accepted everywhere. You should not need it: AgentX reads
`CLAUDE_CODE_SESSION_ID`, which Claude Code exports into the shell of every
Bash tool call, so `agentx attach cx-agent` binds the exact session it ran
inside. That variable is undocumented upstream, so the fallback stays.

## Answering from inside the session

Two MCP tools, available once `agentx serve` is wired in
([Journey 10](/journey/10-mcp-server)):

| Tool | Use |
|---|---|
| `agentx_attach_next` | Take the next queued message. Then just answer — the reply is captured automatically |
| `agentx_attach_answer` | Send a reply that differs from what you told the user in the terminal |

Both read the session id from the environment, never from the model, so a
session cannot drain or answer on behalf of a different one.

## Installing the hooks

`agentx attach install` writes to `~/.claude/settings.json` — **user** scope,
not an agent workspace — because the point is that any session you open can be
addressed. That sounds invasive; it isn't:

- The hooks are dumb pipes. They post to the daemon and forward what comes back.
- For any session that never runs `agentx attach`, the daemon has no binding and
  answers with an empty body, which Claude Code treats as "carry on".
- All state lives in the daemon. Attaching and detaching are runtime
  operations — no file edits, no session restart.
- Hooks belonging to other tools are preserved. Re-running replaces AgentX's own
  entries rather than stacking duplicates.
- If the daemon is down, every hook degrades to a no-op (`|| true`).

The port is read from `node.bind` in `agentx.json` rather than assumed — it
differs per install, and a hook aimed at the wrong port fails *silently*.

### The guard comes with it

`install` also lays down the `PreToolUse` guardrail hook at user scope, and you
have to pass `--no-guard` to prevent it.

An attached session runs under **your** permissions, not the agent workspace's
`.claude/settings.json`. Without a user-scope guard, an attached `clawd` would
be *less* protected than a spawned one — which is exactly the asymmetry the
[guardrails](/reference/guard) were built to close.

## Security

Every attach endpoint is **loopback-only**, like `/guard/check`. The responses
name agent identities and quote channel messages, and a bound session answers
as a production agent — none of that may leave the box.

Things worth knowing before you attach a production identity:

- **Replies go out for real.** Bind `clawd` and your answers appear in GitLab
  under that identity. `agentx attach list` shows who is wearing what.
- **Channel text enters your context.** Even in `notify` mode. Messages are
  clipped (`maxItemChars`, default 4000) and `manual` is always available.
- **One session per identity.** Binding an agent that another session holds
  moves it — which is what you want when you switch terminals.

## Tuning

Defaults live in `src/attach/types.ts` and are deliberately not config-file
knobs yet:

| Setting | Default | Meaning |
|---|---|---|
| `claimTimeoutMs` | 90s | How long a message waits before falling back to spawning |
| `staleSessionMs` | 15min | No hook events for this long ⇒ session treated as gone |
| `maxDrainPerTurn` | 5 | Messages one `auto` turn will answer |
| `maxItemChars` | 4000 | Longest message injected into your context |

## HTTP endpoints

All loopback-only. See [CLI reference](/reference/cli#http-endpoints).

| Endpoint | Purpose |
|---|---|
| `POST /attach/session-start` · `/prompt` · `/stop` · `/session-end` | Hook receivers |
| `POST /attach/bind` · `/detach` | Control plane (`agentx attach`) |
| `POST /attach/next` · `/answer` | Drain + reply (MCP tools) |
| `GET /attach/sessions` | Attached sessions and their inbox depth |

## Limits

- **Delivery is bounded by your turn boundaries.** A message arriving while you
  are mid-turn is seen when that turn ends, not the instant it lands. For
  sub-second response, don't attach — let the agent spawn.
- **Not for unattended work.** Crons, workflows and anything that must run at
  03:00 need a process AgentX controls. Attach mode is for the foreground.
  Both models coexist; attach only preempts while a session is bound.

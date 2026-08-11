---
title: "14. Wearable agents — be the agent, don't spawn one"
---

# 14. Wearable agents — be the agent, don't spawn one

> **Difficulty:** intermediate · **Time:** ~15 minutes

You're deep in a Claude Code session refactoring a parser. A client messages
your support agent on Telegram. Today that spawns a `claude` subprocess
somewhere, which answers with none of the context you have loaded and none of
the judgement you'd apply.

By the end of this journey, that message arrives *in the session you are
already in*, you answer it in one line, and the reply goes back to Telegram
under the agent's identity.

This is the inverse of everything else in AgentX. Elsewhere the daemon spawns
agents. Here, you *are* one.

## Install the hooks — once

```bash
agentx attach install
```

```
✓ Installed attach hooks in /Users/you/.claude/settings.json
  Events: SessionStart, UserPromptSubmit, Stop, SessionEnd → 127.0.0.1:18800
  PreToolUse guard installed at user scope.

Next: agentx attach <agent> inside a Claude Code session.
```

This writes to your **user** settings, so every Claude Code session on the
machine can be addressed. Nothing changes for sessions you don't attach: the
hooks ask the daemon, the daemon says "no binding", Claude Code carries on.

The guard hook rides along on purpose — see [why](/reference/attach#the-guard-comes-with-it).

## Wear an identity

Inside any Claude Code session:

```bash
agentx attach cx-agent
```

```
✓ This session is now wearing cx-agent (notify).
  You'll be told when messages arrive; run /inbox to answer them.
```

No restart. The hooks were already live; binding is a runtime call to the
daemon.

::: tip Start with a test agent
Bind a throwaway agent the first time. Replies from an attached session go out
for real — bind `cx-agent` and your answers appear in the customer's Telegram.
:::

## Take a message

Someone messages the agent. At the end of your next turn:

```
[agentx] 1 message waiting for cx-agent — run /inbox to answer.
```

Ask for it:

> take the message

Claude calls `agentx_attach_next`:

```
Message for "cx-agent" via telegram from bob:

Is the deploy done? Site looks stale on my end.

Answer as "cx-agent". Your reply is sent back to telegram verbatim.
```

You answer normally:

> Deploy finished 10 minutes ago. Stale view is CDN cache — hard-refresh and
> you'll see it. Purging the edge cache now.

That's it. Claude Code hands your text to the `Stop` hook as
`last_assistant_message`, AgentX captures it, and it lands in Bob's Telegram.
No tool call for the reply — you just answered.

## Going on call

For a stretch where you want messages handled without asking:

```bash
agentx attach cx-agent --mode auto
```

Now the `Stop` hook takes the turn: it blocks the stop, feeds in the next
message, you answer, it feeds the next, until the inbox is empty. Bounded at 5
per turn so a burst can't swallow your session.

Back to deep work:

```bash
agentx attach cx-agent --mode manual   # nothing interrupts you
agentx attach detach                   # hand it back to spawned agents
```

## What happens when you walk away

The honest failure mode, because it's the one that matters:

```
message → cx-agent
  └─ your session is attached → queued, 90-second claim deadline
        ├─ you drain it   → you answer
        └─ you don't      → expired → spawned agent answers it normally
```

Close the laptop mid-turn and Bob still gets a reply — 90 seconds later, from
a spawned agent, exactly as before attach mode existed. The expiry is atomic,
so if you come back and drain late, you find an empty inbox rather than
double-answering.

## Who's wearing what

```bash
agentx attach list
```

```
✓ Attach hooks installed  /Users/you/.claude/settings.json

  cx-agent  notify  empty  a3f2-…-9c1  ← this session
    /Users/you/work/parser

  devops-agent  auto  2 pending  7b41-…-2ef
    /Users/you/infra
```

## When not to use it

Attach mode is for the foreground. Delivery is bounded by your turn
boundaries, so:

- **Sub-second replies?** Don't attach. Let the agent spawn.
- **Crons, workflows, 03:00 jobs?** Those need a process AgentX controls.

Both models coexist. Attach only preempts while a session is bound, and every
message falls back to spawning the moment it isn't taken.

## Next

- [Attach reference](/reference/attach) — modes, tuning, security, endpoints
- [Guardrails](/reference/guard) — what stops an attached production identity
  doing damage
- [Journey 10 — MCP server](/journey/10-mcp-server) — the outbound direction:
  driving AgentX *from* Claude Code

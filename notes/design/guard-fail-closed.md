# Guard hook: when to fail closed (#1710), threat model and proposal

Status: **for review, nothing built.** The owner's comment on #1710 stopped the plain fix (`|| true` → deny) because it can lock sessions out. This note writes down the threat model and a proposal. Comment on #1710; building starts after the owner accepts a design.

Checked on main (`01dfa6ce`). All names below are made up: the agent `demo-agent`, the machine `studio`.

## In one paragraph

Every Bash, Write and Edit call in a `claude-code` workspace runs a guard hook. The hook asks the daemon (the AgentX background service) whether the call is safe. Today, when the daemon gives no answer, the hook says nothing, and Claude Code runs the call. Saying "deny" instead would be safer for agents, but the same hook also runs in sessions a person uses, including the one used to start the daemon again. The proposal: when the daemon does not answer, **check the call locally** with the same rules (`agentx guard check`) instead of skipping the check or refusing everything. Refuse outright only if the local check also fails, and only in sessions the daemon started.

## Where the hook is installed

| Where | Who reads it | Runs when the daemon is down? |
|---|---|---|
| `src/agents/workspace-setup.ts` (`guardHookCommand`) → `<workspace>/.claude/settings.json` | Agents the daemon starts **and** any person who opens Claude Code in that folder | Yes: a person's session, a detached cloud session (`src/agents/cloud-sessions.ts`, spawned `detached: true`), and an agent mid-turn during a restart |
| `src/attach/install.ts` (`guardHookEntries`) → `~/.claude/settings.json` | **Every** Claude Code session of that user on the machine | Yes, always; including the session used to repair or restart the daemon |
| `mcpGuardHookCommand` (#1698) | Only MCP servers with an `allowTools` list, in workspaces | Already fails closed; those tools are not needed to repair the daemon |

## Threat model

What the guard protects against: an agent running a destructive command (database reset, `dropdb`, a migration pointed at production) by mistake. The 2026-07-21 incident is the reference case. The guard is a safety net against accidents, not a boundary against a hostile local user: anyone with a shell on `studio` can edit `settings.json` or run the command without Claude Code.

Ways the check is skipped today (fail open):

1. **Daemon restarting** while a warm agent process or a detached session keeps running. Restarts are routine (`restart-when-idle`, updates), so this is the likeliest gap.
2. **Daemon slow**: `/guard/check` takes over 3 s on a loaded host.
3. **Daemon erroring**: a 5xx from a bug in the check path.
4. **Daemon stopped** while a person works in a workspace folder or uses an attached session.

Risks of failing closed everywhere (the owner's points):

- **Lock-out**: the user-scope attach hook would refuse every Bash call in every session while the daemon is down, including `agentx daemon start`.
- **Random denials** on a loaded host (case 2), which agents would read as policy decisions.
- A human in a workspace folder would be blocked from ordinary work whenever the daemon is stopped.

Not in scope: the Read tool (not matched by the hook), and the static `permissions.deny` list (Claude Code applies it without the daemon, but may skip it under `bypassPermissions`).

## Proposal

### 1. Local fallback instead of "no answer" (all hook sites)

On any curl failure (no listener, timeout, non-2xx with `curl -f`), run the same check locally:

```sh
out=$(curl -sf --max-time 3 ... '/guard/check?agent=demo-agent') && printf '%s' "$out" \
  || <node> <dist/cli.js> guard check --agent demo-agent --root <install root>
```

- `agentx guard check` already exists (`src/commands/guard.ts`), reads the same policy files under `.agentx/guardrails`, and always exits 0.
- The fast path is unchanged: one loopback curl, about 1 ms. `-sf` costs nothing extra on a 2xx.
- The fallback costs about 0.55 s per call (measured in a dev container: 532–616 ms over 5 runs), only while the daemon is not answering.
- `agentx daemon start` and ordinary commands are not destructive, so the local check allows them. This removes the lock-out without a hand-written allow list in shell.
- Cases 1–4 are all covered: the rules are evaluated, not skipped.

What the local check cannot do: steps that need the daemon, such as asking a person to confirm (`checkPayloadWithConfirmation`), the MCP allow list and per-task autonomy. Proposed rule: a verdict that needs confirmation becomes **deny** with a reason ("needs confirmation; the daemon is not answering, try again once it is"). A plain allow stays allow.

### 2. Refuse only if the fallback also fails, and only for daemon-started sessions

If the local check itself fails (node missing, `dist` moved during an update), the hook needs a last answer:

- **Daemon-started sessions**: deny with a readable reason. The daemon already sets `AGENTX_AGENT_ID` on every process it starts (`src/agents/runtime.ts`, `src/agents/claude-process-factory.ts`). Proposal: add a dedicated `AGENTX_GUARD=required` so the meaning is explicit, and have the hook deny only when it is set.
- **Everyone else** (a person in a workspace folder, the user-scope attach hook): allow, as today. A person setting the variable by hand only makes their own session stricter.

The shell is still arranged so the final command is `printf`, so the hook never exits 2 (curl uses exit 2 for its own start-up errors, and exit 2 from a hook blocks with no reason).

### 3. Attach hook

Gets step 1 only (local fallback). It never denies on its own failure, per the owner's comment.

## Alternatives considered

- **Plain fail closed** (the first fix, not merged): simplest, but locks out the repair session and denies at random under load.
- **Sentinel file** (`.agentx/daemon.pid` or a restart-window file): deny only while the daemon is "meant to be up". The pid file is removed on a clean stop but not after a crash, so a crashed daemon would lock sessions out until someone deletes it; a stale file is also hard to tell apart from a hung daemon in shell. Still possible as an extra signal on top of step 2.
- **Raise the timeout**: helps case 2 only, and makes every call during a restart wait longer.

## Questions for the owner

1. Is the local fallback (about 0.55 s, only while the daemon is not answering) acceptable, or should the fallback be a smaller dedicated script?
2. Is "needs confirmation → deny while the daemon is down" the right answer, or should it be allow-with-warning?
3. Should a daemon-started session deny when both checks fail (step 2), or is the local fallback enough on its own?
4. Should a person opening Claude Code in an agent's workspace folder be treated like the agent (fail closed), or like any other person (as proposed)?

## Acceptance (once accepted)

- Tests run the real hook command against a stand-in daemon for: no listener, timeout, HTTP 500, 2xx pass-through, empty 2xx (allow), and the fallback-also-fails case with and without `AGENTX_GUARD=required`.
- The hook never exits 2 in any case.
- The fast path is measured again on loopback (about 1 ms).
- The doc comments on `guardHookCommand` and `hookCommand` (attach) are corrected; the claim that "daemon down means there are no agent tool calls" is removed.
- `docs/reference/config-agents.md` gets an **If something is wrong** entry for the deny message.

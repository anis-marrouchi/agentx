# Guard hook: when to fail closed (#1710), threat model and proposal

Status: **for review, nothing built.** The owner's comment on #1710 stopped the plain fix (`|| true` → deny) because it can lock sessions out. This note writes down the threat model and a proposal. Comment on #1710; building starts after the owner accepts a design.

Revision 2 answers the review of the first version (9e6a6f47): restart sessions can no longer be locked out, the fallback runs the rules only, the time budget is written down, and a failed local check can be told apart from an allow.

Revision 3 answers the re-review of 903cf41e: the step 3 allow list covers the restart forms people actually type (`gui/$(id -u)`, `sudo systemctl`, `npx tsx … cli.ts`), and the hook timeout leaves room for node start-up on a loaded host.

Checked on main (`01dfa6ce`). All names below are made up: the agent `demo-agent`, the machine `studio`.

## In one paragraph

Every Bash, Write and Edit call in a `claude-code` workspace runs a guard hook. The hook asks the daemon (the AgentX background service) whether the call is safe. Today, when the daemon gives no answer, the hook says nothing, and Claude Code runs the call. Saying "deny" instead would be safer for agents, but the same hook also runs in sessions a person uses, including the one used to start the daemon again. The proposal: when the daemon cannot be reached, **check the call locally with the deterministic rules only** (no model call, no dialog). If the local check also fails, refuse, but only in sessions the daemon started, and never for the commands that start or restart the daemon.

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
5. **Daemon waiting on its own confirmation dialog** (existing bug, found in review). `checkPayloadWithConfirmation` opens a dialog with a 45 s timeout (`src/guard/service.ts:131`), but the hook's curl gives up after 3 s and `|| true` turns that into an allow. The call runs while the dialog is still on screen, and the click is never read.

Risks of failing closed everywhere (the owner's points):

- **Lock-out**: the user-scope attach hook would refuse every Bash call in every session while the daemon is down, including `agentx daemon start`.
- **Random denials** on a loaded host (case 2), which agents would read as policy decisions.
- A human in a workspace folder would be blocked from ordinary work whenever the daemon is stopped.

Not in scope: the Read tool (not matched by the hook), and the static `permissions.deny` list (Claude Code applies it without the daemon, but may skip it under `bypassPermissions`).

## What `agentx guard check` does today, and what the fallback needs

`runCheckFromStdin` (`src/guard/check.ts:142-177`) is not only the deterministic rules:

- After the rules, in `enforce` mode, it calls `assessRisk`. That asks the model seat for every Write and Edit (`classifyMutation` treats both tools as mutating, `src/guard/mutating.ts:126`) and for every Bash call with destructive syntax.
- If the seat says so, it opens `confirmDestructive`, a dialog with a 60 s default timeout. That outlives the 10 s hook; Claude Code drops a timed-out hook and runs the call.
- It catches every error and prints nothing (`check.ts:174-176`). Empty output means allow, so a broken check looks exactly like a pass.

The first version's figure (about 0.55 s) holds only for calls that skip the seat. So the fallback needs a CLI change:

**`agentx guard check --rules-only`**

- Runs `runGuard` (policy load + `evaluate` + audit row) and prints `decisionOutput`. No `assessRisk`, no seat call, no dialog, no network.
- An effective `ask` from the rules becomes **deny** with the reason "needs confirmation; the daemon is not answering, try again once it is" (the dialog is a daemon-only step).
- On any internal error, prints the fixed marker line `AGENTX_GUARD_ERROR` on stdout instead of nothing. Still exits 0.
- Carries its own deadline (`--deadline-ms`, default 3000). Past it, the process prints the marker and exits 0, so the fallback can never use up the hook's budget.

## Proposal

### 1. Hook shape and time budget (all hook sites)

The hook reads stdin once, tries the daemon, falls back to the rules-only check, and only then gives a last answer:

```sh
p=$(cat)
out=$(printf '%s' "$p" | curl -sf --connect-timeout 1 --max-time 55 ... '/guard/check?agent=demo-agent' 2>/dev/null) \
  && { printf '%s' "$out"; exit 0; }
out=$(printf '%s' "$p" | "$AGENTX_GUARD_CLI" guard check --rules-only --agent demo-agent --root <install root> 2>/dev/null) \
  && [ "$out" != "AGENTX_GUARD_ERROR" ] && { printf '%s' "$out"; exit 0; }
# step 2: last answer (see below); always ends in printf, never exit 2
```

The key change is `--connect-timeout 1` with a long `--max-time`. A daemon that is down or restarting refuses the connection at once, so the fallback starts within about 1 ms (at most 1 s if the port is filtered). A daemon that accepted the connection is up, so the hook waits for its answer, including a confirmation click. That fixes case 5, and it means curl giving up no longer gets read as "the daemon is down".

| Slot | Limit | What happens |
|---|---|---|
| curl connect | 1 s | Refused or no answer → go to fallback straight away |
| curl total | 55 s | Daemon answers: allow/deny/ask passed through, including a dialog answer. Non-2xx → fallback. No answer after 55 s (hung daemon) → fallback |
| daemon dialog | 45 s | Ends inside the curl's 55 s, so its answer is always read |
| node start-up of the fallback | ~0.5 s idle, several s loaded | Not inside `--deadline-ms`, which is measured once the process runs |
| rules-only fallback | 3 s (own deadline) | Prints the verdict, or `AGENTX_GUARD_ERROR` on error or deadline |
| step 2 | ~5 ms | Shell only |
| hook `timeout` | **75 s** (raised from 10) | Worst case is 55 + start-up + 3 + shell. That leaves about 17 s for node start-up and the shell, so Claude Code does not drop the hook even on a loaded host (dropping it would allow the call) |

Load dependence that remains: a call takes the fallback only when the daemon cannot be reached, gives an error, or hangs for 55 s. The deterministic verdict is the same on both paths. Only the seat and dialog step differs: on the fallback it is skipped, and a rules-level `ask` becomes deny. Denying is the safe direction, and the reason text makes clear it is a "daemon not answering" deny, not a policy one.

The cost: while the daemon is hung (accepts connections but never answers), each call waits 55 s before the fallback. A daemon that is down or restarting costs nothing extra. This is open question 5.

### 2. A CLI path that survives updates

The fallback cannot call `<release dir>/dist/cli.js`. On a host that runs one directory per release, updates switch and remove that directory, which is exactly when the fallback is needed. Build scope:

- On each start, the daemon writes the stable link `<AGENTX_HOME>/bin/agentx-guard` pointing to its own `node` + `cli.js`, replacing the old link in one atomic step. The hook calls that link (`$AGENTX_GUARD_CLI` above, written into the hook as a fixed absolute path).
- If the link is missing or broken (a release removed while the daemon is down), the hook tries `agentx` on `PATH`.
- If neither runs, the shell sees a non-zero exit (127 or similar). That counts as a failed check and leads to step 2, the same as the marker. The CLI exits 0 on every other path, so a non-zero exit always means it did not run.

### 3. Last answer when the local check fails too (daemon-started sessions only)

The local check counts as failed when it prints `AGENTX_GUARD_ERROR`, exits non-zero, or cannot be found.

- **Daemon-started sessions** (`AGENTX_GUARD=required`, a new variable set next to `AGENTX_AGENT_ID` in `src/agents/runtime.ts` and `src/agents/claude-process-factory.ts`): deny with a readable reason, **except a fixed allow list**:
  - Bash commands that, after trimming spaces, are exactly `agentx daemon start|restart|status`, `<path>/cli.js daemon start|restart|status` or `node <path>/cli.js daemon start|restart|status` (optionally `--when-idle`), `npx tsx <path>/cli.ts daemon start|restart|status`, `launchctl kickstart [-k] gui/<uid>/<label>`, `launchctl bootstrap|bootout gui/<uid> <plist>`, `systemctl --user start|restart|status <unit>`, `sudo systemctl start|restart|status <unit>`.
  - In the `gui/` argument, `<uid>` is digits, or exactly one of the tokens `$(id -u)` and `$UID`, as in `launchctl kickstart -k gui/$(id -u)/<label>`. The two tokens are accepted only there, as the whole `<uid>`.
  - Apart from those two tokens, the match is on the whole `command` string and allows only `[A-Za-z0-9_./~@:= -]`. Any other `$`, backticks, `;`, `&`, `|`, redirects or newlines are refused, so `agentx daemon start; dropdb x`, `launchctl kickstart -k gui/$(id -u)/x; dropdb y` and a `gui/` argument with backticks are refused. If the parse fails, the call is denied, which is the safe direction.
  - Any other restart form is not supported in this slot. The runbooks that tell agents how to restart the daemon use only the forms above.
  - Write and Edit are always denied in this slot.
- **Everyone else** (a person in a workspace folder, the user-scope attach hook): allow, as today. A person who sets the variable by hand only makes their own session stricter.

The shell always ends with `printf` and `exit 0`, so the hook never exits 2 (curl uses exit 2 for its own start-up errors, and exit 2 from a hook blocks with no reason).

### 4. Attach hook

Gets steps 1 and 2 (daemon, then rules-only fallback, same budget). It never denies on its own failure, per the owner's comment.

Policy without an agent id: the attach hook sends no `?agent=`, and the daemon route reads the agent only from that parameter (`src/daemon/index.ts:5568`). It does not look up the attached identity. So both paths already evaluate attached sessions with the install-wide policy (`loadPolicy(root, undefined)`: the catalog, `policy.yaml` and `environments/*.yaml`, no `agents/<id>.yaml`). The fallback changes nothing here. Per-identity policy for attached sessions would be a separate change.

### 5. Audit rows

Both paths write an audit row (`recordDecision`). A duplicate now only happens when the daemon hangs past 55 s and later finishes. That is rare, so we expect the duplicate and do not dedupe, and the audit table gets no new column.

## Alternatives considered

- **Plain fail closed** (the first fix, not merged): simplest, but locks out the repair session and denies at random under load.
- **Step 2 denies only the static `GUARDRAIL_DENY` classes**: never locks anyone out, but it adds little beyond `permissions.deny`, and it leaves Write/Edit open. The fixed allow list above denies by default and still lets the daemon be started.
- **Keep curl at 3 s and fix the dialog separately** (review item 3b): keeps today's fast fallback on a slow daemon, but leaves case 5 open and leaves the confirmation class dependent on load. The long `--max-time` with a short `--connect-timeout` fixes both in the same line, so this note puts it in this build (open question 5).
- **Sentinel file** (`.agentx/daemon.pid` or a restart-window file): deny only while the daemon is "meant to be up". The pid file is removed on a clean stop but not after a crash, so a crashed daemon would lock sessions out until someone deletes it.
- **Raise only the timeout**: helps case 2, and makes every call during a restart wait longer. Connection refusal is the better signal.

## Questions for the owner

1. Is the rules-only local fallback (about 0.55 s, only while the daemon cannot be reached) acceptable, or should the fallback be a smaller dedicated script?
2. Is "rules say ask → deny while the daemon is not answering" right, or should it be allow-with-warning?
3. Should a daemon-started session deny when both checks fail (step 3), or is the local fallback enough on its own?
4. Should a person opening Claude Code in an agent's workspace folder be treated like the agent (fail closed), or like any other person (as proposed)?
5. Is fixing the 3 s curl vs 45 s dialog mismatch (`--connect-timeout 1 --max-time 55`, hook timeout 60) part of this build, as proposed, or its own issue? The cost is up to 55 s per call while a daemon is hung.
6. Is the fixed allow list in step 3 (daemon start/restart/status through `agentx`, `cli.js`, `launchctl`, `systemctl --user`) the right set?

## Build scope (once accepted)

1. `agentx guard check --rules-only [--deadline-ms N]`: no `assessRisk`, no dialog, rules `ask` → deny, `AGENTX_GUARD_ERROR` marker on internal error or deadline, exit 0 always.
2. The daemon writes the stable `<AGENTX_HOME>/bin/agentx-guard` link on start.
3. One shared hook-command builder used by `guardHookCommand` and the attach `guardHookEntries`. It builds steps 1 and 3 (step 3 only in the workspace hook, active only with `AGENTX_GUARD=required`), with the fixed daemon start/restart allow list. Hook `timeout` 75.
4. `AGENTX_GUARD=required` set on daemon-started processes.
5. The doc comments on `guardHookCommand` and `hookCommand` (attach) are corrected; the claim that "daemon down means there are no agent tool calls" is removed. The comment on `guardHookEntries` (`src/attach/install.ts:56-58`) no longer says the daemon resolves the attached identity per call: `/guard/check` reads the agent only from `?agent=`.
6. `docs/reference/config-agents.md` gets an **If something is wrong** entry for both deny messages.

## Acceptance

Tests run the real hook command (the builder takes the budget as a parameter, so tests use small values) against a stand-in daemon:

- 2xx pass-through, empty 2xx (allow), HTTP 500 → fallback, no listener → fallback.
- **Slow stand-in daemon** (accepts the connection, answers after the curl `--max-time`) with a **slow fallback start** (the stand-in CLI sleeps before it runs, standing in for node start-up on a loaded host): the fallback runs, and the hook's total wall time stays under the hook `timeout`.
- Stand-in daemon that answers within `--max-time` but after 3 s: its answer is used (case 5).
- `--rules-only`: a Write makes no seat call and opens no dialog (the seat and dialog are stubbed to throw); a rules `ask` comes back as deny; an internal error prints the marker.
- Fallback fails (marker, missing CLI, broken link, `PATH` without `agentx`), with and without `AGENTX_GUARD=required`.
- **Required session, daemon down, CLI missing → `agentx daemon start` is allowed**; so are the other allow-list forms, including `launchctl kickstart -k gui/$(id -u)/<label>`, `launchctl kickstart -k gui/$UID/<label>`, `sudo systemctl restart <unit>` and `npx tsx <path>/cli.ts daemon restart`. Denied: `agentx daemon start; dropdb x`, `agentx daemon start && rm -rf ~`, `launchctl kickstart -k gui/$(id -u)/x; dropdb y`, a `gui/` argument with backticks (`` gui/`id -u`/x ``), a `gui/` argument with any other `$` (`gui/$(whoami)/x`, `gui/$HOME/x`), `$(id -u)` outside the `gui/` argument, `sudo systemctl stop <unit>`, a Write and an Edit.
- The hook never exits 2 in any case.
- The fast path is measured again on loopback (about 1 ms).

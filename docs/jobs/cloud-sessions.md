# Send coding tasks to Claude cloud sessions

Every agent run on your computer counts against your Claude plan. A Claude account can also hold a separate credit for **cloud sessions**: Claude Code working on a copy of your repository on a computer that Anthropic runs, started with `claude --cloud`, which you follow in a browser at claude.ai/code. Only cloud sessions draw on that credit.

With the setting on this page, an agent sends a coding task that arrives from GitHub to a cloud session instead of running it on your computer. The session does the work and opens a pull request. Your computer stays free, and the plan's weekly limit is not touched.

The setting is off until you turn it on, for one agent and for the GitHub channel. Here is the whole path:

![How a GitHub task becomes a cloud session: you keep a clone, point the project file at it and turn the setting on; an issue arrives, AgentX starts a session and comments its link on the issue; the session opens a pull request that you review](/diagrams/cloud-session.svg)

## What goes to the cloud, and what does not

- Only a task from the **GitHub channel** about an **issue or pull request**. A comment on an issue is one. A push, a Telegram message or a schedule is not: those run on your computer as before.
- Only when the agent's engine is `claude-code`, and when **this computer holds a clone** of that repository whose `origin` points at `github.com`. A repository that lives elsewhere, or that this computer has no clone of, runs locally.
- The result is a **pull request**, not a reply. AgentX posts one comment on the issue with the session's id and its link, and keeps both on the task's trace.
- While a session is open for an issue (24 hours by default), **no second run starts** for that issue. A new comment on the issue is forwarded to the session instead.
- When the launch fails, the task **runs on your computer** as before, and the reason is in the daemon log and on the trace.
- The cloud session reads the repository's own `CLAUDE.md`. It does not get the agent's system prompt, tool servers or local files.

## Before you start

1. **Terminal**, on the computer that runs the agent: run `claude --version`. You need a version that has the `--cloud` option; run `claude --help` and look for it.
2. **Terminal:** run `python3 --version`. AgentX uses Python's `pty` module to give `claude --cloud` the terminal it needs. It is on every Mac and on nearly every Linux system.
3. **Terminal:** run `claude` once and sign in with the account that holds the cloud credit, then leave with `/exit`.
4. **Browser:** make sure the [GitHub channel](/reference/config-channels#github) already works: an issue in the repository reaches the agent and gets a comment.

## Turn it on

1. **Terminal:** clone the repository on the computer that runs the agent, for example into `/home/you/repos/example-repo`:

   ```sh
   git clone git@github.com:example-org/example-repo.git /home/you/repos/example-repo
   ```

2. **Terminal:** create the **project file** for that repository, `.agentx/projects/example-org/example-repo.yaml` in the folder you run `agentx` from, and point `runbook` at the clone. Write the full path, not `~`:

   ```yaml
   project: example-org/example-repo
   channel: github
   runbook: /home/you/repos/example-repo
   ```

   The daemon reads project files on the fly: save, and the next event uses it. If the agent's own `workspace` is already that clone, you can skip this step.

3. **Terminal:** open `agentx.json` and turn the setting on for the agent and for the channel:

   ```json
   "agents": {
     "coder": {
       "name": "Coder",
       "workspace": "/path/to/coder-workspace",
       "tier": "claude-code",
       "cloudSessions": { "enabled": true }
     }
   },
   "channels": {
     "github": {
       "enabled": true,
       "cloudSessions": true,
       "routes": [{ "repo": "example-org/example-repo", "agent": "coder" }]
     }
   }
   ```

4. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.

## Settings

Under `agents.<id>.cloudSessions`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Sends this agent's GitHub issue and pull request tasks to cloud sessions. Needs `channels.github.cloudSessions` too. |
| `maxPerDay` | number | `0` | Most sessions this agent may start per day. `0` means no limit. Past the limit, tasks run on your computer. |
| `openHours` | number (1–168) | `24` | How long a started session counts as open: no local run starts for its issue, and comments are forwarded to it. |
| `launchTimeoutSeconds` | number (10–600) | `120` | How long `claude --cloud` may take to print the session before AgentX gives up and runs the task locally. |

Under `channels.github`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `cloudSessions` | boolean | `false` | Lets agents with `cloudSessions.enabled` send this channel's tasks to the cloud. Both must be on. |

## While a session is open

1. **Browser:** open the link in the comment on the issue to watch the session work.
2. **Browser:** to steer it, comment on the issue. AgentX forwards the comment to the session with `claude -p "<comment>" --cloud <session-id>` and answers with a short note.
3. When the session is done, review its pull request as you would any other.
4. After `openHours` have passed, the next comment on the issue starts a new task as usual.

To forget an open session before its time is up:

1. **Terminal:** run `agentx daemon stop`.
2. **Terminal:** open `.agentx/cloud-sessions.json` and remove the session's entry.
3. **Terminal:** run `agentx daemon start`.

## Check it worked

1. **Browser:** open a new issue in the repository, with a small, clear task.
2. **Browser:** within a minute or two the issue gets a comment from the agent that starts with "Started a Claude cloud session" and shows a session id and a claude.ai/code link.
3. **Terminal:** run `agentx trace list --agent coder --limit 1`, then `agentx trace show <taskId>` with the id it printed. The trace has a `cloud_session` step with the action `launched` and the same id and link.
4. **Browser:** open the link. The session is working on a copy of the repository, and later a pull request appears that references the issue.

## If something is wrong

- **The agent answered the issue itself, as before.** Both settings must be on: `cloudSessions.enabled` on the agent and `cloudSessions` on the GitHub channel. The agent's `tier` must be `claude-code`. Run `agentx trace show <taskId>`: the `cloud_session` step says why the task stayed local.
- **The trace says "no checkout of owner/repo on this node".** The project file's `runbook` path (or the agent's `workspace`) must be a clone whose `origin` is that repository on github.com. **Terminal:** run `git -C /home/you/repos/example-repo remote get-url origin` and compare.
- **The trace says "did not print a session within 120s" or "exited with code 1".** **Terminal:** go to the clone and run `claude --cloud "Say hello"` by hand. Sign in if it asks, and answer any question it asks once; AgentX cannot answer for you. A slow network needs a higher `launchTimeoutSeconds`.
- **The trace says "python3 is not installed".** That computer needs Python 3; AgentX uses it to give `claude --cloud` a terminal.
- **A second run started for the same issue.** The first session's `openHours` had passed, or `.agentx/cloud-sessions.json` was removed. Raise `openHours` if sessions take longer.
- **Too many sessions started.** `maxPerDay` caps them. Tasks past the limit run on your computer and the trace says "daily cap reached".

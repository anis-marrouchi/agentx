# Give each coding task its own worktree

Without this setting, every task an agent runs on an issue works in the same folder: the agent's **workspace**, or the clone of the repository it was pointed at. Two issues at the same time then mix their changes, and a task starts on whatever branch the last one left.

With the setting on, each issue gets a **worktree** of its own: a second folder of the same git repository, on its own **branch** (a line of commits), that git keeps in step with the clone. The clone itself is never switched, reset or cleaned. Every later task on the same issue reuses the same folder, so work in progress stays where it was.

This works for issues from GitHub, GitLab, [Linear and Jira](/jobs/linear-jira). It is off until you turn it on, for each agent.

## What it does, and what it does not

- **One folder and one branch per issue.** GitHub issue #12 gets the branch `agentx/issue-12`; Linear issue ENG-12 gets `agentx/eng-12`. The first task makes the branch from the repository's default branch (or from the same branch on the server, when an earlier task pushed it). The agent is told the folder and the branch, and to open its pull request from that branch.
- **Where the folders are.** Beside the clone, in `.agentx-worktrees/<clone name>/`. For a clone at `/home/you/repos/example-repo`, issue #12 is in `/home/you/repos/.agentx-worktrees/example-repo/issue-12`.
- **Which clone.** The project file's `runbook` path, else the agent's `workspace`. For a GitHub or GitLab issue its `origin` must be that issue's repository; for a Linear or Jira issue, the route's `checkout`.
- **Pull requests and merge requests are left as they are.** A review comment on one runs in the clone as before: that branch belongs to whoever opened it.
- **Old folders are cleaned up.** A worktree no task used for `maxAgeDays` (14 days by default) is removed, but only when it holds no uncommitted change. Its branch is kept, because it may hold work you pushed.
- **When a worktree cannot be made**, the task runs in the clone as before, and the daemon log says why.
- **The first task in a new worktree starts a fresh conversation** with Claude Code, which keeps its conversations per folder. Later tasks on the same issue continue it.
- The agent still gets its own settings and secrets (its `.env`) from its workspace. A warm process (`persistentProcess`) is not used for these tasks, because a running process cannot change folders.

## Before you start

1. **Terminal:** keep a clone of the repository on the computer that runs the agent, for example:

   ```sh
   git clone git@github.com:example-org/example-repo.git /home/you/repos/example-repo
   ```

2. **Terminal:** make sure the clone knows its default branch:

   ```sh
   git -C /home/you/repos/example-repo remote set-head origin --auto
   ```

3. **Terminal:** point the agent at the clone. Either set the agent's `workspace` to it, or create the **project file** `.agentx/projects/example-org/example-repo.yaml` in the folder you run `agentx` from, with the clone's full path:

   ```yaml
   project: example-org/example-repo
   channel: github
   runbook: /home/you/repos/example-repo
   ```

## Turn it on

1. **Terminal:** open `agentx.json` and add `worktrees` to the agent:

   ```json
   "agents": {
     "coder": {
       "name": "Coder",
       "workspace": "/path/to/coder-workspace",
       "tier": "claude-code",
       "worktrees": { "enabled": true }
     }
   }
   ```

2. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.

## Settings

Under `agents.<id>.worktrees`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Runs each of this agent's issue tasks in the issue's own worktree. |
| `root` | folder | `.agentx-worktrees/<clone name>` beside the clone | Where the worktrees are made. |
| `maxAgeDays` | number (1–365) | `14` | A worktree no task used for this many days, with no uncommitted change, is removed. Its branch stays. |

## Check it worked

1. **Browser:** open a new issue in the repository for the agent, or mention the agent in one.
2. **Terminal:** run `agentx daemon logs` and look for a line such as `[worktrees] coder example-org/example-repo#12: created … on agentx/issue-12`.
3. **Terminal:** run `git -C /home/you/repos/example-repo worktree list`. The issue's folder is listed with its branch.
4. **Terminal:** run `git -C /home/you/repos/example-repo status`. The clone is still on the branch it was on before.
5. **Browser:** comment on the same issue. The log now says `reusing` for the same folder.

## If something is wrong

- **The log says "running in the workspace: no checkout of …".** The clone's `origin` is not the issue's repository, or the agent is not pointed at the clone. Check `git -C <clone> remote get-url origin` and the project file's `runbook`.
- **The log says "could not create the worktree for agentx/issue-12: … is already checked out".** Someone switched the clone itself to that branch. **Terminal:** switch the clone back to its usual branch with `git -C <clone> switch main`; the next task makes the worktree.
- **The log says "… exists but is not on agentx/issue-12".** The folder was changed by hand. Commit or save what is in it, then remove it with `git -C <clone> worktree remove <folder>`.
- **A worktree you still need was removed.** Only clean ones are removed, and the branch is kept: the next task on the issue makes the folder again from that branch. Raise `maxAgeDays` to keep folders longer.
- **The agent edited the clone instead.** It is told to stay in its worktree; repeat that in the agent's instructions if it does not.

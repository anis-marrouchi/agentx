# Give each coding task its own worktree

Without worktrees, every task an agent runs on an issue works in the same folder: the agent's **workspace**, or the clone of the repository it was pointed at. Two issues at the same time then mix their changes, and a task starts on whatever branch the last one left.

With worktrees, each issue gets a **worktree** of its own: a second folder of the same git repository, on its own **branch** (a line of commits), that git keeps in step with the clone. The clone itself is never switched, reset or cleaned. Every later task on the same issue reuses the same folder, so work in progress stays where it was.

This works for issues from GitHub, GitLab, [Linear and Jira](/jobs/linear-jira), and for GitHub pull requests and GitLab merge requests. It is off until you turn it on, for each agent: turn it on for the agents that write code. It only takes effect when the agent has a clone of the issue's repository (see **Which clone** below). Without one, tasks run in the workspace as before.

## What it does, and what it does not

- **One folder and one branch per issue.** GitHub issue #12 gets the branch `agentx/issue-12`; Linear issue ENG-12 gets `agentx/eng-12`. The first task makes the branch from the repository's default branch (or from the same branch on the server, when an earlier task pushed it). The agent is told the folder and the branch, and to open its pull request from that branch.
- **Where the folders are.** Beside the clone, in `.agentx-worktrees/<clone name>/`. For a clone at `/home/you/repos/example-repo`, issue #12 is in `/home/you/repos/.agentx-worktrees/example-repo/issue-12`.
- **Which clone.** The project file's `runbook` path, else the agent's `workspace`. For a GitHub or GitLab issue its `origin` must be that issue's repository; for a Linear or Jira issue, the route's `checkout`.
- **Pull requests and merge requests run on their own branch.** A task on a pull request or merge request (a review, a comment) runs on that change's source branch, and the agent is told to push to it rather than open a new one. When a worktree already has that branch checked out, the task uses it: most often the issue's worktree the agent opened the change from. When the clone itself is on that branch, the task runs in the clone. Otherwise a new worktree is made beside the issue ones, `pr-<n>` (GitHub) or `mr-<n>` (GitLab), on a local branch that tracks the one on the server. A branch is never checked out in two folders.
- **Forks and unknown branches stay in the clone.** A change whose branch lives in another repository (a fork) runs in the clone, and the log says `fork`. So does one whose branch the event did not name (a GitHub comment on the pull request's conversation tab carries no branch); the log says `source branch unknown`.
- **Old folders are cleaned up.** A worktree no task used for `maxAgeDays` (14 days by default) is removed, but only when it holds no uncommitted change. Its branch is kept, because it may hold work you pushed.
- **Work already in progress stays where it is.** When you turn worktrees on, an issue the agent was already working on in the clone (it has a conversation to continue, or an open request on that issue) keeps running in the clone, so its work and branch stay in sight. The log says `in progress before worktrees`. Only new issues get a worktree, and an issue that already has one keeps using it.
- **When a worktree cannot be made**, the task runs in the clone as before, and the daemon log says why.
- **The first task in a new worktree starts a fresh conversation** with Claude Code, which keeps its conversations per folder. Later tasks on the same issue continue it. A pull request task that runs in the issue's worktree starts a fresh conversation each time, with the chat's recent history.
- **The agent signs its pull requests.** It is told to end each pull request or merge request description with `<!-- agentx:<agent id> -->`, so a failed CI run on it wakes the right agent.
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

## Turn it on for a coding agent

1. **Terminal:** open `agentx.json` and add `worktrees` to the agent that writes code:

   ```json
   "agents": {
     "coder-agent": {
       "name": "Coder",
       "workspace": "/path/to/coder-workspace",
       "tier": "claude-code",
       "worktrees": { "enabled": true }
     }
   }
   ```

2. **Terminal:** unless the agent's `workspace` is itself a clone of the repository, give the project file a `runbook:` line with the clone's full path (step 3 of **Before you start**):

   ```yaml
   project: example-org/example-repo
   channel: github
   runbook: /path/to/checkout
   ```

3. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.

To turn it off again, set `"enabled": false` or remove `worktrees`.

## Settings

Under `agents.<id>.worktrees`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Runs each of this agent's issue tasks in the issue's own worktree, and pull and merge request tasks on the change's branch. |
| `root` | folder | `.agentx-worktrees/<clone name>` beside the clone | Where the worktrees are made. |
| `maxAgeDays` | number (1–365) | `14` | A worktree no task used for this many days, with no uncommitted change, is removed. Its branch stays. |

## Check it worked

1. **Browser:** open a new issue in the repository for the agent, or mention the agent in one. Use a new issue: one the agent was already working on stays in the clone.
2. **Terminal:** run `agentx daemon logs` and look for a line such as `[worktrees] coder-agent example-org/example-repo#12: created … on agentx/issue-12`.
3. **Terminal:** run `git -C /home/you/repos/example-repo worktree list`. The issue's folder is listed with its branch.
4. **Terminal:** run `git -C /home/you/repos/example-repo status`. The clone is still on the branch it was on before.
5. **Browser:** comment on the same issue. The log now says `reusing` for the same folder.
6. **Browser:** have the agent open a pull request from the issue, then leave a review on it. The log says `reusing` the issue's folder on `agentx/issue-12`.

## If something is wrong

- **The log says "running in the workspace: no checkout of …".** The clone's `origin` is not the issue's repository, or the agent is not pointed at the clone. Check `git -C <clone> remote get-url origin` and the project file's `runbook`.
- **The log says "could not create the worktree for agentx/issue-12: … is already checked out".** Someone switched the clone itself to that branch. **Terminal:** switch the clone back to its usual branch with `git -C <clone> switch main`; the next task makes the worktree.
- **The log says "… exists but is not on agentx/issue-12".** The folder was changed by hand. Commit or save what is in it, then remove it with `git -C <clone> worktree remove <folder>`.
- **The log says "running in the workspace: fork …" or "source branch unknown".** Expected for a change from a fork, or an event that names no branch: the task runs in the clone.
- **The log says "running in the workspace: in progress before worktrees (session)" or "(open request)".** Expected for an issue the agent was already working on in the clone when worktrees were turned on. Its next new issue gets a worktree.
- **A worktree you still need was removed.** Only clean ones are removed, and the branch is kept: the next task on the issue makes the folder again from that branch. Raise `maxAgeDays` to keep folders longer.
- **The agent edited the clone instead.** It is told to stay in its worktree; repeat that in the agent's instructions if it does not.

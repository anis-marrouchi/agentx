# Dev team on GitLab

**Result:** Issues you assign on GitLab come back as merge requests with a second agent's review, and each weekday morning you see what is stuck.

**First result:** the next weekday at 08:30, the morning digest of what is stuck. The first merge request comes back once you assign an issue to `dev`.

## Who is in the team

| Agent | What it does |
|---|---|
| `dev` | Turns an issue assigned to it into a small merge request with a test, then asks for a review. Never merges. |
| `reviewer` | Reviews every merge request it is asked to, line by line, and approves or lists what must change. Never merges. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `dev-morning-digest` | Monday to Friday, 08:30 | Merge requests waiting for you, reviews open for more than two days, and assigned issues with no merge request yet. |

## Install it

1. Run `agentx team add dev-team` in the folder that holds your `agentx.json`.
2. Run `agentx channel add`, choose GitLab, and route your project to `dev`.
3. Add the webhook it prints to your GitLab project.

Point each agent's workspace (`agents/dev`, `agents/reviewer`) at a clone of your repository so they can read and change the code.

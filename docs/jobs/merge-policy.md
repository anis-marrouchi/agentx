# Let agents merge only changes at the edges

Some folders hold the heart of a project: the code everything else depends on. Others sit at the edges: documentation, examples, small add-ons. A mistake at the edge is cheap; a mistake in the core is not.

The **merge policy** lets you say which folders are **core** and which are **edge**. A pull request (a proposed change on GitHub) that only touches edge files merges on its own once the automatic tests (CI) pass, as before. A pull request from an agent that touches a core file waits until **a person approves it**. Its status shows on the pull request as a check named `agentx/merge-policy`, and the pull request gets a `core-change` label.

The policy is off until you turn it on, and it has no folders until you list them. Here is the whole path:

![How the merge policy sorts a pull request: you list your core folders, turn the policy on and make agentx/merge-policy a required check; when an agent opens or pushes to a pull request, AgentX reads the changed files; an edge-only pull request gets success and merges on green CI; a pull request that touches core is labeled core-change and stays pending until you approve its latest commit, then turns green; a new push asks for a new approval](/diagrams/merge-policy.svg)

## How a pull request is sorted

- Every changed file is checked against your lists. If **any** file is core, the whole pull request is core. A renamed file counts at its old path too, so moving a file out of a core folder is a core change.
- **Core paths** (`corePaths`) are always core, even when an edge pattern matches the same file.
- **Edge paths** (`edgePaths`) are optional:
  - Not set: every file that is not under a core path is edge.
  - Set: a file under **neither** list is core. A new folder then needs a person until you file it as edge.
- A pull request that changes more files than GitHub will list (3,000) is treated as core.
- Patterns: a folder name covers everything inside it (`src/core`). `*` stays inside one folder, `**` crosses folders (`plugins/**/manifest.json`).

## What the status says

| Status | When |
|---|---|
| **success** "edge only" | No core file changed. Auto-merge works as before, once CI passes. |
| **pending** "needs … human approval" | An agent's pull request touches core and no person has approved its latest commit yet. A merge waits. |
| **pending** "changes requested by …" | A person asked for changes. Their later approval clears it. |
| **success** "approved by …" | A person approved the latest commit. |
| **success** "opened by a person" | A person opened the pull request. It is still labeled `core-change`. |
| **error** "check failed: …" | GitHub did not answer, so the files are unknown. An error is never shown as a success. |

Full CI still runs on every pull request, edge or core. This status is one more check; it never replaces the others.

## Who can approve

An approval counts only when all of these are true:

- It approves the pull request's **latest commit**. A new push asks for a new approval, so an approval never covers code the person did not see.
- It comes from a person with write access to the repository (owner, member or collaborator), or from a login in `approvers` when you set that list.
- It is not from the pull request's author, a bot, or an account AgentX posts with.

A person's latest review is the one that counts. A review with only a comment changes nothing; a dismissed review cancels that person's earlier approval.

::: warning Agents need their own GitHub account
If your agents post with **your** personal token, their pull requests look like yours, and GitHub does not let you approve your own pull request. Connect AgentX through its GitHub App instead, so agent pull requests come from the App's own account. See [GitHub channel](/reference/config-channels#github).
:::

## Before you start

1. **Browser:** make sure the [GitHub channel](/reference/config-channels#github) already works: an issue in the repository reaches an agent and gets a comment.
2. **Browser:** on GitHub, open the AgentX GitHub App's settings, then **Permissions**. Give it **Commit statuses: Read and write** and **Issues: Read and write** (labels live there). With a personal token instead, it needs the `repo` scope.
3. **Browser:** in the repository's **Settings › Webhooks**, open the AgentX webhook and make sure **Pull requests** and **Pull request reviews** are both ticked.

## Turn it on

1. **Terminal:** open `agentx.json` and add your core folders under `quality.mergePolicy`. The folders below are examples; use your own:

   ```json
   "quality": {
     "mergePolicy": {
       "enabled": true,
       "corePaths": ["src/core", "src/auth/**", "package.json"]
     }
   }
   ```

2. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.
3. **Browser:** in the repository's **Settings › Branches**, edit the rule for your main branch and add `agentx/merge-policy` to the required status checks. Until you do, the status shows but does not stop a merge.

## Settings

Under `quality.mergePolicy`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Turns the policy on. Off, no status or label is posted. |
| `corePaths` | list of patterns | `[]` | Files and folders that need a person's approval. |
| `edgePaths` | list of patterns | `[]` | Files and folders agents may merge on their own. Empty: everything not in `corePaths`. Set: a file under neither list is core. |
| `label` | text | `"core-change"` | Label put on pull requests that touch core, and taken off when a push leaves only edge files. `""`: no label. |
| `requiredApprovals` | number (1–10) | `1` | How many people must approve the latest commit of a core agent pull request. |
| `approvers` | list of GitHub logins | `[]` | Only these people's approvals count. Empty: anyone with write access. |

## Check it worked

1. **Browser:** have an agent open a pull request that only changes an edge file, such as a page under `docs/`.
2. **Browser:** open the pull request's checks list. `agentx/merge-policy` shows **success** with "edge only: merges on green CI", and there is no `core-change` label.
3. **Browser:** have an agent open a pull request that changes a file under one of your `corePaths`.
4. **Browser:** the pull request gets the `core-change` label, and `agentx/merge-policy` shows **pending** with the core file it found.
5. **Browser:** click **Files changed**, then **Review changes**, choose **Approve** and click **Submit review**.
6. **Browser:** within a few seconds `agentx/merge-policy` turns **success** with "approved by" and your login.

## If something is wrong

- **No `agentx/merge-policy` status at all.** Check that `quality.mergePolicy.enabled` is `true` and that the webhook sends **Pull requests** events. **Terminal:** look for `[merge-policy]` lines in the daemon log.
- **Every pull request shows "edge only".** `corePaths` is empty or does not match. Paths start at the repository root, without a leading `/`: `src/core`, not `/src/core`.
- **You approved, but the status stays pending.** Your approval is for an older commit (approve again after the latest push), or you are the author, or your login is not in `approvers`. Also check that the webhook sends **Pull request reviews** events.
- **A core pull request merged without an approval.** `agentx/merge-policy` is not a required check yet. Add it in **Settings › Branches**.
- **The log says "could not add label … 403".** The App or token cannot write labels. Give it **Issues: Read and write**. The status is posted anyway.
- **Error "check failed: …".** GitHub did not answer. **Browser:** edit the pull request's description, or push a new commit, to check again.
- **The status says "opened by a person" on an agent's pull request.** AgentX did not recognise the author as an agent: it posts with a personal token you also use yourself. Connect AgentX through its GitHub App.

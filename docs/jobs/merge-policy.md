# Let agents merge only edge changes

Some folders of a codebase are its **core**: the parts where a mistake breaks everything else, such as the engine, the database schema or the security checks. Other folders are **edges**: pages, docs, tests and small tools, where a mistake stays small.

The **merge policy** lets agents keep merging edge changes as soon as the checks pass, and makes a change to the core wait for a person. You decide which paths are core. Until you list some, nothing is core and nothing changes.

## What it does

For each pull request (a proposed change on GitHub), AgentX reads the list of changed files and posts a status named `agentx/merge-policy` on its latest commit:

| The pull request | Status | Description starts with |
|---|---|---|
| changes no core path | **success** | "edge only" |
| changes a core path and a person approved it | **success** | "core paths changed … approved by …" |
| changes a core path and was opened by a person | **success** | "core paths changed … opened by …" |
| changes a core path, no approval yet, **required** mode | **pending** | "core paths changed … waiting for a person" |
| changes a core path, no approval yet, **advisory** mode | **success** | "[advisory] core paths changed" |

- A pull request that changes a core path also gets a **label**, `core-change` unless you choose another, so you can find these in the pull request list. The label comes off again when a later push no longer touches a core path.
- Every pull request still runs the full CI (the automatic tests GitHub runs). The policy adds a check; it never skips one.
- The policy never merges anything and never changes your branch settings. The status only blocks a merge once you make it a required check (below).

## How a person approves

An approval belongs to one commit. A new push needs a new approval.

- **On GitHub:** an **Approve** review on the latest commit, from someone other than the pull request's author and other than the accounts AgentX posts with. If you set `approvers`, only those logins count. A later "Request changes" or a dismissed review takes the approval back.
- **On your approvals card:** in required mode, AgentX also raises a card for you (the same cards as in [Approvals](/dashboard/approvals)) that asks whether to approve the pull request at that commit. **YES** approves it; within about a minute the status turns green. This is the way to approve when one GitHub account opens every pull request, because GitHub does not let an author approve their own pull request.

## Before you start

1. **Browser:** make sure the [GitHub channel](/reference/config-channels#github) already works: an issue in the repository reaches an agent and gets a comment.
2. **Browser:** on GitHub, open the AgentX GitHub App's settings, then **Permissions**. Give it **Commit statuses: Read and write**, **Pull requests: Read** and **Issues: Read and write** (labels are issue labels). With a personal token instead, it needs the `repo` scope.
3. **Browser:** in the repository's **Settings › Webhooks**, open the AgentX webhook and tick **Pull requests** and **Pull request reviews**.

## Turn it on

1. **Terminal:** open `agentx.json` and add your core paths under `quality.mergePolicy`. Start in `advisory` mode. The paths below are only an example; list your own:

   ```json
   "quality": {
     "mergePolicy": {
       "enabled": true,
       "mode": "advisory",
       "corePaths": ["src/engine/**", "src/auth/**", "db/migrations/**"],
       "edgePaths": ["src/engine/fixtures/**"]
     }
   }
   ```

   `*` stays inside one folder, `**` crosses folders, and a folder name on its own covers everything under it. A file that matches `edgePaths` is edge even inside a core folder.

2. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.
3. **Browser:** open or push to a pull request and look at its checks list.

### From advisory to required

In advisory mode a core change is marked but never held. Run it like this for a few days to see which pull requests count as core, and adjust the paths.

To make core changes wait for a person, once the repository owner agrees:

1. **Terminal:** set `"mode": "required"` in `agentx.json` and restart the daemon.
2. **Browser:** in the repository's **Settings › Branches**, edit the rule for `main` and add `agentx/merge-policy` to the required status checks. Turn on **Do not allow bypassing the above settings**, or an admin account (which agents may use) can merge anyway.

## Settings

Under `quality.mergePolicy`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Turns the policy on. Off, no status or label is posted. |
| `mode` | `"advisory"` or `"required"` | `"advisory"` | Advisory passes an unapproved core change with "[advisory]". Required leaves it **pending** until a person approves. |
| `corePaths` | list of patterns | `[]` | Files that count as core. Empty: nothing is core, every pull request is "edge only". |
| `edgePaths` | list of patterns | `[]` | Exceptions carved out of `corePaths`. |
| `label` | text | `"core-change"` | The label put on a core pull request. |
| `approvers` | list of GitHub logins | `[]` | Only these logins' approvals count. Empty: anyone but the author and AgentX's own accounts. |
| `ownerCard` | boolean | `true` | In required mode, raise an approvals card for each unapproved core commit. |

## Check it worked

1. **Browser:** have an agent open a pull request that changes only an edge file. Its checks list shows `agentx/merge-policy` green with "edge only".
2. **Browser:** have an agent open a pull request that changes a core file. It gets the `core-change` label, and `agentx/merge-policy` reads "core paths changed" with the file names.
3. **Required mode:** the status is pending, and a card "Core change waiting: …" is in your approvals. Answer **YES**. Within about a minute the status turns green with "approved by".
4. **Browser:** push a new commit to that pull request. The status is pending again and a new card asks about the new commit.

## If something is wrong

- **No `agentx/merge-policy` status.** Check that `quality.mergePolicy.enabled` is `true` and that the webhook sends **Pull requests** events. Drafts are skipped until they are marked ready. **Terminal:** look for `[merge-policy]` lines in the daemon log.
- **The log says "check failed: GitHub POST …/statuses/…: 403".** The App or token cannot write commit statuses. Give it **Commit statuses: Read and write**.
- **The log says "label failed".** The App or token cannot write labels. Give it **Issues: Read and write**. The status is still posted.
- **A GitHub approval does not turn the status green.** The approval must be on the latest commit, from someone who is not the author and not an AgentX account, and the webhook must send **Pull request reviews** events. If `approvers` is set, the login must be in it.
- **No card in required mode.** `ownerCard` may be `false`, or the agent routed to the repository already has the most cards waiting allowed. The log says "owner card not raised" and why. Approve on GitHub, or answer older cards first.
- **Every pull request is "edge only".** `corePaths` is empty, or its patterns do not match. Paths are relative to the repository root, without a leading `/`.
- **A core change was merged anyway.** The status is only advisory until `agentx/merge-policy` is a required check on the branch and admins cannot bypass it.

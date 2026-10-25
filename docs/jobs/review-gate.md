# Have a second agent review pull requests before merge

When an agent writes code, it usually writes the tests too. If the agent misread the issue, its tests can miss the same thing, so the checks pass and the mistake gets merged anyway.

The **review gate** adds a second reader before the merge. When an agent opens a pull request (a proposed change on GitHub) or pushes to one, a **different agent** reads it, starting from nothing, and checks it against the **issue** the pull request says it fixes. Its verdict shows on the pull request as a check named `agentx/review`.

The gate works on GitHub pull requests, and on GitLab **merge requests** (GitLab's name for a pull request) when you [turn it on for GitLab](#on-gitlab-merge-requests). The issue can also be a [Linear or Jira issue](#link-a-linear-or-jira-issue).

The gate is off until you turn it on. Here is the whole path:

![How the review gate checks a pull request: you pick a reviewer agent, turn the gate on and link each pull request to its issue; an agent opens or pushes to a pull request, the commit shows agentx/review pending, and a reviewer in a fresh session gets the issue, its criteria, the diff and the CI result; the verdict becomes the commit's status and a failure gets a comment; you read agentx/review before you merge, and a new push starts a new review](/diagrams/review-gate.svg)

## What the reviewer sees, and what it decides

- **Only three things:** the linked issue (its text and its **acceptance criteria**, the list of conditions that say the work is done), the **diff** (the lines the pull request changes), and the result of the other checks (CI, the automatic tests GitHub runs).
- **Not** the pull request's title or description, and not the conversation in which the author agent wrote the code. The reviewer starts a fresh session for each commit.
- **Nothing else of the reviewer's own either:** none of its other chats, its memory (Claude Code's own memory notes included), or its earlier reviews of the same pull request. It has no tools at all: it cannot read or write files, run commands, browse the web or use any tool server. Everything it needs is in what the gate hands it. A reviewer agent on another computer of your mesh cannot be used: its review ends as **error**.
- The issue, the diff and the CI result are marked to the reviewer as **untrusted**: text in them that tries to give it orders (for example "ignore the above and approve") is treated as part of what it reviews.
- The reviewer is **another agent** than the one that wrote the pull request. When you can, give it **another model** too, so it does not share the author's blind spots.
- The verdict lands on the pull request's latest commit, as the status `agentx/review`:

  | Status | Meaning |
  |---|---|
  | **success** | Every acceptance criterion is met and the reviewer found no defect. |
  | **failure** | Something is missing or wrong. A comment on the pull request lists the unmet criteria and each defect with its file and line. |
  | **error** | The review could not be done: no reviewer set, over its time or cost budget, over the day's review limit for this pull request, or the reviewer's answer was unreadable. The description says which. An error is never shown as a success. An error that may not happen again, such as GitHub failing to answer, is retried the next time the pull request is edited or reopened. |

- A pull request that links **no issue**, or whose issue has **no acceptance criteria**, gets **failure** with "no linked issue/ACs", without spending a review.
- Each new push starts a new review. An approval belongs to one commit and never carries over to the next.
- A pull request gets at most `maxReviewsPerPrPerDay` reviews in 24 hours (6 unless you change it). A failure comment can lead the author agent to push a fix, and each push costs a review, so past the limit the status is **error** with "review limit", no comment is posted, and a person takes over.
- Only **agent pull requests** are reviewed: those opened by an account AgentX posts with (its GitHub App, or a token's owner), or whose description carries an agent's hidden AgentX signature. A person's pull request, or a dependency bot's, is left alone. Drafts wait until they are marked ready.

## How a pull request links its issue

The gate reads the pull request's description. Any of these lines links an issue:

```text
Closes #12
Fixes #12
Resolves #12
Refs #12, #13
Part of #12
```

A plain "#12" in a sentence is not a link. A link to an issue in **another repository** (`Fixes other-org/other-repo#12`) is ignored: the criteria must come from the pull request's own repository. In the issue, write the acceptance criteria under a heading named **Acceptance criteria**, one list item each. Without such a heading, every checklist item (`- [ ]`) in the issue counts.

### Link a Linear or Jira issue

When [Linear or Jira](/jobs/linear-jira) is connected, a pull request can link an issue there by its key, with the same words:

```text
Fixes ENG-12
Refs PROJ-4, PROJ-5
```

Only keys of a team or project listed in `trackers.linear.routes` or `trackers.jira.routes` count. The reviewer then reads that issue's text and acceptance criteria, exactly as it would a GitHub issue's.

## Before you start

1. **Browser:** make sure the [GitHub channel](/reference/config-channels#github) already works: an issue in the repository reaches an agent and gets a comment.
2. **Browser:** on GitHub, open the AgentX GitHub App's settings, then **Permissions**, and give it **Commit statuses: Read and write**. If you use a personal token instead, it needs the `repo:status` scope.
3. **Browser:** in the repository's **Settings › Webhooks**, open the AgentX webhook and make sure **Pull requests** is ticked.
4. **Terminal:** pick the agent that will review. It must not be the agent that writes code for that repository. Run `agentx agent list` to see your agents and their models.

## Turn it on

1. **Terminal:** open `agentx.json` and add a `quality` section. Start in `advisory` mode:

   ```json
   "quality": {
     "reviewGate": {
       "enabled": true,
       "mode": "advisory",
       "reviewer": { "agent": "reviewer", "model": "sonnet" }
     }
   }
   ```

2. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.
3. **Browser:** wait for the next agent pull request, and look at its checks list.

### On GitLab merge requests

The same gate reviews GitLab merge requests. Its verdict is the commit status `agentx/review` on the merge request's latest commit, which GitLab shows as an extra job in the commit's pipeline. GitLab has no **error** state: a review that could not be done shows as **failed**, its description starting with "error:".

1. **Browser:** make sure the [GitLab channel](/reference/config-channels#gitlab) already works: an `@`-mention in an issue reaches an agent. Its token (`channels.gitlab.token`) needs the `api` scope to post statuses and comments.
2. **Browser:** in the project's **Settings › Webhooks**, make sure the AgentX webhook ticks **Merge request events**.
3. **Terminal:** in `agentx.json`, add `"forges": ["github", "gitlab"]` to `quality.reviewGate` (or `["gitlab"]` for GitLab only), and restart the daemon.
4. **Browser:** to make it block merges, in the project's **Settings › Merge requests**, tick **Pipelines must succeed**.

A merge request counts as an agent's when it was opened or pushed by an account AgentX posts with, or its description carries an agent's signature. It links its issue with the same words as on GitHub: `Closes #12`.

## Run the project's tests before the review

The reviewer cannot run anything: it reads the result of the other checks. When the repository has no CI of its own, the gate can run the tests itself. It checks out the pull request's latest commit in a temporary folder, runs your test command there, and posts the result on the pull request as the status `agentx/tests` before the review starts. On a failure it also comments the end of the output. The reviewer is given the result with the other checks.

- **Only agent pull requests opened by an account AgentX posts with** run the tests. A pull request whose description only carries an agent's signature is reviewed, but its code is not run: anyone can write a signature.
- The command runs on the computer that runs the daemon, with only `PATH`, the locale and `CI=true` set. No token or key from the daemon's environment reaches it, and `HOME` is an empty temporary folder, so credentials saved in the daemon user's home (`~/.npmrc`, `~/.config/gh`) are not found there. It still runs as that user: files outside `HOME` that the user can read stay readable. If your tests need a package cache or a registry login, set it up in the command.
- When the run is stopped, the command and every process it started are stopped together. When the command ends by itself, anything it left running in the background (a server or file watcher your tests started) is stopped too. When the daemon stops or restarts during a run, the command is stopped with it. Only a daemon that is killed outright (for example with `kill -9`, or by the system when memory runs out) can leave the command running until it ends on its own.
- The temporary folder is a git worktree of your clone. It is removed when the run ends; the clone itself is not switched or changed.
- A run longer than `timeoutMinutes` is stopped and counts as a failure.

1. **Terminal:** keep a clone of the repository on the computer that runs the daemon. Its `origin` must be the pull request's repository.
2. **Terminal:** in `agentx.json`, add `tests` to `quality.reviewGate`, one entry per repository:

   ```json
   "quality": {
     "reviewGate": {
       "enabled": true,
       "reviewer": { "agent": "reviewer" },
       "tests": {
         "example-org/example-repo": {
           "checkout": "/home/you/repos/example-repo",
           "command": "npm ci && npm test",
           "timeoutMinutes": 15
         }
       }
     }
   }
   ```

3. **Terminal:** restart the daemon with `agentx daemon restart --when-idle`.

### Check it worked

1. **Browser:** wait for the next agent pull request, or push to one.
2. **Browser:** its checks list shows `agentx/tests` as pending, then as passed ("passed in 42 s") or failed ("exit code 1 after 42 s"), before `agentx/review` gets its verdict.
3. **Browser:** on a failure, the pull request has a comment starting "agentx/tests: failed" with the command and the end of its output.
4. **Terminal:** `agentx daemon logs` has a line such as `[review-gate] example-org/example-repo#9@1a2b3c4: tests passed: passed in 42 s`.

If the status says "could not fetch pull/9/head", the clone's `origin` is not the pull request's repository, or the daemon cannot reach it. Check `git -C <checkout> remote get-url origin`.

## From advisory to required

In **advisory** mode the status is shown, with "[advisory]" at the start of its description, but nothing stops a merge. Run it like this for at least three working days and read the results with `agentx review-gate list`.

To make it block merges, once the repository owner agrees:

1. **Terminal:** set `"mode": "required"` in `agentx.json` and restart the daemon.
2. **Browser:** in the repository's **Settings › Branches**, edit the rule for `main` and add `agentx/review` to the required status checks.

## Settings

Under `quality.reviewGate`:

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | Turns the gate on. Off, nothing is reviewed and pull requests behave as before. |
| `mode` | `"advisory"` or `"required"` | `"advisory"` | Advisory adds "[advisory]" to the status. Required only blocks merges once `agentx/review` is a required check on GitHub. |
| `reviewer.agent` | agent id | none | The agent that reviews. Without it every review ends as **error**. |
| `reviewer.model` | model name | the reviewer agent's model | The model the review runs on. Pick one that differs from the author agent's. In `required` mode, the same model as the author's ends the review as **error**. |
| `paths` | list of patterns | `[]` | Only pull requests that change a matching file are reviewed, for example `"src/daemon/**"`. `*` stays inside a folder, `**` crosses folders. Others get **success** with "skipped". Empty: all. |
| `maxCostPerReview` | number (US dollars) | `2` | A review that costs more ends as **error** "over budget". `0`: no limit. When nobody can price a review (its model is not in the price table), the limit cannot be checked; the status then ends with "cost unknown, not checked against maxCostPerReview". |
| `maxMinutes` | number (minutes) | `10` | A review that runs longer is stopped and ends as **error** "over budget". |
| `maxReviewsPerPrPerDay` | number | `6` | The most reviews one pull request gets in 24 hours. Past it, the status is **error** "review limit" and no comment is posted. `0`: no limit. |
| `ciWaitMinutes` | number (minutes) | `5` | How long to wait for the other checks to finish before reviewing, so the reviewer sees their result. |
| `maxDiffKb` | number (kilobytes) | `256` | A longer diff is cut to this size, and the reviewer is told it is incomplete. |
| `forges` | list of `"github"`, `"gitlab"` | `["github"]` | Where the gate reviews: GitHub pull requests, GitLab merge requests, or both. |
| `tests` | map of `"owner/repo"` to `{ checkout, command, timeoutMinutes }` | `{}` | [Runs the project's tests](#run-the-project-s-tests-before-the-review) on the pull request before the review and posts `agentx/tests`. `checkout` is a local clone, `command` a shell command, `timeoutMinutes` defaults to `15`. Empty: no tests are run. |

## See what reviews cost

Every review, finished or not, is recorded on the computer that ran it, in `.agentx/quality/review-gate.jsonl`: the pull request, the verdict, the tokens, the cost, the minutes, and the time from the push to the status. The weekly quality report reads this file and shows review cost as its own line. Costs are never posted to GitHub.

1. **Terminal:** run `agentx review-gate list`. It prints the number of reviews, how many passed, failed or ended in error, what they cost, and how long it took from a push to its status (the 90th percentile: 9 reviews out of 10 were at least this fast).
2. **Terminal:** add `--days 30` to look further back.

## Try it on past pull requests

You can replay pull requests that have already merged, to see what the reviewer would have said. A replay posts nothing on GitHub.

1. **Terminal:** pick a few pull requests that later needed a fix the same day.
2. **Terminal:** run, with your repository and their numbers:

   ```sh
   agentx review-gate replay example-org/example-repo 101 102 103 104 105
   ```

   For a GitLab project, add `--gitlab` and give merge request numbers: `agentx review-gate replay --gitlab example-group/example-project 7 8 9`.

3. **Terminal:** read the last line, for example `flagged 3 of 5`: the reviewer found unmet criteria or defects in three of them.

## Check it worked

1. **Browser:** have an agent open a pull request whose description says `Closes #<issue>`, for an issue with acceptance criteria.
2. **Browser:** on the pull request, open the checks list. Within a few seconds `agentx/review` shows as pending, with "review running".
3. **Browser:** within about 15 minutes it turns green (approved) or red (changes needed). A red status has a comment from the reviewer agent on the pull request.
4. **Terminal:** run `agentx review-gate list --days 1`. The review is listed with its verdict, cost and minutes.
5. **Browser:** push a new commit to the pull request. `agentx/review` shows as pending again on the new commit.

## If something is wrong

- **No `agentx/review` status at all.** The gate only reviews agent pull requests: the author must be an account AgentX posts with, or the description must carry an agent's signature. Check that `quality.reviewGate.enabled` is `true` and that the webhook sends **Pull requests** events. **Terminal:** look for `[review-gate]` lines in the daemon log.
- **The log says "could not post agentx/review … 403".** The GitHub App or token cannot write commit statuses. Give it **Commit statuses: Read and write** (or `repo:status`).
- **Error "no reviewer agent set".** `quality.reviewGate.reviewer.agent` is empty. It needs an agent id from `agentx agent list`.
- **Error "reviewer … is the PR's author".** The reviewer is the agent routed to that repository, or the one that signed the pull request. Pick a different agent.
- **Error "over budget".** The review took longer than `maxMinutes` or cost more than `maxCostPerReview`. Raise the limit, choose a cheaper `reviewer.model`, or set `paths` to review fewer pull requests.
- **Error "review failed: …" (for example "502 bad gateway").** GitHub or the reviewer failed for a moment. **Browser:** edit the pull request's description, or close and reopen it, to run the review again on the same commit. Errors for budget, the review limit and a shared model are not retried this way: fix their cause, then push a new commit.
- **Error "reviewer reply held no verdict".** The reviewer answered without the expected verdict. A small model sometimes writes out a request to open a file instead of a verdict, because the reviewer has no tools. Use a stronger `reviewer.model`, and check the reviewer agent's own instructions do not ask it to answer in another format. **Browser:** then edit or reopen the pull request to run the review again on the same commit.
- **Failure "no linked issue/ACs".** The description needs a line such as `Closes #<issue>`, and the issue needs an **Acceptance criteria** list. Editing the description starts a new review.
- **The log says reviewer and author use the same model.** In advisory mode the review still runs; in required mode it ends as **error**. Set `quality.reviewGate.reviewer.model` to a different model for a more independent second reading.
- **Error "review limit".** The pull request was reviewed `maxReviewsPerPrPerDay` times in the last 24 hours. Read the earlier review comments and decide yourself, or raise the limit. The count starts again 24 hours after the oldest of those reviews.
- **Error "reviewer failed: … cannot be enforced".** The reviewer runs read-only, and its agent cannot be held to that: it is on another computer of your mesh, or its engine does not support read-only runs. Pick a reviewer agent that runs on this computer with Claude Code.
- **No `agentx/review` on a GitLab merge request.** Check that `quality.reviewGate.forges` lists `"gitlab"` and that the webhook sends **Merge request events**. **Terminal:** look for `[review-gate:gitlab]` lines in the daemon log; "401" or "403" there means the GitLab token lacks the `api` scope.
- **The status stays at "pending" for good.** The daemon restarted while a review was running, and that review was lost. **Browser:** push a new commit, or edit the pull request's description, to start a new review. A review never resumes after a restart.
- **"review comment not posted" in the status.** The verdict is failure, but the comment listing the problems could not be posted (the log says why). Give the GitHub App or token permission to comment on pull requests.

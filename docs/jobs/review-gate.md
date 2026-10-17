# Have a second agent review pull requests before merge

When an agent writes code, it usually writes the tests too. If the agent misread the issue, its tests can miss the same thing, so the checks pass and the mistake gets merged anyway.

The **review gate** adds a second reader before the merge. When an agent opens a pull request (a proposed change on GitHub) or pushes to one, a **different agent** reads it, starting from nothing, and checks it against the **issue** the pull request says it fixes. Its verdict shows on the pull request as a check named `agentx/review`.

The gate is off until you turn it on. Here is the whole path:

![How the review gate checks a pull request: you pick a reviewer agent, turn the gate on and link each pull request to its issue; an agent opens or pushes to a pull request, the commit shows agentx/review pending, and a reviewer in a fresh session gets the issue, its criteria, the diff and the CI result; the verdict becomes the commit's status and a failure gets a comment; you read agentx/review before you merge, and a new push starts a new review](/diagrams/review-gate.svg)

## What the reviewer sees, and what it decides

- **Only three things:** the linked issue (its text and its **acceptance criteria**, the list of conditions that say the work is done), the **diff** (the lines the pull request changes), and the result of the other checks (CI, the automatic tests GitHub runs).
- **Not** the pull request's title or description, and not the conversation in which the author agent wrote the code. The reviewer starts a fresh session for each commit.
- The reviewer is **another agent** than the one that wrote the pull request. When you can, give it **another model** too, so it does not share the author's blind spots.
- The verdict lands on the pull request's latest commit, as the status `agentx/review`:

  | Status | Meaning |
  |---|---|
  | **success** | Every acceptance criterion is met and the reviewer found no defect. |
  | **failure** | Something is missing or wrong. A comment on the pull request lists the unmet criteria and each defect with its file and line. |
  | **error** | The review could not be done: no reviewer set, over its time or cost budget, or the reviewer's answer was unreadable. The description says which. An error is never shown as a success. |

- A pull request that links **no issue**, or whose issue has **no acceptance criteria**, gets **failure** with "no linked issue/ACs", without spending a review.
- Each new push starts a new review. An approval belongs to one commit and never carries over to the next.
- Only **agent pull requests** are reviewed: those opened by an account AgentX posts with (its GitHub App, or a token's owner), or whose description carries an agent's hidden AgentX signature. A person's pull request, or a dependency bot's, is left alone. Drafts wait until they are marked ready.

## How a pull request links its issue

The gate reads the pull request's description. Any of these lines links an issue:

```text
Closes #12
Fixes example-org/example-repo#12
Resolves #12
Refs #12, #13
Part of #12
```

A plain "#12" in a sentence is not a link. In the issue, write the acceptance criteria under a heading named **Acceptance criteria**, one list item each. Without such a heading, every checklist item (`- [ ]`) in the issue counts.

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

### From advisory to required

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
| `reviewer.model` | model name | the reviewer agent's model | The model the review runs on. Pick one that differs from the author agent's. |
| `paths` | list of patterns | `[]` | Only pull requests that change a matching file are reviewed, for example `"src/daemon/**"`. `*` stays inside a folder, `**` crosses folders. Others get **success** with "skipped". Empty: all. |
| `maxCostPerReview` | number (US dollars) | `2` | A review that costs more ends as **error** "over budget". `0`: no limit. |
| `maxMinutes` | number (minutes) | `10` | A review that runs longer is stopped and ends as **error** "over budget". |
| `ciWaitMinutes` | number (minutes) | `5` | How long to wait for the other checks to finish before reviewing, so the reviewer sees their result. |
| `maxDiffKb` | number (kilobytes) | `256` | A longer diff is cut to this size, and the reviewer is told it is incomplete. |

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
- **Error "reviewer reply held no verdict".** The reviewer answered without the expected verdict. Use a stronger `reviewer.model`, and check the reviewer agent's own instructions do not ask it to answer in another format.
- **Failure "no linked issue/ACs".** The description needs a line such as `Closes #<issue>`, and the issue needs an **Acceptance criteria** list. Editing the description starts a new review.
- **The log says reviewer and author use the same model.** The review still runs, but a different `quality.reviewGate.reviewer.model` makes it a more independent second reading.

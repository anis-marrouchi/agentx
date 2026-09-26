# Review what your agents learn

Agents get better over time because AgentX lets them remember. There are three kinds of memory, and each has a place where you stay in control:

- **Facts:** after every reply, AgentX notes useful facts from the conversation ("deploys happen on Tuesdays") and reminds the agent of them later.
- **Memories:** notes an agent writes for itself on purpose, such as a rule you gave it.
- **Lessons:** every night, AgentX suggests which memories are worth sharing with *all* agents, as articles in the shared wiki (a knowledge base every agent reads).

This page shows how to review each one. Everything here happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`.

## What AgentX never keeps

- **Passwords, tokens and keys.** If a conversation contains one, it isn't saved as a fact, even when someone asks.
- **Facts from public channels without your approval.** Anyone can write to a public web chat, so facts from there wait for you before any agent sees them. Facts from your own tools, your team's chats, GitLab and GitHub are used straight away.

## 1. Approve or reject facts from public channels

1. See which facts are waiting:
   ```sh
   agentx memory facts held
   ```
   Each one shows its agent, an ID, where it came from, and the fact itself.
2. Let one be used:
   ```sh
   agentx memory facts approve <id> --agent <agent>
   ```
   Or keep it out for good:
   ```sh
   agentx memory facts reject <id> --agent <agent>
   ```
3. For an overview of every agent's facts by source, run `agentx memory facts summary`.

## 2. Remove passwords stored before this protection

Older versions of AgentX could store a password or token as a fact. Those are no longer shown to agents, but they may still be on disk.

1. Count them:
   ```sh
   agentx memory facts scrub
   ```
2. Delete them:
   ```sh
   agentx memory facts scrub --apply
   ```

## 3. Approve the lessons proposed for the shared wiki

Every night, `agentx wiki promote --commit` reads what agents have learned and suggests lessons for the shared wiki. Nothing is written to the wiki until you approve it.

1. See the suggestions:
   ```sh
   agentx wiki proposals list
   ```
   Each one says whether it's a new article or a change to an existing one, and which agents back it.
2. Read one, with the evidence behind it:
   ```sh
   agentx wiki proposals show <id>
   ```
   The evidence lists the memories it came from, who wrote each one and when, and, for problems that keep coming up, in how many separate sessions they appeared.
3. Add it to the wiki:
   ```sh
   agentx wiki proposals approve <id>
   ```
   If someone changed that article after the suggestion was made, AgentX stops so you don't overwrite their change. Read the article, then approve with `--force` if the suggestion should still win.
4. Or turn it down, with a note for later:
   ```sh
   agentx wiki proposals reject <id> --reason "too specific to one client"
   ```
   A rejected suggestion isn't offered again unless the memories behind it change.

To preview what tonight's run would look at, without asking the judge or writing anything, run `agentx wiki promote`.

## 4. Undo a change to an agent's memory

Every time a memory is changed or deleted, the previous version is kept (the last 20 of each). Use the daemon's web address, on port 18800 by default:

1. List the saved versions of a memory:
   ```sh
   curl -s 'http://localhost:18800/api/memory/no-mock-db/versions?agent=ops-agent'
   ```
2. Put one back, using its `id` from the list:
   ```sh
   curl -s -X POST 'http://localhost:18800/api/memory/no-mock-db/restore?agent=ops-agent' \
     -H 'Content-Type: application/json' -d '{"version":"<id>"}'
   ```
   This works for deleted memories too. The version you replace is kept, so a restore can be undone the same way.

Each memory also records who wrote it: the agent and the task it was working on, or `unverified` when that couldn't be checked. An agent can only change its own memories.

<!-- No screenshot: every step here is a terminal command. -->

## Check it worked

1. `agentx memory facts scrub` reports `0 fact(s) contain credentials`.
2. `agentx memory facts held` lists nothing you haven't decided on.
3. After you approve a lesson, `agentx wiki proposals list --all` shows it as `approved`, and the article is in the shared wiki under `.agentx/wiki/`.
4. After a restore, the memory's `versions` list includes the version you replaced.

## If something is wrong

- **`approve` says the article changed since this proposal:** someone edited it after the suggestion was made. Read both, then approve with `--force` or reject.
- **`approve` says the proposal is already approved or rejected:** it was decided earlier. Check `agentx wiki proposals list --all`.
- **No proposals ever appear:** check that the nightly `wiki promote --commit` job is switched on (`agentx schedule list`) and that agents have saved memories recently.
- **A fact you expected isn't used:** it may come from a public channel and be waiting in `agentx memory facts held`, or it contained a password or token and was never kept.
- **`restore` answers `no such version`:** list the versions again and copy the `id` exactly.
- **Memory changes are refused with `403`:** the request named a task from another agent. Each agent can only change its own memories.

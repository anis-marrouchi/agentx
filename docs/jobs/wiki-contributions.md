# Let agents keep the wiki up to date

The shared wiki is the knowledge base every agent reads. Until now only one nightly job wrote it, from saved conversations. It missed what agents check while they work: a bill that was paid, a server that moved, a phone number found in the address book.

With **daily contributions** switched on, each agent you choose looks back once a day at its own work and suggests small additions to the wiki:

- **Add:** one fact a page is missing, such as a phone number or a due date.
- **Correct:** a page states an old value; the agent gives the new one.
- **Create:** a short page for a person, client, project or invoice that has none.

Every suggestion names where the agent checked it (a system, a command or a person) and when. An agent can't rewrite a page: the suggestions have no room for one, because rewrites are what lose facts.

Once a day, one **merge** applies everyone's suggestions:

- When two suggestions disagree, the one checked most recently wins. The older value stays on the page as "previously" and in the page's history.
- When an older check disagrees with what the wiki already holds, nothing changes and a question waits for you in `agentx wiki questions`.
- Several suggestions for a new page with the same name become one page.
- A page the merge creates is readable by every agent, like the lessons in the shared wiki. Don't switch this on for an agent whose work is private to it.
- A new page whose name is close to an existing page's, such as "Tax Payment Plan Engagement 4471" next to "Tax Payment Plan", is **held** as a possible duplicate, with its facts, so you can choose.
- A change that would remove a phone number, an email, a role, a "main contact" note, a link or a number is **held** for you to decide.

Everything on this page happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`. It is off until you switch it on.

## Switch it on for an agent

1. **Terminal:** run `agentx wiki contribute enable <agent>`, with the id of the agent from `agentx.json`. For example:

   ```bash
   agentx wiki contribute enable support-agent
   ```

2. Repeat step 1 for each agent that should take part.
3. **Terminal:** run `agentx schedule list`. Two new daily jobs appear: `wiki-contribute` (the agents look back at their day, 22:40 UTC by default) and `wiki-contribute-merge` (the suggestions are applied, 23:20 UTC by default).

To switch an agent off again, run `agentx wiki contribute disable <agent>`. When no agent is on, the two jobs go away.

## Set the limits

Each agent's run stops at whichever limit it reaches first:

- **30 suggestions** per run;
- **$0.50** of model use per run (each call is also capped at what is left);
- **60 pieces of work** read per run (chat messages and tasks). What is left is read the next day.

To change them for one agent:

1. **Terminal:** set the cost limit, in dollars:

   ```bash
   agentx config set agents.support-agent.wiki.contribute.maxCostUsd 0.3
   ```

2. **Terminal:** set the suggestion limit:

   ```bash
   agentx config set agents.support-agent.wiki.contribute.maxPatches 20
   ```

`config set` saves `agentx.json` and tells the running daemon to read it again.

You can also pass the limits when switching it on: `agentx wiki contribute enable support-agent --max-cost 0.3 --max-patches 20`.

## Change when it runs

1. **Terminal:** set when the agents look back at their day, as a schedule (minute, hour, day of month, month, day of week). This example is 21:30:

   ```bash
   agentx config set wiki.contributions.schedule "30 21 * * *"
   ```

2. **Terminal:** set when the merge runs, here 22:00:

   ```bash
   agentx config set wiki.contributions.mergeSchedule "0 22 * * *"
   ```

3. **Terminal:** set the time zone both times are in:

   ```bash
   agentx config set wiki.contributions.timezone Europe/Paris
   ```

4. **Terminal:** run `agentx schedule list` and check the two jobs show the new times.

Leave at least 30 minutes between the two, so every agent has finished before the merge starts.

## Try it by hand first

1. **Terminal:** preview what one agent would suggest, without saving anything:

   ```bash
   agentx wiki contribute --agent support-agent --dry-run
   ```

2. Read the list. Each line shows the kind (add, correct, create), the page, the fact, the source and the date it was checked.
3. **Terminal:** run it for real: `agentx wiki contribute --agent support-agent`.
4. **Terminal:** preview the merge: `agentx wiki contributions merge --dry-run`.
5. **Terminal:** apply it: `agentx wiki contributions merge`.

## Decide on held suggestions

1. **Terminal:** run `agentx wiki contributions held`. Each line shows an id, the agent, the page, what would change and why it was held.
2. If the change is right, run `agentx wiki contributions approve <id>`. The page's previous version is kept in its history.
3. If it is wrong, run `agentx wiki contributions reject <id>`.

## Agents also search each other's pages

An agent's wiki search (`agentx wiki query`, and the `agentx_wiki_query` tool agents use) used to read only that agent's own pages. It now also reads other agents' pages it is allowed to see, and the shared lessons. The answer says which agent's page it used and how recent it is, and prefers the newer page when two disagree.

- The agent's own pages come first. Other agents' pages take at most half of the pages one answer reads, so they can't push the agent's own pages out. When the agent has fewer pages on the subject than that, other agents' pages fill the slots left.
- For each page the search picks, it also opens up to 3 of the newest pages that link to it, by its title or by another name it goes by. A decision about a person, for example, is found from the person's page.

To search only an agent's own pages, add `--own-only`. To switch shared search off for everyone, run `agentx config set wiki.query.shared false`.

## Measure the difference

To see whether the wiki got better, score it against questions you know the answers to.

1. Write a question file, one question per line, each with the facts a right answer must contain:

   ```json
   {"id": "q1", "question": "What is the billing contact's phone number at Example Ltd?", "expect": ["+1 555 0100"]}
   {"id": "q2", "question": "Is invoice 1001 paid?", "expect": ["paid"]}
   ```

   Keep this file outside the AgentX folder if it holds real names or numbers.

2. **Terminal:** score it and save the result:

   ```bash
   agentx wiki score --agent support-agent --questions questions.jsonl --out before.json
   ```

3. A week later, run step 2 again with `--out after.json`.
4. **Terminal:** compare the two: `agentx wiki score --compare before.json after.json`. Each question that changed shows its old and new score and the facts it gained or lost.

Each saved score also records:

- the settings the run used: how pages were picked, `linkedPages`, `linkedChars`, whether the live read and the notes were on, and the models of each way of picking pages (each question records which way answered it);
- how long each question took, and what its model calls cost in dollars. Cost is known only for the summaries method. A question answered another way, or one with a model call that failed or reported no cost, shows `?`.

The comparison starts with the time and cost per question of each run, and a `changed:` line that lists each setting that differs, such as `linkedPages: 0 → 2`. To learn what one setting does, change only that one between the two runs. The comparison warns you when more than one setting changed, or when the two runs asked different questions.

To measure what one setting changes, run step 2 twice, the same day and with the same question file, changing only that setting. For example:

- shared search: once with `--own-only`, once without;
- linked pages: once with `--method summaries --linked 0`, once with `--method summaries --linked 2`.

## `wiki patch` refuses to lose facts

`agentx wiki patch` (and the `agentx_wiki_patch` tool) asks a model to make one small edit to a page. It now refuses to save, and shows why, when the result:

- is much shorter than the page was;
- contains the model's own commentary, such as "Here is the updated article";
- repeats a heading;
- drops a phone number, email, role, "main contact" note, link or number.

It also refuses when the page changed while the patch was being made, so two patches at once can't undo each other, and it keeps the page's existing related links. If the change really is meant to remove something, run the patch again with `--allow-fact-loss`.

## Check it worked

1. **Terminal:** run `agentx wiki contributions`. You see how many suggestions are waiting, and what the last merge did: facts applied, pages updated and created, questions raised and suggestions held.
2. Open a page the merge updated. At the bottom, a **Checked facts** section lists each fact with its source, check date and the agent that checked it.
3. **Terminal:** run `agentx wiki facts list`. The same facts appear, with where, when and by whom they were checked.
4. **Terminal:** after two scored runs, run `agentx wiki score --compare before.json after.json`. Under the scores you see a `before:` and an `after:` line with the time and cost per question, and a `changed:` line that names the setting you changed.

## If something is wrong

- **`No agent has wiki.contribute.enabled`:** switch an agent on with `agentx wiki contribute enable <agent>`.
- **`no trace database … reading chat turns only`:** the command ran outside the folder the daemon runs from, so it couldn't read the agents' tasks. Run it from the folder that holds `agentx.json`, or pass `--db <path>`.
- **A run says `stopped at max-cost` every day:** the agent has more work than its limit covers. Raise `maxCostUsd` for that agent, or accept that the rest is read the next day.
- **The merge lists a subject with more than one page:** two agents wrote a page for the same thing. Merge them by hand in the wiki, and add the other name to the page you keep as an alias.
- **A suggestion is held as "possible duplicate of …":** read both. If they are the same thing, reject the suggestion and correct the existing page with `agentx wiki patch`. If they are different, approve it and the new page is created.
- **A suggestion is held with "the contributing agent cannot read this page":** the page is private to another agent. Share it with that agent, or approve the suggestion yourself.
- **The comparison says `More than one setting changed`:** the runs differ in more than the setting you meant to test, so the change in score can't be put down to it. Run both again with only that setting changed.
- **The comparison says `what changed between the runs is unknown`:** one report was saved by an earlier version, which did not record its settings. Run it again.
- **`claude: command not found`:** the daily job calls the `claude` command. Install it, or see [If something is wrong](/reference/cli-commands#if-something-is-wrong) in the command reference.

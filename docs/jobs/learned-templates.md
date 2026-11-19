# Learn templates from ended talks

![Once a week AgentX reads counts about the talks that ended, with no messages or names, and a model drafts up to three templates. The approver agent you named reads each draft once and says yes or no. You get one message. A template with a yes is used only on a talk where you name it. A no, or no approver, and the draft is never used.](/diagrams/learned-templates.svg)

A **template** says what kind of talk a chat is (a meeting with an outside party, a hand-off, a change on a live system) and adds a few sentences to your agent's `[Situation]` line for it. AgentX ships a small list of them; see [Templates](/jobs/stop-goodbye-loops#templates-what-kind-of-talk-it-is).

With this feature on, AgentX also **learns** templates from your own talks. Once a week it looks at the talks that ended, and a model proposes a few new templates, for example "Interview with a candidate: ask what the candidate expects as next steps before the talk ends". Each proposal is a **draft**. An agent you name, the **approver**, reads each draft once and says yes or no. Nothing learned is used before that yes.

The rules:

- It is **off** until you switch it on, and it needs an approver. Without one, drafts wait and nothing is used.
- A learned template can only add sentences: one per phase of the talk, and one line on what the closing note must hold. It is built on one of the shipped templates (`meeting`, `meeting.external`, `job.production`, `hand-off`) and keeps that template's closing steps. It can never hold a message, send one, choose where a note goes, give a task to anyone, set a due date or change any other rule. There is no place in a draft to write those, and a check refuses text that asks for them.
- The check also refuses links (also written as "dot com" or with `[.]`), digits and numbers written as words (except "one"), addresses, quotes, markdown, invisible or direction characters, letters outside the Latin alphabet, words that look like a name, words that claim someone's authority ("the owner says", "boss", "the user wants", "already approved"; the plain word "owner" is fine) and words that read like an order to the system (such as "ignore", "approve", "tool"). The check works on words. Whether a rule is a good idea is for the approver to judge.
- A learned template is used only on a talk **you** name it on (`agentx situation closing --template learned.<name>`), and only while `situations.templates.enabled` is on. AgentX keeps your pick sealed: a template name written onto a talk any other way (by an agent's tool, or straight into the database) is not used.
- Its sentences reach your agent **in quotes**, marked "Learned from past talks and approved, a suggestion", so they never read as your words or as AgentX's.
- It costs at most **$2 a week on each machine** (each AgentX node has its own limit), counted inside that machine's daily self-improvement budget (`improve.dailyUsd`). Before each model call, AgentX checks that the call fits both limits; if it does not, the run stops there. On a Claude subscription these dollars are what the calls would cost at API prices, as the command-line tool reports them, not money charged.
- You can take a learned template back at any time.

## What the model and the approver see

The drafting model never sees a message. For each talk that ended in the last 4 weeks it gets only:

- the talk's template, how it ended (closed, stale, by a person), how long it lasted and how much it mattered. Each must be one of its known values; anything else is sent as `other`;
- how many messages the goodbye gate held, for what reason, and from which **kind** of sender (person, bot or agent). A reason with a word the check refuses is sent as `other`;
- the lower-case words of the talk's purpose that at least 3 of the talks share (`minEvidence`). A word with a capital letter, a digit, an address or a link is left out, and so is any word in a script without capitals (such as Arabic), because it could be a name. A word only one or two talks have is left out too: a name written in lower case is rarely shared by that many talks. A word the check refuses (such as "ignore" or "approve") is left out however many talks share it.

No name, number, chat, sender or message text leaves your machine for this. The approver reads the draft and those same counts, in quotes, as outside text. The counts it reads are the ones saved with the draft when it was made, not read again from the talks later.

## Settings

All settings are under `situations.learned` in `agentx.json`.

| Setting | Default | What it does |
|---|---|---|
| `situations.learned.enabled` | `false` | `true` installs the weekly workflow `situation-learn` (at the next daemon start) and uses approved learned templates. `false` uses none, even approved ones. |
| `situations.learned.model` | `opus` | The model that writes the drafts, once a week. |
| `situations.learned.maxRunUsd` | `2` | Dollars one week's run may spend, drafts and reviews together. At most 2. |
| `situations.learned.windowDays` | `28` | How many days of ended talks the run reads (7 to 30). |
| `situations.learned.minEvidence` | `3` | How many ended talks a draft must come from. |
| `situations.learned.maxDrafts` | `3` | Drafts one run may propose (1 to 5). |

The approver is not a setting in `agentx.json`: you name it with `agentx situation learned approver <agent>` (below), which needs your operator key. Not named: drafts wait, and nothing learned is used.

It also needs `improve.enabled` (the self-improvement budget, see [Failure signals](/jobs/failure-signals)), and `situations.templates.enabled` to use a template on a talk.

## Turn it on

1. **Terminal:** in the AgentX folder, switch the self-improvement budget on: `agentx config set improve.enabled true`. Its daily limit is `improve.dailyUsd` ($3 unless you changed it).
2. **Terminal:** switch templates on: `agentx config set situations.templates.enabled true`.
3. **Terminal:** name the approver, an agent on this machine: `agentx situation learned approver <agent>`. It answers `<agent> now approves or turns down learned drafts`. Run it in the AgentX folder on the daemon's machine: it sends your operator key. If you name another approver later, templates the old one approved are no longer used.
4. **Terminal:** switch learning on: `agentx config set situations.learned.enabled true`.
5. **Terminal:** restart the daemon so the weekly workflow is installed: `agentx daemon restart`. The log says `Situations: installed workflow(s) situation-learn`.

The workflow runs every Monday at 04:00 UTC. It appears on the **Workflows** page as `situation-learn`, with its runs. AgentX drafts at most once in 6.5 days, however the workflow is started.

How the approver answers: for each draft AgentX makes one model call in the approver's name, on the approver's Claude model (or `situations.learned.model` if the approver runs another provider). The call gets the draft and a fixed set of approver rules, and nothing else: no tools, no memory, and nothing from the approver's folder (not its `CLAUDE.md`, not its `.claude/settings.json`, no hooks). AgentX reads the answer itself. The answer must be exactly one `{"verdict": …, "why": …}` object; anything else counts as a no. Each draft is asked once; a draft whose call failed is asked once more about a week later, then never again.

## See the drafts and take one back

1. **Terminal:** list them: `agentx situation learned`. Each line shows the template's id, whether it is **in use**, how many talks it came from, its sentences in quotes, and the approver's yes or no with the reason.
2. **Terminal:** to use one on a talk, name it in the closing steps: `agentx situation closing <talk id> --template learned.<name> --purpose "job interview" --home <issue link>`.
3. **Terminal:** to take one back: `agentx situation learned retire learned.<name>`. It is no longer used, from the next turn on. A retired template cannot be approved again; the next weekly run will not propose the same id or the same sentences.

Only you can take one back: the command sends your **operator key** (the secret in `.agentx/operator.key`), and an agent's own tools are refused. There is no command or page that approves a draft: only the approver's call does.

## Limits

- **Where decisions live.** Every decision (each draft's status, how often it was asked, who said yes or no, retired templates, the approver, your picks) is kept in one **sealed state**: a record signed with a key made from your operator key, with a counter that only goes up. The status columns of the drafts table are a copy for reading; changing them changes nothing. A draft whose text changed after it was made is never asked about or used.
- **An edited state stops everything.** If the sealed state is changed outside AgentX, its seal no longer matches: nothing learned is drafted, asked or used until you run `agentx situation learned reset`, which drops every draft and decision. The next weekly run sends you one message saying so.
- **An older copy put back.** AgentX keeps the newest generation it has written in a second place, the file `.agentx/learned.gen`, sealed with the operator key. At start and on every read it takes the higher of that file and what it has seen. So putting back an earlier copy of the state, or of the whole database (to undo a retire, a no or a new approver), stops everything as above, before or after a restart. A missing `learned.gen` beside an existing state, or a state that vanished while the file says there was one, stops everything too.
- **What is left.** To undo a decision, someone has to put back both an earlier copy of the database and the matching earlier `learned.gen`. The guard rule `learned-gen-write` keeps agents off that file, with the same known gaps as the operator-key rule below; deleting the file is noticed rather than blocked.
- **The operator key is a second lock, not a wall.** The guard rule `operator-key-read` stops an agent's plain attempts to read `.agentx/operator.key`, but it has known gaps: commands built indirectly (`xargs`, `find -exec`, shell variables), other programs that read files (`sqlite3` `readfile`, `tsx -e`, `git hash-object`), hooks, and agents on tiers that run without the guard. An agent that gets the key can forge seals. Keep agents that do not need it off this machine's AgentX folder.
- **The approver.** Only your operator key names it, and the name is in the sealed state, so an agent that edits `agentx.json` or the database cannot make itself the approver. A yes counts only while the agent that gave it is still the approver.
- **A no stays a no.** A no, and a retire, are sealed and final: setting a draft back in the database does not make it askable. A sentence that was turned down or retired is not drafted again under another name.
- **The approver reads nothing from its folder.** Its call runs with fixed rules, so another agent that writes in the approver's folder cannot steer the answer. The approver's own `CLAUDE.md` and memory are not read either; the approver's name and model are what it brings.
- **The meaning of a rule.** The check refuses words and forms, not ideas. A plain-worded rule that is still a bad idea is for the approver to turn down, and for you to retire.
- **Cost, per machine.** Each call is booked at an estimate ($1 for a draft, $0.50 for a review) before it starts, and must fit both limits; the real cost replaces the estimate when the call returns. A call that fails or is cut off stays booked at its estimate. One call that costs more than its estimate can take the run a little past `maxRunUsd`; the next call is then refused. The run's spend is what was booked in the last 6.5 days.
- **One run a week.** AgentX books the week's drafting run before its model call, so starting the workflow again does not make a second call within 6.5 days. The two steps run only inside the `situation-learn` workflow: the built-in actions API (`POST /api/actions/builtin/…`) and any other workflow are refused, and two runs at once take turns. If `situation-learn.yaml` is changed or deleted, AgentX puts the shipped file back at the next daemon start.

## Check it worked

1. **Terminal:** `agentx situation learned`. Right after you switch it on, it says `No learned templates yet.` (and no "is off" line).
2. **Browser:** open the **Workflows** page of the dashboard. `situation-learn` is listed. After a Monday, it has a run with the steps `draft`, `review` and, when something was decided, `tell_owner`.
3. **Terminal:** after a run, `agentx situation learned` lists the drafts. One the approver said yes to says **in use**; one it turned down says **rejected**.
4. You get one message after a run that decided something: "Learned templates this week: … approved by …; … turned down by …".
5. **Terminal:** on a talk where you named an approved template, `agentx situation list` shows that template, and the agent's `[Situation]` line carries its sentence in quotes.

## If something is wrong

- **No `situation-learn` on the Workflows page.** The daemon reads `situations.learned.enabled` at start, and puts `situation-learn.yaml` back at every start while learning is on, so a missing or edited file is restored by a restart.
  1. **Terminal:** restart the daemon.
  2. **Terminal:** search the daemon log for `Situations: workflow situation-learn not used`. That line names a file that does not load.
  3. The log also names any other file that declares the id `situation-learn`. Delete that file, then restart again.
- **The run made no draft.** The run's `draft` step gives the reason. `learns once a week` means a run already drafted in the last 6.5 days. `ended talk(s) in the last 28 days; a draft needs 3` means there were too few. `improve.enabled is off`, `daily budget` or `run cap` name the limit that stopped it. `no operator key` means `.agentx/operator.key` is missing: a daemon restart creates it.
- **Drafts stay "waiting for the approver".** The run's `review` step gives the reason. `no approver` means none was named with `agentx situation learned approver <agent>`, or that agent is no longer on this machine; `agentx situation learned` shows the approver on its first line. A step that says `run cap` stopped at the $2 limit; the rest are asked next week.
- **A talk does not use a learned template that shows on it.** Only a template you named with `agentx situation closing --template` is used; a name written onto the talk any other way is not.
- **An approved template says "approved, not in use".** `situations.learned.enabled` or `situations.templates.enabled` is off, another approver was named since, or the template's text was changed after the yes, or the operator key changed (a new key makes every earlier seal invalid).
- **A line says "not drafted by this daemon (no valid seal)".** The row was written or changed by something other than AgentX's weekly run. It is never asked about or used.
- **`agentx situation learned` (or your weekly message) says "the sealed state was changed outside AgentX", "an older sealed state was put back", "the sealed state is missing" or "learned.gen is missing".** Something edited the learned-templates records. Nothing learned is drafted, asked or used. Find out what changed it, then **Terminal:** `agentx situation learned reset`, and name the approver again.
- **`agentx situation learned retire` answers HTTP 403.** The command must run in the AgentX folder (where `.agentx/operator.key` is), on the machine the daemon runs on.

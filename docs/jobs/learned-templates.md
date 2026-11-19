# Learn templates from ended talks

![Once a week AgentX reads counts about the talks that ended, with no messages or names, and a model drafts up to two templates. You get one card with that week's drafts and answer yes or no to each. A template with your yes is used only on a talk where you name it. A no, or no answer by the next week, and the draft is not used.](/diagrams/learned-templates.svg)

A **template** says what kind of talk a chat is (a meeting with an outside party, a hand-off, a change on a live system) and adds a few sentences to your agent's `[Situation]` line for it. AgentX ships a small list of them; see [Templates](/jobs/stop-goodbye-loops#templates-what-kind-of-talk-it-is).

With this feature on, AgentX also **learns** templates from your own talks. Once a week it looks at the talks that ended, and a model proposes a few new templates, for example "Interview with a candidate: ask what the candidate expects as next steps before the talk ends". Each proposal is a **draft**. You get **one card a week** with that week's drafts, and you say yes or no to each. No agent decides for you. Nothing learned is used before your yes.

The rules:

- It is **off** until you switch it on.
- **You are not flooded.** At most one card a week, holding at most 2 drafts (`maxDrafts`). No card in a week with nothing new.
- **Nothing goes stale.** A draft you do not answer is dropped quietly at the next weekly run; if the talks still show the same pattern, it may come back later. If two cards in a row go unanswered, learning **pauses itself** and tells you once; `agentx situation learned resume` starts it again. A template no talk has used for **8 weeks** is retired by itself and named on your next card.
- A learned template can only add sentences: one per phase of the talk, and one line on what the closing note must hold. It is built on one of the shipped templates (`meeting`, `meeting.external`, `job.production`, `hand-off`) and keeps that template's closing steps. It can never hold a message, send one, choose where a note goes, give a task to anyone, set a due date or change any other rule. There is no place in a draft to write those, and a check refuses text that asks for them.
- The check also refuses links (also written as "dot com" or with `[.]`), digits and numbers written as words (except "one"), addresses, quotes, markdown, invisible or direction characters, letters outside the Latin alphabet, words that look like a name, words that claim someone's authority ("the owner says", "boss", "the user wants", "already approved"; the plain word "owner" is fine) and words that read like an order to the system (such as "ignore", "approve", "tool"). The check works on words. Whether a rule is a good idea is for you to judge on the card.
- A learned template is used only on a talk **you** name it on (`agentx situation closing --template learned.<name>`), and only while `situations.templates.enabled` is on. AgentX keeps your pick sealed: a template name written onto a talk any other way (by an agent's tool, or straight into the database) is not used.
- Its sentences reach your agent **in quotes**, marked "Learned from past talks and approved, a suggestion", so they never read as your words or as AgentX's.
- It costs at most **$2 a week on each machine** (each AgentX node has its own limit), counted inside that machine's daily self-improvement budget (`improve.dailyUsd`). Only the drafting call costs anything; your answers cost nothing. On a Claude subscription these dollars are what the call would cost at API prices, as the command-line tool reports them, not money charged.
- You can take a learned template back at any time.

## What the model sees

The drafting model never sees a message. For each talk that ended in the last 4 weeks it gets only:

- the talk's template, how it ended (closed, stale, by a person), how long it lasted and how much it mattered. Each must be one of its known values; anything else is sent as `other`;
- how many messages the goodbye gate held, for what reason, and from which **kind** of sender (person, bot or agent). A reason with a word the check refuses is sent as `other`;
- the lower-case words of the talk's purpose that at least 3 of the talks share (`minEvidence`). A word with a capital letter, a digit, an address or a link is left out, and so is any word in a script without capitals (such as Arabic), because it could be a name. A word only one or two talks have is left out too: a name written in lower case is rarely shared by that many talks. A word the check refuses (such as "ignore" or "approve") is left out however many talks share it.

No name, number, chat, sender or message text leaves your machine for this.

## Settings

All settings are under `situations.learned` in `agentx.json`.

| Setting | Default | What it does |
|---|---|---|
| `situations.learned.enabled` | `false` | `true` installs the weekly workflow `situation-learn` (at the next daemon start) and uses the templates you approved. `false` uses none, even approved ones. |
| `situations.learned.model` | `opus` | The model that writes the drafts, once a week. |
| `situations.learned.maxRunUsd` | `2` | Dollars one week's drafting may spend. At most 2. |
| `situations.learned.windowDays` | `28` | How many days of ended talks the run reads (7 to 30). |
| `situations.learned.minEvidence` | `3` | How many ended talks a draft must come from. |
| `situations.learned.maxDrafts` | `2` | Drafts one week may propose: the most one card holds (1 to 5). With more than 2, the card's yes takes them all, and you answer one by one with `agentx situation learned answer`. |

These are fixed, not settings: one card a week; a card lasts 6 days; unanswered drafts are dropped at the next run; learning pauses after 2 unanswered cards in a row; a template unused for 8 weeks is retired.

It also needs `improve.enabled` (the self-improvement budget, see [Failure signals](/jobs/failure-signals)), and `situations.templates.enabled` to use a template on a talk.

## Turn it on

1. **Terminal:** in the AgentX folder, switch the self-improvement budget on: `agentx config set improve.enabled true`. Its daily limit is `improve.dailyUsd` ($3 unless you changed it).
2. **Terminal:** switch templates on: `agentx config set situations.templates.enabled true`.
3. **Terminal:** switch learning on: `agentx config set situations.learned.enabled true`.
4. **Terminal:** restart the daemon so the weekly workflow is installed: `agentx daemon restart`. The log says `Situations: installed workflow(s) situation-learn`.

The workflow runs every Monday at 04:00 UTC. It appears on the **Workflows** page as `situation-learn`, with its runs and the steps `draft` and `card`. AgentX starts a new week at most once in 6.5 days, however the workflow is started.

## Answer the weekly card

When a week has new drafts, AgentX raises one decision card for you. It shows in **Needs you** on the dashboard's Hub, in your daily digest, and, on a Mac with the popup on, as a popup.

![The weekly card with two learned drafts: their sentences, and the choices Use both, Only: Interview with a candidate, and Only: Call with a supplier.](/screenshots/learned-templates/weekly-card.png)

The card lists each draft with its id and its sentences (cut to fit; `agentx situation learned` shows them in full).

1. **Mac popup:** pick **Use both**, or **Only: …** for one of them, then press **Yes**. Press **No** to turn both down. With one draft, the card is a plain **Yes** or **No**.
2. **Or Terminal:** in the AgentX folder on the daemon's machine, answer each draft: `agentx situation learned answer learned.<name> yes` (or `no`). It sends your **operator key** (the secret in `.agentx/operator.key`). Use this on a machine without the popup, such as a server.
3. **Terminal:** check: `agentx situation learned` shows **approved** or **turned down** for each.

Only those two ways count. A yes on the Hub, from `agentx approvals approve`, from a phone, from a chat reply or from another machine of the mesh is refused, and a card file changed by hand changes nothing: the card file is not where your answer is kept. A **No** on the Hub closes the card without turning the drafts down for good; they are dropped at the next run like unanswered ones.

A **no** is final: that draft is never used, and its sentences are not drafted again. A yes means the template may be used on the talks you name it on.

If you do not answer, nothing happens until the next weekly run. Then the card closes and its drafts are dropped quietly.

## When learning pauses

If two cards in a row get no answer at all, the next weekly run pauses learning. You get **one message** saying so (there is no card while it is paused), and nothing is drafted or spent until you start it again.

1. **Terminal:** in the AgentX folder, run `agentx situation learned resume`. It answers `Learning resumed: the next weekly run drafts again.`
2. The next Monday run drafts again and, if something is new, raises a card.

## Templates nobody uses

A template you approved that no talk has used for 8 weeks (counted from your yes, or from the last time you named it on a talk) is **retired** at the next weekly run. Your next card names it under **Also**; if there is no card that week, you get one message instead. A retired template is no longer used; the model may propose its sentences again later if the talks show the pattern again.

## See the drafts and take one back

1. **Terminal:** list them: `agentx situation learned`. Each line shows the template's id, whether it is **in use**, how many talks it came from, its sentences in quotes, and your answer. The first lines say whether this week's card is open and whether learning is paused.
2. **Terminal:** to use one on a talk, name it in the closing steps: `agentx situation closing <talk id> --template learned.<name> --purpose "job interview" --home <issue link>`.
3. **Terminal:** to take one back: `agentx situation learned retire learned.<name>`. It is no longer used, from the next turn on. A template you retire cannot be approved again; the next weekly run will not propose the same id or the same sentences.

Only you can answer, resume or take one back: these commands send your operator key, and an agent's own tools are refused.

## Limits

- **Where decisions live.** Every decision (each draft's status, your yes or no, the open card, unanswered cards in a row, the pause, retired templates, your picks) is kept in one **sealed state**: a record signed with a key made from your operator key, with a counter that only goes up. The status columns of the drafts table are a copy for reading; changing them changes nothing. A draft whose text changed after it was made is never put on a card or used.
- **Your answer is sealed by the daemon.** The popup the daemon shows is built from the sealed state, not from the card file, and its answer is sealed in the daemon itself. `agentx situation learned answer` needs your operator key. Nothing else seals an answer.
- **An edited state stops everything.** If the sealed state is changed outside AgentX, its seal no longer matches: nothing learned is drafted, asked or used until you run `agentx situation learned reset`, which drops every draft and decision. The next weekly run sends you one message saying so.
- **An older copy put back.** AgentX keeps the newest generation it has written in a second place, the file `.agentx/learned.gen`, sealed with the operator key. At start and on every read it takes the higher of that file and what it has seen. So putting back an earlier copy of the state, or of the whole database (to undo a retire or a no), stops everything as above, before or after a restart. A missing `learned.gen` beside an existing state, or a state that vanished while the file says there was one, stops everything too.
- **What is left.** To undo a decision, someone has to put back both an earlier copy of the database and the matching earlier `learned.gen`. The guard rule `learned-gen-write` keeps agents off that file, with the same known gaps as the operator-key rule below; deleting the file is noticed rather than blocked.
- **The operator key is a second lock, not a wall.** The guard rule `operator-key-read` stops an agent's plain attempts to read `.agentx/operator.key`, but it has known gaps: commands built indirectly (`xargs`, `find -exec`, shell variables), other programs that read files (`sqlite3` `readfile`, `tsx -e`, `git hash-object`), hooks, and agents on tiers that run without the guard. An agent that gets the key can forge seals. Keep agents that do not need it off this machine's AgentX folder.
- **A no on the Hub only counts as an answer.** It keeps learning from pausing, but does not turn the drafts down for good, because the card file can be written by other programs on the machine. Use the popup or `agentx situation learned answer … no` for a final no.
- **The popup after a restart.** The popup shows a card waiting less than a day old. After that, or on a machine without the popup, answer with `agentx situation learned answer`.
- **The meaning of a rule.** The check refuses words and forms, not ideas. A plain-worded rule that is still a bad idea is yours to turn down, or to retire later.
- **Cost, per machine.** The drafting call is booked at an estimate ($1) before it starts, and must fit both limits; the real cost replaces the estimate when the call returns. A call that fails or is cut off stays booked at its estimate. The run's spend is what was booked in the last 6.5 days.
- **One run a week.** AgentX seals the start of the week before anything else, so starting the workflow again does not draft or raise a second card within 6.5 days. The two steps run only inside the `situation-learn` workflow: the built-in actions API (`POST /api/actions/builtin/…`) and any other workflow are refused, and two runs at once take turns. If `situation-learn.yaml` is changed or deleted, AgentX puts the shipped file back at the next daemon start.
- **From phase 8.** A node that ran the earlier version (where an agent approved drafts) keeps its records: the approver it named is dropped, and a template that agent approved goes back to a draft and comes to you on the next card. Nothing an agent approved is used.

## Check it worked

1. **Terminal:** `agentx situation learned`. Right after you switch it on, it says `No learned templates yet.` (and no "is off" line).
2. **Browser:** open the **Workflows** page of the dashboard. `situation-learn` is listed. After a Monday, it has a run with the steps `draft` and `card`, and `tell_owner` only when learning paused or a template was retired with no card that week.
3. **Browser:** after a run with new drafts, **Needs you** on the Hub holds one card titled "Learned templates to approve" ("Learned template to approve" when there is one draft).
4. **Terminal:** after you answer, `agentx situation learned` shows each draft as **approved** (and **in use** once templates are on) or **turned down**.
5. **Terminal:** on a talk where you named an approved template, `agentx situation list` shows that template, and the agent's `[Situation]` line carries its sentence in quotes.

## If something is wrong

- **No `situation-learn` on the Workflows page.** The daemon reads `situations.learned.enabled` at start, and puts `situation-learn.yaml` back at every start while learning is on, so a missing or edited file is restored by a restart.
  1. **Terminal:** restart the daemon.
  2. **Terminal:** search the daemon log for `Situations: workflow situation-learn not used`. That line names a file that does not load.
  3. The log also names any other file that declares the id `situation-learn`. Delete that file, then restart again.
- **No card this week.** The run's `draft` step gives the reason. `learns once a week` means a week already started in the last 6.5 days. `ended talk(s) in the last 28 days; a draft needs 3` means there were too few. `improve.enabled is off`, `daily budget` or `run cap` name the limit that stopped it. `learning is paused` means two cards went unanswered: run `agentx situation learned resume`. `no operator key` means `.agentx/operator.key` is missing: a daemon restart creates it. The `card` step says `nothing new this week` when the model proposed nothing.
- **The popup does not show the card.** The popup shows cards less than a day old, only on a Mac with `approvals.popup.enabled` on. Answer with `agentx situation learned answer learned.<name> yes|no` instead.
- **Yes on the Hub says it can only be answered no.** That is on purpose: answer in the popup or with `agentx situation learned answer`.
- **`agentx situation learned answer` says "is not on this week's card".** The draft was dropped at a weekly run, or the id is wrong. `agentx situation learned` lists the drafts on this week's card.
- **A talk does not use a learned template that shows on it.** Only a template you named with `agentx situation closing --template` is used; a name written onto the talk any other way is not.
- **An approved template says "approved, not in use".** `situations.learned.enabled` or `situations.templates.enabled` is off, the template's text was changed after your yes, or the operator key changed (a new key makes every earlier seal invalid).
- **A line says "not drafted by this daemon (no valid seal)".** The row was written or changed by something other than AgentX's weekly run. It is never put on a card or used.
- **`agentx situation learned` (or a message from AgentX) says "the sealed state was changed outside AgentX", "an older sealed state was put back", "the sealed state is missing" or "learned.gen is missing".** Something edited the learned-templates records. Nothing learned is drafted, asked or used. Find out what changed it, then **Terminal:** `agentx situation learned reset`.
- **`agentx situation learned answer`, `resume` or `retire` answers HTTP 403.** The command must run in the AgentX folder (where `.agentx/operator.key` is), on the machine the daemon runs on.

# Learn templates from ended talks

![Once a week AgentX reads counts about the talks that ended, with no messages or names, and a model drafts up to three templates. The approver agent you named reads each draft once and says yes or no. You get one message. A template with a yes is used only on a talk where you name it. A no, or no approver, and the draft is never used.](/diagrams/learned-templates.svg)

A **template** says what kind of talk a chat is (a meeting with an outside party, a hand-off, a change on a live system) and adds a few sentences to your agent's `[Situation]` line for it. AgentX ships a small list of them; see [Templates](/jobs/stop-goodbye-loops#templates-what-kind-of-talk-it-is).

With this feature on, AgentX also **learns** templates from your own talks. Once a week it looks at the talks that ended, and a model proposes a few new templates, for example "Interview with a candidate: ask what the candidate expects as next steps before the talk ends". Each proposal is a **draft**. An agent you name, the **approver**, reads each draft once and says yes or no. Nothing learned is used before that yes.

The rules:

- It is **off** until you switch it on, and it needs an approver. Without one, drafts wait and nothing is used.
- A learned template can only add sentences: one per phase of the talk, and one line on what the closing note must hold. It is built on one of the shipped templates (`meeting`, `meeting.external`, `job.production`, `hand-off`) and keeps that template's closing steps. It can never hold a message, send one, choose where a note goes, give a task to anyone, set a due date or change any other rule. There is no place in a draft to write those, and a check refuses text that asks for them.
- The check also refuses links, numbers, addresses, quotes, words that look like a name, and words that read like an order to the system (such as "ignore", "the owner says", "approve", "tool").
- A learned template is used only on a talk **you** name it on (`agentx situation closing --template learned.<name>`), and only while `situations.templates.enabled` is on. Your agent cannot pick one by itself.
- Its sentences reach your agent **in quotes**, marked "Learned from past talks and approved, a suggestion", so they never read as your words or as AgentX's.
- It costs at most **$2 a week**, counted inside your daily self-improvement budget (`improve.dailyUsd`). Before each model call, AgentX checks that the call fits both limits; if it does not, the run stops there.
- You can take a learned template back at any time.

## What the model and the approver see

The drafting model never sees a message. For each talk that ended in the last 4 weeks it gets only:

- the talk's template, how it ended (closed, stale, by a person), how long it lasted and how much it mattered;
- how many messages the goodbye gate held, for what reason, and from which **kind** of sender (person, bot or agent);
- the lower-case words of the talk's purpose that at least 3 of the talks share (`minEvidence`). A word with a capital letter, a digit, an address or a link is left out, and so is any word in a script without capitals (such as Arabic), because it could be a name. A word only one or two talks have is left out too: a name written in lower case is rarely shared by that many talks.

No name, number, chat, sender or message text leaves your machine for this. The approver reads the draft and the same counts, in quotes, as outside text.

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

How the approver answers: AgentX starts a separate run of that agent for each draft, with only the draft in front of it, in read-only mode (no tools that write or send, no memory), the way a [second agent reviews pull requests](/jobs/review-gate). AgentX reads the yes or no from that run's answer itself. Each draft is asked once; a draft whose run failed (or gave no clear yes or no) is asked once more about a week later, then never again.

## See the drafts and take one back

1. **Terminal:** list them: `agentx situation learned`. Each line shows the template's id, whether it is **in use**, how many talks it came from, its sentences in quotes, and the approver's yes or no with the reason.
2. **Terminal:** to use one on a talk, name it in the closing steps: `agentx situation closing <talk id> --template learned.<name> --purpose "job interview" --home <issue link>`.
3. **Terminal:** to take one back: `agentx situation learned retire learned.<name>`. It is no longer used, from the next turn on. A retired template cannot be approved again; the next weekly run will not propose the same id.

Only you can take one back: the command sends your **operator key** (the secret in `.agentx/operator.key`), and an agent's own tools are refused. There is no command or page that approves a draft: only the approver's own run does.

## Limits

- **Who approves.** The approver is an agent. AgentX seals each draft and each yes with a key made from your operator key, which the guard keeps agents from reading (rule `operator-key-read`). A row that an agent writes or changes in the database has no valid seal, so it is never asked about and never used, and a template whose text changed after the yes is not used either. If the guard is off, or an agent runs without it, an agent that reads the key could forge a seal.
- **The approver.** Only your operator key names it, and the name is sealed, so an agent that edits `agentx.json` or the database cannot make itself the approver. A yes counts only while the agent that gave it is still the approver.
- **A no stays a no.** How often a draft was asked is sealed, so setting a draft back in the database breaks its seal: it is never asked or used again. A draft restored from an earlier copy is not asked again by the running daemon either; after a daemon restart, such a copy could be asked once more. A sentence that was turned down is not drafted again under another name.
- **The approver's own files.** The review run still reads the approver agent's own instructions from its folder (its `CLAUDE.md`), as the pull-request reviewer does. Another agent that can write in that folder could try to steer the answer. Keep the approver's folder to itself.
- **Cost.** Each call is booked at an estimate ($1 for a draft, $0.50 for a review) before it starts, and must fit both limits; the real cost replaces the estimate when the call returns. A call that fails or is cut off stays booked at its estimate. One call that costs more than its estimate can take the run a little past `maxRunUsd`; the next call is then refused. The run's spend is what was booked in the last 6.5 days.
- **One run a week.** AgentX books the week's drafting run before its model call, so starting the workflow again does not make a second call within 6.5 days. The two steps run only inside a workflow: the built-in actions API (`POST /api/actions/builtin/…`) refuses them, and two runs at once take turns.

## Check it worked

1. **Terminal:** `agentx situation learned`. Right after you switch it on, it says `No learned templates yet.` (and no "is off" line).
2. **Browser:** open the **Workflows** page of the dashboard. `situation-learn` is listed. After a Monday, it has a run with the steps `draft`, `review` and, when something was decided, `tell_owner`.
3. **Terminal:** after a run, `agentx situation learned` lists the drafts. One the approver said yes to says **in use**; one it turned down says **rejected**.
4. You get one message after a run that decided something: "Learned templates this week: … approved by …; … turned down by …".
5. **Terminal:** on a talk where you named an approved template, `agentx situation list` shows that template, and the agent's `[Situation]` line carries its sentence in quotes.

## If something is wrong

- **No `situation-learn` on the Workflows page.** The daemon reads `situations.learned.enabled` at start: restart it. Check the log for `Situations: workflow situation-learn not used`, which names a file that does not load. If you deleted the workflow before, AgentX does not put it back: remove `situation-learn` from the list in `_situation-workflows.json` in the workflows folder, then restart the daemon.
- **The run made no draft.** Open the run's `draft` step. `learns once a week` means a run already drafted in the last 6.5 days. `ended talk(s) in the last 28 days; a draft needs 3` means there were too few. `improve.enabled is off`, `daily budget` or `run cap` name the limit that stopped it. `no operator key` means `.agentx/operator.key` is missing: a daemon restart creates it.
- **Drafts stay "waiting for the approver".** Open the run's `review` step. `no approver` means none was named with `agentx situation learned approver <agent>`, or that agent is no longer on this machine; `agentx situation learned` shows the approver on its first line. A step that says `run cap` stopped at the $2 limit; the rest are asked next week.
- **An approved template says "approved, not in use".** `situations.learned.enabled` or `situations.templates.enabled` is off, another approver was named since, or the template's text was changed after the yes, or the operator key changed (a new key makes every earlier seal invalid).
- **A line says "not drafted by this daemon (no valid seal)".** The row was written by something other than AgentX's weekly run. It is never asked about or used. Retire it.
- **`agentx situation learned retire` answers HTTP 403.** Run it in the AgentX folder (where `.agentx/operator.key` is), on the machine the daemon runs on.

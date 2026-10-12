# Try a cheaper workflow beside a live one

Some jobs run the same way many times a day, and each run is one long agent turn. You can often do the same job more cheaply with a **pilot workflow**: a few small steps written from what the full agent did on past runs. Before you trust it, you want figures: what each run costs on each path, and how often the pilot gives up.

This page shows how to run a pilot **beside** the live job, on the same input, without letting it change anything. Then one command compares the two.

A **workflow** is a list of steps AgentX runs in order. One pass through it is a **run**. A **trace** is the record AgentX keeps of one agent turn, with the tokens it used.

## How it works

- The live workflow keeps doing every run, as today.
- After its agent step, the live workflow starts the pilot workflow with the same input. The pilot's agent steps run with autonomy `report`, so they read, decide and answer, but change nothing.
- When the pilot cannot handle a case, its step answers with the result token `RESULT: fallback`. That is a **hand-back**: if the pilot were live, the full agent would take the case.
- `agentx workflow pilot-report` reads the traces of both runs and prices their tokens with the same table the costs page uses. Requests over 200,000 input tokens are priced at 1.5 times, as the provider bills them.

Steps that run code (scripts, branches) make no model call and count as zero on both paths.

## Set it up

You need workflows turned on and the live workflow saved in `.agentx/workflows/`. The examples use a live workflow `owner-sweep` with a script step `sweep` and an agent step `act`.

1. **In your editor**, create `.agentx/workflows/owner-sweep-pilot.yaml`. Its trigger is manual, because the live workflow starts it:

   ```yaml
   id: owner-sweep-pilot
   version: 2
   title: Owner sweep pilot (dry-run)

   nodes:
     - id: start
       type: trigger.manual
       config: {}

     - id: decide
       type: agent
       config:
         agentId: example-agent
         autonomy: report
         prompt: |
           For each line below, say which action you would take and why.
           Do not change anything. If a line does not fit these rules,
           end your reply with "RESULT: fallback".

           {{start.items}}

     - id: done
       type: end
       config: { status: completed }

   edges:
     - { from: start, to: decide }
     - { from: decide, to: done }
   ```

2. **In your editor**, open the live workflow and add a step after its agent step that starts the pilot with the same input:

   ```yaml
     - id: pilot
       type: subProcess
       config:
         workflowId: owner-sweep-pilot
         inputMap:
           start: { items: "{{sweep.output}}" }
   ```

3. **In the same file**, send the agent step to the new step, and the new step to the end. Replace the edge `{ from: act, to: done }` with:

   ```yaml
     - { from: act, to: pilot }
     - { from: pilot, to: done }
   ```

4. **In the terminal**, check both files:

   ```bash
   agentx workflow validate .agentx/workflows/owner-sweep-pilot.yaml
   agentx workflow validate .agentx/workflows/owner-sweep.yaml
   ```

5. **In the terminal**, reload the workflows:

   ```bash
   agentx workflow add .agentx/workflows/owner-sweep-pilot.yaml
   agentx workflow add .agentx/workflows/owner-sweep.yaml
   ```

The pilot runs after the live agent has finished, so it never delays the live work.

## Read the figures

1. **In the terminal**, after a few days of runs:

   ```bash
   agentx workflow pilot-report owner-sweep owner-sweep-pilot --since 7d
   ```

2. Read the table:

   | Line | What it is |
   |---|---|
   | `owner-sweep (all)` | Every live run that reached a model in the period. Runs that stopped at a script step are left out. |
   | `live, paired runs` | The live runs that have a pilot run beside them. |
   | `pilot path, paired` | What the same runs would cost on the pilot path: the pilot's cost, plus the live cost for each hand-back. |

   Below the table: how many runs were handed back, and the saving in percent on the paired runs.

3. **In the terminal**, to check runs one by one, list each pair with its trace ids, then open a trace:

   ```bash
   agentx workflow pilot-report owner-sweep owner-sweep-pilot --since 7d --pairs
   agentx trace show <trace-id>
   ```

Whether each answer was right is for you to judge: compare what the pilot said it would do with what the live agent did on the same lines. A hand-back is not an error; it is counted in the hand-back share and in the cost.

Add `--json` to get the same report as data, with every pair.

## Check it worked

- `agentx workflow runs owner-sweep-pilot` lists pilot runs, one after each live run that reached its agent step.
- `agentx workflow pilot-report owner-sweep owner-sweep-pilot` shows a `pilot path, paired` line with at least one run.
- The pilot changed nothing: the issues, messages or files the job works on show only the live agent's actions.

## If something is wrong

- **No pilot runs:** the live workflow was not reloaded, or the edge from `act` still goes to `done`. Run `agentx workflow show owner-sweep` and check the `pilot` step and its edges.
- **The pilot changed something:** `autonomy: report` is enforced only for agents on the `claude-code` tier. Use such an agent for the pilot, or take the tools that change things away from it.
- **Live runs stay paused at `pilot`:** the live run waits for the pilot to reach an `end` step. A pilot run that fails leaves the live run paused. Give every path in the pilot an `end` step, and cancel stuck runs with `agentx workflow cancel <runId>`.
- **`Not compared: … pilot run(s) without a live run`:** those pilot runs were started by hand, or their live run is older than `--since`. They are left out of the figures.
- **Costs look too low:** only agent turns are priced. A step that calls a model some other way (for example `action.builtin` with `extract.structured`, or `classify`) leaves no trace with tokens, so it is not counted. Keep the pilot's model calls in `agent` steps.
- **`No trace database`:** run the command in the folder the daemon runs in, or pass `--db <path>`.

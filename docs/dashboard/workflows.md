# Workflows — saved automations

A workflow is a saved automation: something starts it (a message, a GitLab event, a time of day, or you), and then one or more steps run, such as asking an agent to do a job. Each time it starts is called a **run**.

You see your workflows in two places:

- **Workflows** on the [Wall](./wall.md): every workflow with its state and last runs, a switch to turn it on or off, and a button to start it. Start here.
- The classic **Workflows** page (`/workflows`): the same list, the full history of each run, **Follow-ups**, the **Every task in a workflow** setting, and the editor, where the steps appear as boxes joined by arrows (the canvas).

## See your workflows on the Wall

1. **Browser:** open the dashboard. The Wall is the first page you see.
2. Select **Workflows** in the nav on the left, under **Automation**. The number next to it is how many workflows this machine has. On a phone, select **More** in the bottom bar, then **Workflows**. The page's address is `/wall#page=workflows`.
3. Each workflow is one row. It shows:
   - its name, and its state: **Running**, **Last run failed**, **Done**, **Waiting** (a step waits for someone), **Never run**, **Off**, or **Held** (it would clash with another way the same events are handled, so it takes no runs until that is fixed);
   - what starts it, in words, such as **Started by hand**, **Fridays at 16:00** or **When a message arrives by email**;
   - its agents and its project;
   - its last runs as small squares, oldest on the left: green finished, red failed, blue running, amber waiting, grey stopped;
   - on the right, a switch that reads **On** or **Off**.
4. A run that failed adds a red line under the row: when it stopped, and at which step.
5. Workflows that need a look come first: a failed last run, then running ones, then the rest by name. Off ones come last.

![The Workflows page on the Wall: one workflow opened on its last run, two that are off and look stale, and Follow-ups on the right](/screenshots/wall/workflows.png)

*Demo data; your workflows will differ.*

The line under the tabs counts your workflows, how many are on, and the runs of the last seven days. The page refreshes with the rest of the Wall, every minute, and when you select **Refresh**.

### Find one workflow

1. Select a tab: **All**, **Running**, **Failed** or **Off**. The number on **Running** and **Failed** is how many workflows are in it.
2. Type part of a name, a project or an agent in **Filter workflows**.
3. Pick a project in **All projects**. **No project** lists the workflows that have none.
4. The address keeps what you picked, so you can save or share it as a link.

### Spot a workflow nobody uses

A workflow that is off and has not run for 30 days shows **looks stale** in amber, with how long it has been quiet (**no run for 41 days**, or **never run**). It is a hint to delete it or turn it back on in the editor. Jobs does the same for schedules.

### See the last run step by step

1. Select a workflow's name. Its last run opens under the row.
2. The first line says when the run started, how it ended, how long it took and what started it.
3. Under it, one line per step: a green tick for a step that finished, a red mark for the step where it stopped, with the reason, and a grey circle for steps it did not reach. Each step names the agent that did it and how long it took.
4. Under the steps:
   - **Run again** starts it once more with the same input as that run.
   - **Open in the editor ↗** opens the workflow on the canvas, in a new tab.
   - **All runs** opens the classic page, where every run is listed.
5. Select the name again to close it.

## Start a run

1. On the Wall's **Workflows** page, select **Run…** under a workflow that is on.
2. A box opens. Fill in the inputs the workflow asks for. A field marked **\*** is needed.
3. To send the input as text in JSON format instead, open **Inputs as JSON**.
4. Read the line above the buttons: it says who does the steps, and, for a workflow that something else normally starts (a message or a time of day), that this run stands in for that.
5. Select **Start the run**. The box closes and the line at the top of the page says **Started**. The workflow opens on its new run.

To close the box without starting anything, select **Back** or press Escape.

![The Run box: the workflow's name, Inputs as JSON, what will happen, then Back and Start the run](/screenshots/wall/workflows-run.png)

## Turn a workflow on or off

1. On the Wall's **Workflows** page, select the switch on the workflow's row.
2. The line at the top of the page says what changed. When it is **Off**, nothing starts it any more; runs already under way go on. When it is **On**, what starts it starts a run again.

This saves the workflow the same way the editor does. A workflow marked **Held** has no switch: fix the clash it names, then turn it on in the editor.

### On a phone

On a phone, the page lists the same workflows and tabs, and opens a workflow the same way. It has no switches and no **Run…** buttons: starting a workflow, and turning one on or off, are done on a computer. The editor is not made for a phone either.

![The Workflows page on a phone: the list without switches, under "Only the owner can start, turn on or turn off a workflow"](/screenshots/wall/workflows-phone.png)

## Open and run a workflow on the classic page

![Two example workflows in the demo](/screenshots/workflows-list.png)

*Both demo examples only start when someone runs them.*

1. **Browser:** open `/workflows`, or select **Workflows** under **Dashboard pages** on the Wall.
2. Select a workflow in the list. Its steps and recent runs appear on the right.
3. To start it by hand, select **▶ Run**.
4. Fill in the fields the workflow asks for (or open **Or edit the raw JSON payload**).
5. Select **Run now**. A message shows **run started**, and a panel opens with the run's steps as they happen.
6. To stop a run that is still going, select **Pause** or **Cancel** in that panel.

## See what is being followed

Workflows that agents started for your requests are listed under **Follow-ups**, at the top of the left column of the classic page, one group per tag (such as `client:example-co`). On the Wall's **Workflows** page, the **Follow-ups** box on the right counts them; select **Show them** to open the classic page.

1. **Browser:** in the Workflows tab, look at **Follow-ups**. Groups with a blocked run are open.
2. **Browser:** click a group's name to open it. Each run shows the step it is on, what it waits on and since when.
3. **Browser:** click a run to open its steps.

See [Let a workflow follow a request](../jobs/follow-up-workflows.md).

## Run every task through a workflow

Below **Follow-ups**, on the classic page, the card **Every task in a workflow** turns on the setting that runs each task an agent gets inside a workflow run, for every agent or one at a time.

1. **Browser:** click **Every task in a workflow** to open the card.
2. **Browser:** tick **Run every task through a workflow**, or open **Per agent** and choose **on** or **off** next to an agent.

See [Run every task through a workflow](../jobs/every-task-a-workflow.md).

## Edit a workflow

![The workflow editor with the Ask AI to build… button](/screenshots/editor-chat-closed.png)

1. **Browser:** on the Wall's **Workflows** page, open the workflow and select **Open in the editor ↗**. To start a new one, select **New in the editor ↗** next to the page's title. On the classic page, select the workflow, then **Edit on canvas**, or **+** at the top of the list.
2. Drag a starting point or a step from the left-hand list onto the canvas.
3. Select a box to change its settings in the right-hand panel.
4. Select **Save**.

To describe the automation in plain English instead, select **Ask AI to build…**. See [Describe what you want](../automations/describe-it.md). Read a proposed workflow before you select **Apply to canvas**: it **replaces everything on the canvas**. Save only when the steps and destinations match what you intend.

## Check it worked

1. **Browser:** after **Save**, the editor shows **Saved**. Select **Refresh** on the Wall's **Workflows** page: the workflow is listed, and the number next to **Workflows** in the nav went up by one.
2. On the Wall, select **Run…** on a workflow you start by hand, then **Start the run**. The line at the top says **Started**, and a blue square appears at the right of the row's squares. After **Refresh**, once it finishes, the square turns green and the opened run lists each step with a tick.
3. Select the switch on a test workflow. It reads **Off**, and the workflow is under the **Off** tab. Select it again to turn it back on.
4. On the classic page, select **▶ Run**, then **Run now**. The run panel lists each step as it finishes.
5. Follow [Check that it worked](../automations/check-it-worked.md) to confirm the result reached its destination.

## If something is wrong

- **The Wall says "Could not read the workflows":** the dashboard could not ask the machine. The rest of the Wall still works. Select **Try again**; if it persists, check the machine with `agentx daemon status`.
- **The Wall says "Only the owner can start, turn on or turn off a workflow":** the dashboard did not accept your key. Open the Wall on the machine itself, or sign in with the dashboard token, then try again.
- **"Could not start …: workflow … is disabled":** the workflow is off. Turn it on with its switch first.
- **No switch and no Run… on a row:** you are on a phone (use a computer), or the workflow is **Held** (fix the clash in the editor).
- **Save fails with a message:** the workflow has a mistake, such as a step with no agent. Fix the step the message names and save again.
- **Run needs Force:** a workflow that normally starts on an event (not by hand) needs **Force** ticked in the run form to start it now. The form ticks it for you.
- **Ask AI to build… answers with an error:** the assistant needs an agent with a working model. See [Describe what you want](../automations/describe-it.md).
- **A run stops at a step:** open the run panel and read the error on that step. See [Check that it worked](../automations/check-it-worked.md).

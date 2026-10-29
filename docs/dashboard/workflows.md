# Workflows — saved automations

A workflow is a saved automation: something starts it (a message, a GitLab event, a time of day, or you), and then one or more steps run, such as asking an agent to do a job. Each time it starts is called a **run**.

You see your workflows in two places:

- **Workflows** on the [Wall](./wall.md): every workflow with its state and last runs, a switch to turn it on or off, and a button to start it. Start here.
- The **workflow editor**, also on the Wall: the steps appear as boxes joined by arrows on a drawing area (the *canvas*). See [Edit a workflow](#edit-a-workflow).
- The classic **Workflows** page (`/workflows`): the same list, the full history of each run, **Follow-ups** and the **Every task in a workflow** setting.

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
   - **Open in the editor** opens the workflow on the canvas, in the same tab. See [Edit a workflow](#edit-a-workflow).
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

On a phone, the page lists the same workflows and tabs, and opens a workflow the same way. It has no switches and no **Run…** buttons: starting a workflow, and turning one on or off, are done on a computer. The editor opens on a phone too; see [The editor on a phone](#the-editor-on-a-phone).

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

The editor is a page of the Wall. It has two columns: a **side menu** on the left and the **canvas** on the right. The Wall's nav shrinks to its icons, so the canvas gets the room.

![The workflow editor on the Wall: the side menu with the workflow's settings on the left, the steps arranged from left to right on the canvas](/screenshots/workflows/editor.png)

*Demo data; your workflows will differ.*

### Open the editor

1. **Browser:** on the Wall, select **Workflows** in the nav.
2. To change a workflow, select its name, then **Open in the editor**. To start a new one, select **New workflow** next to the page's title.
3. The editor opens in the same tab. Its address is `/wall#page=editor&e-wf=` followed by the workflow's ID (its short name), so you can save it as a bookmark. The old address, `/workflows/editor?id=…`, opens the same page. On the classic page, **Edit on canvas** and **+** open it too.

A workflow that has never been laid out (for example one written as a file) is arranged for you when it opens.

### Read the canvas

- Each step is a box. The small line above its name says what it does, such as **Ask an agent** or **Send a message**.
- Arrows run from left to right in the order the steps run.
- A step that can go more than one way has one dot per way on its right edge, each with its name. A choice ("If this, then that") has one dot per case, such as **status**, **new** and **other**. **Ask the owner** has **yes**, **no** and **expired**.
- A dashed arrow that goes back under the boxes is a loop: the run goes back to an earlier step, for example to try again.

![A merge check with a loop: the dashed arrow under the boxes goes from pause back to verify](/screenshots/workflows/editor-loop.png)

### Change a step

1. Select a box on the canvas. The side menu shows **This step** with its settings.
2. Change what you need. The status next to the title turns to **unsaved**.
3. Select **Save**, or press ⌘S (Ctrl+S on Windows and Linux). The status turns to **saved**.

![A choice selected: its cases in the side menu, and one named dot per case on the box](/screenshots/workflows/editor-step.png)

To see the whole workflow's settings again, select an empty spot on the canvas. The tab then reads **Workflow**.

### Add and connect steps

1. In the side menu, select **Add a step**.
2. Select a step in the list. It lands in the middle of the canvas, ready to set up. You can also drag it onto the canvas, to a place you choose.
3. To connect two steps, press on a dot on the right edge of the first box and drag to the second box. Let go when the box is outlined.
4. To remove a step or an arrow, select it and press Delete.

### Make room on the canvas

- **Fold the side menu:** select the panel button at the far left of the toolbar, the **×** in the menu, or press `[`. The canvas grows into the space. Select the button again to bring the menu back. The editor remembers your choice.
- **Arrange:** select **Arrange** in the toolbar, or press `L`. The steps are laid out from left to right, with no box on top of another, a choice's cases in their order from top to bottom, and loops drawn underneath. Arrange is one step you can undo.
- **Fit:** select the fit button in the toolbar or at the bottom left, or press `F`, to see the whole workflow. Use **+** and **−**, or Ctrl and the mouse wheel, to zoom. Drag an empty spot to move around.

![The side menu folded away: the canvas takes the whole width](/screenshots/workflows/editor-menu-closed.png)

### Keyboard

| Key | What it does |
|---|---|
| ⌘S / Ctrl+S | Save |
| ⌘Z / Ctrl+Z, ⌘⇧Z / Ctrl+Y | Undo, redo |
| Tab, then Enter | Move between steps, select one |
| Arrow keys (Shift for bigger moves) | Move the selected step |
| Delete | Remove the selected step or arrow |
| ⌘D / Ctrl+D | Copy the selected step |
| `L` | Arrange |
| `F` | Fit the workflow in view |
| `[` | Fold or unfold the side menu |
| `/` | Find a step to add |
| ⌘Enter / Ctrl+Enter | Preview |
| `?` | Show these keys |

### Describe it instead

To describe the automation in plain English, select **Ask AI to build…** at the bottom right. See [Describe what you want](../automations/describe-it.md). Read a proposed workflow before you select **Apply to canvas**: it **replaces everything on the canvas**. Save only when the steps and destinations match what you intend.

**Preview** walks through the steps on screen; it does not run them. To run a workflow for real, use **Run…** on the Workflows page.

### Leave the editor

Select **Workflows** at the left of the toolbar, or any page in the nav. If there are changes you have not saved, the editor asks first. Select **Cancel** to stay.

### The editor on a phone

On a phone, the canvas takes the whole screen above the bottom bar. The side menu starts folded: select the panel button at the top left to open it over the canvas, and **×** to close it. Drag with one finger to move around.

![The editor on a phone: the canvas over the Wall's bottom bar, with the side menu folded](/screenshots/workflows/editor-phone.png)

### Who can change a workflow

Only the owner saves, deletes or lays out a workflow, and only the owner can use **Ask AI to build…**. The owner is whoever opens the Wall on the machine itself, or signs in with the dashboard token. Anyone else can open the editor to look: there is no **Save** and no **Add a step**, and the side menu says so. The dashboard refuses their changes even if they are sent another way.

## Check it worked

1. **Browser:** after **Save**, the editor shows **saved**. Select **Workflows** at the left of the toolbar: the workflow is listed, and for a new one the number next to **Workflows** in the nav went up by one.
2. Open the workflow in the editor again and select **Arrange**: every step is visible, none on top of another, and the arrows run from left to right.
3. On the Wall, select **Run…** on a workflow you start by hand, then **Start the run**. The line at the top says **Started**, and a blue square appears at the right of the row's squares. After **Refresh**, once it finishes, the square turns green and the opened run lists each step with a tick.
4. Select the switch on a test workflow. It reads **Off**, and the workflow is under the **Off** tab. Select it again to turn it back on.
5. On the classic page, select **▶ Run**, then **Run now**. The run panel lists each step as it finishes.
6. Follow [Check that it worked](../automations/check-it-worked.md) to confirm the result reached its destination.

## If something is wrong

- **The Wall says "Could not read the workflows":** the dashboard could not ask the machine. The rest of the Wall still works. Select **Try again**; if it persists, check the machine with `agentx daemon status`.
- **The Wall says "Only the owner can start, turn on or turn off a workflow":** the dashboard did not accept your key. Open the Wall on the machine itself, or sign in with the dashboard token, then try again.
- **"Could not start …: workflow … is disabled":** the workflow is off. Turn it on with its switch first.
- **No switch and no Run… on a row:** you are on a phone (use a computer), or the workflow is **Held** (fix the clash in the editor).
- **Save fails with a message:** the workflow has a mistake, such as a step with no agent. Fix the step the message names and save again.
- **There is no Save button, and the side menu says only the owner can change the workflow:** you opened the Wall from another computer without signing in. Sign in with the dashboard token, or open the Wall on the machine itself.
- **The editor says "The editor could not be loaded":** the page could not fetch the editor. Refresh the page. If it keeps happening after an update, run `pnpm build` (from a source checkout) and restart the daemon.
- **The canvas looks empty:** the steps are outside the view. Press `F` or select the fit button.
- **An arrow leaves from a dot named after a case that no longer exists:** the choice's cases changed and the arrow kept its old name. Select the arrow and delete it, then connect the right dot again.
- **Run needs Force:** a workflow that normally starts on an event (not by hand) needs **Force** ticked in the run form to start it now. The form ticks it for you.
- **Ask AI to build… answers with an error:** the assistant needs an agent with a working model. See [Describe what you want](../automations/describe-it.md).
- **A run stops at a step:** open the run panel and read the error on that step. See [Check that it worked](../automations/check-it-worked.md).

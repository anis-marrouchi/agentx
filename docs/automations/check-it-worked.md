# Check that an automation worked

After you build a workflow, check three things: that it is set up the way you meant, that a test run finished, and that the result arrived where it should. Use a test destination (a test chat or project) for the first run.

## Check the setup

1. **Browser:** open the dashboard and select the **Workflows** tab.
2. Select the workflow in the list.
3. Read the line under its title: it shows the workflow's ID, its version, and its **trigger** (what starts it, such as a schedule, a message or a GitLab event).
4. Select **Edit on canvas** to check each step's destination and settings.

![The Workflows tab listing two demo workflows](/screenshots/workflows-list.png)

## Run it once

1. **Browser:** on the workflow's details, select **▶ Run**.
2. Leave **Force** ticked unless the workflow starts with **You start it**. Force pretends the trigger just happened.
3. Select **Run now**.
4. Watch the run appear in the workflow's list of runs, with its status: running, completed, failed, paused or canceled.
5. Select the run to open its timeline, which shows each step as it happens.

## A draft can still run

Each workflow has two separate fields, and only one of them decides whether it runs:

- `state` decides whether the workflow can run: `active`, `disabled`, or `quarantined` (held back because it clashes with another workflow).
- `status` only records review progress: `draft`, `review`, `active` or `deprecated`.

So a workflow marked `status: "draft"` still runs if its `state` is `active`. Keep new proposals at `state: "disabled"` until you have checked them. The [engineer reference](../reference/workflow-schema.md) explains both fields.

## Check it worked

1. The run in the workflow's list shows **completed**.
2. **Browser:** open **Activity** and find the agent's task for that run.
3. The destination (chat, issue or channel) received the expected result.
4. **Terminal, optional:** `agentx workflow runs <workflow-id>` lists the workflow's recent runs, and `agentx workflow trace <run-id>` shows each step of one run.

## If something is wrong

- **Nothing ran:** check that the daemon is running (`agentx daemon status`), that the workflow engine is on (see [Describe what you want](./describe-it.md)), and that the workflow's `state` is `active`.
- **It never starts by itself, but Run now works:** its trigger doesn't match what happens. Check the trigger's filter (for example the project or chat) on the canvas.
- **The run failed:** open the failed step with `agentx workflow trace <run-id>`, fix the instructions or destination, and run it again.
- **It ran but the result is wrong or went to the wrong place:** fix the step's instructions or destination on the canvas, save, and run it again.
- **The run is paused:** it is waiting at a step that holds until someone says go, or someone paused it. Open the run to see which step it stopped at; **Resume** continues a run that was paused by hand.
- **No reply at all from the agent:** follow [It's not answering](../help/its-not-answering.md).

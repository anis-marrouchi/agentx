# Check that an automation worked

After you build a workflow, check three things: that it is set up the way you meant, that a test run finished, and that the result arrived where it should. Use a test destination (a test chat or project) for the first run.

## Check the setup

1. **Browser:** open the dashboard. The Hub is the first page you see.
2. Select **Workflows** in the nav on the left, under **Automation**. On a phone, select **More** in the bottom bar, then **Workflows**.
3. Find the workflow's row. It shows its state, what starts it in words (its **trigger**, such as **Fridays at 16:00** or **When a message arrives by email**), its agents and its project.
4. Select the workflow's name, then **Open in the editor**, to check each step's destination and settings.

![The Workflows page on the Hub: one row per workflow, one opened on its last run](/screenshots/wall/workflows.png)

## Run it once

1. **Browser:** on the Hub's **Workflows** page, select **Run…** under the workflow. It must be **On**.
2. Fill in the inputs the workflow asks for. A field marked **\*** is needed.
3. Read the line above the buttons. For a workflow that something else normally starts (a message or a time of day), it says that this run stands in for that.
4. Select **Start the run**. The line at the top of the page says **Started**, and the workflow opens on its new run.
5. Watch its last runs as squares: blue running, green finished, red failed, amber waiting, grey stopped. Select the workflow's name to see the run step by step.

## A draft can still run

Each workflow has two separate fields, and only one of them decides whether it runs:

- `state` decides whether the workflow can run: `active`, `disabled`, or `quarantined` (held back because it clashes with another workflow).
- `status` only records review progress: `draft`, `review`, `active` or `deprecated`.

So a workflow marked `status: "draft"` still runs if its `state` is `active`. Keep new proposals at `state: "disabled"` until you have checked them. The [engineer reference](../reference/workflow-schema.md) explains both fields.

## Check it worked

1. **Browser:** on the Hub's **Workflows** page, the workflow's newest square is green, and its last run shows a green tick on every step.
2. **Browser:** select **Activity** in the Hub's nav and find the agent's run for that workflow.
3. The destination (chat, issue or channel) received the expected result.
4. **Terminal, optional:** `agentx workflow runs <workflow-id>` lists the workflow's recent runs, and `agentx workflow trace <run-id>` shows each step of one run.

## If something is wrong

- **Nothing ran:** check that the daemon is running (`agentx daemon status`), that the workflow engine is on (see [Describe what you want](./describe-it.md)), and that the workflow's `state` is `active`.
- **It never starts by itself, but **Run…** works:** its trigger doesn't match what happens. Check the trigger's filter (for example the project or chat) on the canvas.
- **The run failed:** open the failed step with `agentx workflow trace <run-id>`, fix the instructions or destination, and run it again.
- **It ran but the result is wrong or went to the wrong place:** fix the step's instructions or destination on the canvas, save, and run it again.
- **The run is paused:** it is waiting at a step that holds until someone says go, or someone paused it. On the Hub's **Workflows** page, select the workflow's name to see which step it stopped at. To continue a run that was paused by hand, select **All runs** under it: the full list of runs, with **Resume**, is still on the classic page.
- **No reply at all from the agent:** follow [It's not answering](../help/its-not-answering.md).

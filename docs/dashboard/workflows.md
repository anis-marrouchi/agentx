# Workflows — saved automations

A workflow is a saved automation: something starts it (a message, a GitLab event, a time of day, or you), and then one or more steps run, such as asking an agent to do a job. The **Workflows** tab lists them, shows their recent runs, and opens the editor, where the steps appear as boxes joined by arrows (the canvas).

![Two example workflows in the demo](/screenshots/workflows-list.png)

*Both demo examples only start when someone runs them.*

## Open and run a workflow

1. **Browser:** open the dashboard and select the **Workflows** tab.
2. Select a workflow in the list. Its steps and recent runs appear on the right.
3. To start it by hand, select **▶ Run**.
4. Fill in the fields the workflow asks for (or open **Or edit the raw JSON payload**).
5. Select **Run now**. A message shows **run started**, and a panel opens with the run's steps as they happen.
6. To stop a run that is still going, select **Pause** or **Cancel** in that panel.

## See what is being followed

Workflows that agents started for your requests are listed under **Follow-ups**, at the top of the left column, one group per tag (such as `client:example-co`).

1. **Browser:** in the Workflows tab, look at **Follow-ups**. Groups with a blocked run are open.
2. **Browser:** click a group's name to open it. Each run shows the step it is on, what it waits on and since when.
3. **Browser:** click a run to open its steps.
4. **Browser:** to keep them in view while you work elsewhere, click **Floating view** next to **Follow-ups**. See [Follow workflows in a floating window](../jobs/progress-widget.md).

See [Let a workflow follow a request](../jobs/follow-up-workflows.md).

## Edit a workflow

![The workflow editor with the Ask AI to build… button](/screenshots/editor-chat-closed.png)

1. **Browser:** in the Workflows tab, select the workflow, then select **Edit on canvas**. To start a new one, select **+** at the top of the list.
2. Drag a starting point or a step from the left-hand list onto the canvas.
3. Select a box to change its settings in the right-hand panel.
4. Select **Save**.

To describe the automation in plain English instead, select **Ask AI to build…**. See [Describe what you want](../automations/describe-it.md). Read a proposed workflow before you select **Apply to canvas**: it **replaces everything on the canvas**. Save only when the steps and destinations match what you intend.

## Check it worked

1. **Browser:** after **Save**, the editor shows **Saved** and the workflow appears in the Workflows list.
2. Select **▶ Run**, then **Run now**. The run panel lists each step as it finishes.
3. Follow [Check that it worked](../automations/check-it-worked.md) to confirm the result reached its destination.

## If something is wrong

- **Save fails with a message:** the workflow has a mistake, such as a step with no agent. Fix the step the message names and save again.
- **Run needs Force:** a workflow that normally starts on an event (not by hand) needs **Force** ticked in the run form to start it now. The form ticks it for you.
- **Ask AI to build… answers with an error:** the assistant needs an agent with a working model. See [Describe what you want](../automations/describe-it.md).
- **A run stops at a step:** open the run panel and read the error on that step. See [Check that it worked](../automations/check-it-worked.md).

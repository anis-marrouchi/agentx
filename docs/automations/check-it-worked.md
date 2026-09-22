# Check that an automation worked

::: info In the browser
Open **Workflows** and select the workflow. Confirm it is saved, enabled where applicable, and has the expected source, timing, and output. After a test run, open **Activity** and look for the corresponding run and result. Check the destination channel for the delivered message.
:::

If nothing ran, check the daemon, the schedule, and the workflow's enabled state. If it ran but the output is wrong, inspect the recorded step and update the instructions or destination. Avoid using a production destination for the first test. See [It's not answering](../help/its-not-answering.md).

**Draft is not an execution switch.** Workflow `status` records review progress, while `state` controls whether it can run. A draft with an active state can execute. Keep new proposals disabled until you have checked them; the [engineer reference](../reference/workflow-schema.md) explains both fields.

# Describe what you want and let AgentX build the automation

Before using the assistant, an installer must enable the workflow engine (`agentx config set workflows.enabled true`) and start or reload the daemon. You also need an agent with a working model connection. The editor can load while the engine is disabled, but authoring requests will fail.

::: info In the browser
Open **Workflows**, open the editor, and select **Ask AI to build…**. Describe the desired outcome, timing, source, and destination. For example: “Every Monday, summarize last week's GitLab issues and send the summary to Telegram.”
:::

The authoring agent responds with a proposed workflow. Read its reply and inspect the generated steps. Select **Apply to canvas** only when you are ready: it **replaces the current workflow graph**. Check the destinations and credentials, save, then test with a small run. Saving a disabled workflow does not activate it. Ask your installer to check its `state` before expecting triggers to run.

The authoring agent is normally the first registered agent, unless an engineer sets `AGENTX_WORKFLOW_AUTHOR_AGENT`. If no authoring agent is available, the editor can return a 503 error. Ask the person who installed AgentX to check that agent and its model login.

In the scripted demo, enter **Build the demo report workflow**. It returns a fixed three-step example without calling a real model. Other requests need a real model; the demo does not generate arbitrary automations.

![Scripted authoring reply with Apply to canvas](/screenshots/editor-chat-reply.png)

*A fixed demo response, shown through the real editor and daemon.*

![The report workflow after applying the proposal](/screenshots/editor-canvas.png)

For step names and fields, see the [workflow schema](../reference/workflow-schema.md).

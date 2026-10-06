# Chat from any dashboard page

Use **Ask an agent** to ask about what you are looking at without leaving the dashboard. It needs a running dashboard and daemon, plus an agent with a working model connection. See [core setup](../requirements.md#core-setup).

Every dashboard page has two ways in: the input bar at the bottom (**Ask an agent about this page…**), and the **Ask an agent** tab on the right edge, which opens the conversation panel directly.

![The Ask an agent input bar at the bottom of a dashboard page, and the tab on the right edge](/screenshots/monitor-only-you.png)

## Ask a question

1. **Browser:** open a dashboard page, such as **Monitor** or **Activity**.
2. Select the **Ask an agent** tab on the right edge. The conversation panel opens.
3. In the panel, pick an agent from the **Agent** list.
4. To send the question to another connected machine, pick it from the **Node** list. Otherwise leave **This node**.
5. Type your question in the bottom bar, for example "Summarize what needs my attention on this page."
6. Select **Ask**.
7. Read the reply in the panel. Type again to continue the conversation.

![The open Ask an agent panel on the Monitor page, with the Agent and Node lists, a question and the agent's reply](/screenshots/chat/panel.png)

The question carries the page you're on and its tab. Some pages also send their current filters, counts or the rows in view. All of this goes to the agent's model provider with your question (see [Your data](../your-data.md)). The agent doesn't see a picture of the page and can't browse on its own. It works with its usual tools, so if you ask it to *do* something, it really does it.

## Continue or start over

1. To reopen an earlier conversation, select **History** in the panel, then pick one.
2. To start fresh, select **New**.
3. To close the panel, select **×** or press Escape.

The browser remembers which conversation was open; the conversations themselves are stored by the dashboard. Drag the panel's left edge to resize it (or focus it and use the arrow keys). The small handle above the bottom bar hides and shows the bar.

The workflow editor has its own assistant, **Ask AI to build…**, which proposes workflows. See [Describe what you want](../automations/describe-it.md).

## Check it worked

1. **Browser:** open the panel. The **Agent** list shows your agents (not **Loading agents…**).
2. Ask a question about the page. A reply appears in the panel.
3. Select **History**. Your conversation is listed.

## If something is wrong

- **The Agent list says agents unavailable:** the dashboard can't reach the daemon. **Terminal:** run `agentx daemon status`. See [It's not answering](../help/its-not-answering.md).
- **A question sent to another machine fails:** check the connection between the machines. See [Tailscale setup](../jobs/tailscale.md).
- **No reply, or an error about the model:** the agent's model connection isn't working. Try the agent with **Test drive** in [Settings](./settings.md).
- **Costs:** every question uses the chosen agent's normal model and billing.

# Chat from any dashboard page

Use **Ask an agent** to ask about what you are looking at without leaving the dashboard. It needs a running dashboard and daemon, plus an agent with a working model connection. See [core setup](../requirements.md#core-setup).

On the Hub it is the **Chat** box at the top of the side column (see [Chat on the Hub](#chat-on-the-hub)). On the classic dashboard pages, such as Monitor (`/monitor`), there are two ways in: the input bar at the bottom (**Ask an agent about this page…**), and the **Ask an agent** tab on the right edge, which opens the conversation panel directly.

![The Ask an agent input bar at the bottom of a dashboard page, and the tab on the right edge](/screenshots/monitor-only-you.png)

## Ask a question

1. **Browser:** open a classic dashboard page, such as `/monitor`.
2. Select the **Ask an agent** tab on the right edge. The conversation panel opens.
3. In the panel, pick an agent from the **Agent** list.
4. To send the question to another connected machine, pick it from the **Node** list. Otherwise leave **This node**.
5. Type your question in the bottom bar, for example "Summarize what needs my attention on this page."
6. Select **Ask**.
7. Read the reply in the panel. Type again to continue the conversation.

![The open Ask an agent panel on the Monitor page, with the Agent and Node lists, a question and the agent's reply](/screenshots/chat/panel.png)

Only the dashboard's owner can use it. On the machine that runs the dashboard it just works. On another computer, when `dashboard.token` is set, sign in at `/login` first. With no token set, it only works on the dashboard's own machine.

The question carries the page you're on and its tab. Some pages also send their current filters, counts or the rows in view. All of this goes to the agent's model provider with your question (see [Your data](../your-data.md)). The agent doesn't see a picture of the page and can't browse on its own. It works with its usual tools, so if you ask it to *do* something, it really does it.

## Chat on the Hub

1. **Browser:** open the Hub. On a computer, the **Chat** box is the first box of the side column. Under 1180 px wide, and on a phone, select the chat button in the Hub's header instead.
2. Type your question in the Chat box and select **Ask**, or press `/` to put the cursor there. The side column becomes the chat; the feed and the open post stay where they are. On a phone the chat opens full screen, with **←** back to the page.
3. Pick who answers in **To**. A node list shows only when there is more than one machine to pick.
4. Read the reply in the panel. Type again in **Message…** and select **Send**, or press Enter (Shift+Enter for a new line).

Under the message box, **Goes with it** says what the Hub sends with your message: the page, the status tab, the filters that are set, the open post or run, and up to ten headlines in view. Select it to see the exact fields.

The Hub and the classic pages share the open conversation: a question asked on `/monitor` continues on the Hub, and back. While the agent is answering, the panel says **is answering** and checks again every second and a half. Under the Chat box, the last conversation stays one tap away, with a blue dot while an answer is not opened yet (on the header's chat button too).

When an agent cannot answer, its reply shows in red with **Try again** and **Ask another agent**. When the machine does not take the message, it shows **Not sent**, and your text stays in the message box to send again.

Chat and **New post** stay separate: the chat asks a question and leaves no post; to give an agent a task that shows on the Hub, use [Post a task](./hub.md#post-a-task).

Anyone who is not the owner sees **Chat is for the owner**, with **Sign in** when `dashboard.token` is set. The rest of the Hub stays readable.

## Continue or start over

1. To reopen an earlier conversation, select **History** in the panel, then pick one.
2. To remove one, select **×** next to it in **History**. If the dashboard cannot remove it, **History** says **Not deleted. Try again.** and the conversation stays.
3. To start fresh, select **New**.
4. To close the panel, select **×** or press Escape. When another Hub window (a workflow or a settings confirmation) is open on top, Escape closes that window first and the panel stays open.

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
- **The panel says "Sign in to ask an agent from this page", or History says "Sign in to see past conversations":** the dashboard did not recognise you as its owner. Select **Sign in**, enter the dashboard token, and you come back to the same page. With no `dashboard.token` set, open the dashboard on its own machine instead.
- **History says "Not deleted. Try again.":** the dashboard did not remove the conversation. Select **×** again; if it keeps failing, check the daemon. **Terminal:** run `agentx daemon status`.
- **Costs:** every question uses the chosen agent's normal model and billing.

# Live — who's working now

Live shows every agent, on every connected machine, and what each one is doing right now. Use it when you have just sent a task and want to see whether an agent picked it up.

Live is a current view. For completed work and the route it took, use [Activity](./activity.md). For work that needs your attention, use [Monitor](./monitor.md).

![Live view of three agents in the isolated demo](/screenshots/live.png)

*Scripted demo data; your team's names and machines will differ.*

## Watch, update or stop a running task

A busy agent shows a **running** card with the channel the task came from, how long it has been running, and the start of the message.

1. **Browser:** open the dashboard and select the **Live** tab.
2. Find the agent's card. A running task shows **running · <channel>** and a timer.
3. To watch the agent work, select the task card. Its progress opens as it happens.
4. To add something to the conversation, select **✎ update**. The Task page opens; type your message and send it. The current step keeps running, and your message is handled next.
5. To stop the task, select **✕ stop**, then confirm.

When an agent is idle, its card shows its **last reply**. Select **history →** to see its recent tasks.

If the agent is running an on-screen lesson through the [desktop assistant](./voice.md), the card shows **on screen** with the step number. Select **✕ stop** on that line to end the lesson and give the screen back.

<!-- Screenshot needed: a Live agent card with a running task and its ✎ update / ✕ stop buttons. Not defined in docs/.scripts/capture.mjs yet. -->

## Check it worked

1. **Browser:** open **Live**. Every agent you configured appears, grouped by machine.
2. Send an agent a small task from a channel or [in-page chat](./chat.md).
3. Within a few seconds, that agent's card shows **running**, then its **last reply** when it finishes.

## If something is wrong

- **No agent appears:** the daemon (the AgentX background service) isn't running or the dashboard can't reach it. See [It's not answering](../help/its-not-answering.md).
- **The agent never shows running:** the message didn't reach AgentX. Check that the channel is connected in [Settings](./settings.md).
- **A machine is missing:** its daemon or the connection to it is down. See [Add a second machine](../jobs/second-machine.md).
- **The card still shows running after ✕ stop:** reload the page after a few seconds. Stopping ends only that task; the agent stays available for new work.

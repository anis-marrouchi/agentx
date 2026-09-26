# Answer questions from a channel

A good first job for an agent is answering one narrow kind of question: support hours, a product FAQ, or how an internal process works. A **channel** is the chat app or tool the questions arrive from, such as Telegram.

You need an agent (see [Your first agent](../first-agent.md)) and a connected channel (see [Connect Telegram](../connect-telegram.md)).

## Set the agent up

1. Put the approved source material (FAQ, policy pages, price list) in the agent's workspace folder, so the agent can read it.
2. **Browser:** open **Settings** and stay on the **Agents** tab.
3. Select **Manage** next to the agent.
4. Select the **Personality** tab and open the instructions file.
5. Say what the agent answers, and that it must say "I don't know" when the material doesn't cover a question, instead of guessing.
6. Select **Save**. The change applies from the agent's next reply.
7. Go back to **Settings** and select the **Channels** tab.
8. Check that the channel is bound to this agent. For Telegram, open the Telegram card: each account shows `agent:` followed by the agent's ID.

![Settings › Agents, with a Manage button beside each agent](/screenshots/settings.png)

![The agent page's Personality tab, with the instruction files on the left and the editor with its Save button](/screenshots/agents/personality.png)

![Settings › Channels, showing the Telegram card](/screenshots/settings-channels.png)

## Test it

1. In the channel, ask a question whose answer is in the material.
2. Ask a question that is not covered.
3. **Browser:** open **Activity** and find both conversations.

## Check it worked

- The first answer matches the source material.
- For the second question, the agent says it doesn't know rather than inventing an answer.
- Both requests appear in [Activity](../dashboard/activity.md) under the right agent.

## If something is wrong

- **No reply at all:** follow [It's not answering](../help/its-not-answering.md).
- **Another agent answered:** the channel is bound to a different agent. Change the binding in **Settings › Channels**.
- **The answer is invented:** make the instruction stricter, and check that the source material is in the agent's workspace.
- **The answer is out of date:** replace the files in the workspace with the current version.

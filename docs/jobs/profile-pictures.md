# Give agents and people a picture

Every member of your org can have a picture: each agent, and each person in your [people list](./people.md). When one is set, it shows instead of the coloured circle with initials on the [Wall](../dashboard/wall.md), the [Org](../dashboard/org.md) page, [Settings](../dashboard/settings.md) and [People](../dashboard/people.md). With no picture, everything looks as it did before.

There are two ways to set one:

- **By hand:** you upload a picture in the dashboard, or from the terminal.
- **By the agent:** you ask an agent to pick or make a picture for itself, and it sets it. An agent can only change its own picture, never another agent's or a person's.

![The Wall's Agents page: the cx agent shows its picture, the two agents without one keep their initials](/screenshots/pictures/wall-agents.png)

## What a picture can be

| Rule | What it means |
|---|---|
| File type | PNG, JPEG or WebP. SVG and every other type are refused. |
| Size | 1 MB at most. |
| Shape | AgentX cuts it to a square from the middle, 512 by 512 pixels. |
| Hidden data | AgentX saves a fresh copy, so the location, camera details and any other *metadata* (information stored inside the file) are dropped. |

The same rules apply whichever way a picture is set.

## Set an agent's picture in Settings

1. **Browser:** open the dashboard and select the **Settings** tab.
2. On **Agents**, find the agent and select **Details**.
3. Select **Upload picture** and choose the file.
4. Check the message at the top: **Picture set for …**. The picture now shows next to the agent's name.

![An agent in Settings with its picture, and the Replace picture and Remove picture buttons](/screenshots/pictures/settings-agent.png)

To change it, select **Replace picture**. To go back to the initials, select **Remove picture**, then **OK**.

The buttons show only for this computer's agents. With another machine picked in the top bar, set that machine's pictures on its own dashboard.

## Set a person's picture on the People page

1. **Browser:** open the dashboard and go to `/people`.
2. Select the person's name to open their details.
3. Under **Picture**, select **Upload picture** and choose the file.
4. Check the message at the top: **Picture set.**

![A person opened on the People page, with their picture and the Replace picture and Remove picture buttons](/screenshots/pictures/people.png)

**Replace picture** and **Remove picture** work the same way as for an agent. Only you, the owner, can open these pages: they need the dashboard's access token like the rest of Settings.

## Ask an agent to set its own picture

1. **Browser (or chat):** ask the agent, for example: "Pick a picture for yourself and set it as your profile picture."
2. The agent saves an image as a file in its workspace (a picture it already has, or one it makes with its own tools).
3. The agent sets it with the `agentx_picture` tool, or runs `agentx agent picture set <file>` in its terminal.
4. **Browser:** reload the Wall. The agent's picture shows.

An agent's request is checked by AgentX: it must come from a task that agent is running now. A request for another agent's picture, or one that does not come from a running task, is refused. The agent gets the reason in words.

## Set and remove pictures from the terminal

Run these from the folder that holds `agentx.json`. `cx` and `sara` are example IDs; use your own.

1. **Terminal:** set an agent's picture: `agentx agent picture set ~/Pictures/agent.png --agent cx`
2. **Terminal:** check it: `agentx agent picture show --agent cx`
3. **Terminal:** set a person's picture: `agentx people picture set sara ~/Pictures/sara.jpg`. On a machine with no people list, the owner's ID is `owner`.
4. **Terminal:** remove them again: `agentx agent picture remove --agent cx` and `agentx people picture remove sara`.

When an agent runs `agentx agent picture set <file>` from its own terminal, it leaves out `--agent`: the command always means the agent itself.

## Where pictures are kept

Pictures are files on this computer, under `.agentx/pictures/` in the AgentX folder: `agent/` for agents and `person/` for people. They are not in `agentx.json` and not in any git repository. Each machine of a mesh keeps its own: a picture shows on the dashboard of the machine where it was set.

A new picture gets a new address, so browsers show it on the next page load. Nothing needs a restart.

## Check it worked

1. **Browser:** open the **Wall** and select **Agents**. The agent you gave a picture shows it; the others show their initials.
2. **Browser:** open **Org**. The same picture is next to the agent's name.
3. **Terminal:** run `agentx agent picture show --agent <id>`. It says **picture set**.
4. **Browser:** in Settings, select **Remove picture**, then reload the Wall. The initials are back.

## If something is wrong

- **"SVG pictures are not accepted":** save the image as PNG, JPEG or WebP and try again.
- **"That file is not a picture":** the file is another type, or its name ends in `.png` but it holds something else. Open it in an image viewer and export it as PNG.
- **"The picture is … MB; the limit is 1 MB":** make the image smaller (fewer pixels, or JPEG instead of PNG) and try again.
- **"The picture could not be read":** the file is damaged. Export it again from the program that made it.
- **"Pictures need the "sharp" package":** the image library AgentX uses was not installed on this computer. Reinstall AgentX, or run `npm install -g sharp`.
- **"An agent can only change its own picture":** an agent asked for another agent's picture. Set that one yourself in Settings.
- **"Only an agent sets its own picture, from its own run":** the agent's tool or command did not come from a task it is running, for example when it was run by hand with `AGENTX_AGENT_ID` set. Set the picture in Settings instead.
- **"No agent … in agentx.json" or "No person …":** check the ID with `agentx agent list` or `agentx people list`.
- **The picture does not show on another machine's dashboard:** pictures stay on the machine where they were set. Set it on that machine too.
- **No Upload picture button in Settings:** another machine is picked in the top bar. Pick this computer, or open that machine's own dashboard.

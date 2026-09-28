# Activity — what ran, where, and what it decided

Monitor answers "what needs me?" Activity answers "what ran, where, and what did it decide?" Use Activity to look into a finished task, or a message that seems to have gone to the wrong agent.

Each bar on the timeline is one run: one task an agent worked on. Small marks on a run show what it recorded: a **decision**, a **warning**, **friction** (something that slowed it down), or something to **do later**. A cross marks a **canceled** run.

![Activity timeline from the isolated demo](/screenshots/activity.png)

*The three scripted runs appear on the agent timeline.*

## Find a run

1. **Browser:** open the dashboard and select the **Activity** tab.
2. Pick how far back to look: **6h**, **24h**, **3d** or **7d**.
3. Next to **Lanes by**, pick how to group the runs: **Agent**, **Client**, **Project**, **Channel** or **Node** (machine).
4. Find the lane you care about and the bar at the time you expect.
5. Select the bar. Its details open below the timeline: the route the message took and the outcome.
6. To pick up runs that finished since you opened the page, select **Refresh**.

![Activity grouped by client](/screenshots/activity-by-client.png)

*Grouped by **Client**. Runs whose chat isn't linked to a client land in **unmapped**.*

![Activity grouped by channel](/screenshots/activity-by-channel.png)

*Grouped by **Channel**: where each message came from.*

The **Map** view, next to **Timeline**, draws the whole team as a transit map: projects are lines, agents are stations, and work in progress moves along them.

![The Map view of Activity: channels on the left, the CX agent in the middle, and finished work on the demo shop line](/screenshots/activity/map.png)

The channels on the left are where work comes from. A chat you start in the [phone app](./mobile-app.md), typed or spoken, comes in from **Phone app** and names you (`operator`) as the person who started it. That holds when the agent runs on another computer in your mesh too. In its details, a spoken message says **Voice** and a typed one says **Phone app**. Only work that one agent hands to another shows as **Agent → Agent**.

## Check it worked

1. **Browser:** send an agent a small task, and wait for it to finish.
2. Open **Activity** with **24h** selected.
3. A new bar appears in that agent's lane. Select **Refresh** if the page was already open.
4. Select the bar. Its details show the channel it came from and its result.

## If something is wrong

- **A message never appears:** it may not have reached AgentX at all. Go to [It's not answering](../help/its-not-answering.md) and check whether the channel reached the daemon.
- **Runs sit under unmapped when grouped by Client:** that chat isn't linked to a client yet. The list that links chats to clients is under **Settings › Business**, a tab that only appears when the business features are switched on (`business.enabled` in `agentx.json`). Restart the daemon after changing it.
- **A machine's runs are missing:** that machine may be unreachable. Check [Operations](./operations.md).
- **The timeline is empty:** widen the window to **7d**. Nothing may have run in the last 24 hours.
- **A phone chat shows as Mesh (A2A) or Schedule on the map:** it ran on a computer with an older AgentX, or it was sent before the update. Update AgentX on the computer that runs the agent and on the one your phone is paired with, then restart it there. New phone chats then come in from **Phone app**.

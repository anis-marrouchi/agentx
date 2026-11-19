# Let an agent see your open apps and tabs for one request

![Your agent needs to see what is open on your computer. It asks you with one card, which opens as a popup on your Mac. After your yes, it reads your open apps or browser tabs, each read is logged, and the yes ends by itself. A no, or no answer, and nothing is read.](/diagrams/screen-consent.svg)

Sometimes a request needs what is on your screen: "which document do I have open?", "summarise the tabs I have about the trip". An agent can read three things for one request:

| Source | What it reads | Where it works | Needs your yes |
|---|---|---|---|
| `open-apps` | The app in front, the title of its front window, and the apps you have open. | Mac only | Always |
| `browser-tabs` | The title and address of each open tab in Google Chrome and Safari. The address is cut before `?` and `#`, so search words and codes in it are not read. The page's text is never read. | Mac only | Always |
| `news` | Headlines from the news feeds (RSS or Atom) you list. | Every machine | No, unless you ask for it |

A **source** is one of these places AgentX can read from. **Per request** means the agent reads it only while it works on one task you gave it, never on its own and never in the background.

The rules:

- All three are **off** until you switch them on.
- `open-apps` and `browser-tabs` are read only after **you** say yes, for that one request. Your yes counts only in the popup on your Mac. A message in a chat, another agent, another machine or the command line can say no, never yes.
- Your yes lasts a few minutes (15 unless the agent asks for another time; never more than 60 unless you change it), and then ends by itself. After that a read is refused.
- A yes is for one request: the agent can use it only in the chat or task it asked from, and in the turn where it is told your answer. The same agent in another chat cannot use it.
- Each read is written in a log: when, which source, which agent, for which request. What was read is not kept: it goes only to the agent that asked, and from there to its model, which the card tells you. It is left out of the agent's run history (traces) and the live view of its work.
- The answer never leaves the machine: other machines in your mesh cannot ask for it.
- What the agent then writes back to you is its reply, kept like any other reply.

Limits: a yes counts only from the popup, but a program already running on your Mac with your rights (for example, one that can write AgentX's own files or click on screen for you) could still fake one. Give such tools only to agents you trust.

## Settings

All settings sit under `situations` in the daemon config.

| Setting | Default | What it does |
|---|---|---|
| `situations.sources.open-apps.enabled` | `false` | `true` lets agents ask to read your open apps. |
| `situations.sources.browser-tabs.enabled` | `false` | `true` lets agents ask to read your browser tabs. |
| `situations.sources.news.enabled` | `false` | `true` lets agents read the headlines of your news feeds. |
| `situations.sources.<id>.agents` | all agents | A list of agent ids: only these agents may ask for or read this source. |
| `situations.sources.news.consent` | `none` | `person`: news also needs your yes, as the other two. `open-apps` and `browser-tabs` always need it, whatever this says. |
| `situations.consent.defaultMinutes` | `15` | How long your yes lasts when the agent names no time. |
| `situations.consent.maxMinutes` | `60` | The longest your yes can last, whatever the agent asks. |
| `situations.consent.askMinutes` | `60` | How long the card waits for your answer. No answer: nothing is read. |
| `situations.news.feeds` | none | The addresses of your news feeds (`https://…`). Only you set them; an agent cannot. |
| `situations.news.maxItems` | `10` | Headlines read from each feed. |
| `situations.news.timeoutMs` | `8000` | How long to wait for a feed, in milliseconds. |
| `approvals.popup.enabled` | `false` | The popup on your Mac. It must be on: it is the only place your yes counts. |

## Turn it on

1. **Terminal:** turn on the popup, if it is not on yet: `agentx config set approvals.popup.enabled true`.
2. **Terminal:** switch on a source, for example `agentx config set situations.sources.browser-tabs.enabled true`.
3. **Terminal:** to let only one agent use it, `agentx config set situations.sources.browser-tabs.agents '["helper"]'` (use your agent's id instead of `helper`).
4. **Terminal:** restart the daemon once, so running agents get the `agentx_sources` tool: `agentx restart`. The settings themselves are read at each request.

For `news`, also list your feeds:

1. **Terminal:** `agentx config set situations.news.feeds '["https://news.example.com/feed.xml"]'`.

The first time AgentX reads your browser tabs, macOS asks whether AgentX may control Google Chrome or Safari. Say **OK**. If you said **Don't Allow** before, see [If something is wrong](#if-something-is-wrong).

## What happens when an agent asks

1. You ask an agent something that needs your screen, for example "which of my open tabs is the booking page?".
2. The agent asks you. A popup opens on your Mac: "helper asks to read your browser tabs (titles and addresses)", with how many minutes, its reason in quotes, and that what it reads goes to its model.
   ![The popup: "helper asks to read your browser tabs (titles and addresses)", for 15 minutes from your yes, with the agent's reason in quotes, and the buttons Not now, No and Yes.](/screenshots/screen-for-a-request/consent-card.png)
3. **Popup:** click **Yes** to let it read, or **No**. If you do nothing, the card expires after `askMinutes` and nothing is read.
4. After a yes, the agent reads and answers you. It can read again for the same request until the yes ends. In the plain-dialog popup style, the Return key picks **Not now**, never **Yes**.

A yes is for one agent, the sources named on the card, and the time on the card. Another agent cannot use it.

## See what was read

1. **Terminal:** run `agentx situation reads`.
2. Each line is one read: the time, the source, the agent, how it went (`read`, `empty` or `down`) and the request (the card's id).
3. **Terminal:** to see the reads of one request, `agentx situation reads --request <card id>`.

The log holds no content. It works only on the machine itself.

## Switch it off

1. **Terminal:** `agentx config set situations.sources.browser-tabs.enabled false` (or `open-apps`, `news`).
2. Reads are refused from the next request on. A yes already given stops counting at once, because the source is off.

## Check it worked

1. **Terminal:** run `agentx situation sources`. `open-apps`, `browser-tabs` and `news` are listed, marked "per request" (the first two "with the person's yes").
2. Ask an agent that may use the source: "which tabs do I have open?".
3. **Popup:** the card opens on your Mac. Click **Yes**.
4. The agent answers with your tabs.
5. **Terminal:** run `agentx situation reads`. One line per read, with the card's id.
6. Ask again, and click **No** this time. The agent says it cannot read them, and `agentx situation reads` shows no new line.

## If something is wrong

- **The agent says the ask was refused because the popup is off.** Turn it on: `agentx config set approvals.popup.enabled true`. The popup works only on a Mac, so on another machine nothing can be read from apps or tabs.
- **A read says "off: a per-request source is read only when … enabled is true".** Switch the source on (see [Turn it on](#turn-it-on)).
- **A read says "off for this agent".** The source is limited to other agents in `situations.sources.<id>.agents`.
- **A read says "no consent".** There is no yes for that request yet, the yes ended, the card was answered somewhere other than the popup, or another agent asked for it. The agent asks again if the request still needs it.
- **The agent does not have the `agentx_sources` tool.** Restart the daemon after switching a source on: `agentx restart`.
- **Tabs come back as "not read: … not allowed".** macOS blocked AgentX from Chrome or Safari. **System Settings › Privacy & Security › Automation**, find the app that runs AgentX (Terminal, or `node`), and turn on Google Chrome and Safari.
- **The window title is "unknown".** macOS needs Accessibility permission to read window titles: **System Settings › Privacy & Security › Accessibility**, turn on the app that runs AgentX. The front app and the list of apps are still read.
- **News says "no feeds".** Set `situations.news.feeds`.

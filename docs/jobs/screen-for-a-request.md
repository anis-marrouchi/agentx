# Let an agent see your open apps for one request

![Your agent needs to see what is open on your computer. It asks you with one card, which opens as a popup on your Mac. After your yes, it reads your open apps, each read is logged, and the yes ends by itself. A no, or no answer, and nothing is read.](/diagrams/screen-consent.svg)

Sometimes a request needs what is on your screen: "which app do I have in front?", "is my mail app open?". An agent can read these things for one request:

| Source | What it reads | Where it works | Needs your yes |
|---|---|---|---|
| `open-apps` | The name of the app in front and the names of the apps you have open. Never a window's title or what is in it. | Mac only | Always |
| `browser-tabs` | The title and site of each open tab in Google Chrome and Safari. **Not available yet**: see [Why tabs are not read yet](#why-tabs-are-not-read-yet). | Mac only | Always |
| `news` | Headlines from the news feeds (RSS or Atom) you list. | Every machine | No, unless you ask for it |

A **source** is one of these places AgentX can read from. **Per request** means the agent reads it only while it works on one task you gave it, never on its own and never in the background.

The rules:

- All of them are **off** until you switch them on.
- `open-apps` is read only after **you** say yes, for that one request. Your yes counts only when you click it in the popup that the AgentX daemon opens on your Mac. A message in a chat, another agent, another machine, the command line or an edited file can say no, never yes. If the daemon restarts, every yes ends, and cards asked before the restart are no longer shown.
- Your yes lasts a few minutes (15 unless the agent asks for another time; never more than 60 unless you change it), and then ends by itself. After that a read is refused.
- The popup shows the card as AgentX wrote it when the agent asked. If the card's file is changed afterwards, the popup does not show it, and a yes clicked while it was changed counts for nothing.
- A yes is for one request: the agent can use it only in the task it asked from, and in the turn AgentX starts to tell it your answer. A later message in the same chat cannot use it.
- One yes allows at most 3 reads (you can change this).
- An agent can have only one card waiting for you. After you say no, or do not answer, it cannot ask again for 30 minutes (you can change this).
- The card tells you which chat asked. The agent's answer may be posted in that chat, so anyone in that chat may see it.
- Each read is written in a log: when, which source, which agent, for which request. What was read is not kept by AgentX: it goes only to the agent that asked, and from there to its model, which the card tells you.

### Where what was read still ends up

AgentX leaves what was read out of the agent's run history (traces), the live view of its work, the progress check that watches long turns, and tool hooks. It still ends up in these places, like anything else the agent sees:

- **The agent's model**, as the card says.
- **The agent's session file** on your Mac (for Claude Code agents, under `~/.claude/projects/`). A later turn that resumes the same session can see it again.
- **The agent's reply** to you, kept like any other reply, and posted in the chat that asked.

### Why tabs are not read yet

To read your tabs, macOS must allow a program to control Google Chrome and Safari (the **Automation** permission). If AgentX itself had that permission, every agent it starts would have it too, because agents run inside it. Any agent could then read all your tabs, or click **Yes** for you, without the popup or the log.

So AgentX reads tabs only through a separate small app that alone holds that permission. That app does not exist yet. Until it does, `browser-tabs` shows as "not loaded" in `agentx situation sources`, and an agent that asks for it is refused. Do not give Terminal or `node` the Automation or Accessibility permission to work around this.

Your open apps are read with a macOS tool (`lsappinfo`) that needs no extra permission.

### News is outside text

Headlines come from websites you do not control. A headline could be written to look like an instruction to the agent. The agent is told they are outside text, but read its answer with that in mind. AgentX fetches only public addresses (never your own network or the machine itself, even after a redirect, and it connects to the exact address it checked) and stops after about 1 MB per feed.

### Limits

- A yes counts only from the daemon's popup, but a program already running on your Mac with your rights (for example, one that can click on screen for you) could still click it. Give such tools only to agents you trust.
- Each agent turn gets a secret that proves it to AgentX. Agents run as the same macOS user, so an agent with a shell that looks at other running programs could find another turn's secret. The secret stops guessing from public ids, not that.

## Settings

All settings sit under `situations` in the daemon config.

| Setting | Default | What it does |
|---|---|---|
| `situations.sources.open-apps.enabled` | `false` | `true` lets agents ask to read your open apps. |
| `situations.sources.browser-tabs.enabled` | `false` | `true` lets agents ask to read your browser tabs, once a separate reader exists. Today it has no effect. |
| `situations.sources.news.enabled` | `false` | `true` lets agents read the headlines of your news feeds. |
| `situations.sources.<id>.agents` | all agents | A list of agent ids: only these agents may ask for or read this source. |
| `situations.sources.news.consent` | `none` | `person`: news also needs your yes. `open-apps` and `browser-tabs` always need it, whatever this says. |
| `situations.consent.defaultMinutes` | `15` | How long your yes lasts when the agent names no time. |
| `situations.consent.maxMinutes` | `60` | The longest your yes can last, whatever the agent asks. |
| `situations.consent.askMinutes` | `60` | How long the card waits for your answer. No answer: nothing is read. |
| `situations.consent.maxReads` | `3` | How many reads one yes allows. |
| `situations.consent.reaskMinutes` | `30` | After a no, or no answer, how long the agent must wait before it may ask again. `0`: no wait. |
| `situations.browserTabs.includePaths` | `false` | `true` also gives each tab's path after the site (for example `/docs/start`). Paths can hold names or codes. Never the part after `?` or `#`. |
| `situations.news.feeds` | none | The addresses of your news feeds (`https://…`). Only you set them; an agent cannot. |
| `situations.news.maxItems` | `10` | Headlines read from each feed. |
| `situations.news.timeoutMs` | `8000` | How long to wait for a feed, in milliseconds. |
| `approvals.popup.enabled` | `false` | The popup on your Mac. It must be on: it is the only place your yes counts. |

## Turn it on

1. **Terminal:** turn on the popup, if it is not on yet: `agentx config set approvals.popup.enabled true`.
2. **Terminal:** switch on a source, for example `agentx config set situations.sources.open-apps.enabled true`.
3. **Terminal:** to let only one agent use it, `agentx config set situations.sources.open-apps.agents '["helper"]'` (use your agent's id instead of `helper`).
4. **Terminal:** restart the daemon once, so running agents get the `agentx_sources` tool: `agentx restart`. The settings themselves are read at each request.

For `news`, also list your feeds:

1. **Terminal:** `agentx config set situations.news.feeds '["https://news.example.com/feed.xml"]'`.

## What happens when an agent asks

1. You ask an agent something that needs your screen, for example "which app do I have in front?".
2. The agent asks you. A popup opens on your Mac: "helper asks to read your open apps (names only)", with how many minutes, the chat that asked, its reason in quotes, and that what it reads goes to its model.
   ![The popup: "helper asks to read your open apps (names only)", for 15 minutes from your yes, the chat that asked, the agent's reason in quotes, and the buttons Not now, No and Yes.](/screenshots/screen-for-a-request/consent-card.png)
3. **Popup:** click **Yes** to let it read, or **No**. If you do nothing, the card expires after `askMinutes` and nothing is read.
4. After a yes, the agent reads and answers you. It can read again for the same request, up to `maxReads` times, until the yes ends. In the plain-dialog popup style, the Return key picks **Not now**, never **Yes**.

A yes is for one agent, the sources named on the card, the time on the card and the task that asked. Another agent, or another task, cannot use it.

## See what was read

1. **Terminal:** run `agentx situation reads`.
2. Each line is one read: the time, the source, the agent, how it went (`read`, `empty` or `down`) and the request (the card's id).
3. **Terminal:** to see the reads of one request, `agentx situation reads --request <card id>`.

The log holds no content. It works only on the machine itself.

## Switch it off

1. **Terminal:** `agentx config set situations.sources.open-apps.enabled false` (or `news`).
2. Reads are refused from the next request on. A yes already given stops counting at once, because the source is off.

## Check it worked

1. **Terminal:** run `agentx situation sources`. `open-apps` and `news` are listed, marked "per request" (`open-apps` "with the person's yes"). `browser-tabs` is listed as not loaded, with the reason.
2. Ask an agent that may use the source: "which apps do I have open?".
3. **Popup:** the card opens on your Mac. Click **Yes**.
4. The agent answers with your open apps.
5. **Terminal:** run `agentx situation reads`. One line per read, with the card's id.
6. Ask again in a new message, and click **No** this time. The agent says it cannot read them, and `agentx situation reads` shows no new line.

## If something is wrong

- **The agent says the ask was refused because the popup is off.** Turn it on: `agentx config set approvals.popup.enabled true`. The popup works only on a Mac, so on another machine nothing can be read from your apps.
- **A read says "off: a per-request source is read only when … enabled is true".** Switch the source on (see [Turn it on](#turn-it-on)).
- **A read says "off for this agent".** The source is limited to other agents in `situations.sources.<id>.agents`.
- **The agent says its card was not shown: "the card was changed after it was asked" or "this daemon did not raise this card".** The card's file was changed, or the daemon restarted after the ask. The agent can ask again.
- **A read says "no consent (…)".** The words in brackets say why: no yes yet, the yes ended, it was used for its reads already, the daemon restarted since your yes, it was answered somewhere other than the popup, or another agent or task asked for it. The agent may ask again if the request still needs it.
- **The agent says "a card of yours is still waiting" or "less than 30 minutes ago".** It asked already. Answer the waiting card, or wait for the pause to end.
- **The agent says "no running turn of yours was found".** The call did not come from inside the agent's own turn with its secret. Restart the daemon after updating AgentX, so agents get the secret.
- **The agent does not have the `agentx_sources` tool.** Restart the daemon after switching a source on: `agentx restart`.
- **`browser-tabs` is "not loaded".** That is expected for now: see [Why tabs are not read yet](#why-tabs-are-not-read-yet).
- **News says "refused: … is a private address".** A feed, or a page it redirects to, is on your own network. Only public feeds are read.
- **News says "no feeds".** Set `situations.news.feeds`.

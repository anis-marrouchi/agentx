# Put an AI teammate on the tools your team already uses

<a href="https://www.producthunt.com/products/agentx-4?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-agentx-5" target="_blank" rel="noopener noreferrer"><img alt="AgentX - AI teammates in the tools your team already uses | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1258056&amp;theme=light&amp;t=1790073592268" /></a>

New here? [Before you start](requirements.md) lists what you need, how to install it, and how to check it works.

AgentX runs AI agents for a team. Connect a channel (a chat or work tool such as Telegram or GitLab), give an agent a job, and see what happened in the browser dashboard. A technical teammate installs it on a machine you control; operators can then use the browser for everyday work.

AgentX has two parts that run side by side:

- The **daemon** is the background service that receives messages, runs agents and runs scheduled jobs.
- The **dashboard** is the website you open in your browser to set things up and watch the work.

![The Live tab of the dashboard in the demo](/screenshots/live.png)

## Where to start

- **Try it without a model account:** [see the demo](./see-it-first.md). It uses real AgentX daemons and scripted model replies, so it makes no paid model calls.
- **Set up your own team:**
  1. [Install AgentX](./install.md).
  2. [Create your first agent](./first-agent.md).
  3. [Connect Telegram](./connect-telegram.md).

The dashboard has six main tabs: [Live](./dashboard/live.md), [Operations](./dashboard/operations.md), [Monitor](./dashboard/monitor.md), [Activity](./dashboard/activity.md), [Workflows](./dashboard/workflows.md), and [Settings](./dashboard/settings.md). Start with Monitor to understand what still needs a person and what agents can handle.

## More ways to work with your agents

- [In-page chat](dashboard/chat.md): ask about the dashboard view you are looking at.
- [AgentX Voice](guides/agentx-voice.md): talk to any agent from anywhere on your Mac, and hear it answer in its own voice.
- [Desktop assistant](dashboard/voice.md): talks between agents, live lessons, narration and automations.
- [Terminal UI](dashboard/tui.md): use OpenCode as the conversation interface.
- [Tailscale setup](jobs/tailscale.md): connect machines privately.
- [Agent-to-agent communication](reference/a2a.md): send work to agents on other machines, or connect an outside tool that speaks A2A (an open standard for agents talking to each other).

## Learn one step at a time

1. **See it:** [follow the annotated workflow tour](tutorials/first-workflow.md).
2. **Try it:** [record a VS Code walkthrough](tutorials/record-vscode.md).
3. **Understand it:** [architecture](architecture/overview.md) and [Jev decisions](architecture/jev.md) (small yes-or-no and pick-one questions that AgentX can hand to a cheaper, faster model).
4. **Use it from a terminal:** [command reference](reference/cli.md).

## Check it worked

Once AgentX is installed:

1. **Terminal:** run `agentx daemon status`. It prints `Status: running` and lists your agents.
2. **Browser:** open the dashboard (by default `http://127.0.0.1:4202/live`). The **Live** tab shows your agents.

## If something is wrong

- **You don't have AgentX yet:** start with [Before you start](requirements.md), then [Install](install.md).
- **The dashboard opens but agents don't answer:** the daemon and the dashboard are separate. Check the daemon with `agentx daemon status`, then follow [It's not answering](help/its-not-answering.md).
- **A word on these pages is unclear:** look it up in the [glossary](reference/glossary.md).

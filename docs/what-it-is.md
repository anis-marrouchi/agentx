# What AgentX is

AgentX runs and keeps track of AI agents for a team. Four words cover most of it:

- An **agent** is an AI assistant that does work for you. It has its own folder of files (its workspace), written instructions, and a model (the AI service that writes its replies).
- A **channel** brings in a message from a tool your team already uses, such as Telegram or GitLab.
- A **schedule** starts work at set times, without anyone sending a message.
- A **workflow** is a series of steps, such as "read the report, then post a summary".

AgentX receives the message, picks the right agent, starts it, and records what happened.

The model is an online service. Each time an agent works, your message, the agent's instructions and the files it reads go to that model's provider so it can write the reply. [Your data](./your-data.md) lists everything that leaves your machine and how to keep it at home.

## The two parts you run

You host AgentX yourself, on a machine you control.

- The **daemon** is the background service. It receives messages and runs agents and scheduled work.
- The **dashboard** is a separate small web server. It shows the setup pages and the daily views in your browser.

The dashboard can be open while the daemon is stopped. When work isn't arriving, check both.

![The Live tab showing agents on three demo machines](/screenshots/live.png)

## One machine or several

You can begin with one agent on one machine. If some work belongs on another computer, AgentX can connect machines so that they pass tasks to each other. Each connected machine is a **node**, and the connected group is the **mesh**. You don't need a second machine for your first agent.

Other words you'll meet are explained in the [glossary](reference/glossary.md).

Next: [see it in a demo](./see-it-first.md) or [install it](./install.md).

## Check it worked

This page explains ideas; there's nothing to set up yet. You're ready to continue if you can say what the daemon does and what the dashboard does.

## If something is wrong

- **A term here doesn't match what you see:** check the [glossary](reference/glossary.md).
- **You want to see it before installing:** run the [demo](./see-it-first.md). It needs no model account.

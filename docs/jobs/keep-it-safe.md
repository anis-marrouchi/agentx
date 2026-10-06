# Keep it safe

AgentX agents act for real: they post messages, change issues and run commands. Most of that happens without asking you first. [What always waits for you](#what-always-waits-for-you) says exactly which actions stop for your yes, and a few habits keep the rest under control.

- Know what leaves your machine. Your messages, the agent's instructions and the files it reads go to the model provider. See [Your data](../your-data.md).
- Give each agent only the credentials and access it needs.
- Keep secrets (bot tokens, API keys, passwords) in the `.env` file next to `agentx.json`. `agentx.json` only refers to them by name, such as `${GITLAB_TOKEN}`. Never put a secret in a public document, an issue or a screenshot.
- Try new automations on a test channel and a test project before they touch real work.
- For a generated workflow, check every step and destination before saving. **Apply to canvas** replaces the whole current workflow.
- For a schedule, check its timezone and what happens when it fails.
- Review [Activity](../dashboard/activity.md) after the first run.
- Keep the daemon on a trusted local or private network. See [Tailscale setup](tailscale.md) for a private network between machines, and [Dashboard on your own address](reverse-proxy.md) if you put the dashboard behind a web server.
- Let a person or a machine in the way that fits them, and no wider. The table below says which.

## What always waits for you

An agent does most of its work on its own. Only the actions below stop and wait in **Approvals** until you say yes (see [Approvals](../dashboard/approvals.md)):

| The agent wants to… | What happens |
|---|---|
| Ask you a question with a **decision card** | It waits for your yes or no. If nobody answers before it expires, the card applies its own default: see [When nobody answers a card](#when-nobody-answers-a-card). |
| Create or remove a **schedule** | Nothing runs or stops until you approve it. See [Ask an agent to schedule something](../automations/schedules-from-chat.md). |
| Keep a **fact it learned from an outside source** | The agent can't use it until you approve it. See [Review what your agents learn](agent-memory.md). |
| Add a **lesson to the shared wiki** | Nothing is written until you approve it. |
| **Reply in a watched WhatsApp chat** | The draft waits; nothing is sent until you approve it. A rule can allow short acknowledgements without asking. See [Watch a WhatsApp chat](watch-whatsapp.md). |
| Pick up a **request of yours that was not finished** | It is only handed back to the agent when you say yes. See [Keep track of what you asked for](open-requests.md). |

Everything else, the agent does **without asking**: replying in chat, posting comments, changing issues, editing files in its folder, running commands, and calling the tools and services you connected to it. A rule in an agent's instructions, such as "send nothing", is something the agent is told, not a lock.

What limits those actions is the agent's **tool permissions** (`permissionMode` in `agentx.json`, **Tool permissions** on the agent's page in the dashboard). An agent runs with nobody at its keyboard, so no step ever comes to you for a yes:

| Tool permissions | `permissionMode` | What the agent may do without asking |
|---|---|---|
| **Ask first** (the default) | `"default"` | Only the steps its engine allows without asking. A step that would need permission is refused, not sent to you. On a `claude-code` agent, dangerous commands, such as wiping a disk, are always blocked. |
| **Accept edits**, **Plan only** | `"acceptEdits"`, `"plan"` | The same as **Ask first**. **Plan only** also blocks commands that delete files or data. |
| **Trusted** | `"bypassPermissions"` | Anything its engine can do, without asking. On a `claude-code` agent, only the always-blocked dangerous commands are still refused. |

To keep an agent from acting on something, don't rely on its instructions: leave out the credential or tool it would need, or keep it on **Ask first**.

### When nobody answers a card

Every decision card expires, after 3 days unless the agent asked for another time. When it expires, the agent is told that nobody answered and what it said it would do then: `discard` (drop it), `keep` (leave things as they are) or `pause` (stop that piece of work). The agent picks one of the three when it raises the card.

**A card never says yes by itself.** Only you can approve. A card an agent raised asking for `approve` on expiry, or one saved by an older version of AgentX, is treated as `keep`. That includes a card that already expired as `approve` before you upgraded: its agent is told `keep`. The card's file still records that `approve` was asked for, in the `if_silent_asked` field.

## Who gets which way in

There are five ways of letting someone or something reach this machine. Each hands over a different amount of what is yours, so pick by who is asking, not by what is quickest.

| Who or what | What they get | Page |
|---|---|---|
| Your own phone | The dashboard in a small form: chat with every agent, your computers, activity and alerts. One key per phone, tied to the phone, not to a person. | [Phone app](../dashboard/mobile-app.md) |
| A machine of your own | The mesh password. A machine that holds it can send work to every agent in the mesh and control the other machines' daemons. | [Add a second machine](second-machine.md), [Connect machines with Tailscale](tailscale.md) |
| A teammate, listed in your [people](people.md) with the role `member` | One page, **My work**: their own requests and the agents they use. Of your work, only a short preview of what an agent is busy with right now. One key per machine, and a new machine does nothing until you say yes. | [Invite a teammate to their work page](members.md) for you, [Join My work](join-my-work.md) for them |
| Another organisation that runs AgentX | One agent of yours, working for them inside a grant you set: folders, skills, how much freedom, an end date. They see only the answers to their own requests, and your agent works on your machine, not theirs. | [Let another organisation into part of your mesh](guest-mesh.md) |
| A client, listed in your [people](people.md) with the role `client` | One page, **Your project**: their own requests and where they stand, with no agent named and nothing of your other work. The same pairing as a teammate: one key per machine, nothing until you say yes. Never their phone in the phone app, never their machine in the mesh. | [Give a client a page of their own](clients.md) for you, [Join Your project](join-your-project.md) for them |

Whichever way you pick, the person or machine reaches you over your private network (Tailscale), never over the public internet.

## Give a script or another tool its own token

A **token** is a password for software. Anything that talks to AgentX from outside (a script, a chat bridge, another AgentX machine) should use its own token, limited to what it needs, so you can cut it off without affecting anything else.

1. **Browser:** open the dashboard and select **Settings**.
2. Select the **Tokens** tab.
3. Under **Name**, say who or what the token is for.
4. Under **Scopes**, tick only what it needs. For example, **dashboard:read** only lets it read the dashboard.
5. Optional: under **Expires after**, enter a number of days.
6. Select **Create token**.
7. Copy the token straight away and store it in the tool that needs it. You can't see it again after you leave the page.

![Settings › Tokens with the form to mint a new token](/screenshots/settings-tokens.png)

From the terminal, `agentx token create --name "<label>" --scope dashboard:read` does the same, and `agentx token list` shows existing tokens without their secrets.

## Replace a token that leaked

1. **Browser:** in **Settings › Tokens**, select **Revoke** next to the leaked token. Anything using it stops working at once.
2. Create a new token as above.
3. Put the new token in the tool that used the old one.

For a bot token or API key that leaked, create a new one with the service that issued it (for example, BotFather for Telegram), replace the value in `.env`, and restart the daemon.

## Check it worked

1. **Browser:** **Settings › Tokens** lists each token by name. A revoked token no longer has a **Revoke** button.
2. **Terminal:** `grep -n "token" agentx.json` shows only references such as `${GITLAB_TOKEN}`, never a real secret.
3. **Terminal:** `agentx mesh list` and `agentx app devices` name only machines and phones of your own, and `agentx people devices` names only people you invited on purpose.

## If something is wrong

- **An agent did something you expected it to ask about:** only the actions in [What always waits for you](#what-always-waits-for-you) wait for you. Check the agent's **Tool permissions** and what it has access to.
- **A card shows `then: keep` although the agent asked for `approve`:** that is expected. A card never approves itself; answer it yourself if the work should go ahead.
- **A tool is refused after you revoked a token:** that is expected. Give it the new token.
- **A tool is refused with a new token:** the token may lack the scope it needs, or have expired. Create a new token with that scope and revoke the old one.
- **A real secret is in `agentx.json`:** move it to `.env`, replace it in `agentx.json` with `${NAME}`, and treat the old value as leaked.
- **A teammate's or a client's phone is in `agentx app devices`:** that key opens chat with every agent of yours. Run `agentx app revoke <id>` with the id from the list, then invite them the right way from the table above.
- **A teammate's or a client's machine is in `agentx mesh list`:** it holds the mesh password. Run `agentx mesh remove <name>`, then treat the password as leaked: set a new one in `.env` on each of your machines and restart their daemons.
- **You found a security problem in AgentX itself:** report it as described in the [security policy](https://github.com/anis-marrouchi/agentx/blob/main/SECURITY.md).

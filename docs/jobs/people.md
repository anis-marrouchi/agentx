# Tell agents who is who

The same human can reach your agents in several places: a GitLab comment in the morning, a WhatsApp message in the afternoon. To AgentX these are two unrelated senders until you say they are one person. The `people` list does that: one entry per human, with the logins and numbers that belong to them.

Once a person is listed, every task they start is stamped with their id, whatever channel they used. You can then see everything one person asked for in one place.

Nothing changes until you add someone. With an empty list, what you do on your own machine (voice, the phone app, the dashboard) is recorded as the built-in person `owner`, and senders on other channels are unknown.

## What a person is

| Part | What it means |
|---|---|
| id | A short name you choose, such as `sara`. Lower-case letters, digits, `-` and `_`. |
| name | Their name as you want to read it. |
| role | `owner`, `member` or `guest`. Today the role is a label; only `owner` has an effect (see below). Access rules per role come later. |
| identities | Where they write from, each as `channel:id`: `gitlab:sara.b`, `github:sara-b`, `telegram:123456789`, `whatsapp:21620123456`. |

Which value to use on each channel:

| Channel | Use |
|---|---|
| GitLab, GitHub | The login (the part after `@`). |
| Telegram | The numeric user id, or the username. |
| WhatsApp | The phone number with its country code. Spaces and `+` are ignored. |

Display names are never matched, because anyone can choose one. A sender that matches nobody stays unknown; AgentX does not guess.

## Add yourself

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx people add anis --name "Anis" --role owner --identity telegram:123456789`. Use your own id, name and Telegram id.
3. Add each other place you write from: run `agentx people link anis github:your-login`.
4. Run `agentx people list` to read the result.

The running daemon picks the change up at once. If it is not running, the change applies at the next start.

With one owner listed, your messages on those channels count as yours for [open requests](../reference/config-automation.md#requests) too. You no longer need the same values in `requests.from`.

## Add a teammate

1. **Terminal:** run `agentx people add sara --name "Sara" --identity gitlab:sara.b`. The role is `member` unless you give `--role`.
2. Run `agentx people link sara "whatsapp:+216 20 123 456"` to add their WhatsApp number.

Each identity belongs to one person. Giving the same login or number to a second person is refused.

## See what a person asked for

1. **Terminal:** run `agentx people show sara`.
2. You see the person, their open requests if you use them, and their latest tasks with the time, channel, agent and first words. GitLab and WhatsApp tasks appear in the same list.

Add `--limit 50` for a longer list, or `--json` for a script.

## Change or remove

- **Take an identity away:** `agentx people unlink sara gitlab:sara.b`.
- **Remove a person:** `agentx people remove sara`. Their past tasks keep the id `sara`. New messages from them are unknown.

You can also edit `people` in `agentx.json` by hand; the fields are in the [configuration reference](../reference/config-agents.md#people).

## What is not stamped

- Work that software starts: scheduled jobs, workflows, and a comment an agent posts with your GitLab or GitHub account.
- A second owner at your own machine. With two people in the `owner` role, AgentX cannot tell who is speaking to the Mac or using the dashboard, so those tasks have no person. Messages on Telegram, WhatsApp, GitLab and GitHub are still matched.
- Tasks from before you listed the person.

When an agent hands work to another agent, or to an agent on another machine, the person's id goes with it. The other machine keeps the id even when its own list does not have that person.

## Check it worked

1. Send a message to an agent from a channel you listed.
2. **Terminal:** run `agentx people show <your id>`.
3. The message is in the list of latest tasks, with the channel you used.

## If something is wrong

- **The task is not in the list:** the sender did not match. Run `agentx people list` and compare the identity with the login, id or number on that channel. On Telegram use the numeric id if the username does not match.
- **`identity … belongs to both`:** the login or number is already on another person. Run `agentx people unlink <id> <channel:id>` on the first one.
- **`write it as channel:id`:** the identity has no channel in front. Write `gitlab:sara.b`, not `sara.b`.
- **Tasks on voice or the dashboard have no person:** two people have the `owner` role. Keep one owner and make the other a `member`.

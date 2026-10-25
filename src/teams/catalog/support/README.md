# Support desk from your docs

**Result:** Every customer question on Telegram gets an answer from your own documents, with the page it came from, and each evening you get the questions your documents could not answer.

**First result:** the first question a customer sends after you connect Telegram is answered within minutes, with its source. The first evening list arrives at 18:00 on the next weekday.

## Who is in the team

| Agent | What it does |
|---|---|
| `support` | Answers questions on Telegram, and by email if you connect a mailbox, from the documents in `docs/`, ends each answer with `Source: docs/<file>`, and writes what the documents do not cover in `open-questions.md` for you. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `support-evening-open-questions` | Monday to Friday, 18:00 | The questions still waiting on you, and how many were answered from your documents. |
| `support-weekly-doc-gaps` | Friday, 16:00 | The week's unanswered topics, with the document to add each one to. |

## Install it

1. Run `agentx team add support` in the folder that holds your `agentx.json`.
2. Copy your guides, FAQs and policies into `agents/support/docs/`, as `.md` or `.txt` files.
3. Run `agentx connect telegram --agent support` and follow the steps to pair your bot.
4. Optional, a support mailbox: run `agentx connect email --agent support`. Each email reply, with its `Source:` line, waits in Approvals until you send it. See `docs/jobs/answer-email.md`.

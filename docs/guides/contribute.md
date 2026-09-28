# Contribute to AgentX

People are the heart of AgentX. Your experience, judgment and ideas are what make it useful, and every contribution is equally welcome, however it was written.

There are two ways to open an issue. Pick the one you like.

## Write it yourself

1. In the browser, open the [new issue page](https://github.com/anis-marrouchi/agentx/issues/new/choose).
2. Pick the form that fits: **Bug report**, **Enhancement**, **Feature**, **Integration**, **Idea** or **Docs**. **Installation or upgrade problem** and **Share your mesh** are there too.
3. Fill in the form and press **Create**.

## Let your agent help

`agentx contribute` is an optional helper. Your own AgentX agent looks for duplicates, drafts the issue in the right form with you, and gives you a link to a filled-in form. You read it, change what you like, and submit it yourself. Nothing is posted for you.

1. In a terminal, install the skill in your agent's workspace folder: `agentx skill install anis-marrouchi/agentx/agentx-contribute`
2. Ask your agent, in any channel: "Help me file an AgentX issue about …"
3. Answer its questions and review the draft it shows you.
4. Open the link it gives you, check the form, and press **Create**.

The helper only drafts with a recommended model, listed in [`contrib/models.json`](https://github.com/anis-marrouchi/agentx/blob/main/contrib/models.json). The list keeps drafts clear and consistent, and it changes as models improve. If your agent runs another model, it tells you so and points you to the web form. That says nothing about you or your idea.

The issue ends with a short footer noting it was prepared with AgentX: the model, the AgentX version, and the category. The model is what your agent reports; it is information, not a judgment of the contribution.

### The commands behind the skill

You can also run them yourself in a terminal:

| Command | What it does |
| --- | --- |
| `agentx contribute` | Shows both ways to contribute |
| `agentx contribute check-model <model>` | Says whether a model is on the recommended list |
| `agentx contribute search <words...>` | Lists open issues that match, most-voted first |
| `agentx contribute draft <file> --model <model>` | Turns a draft JSON file into a pre-filled form link; `-` reads the draft from standard input |

`check-model` and `draft` read the list from GitHub. Add `--models <path or URL>` to read another copy, such as `contrib/models.json` in a checkout.

## Vote for what matters to you

The community decides together what matters most.

1. In the browser, open the [open requests, most voted first](https://github.com/anis-marrouchi/agentx/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc).
2. Open a request you care about.
3. Under the first message, add a 👍 reaction. That is your vote. Comments do not count, so discussion stays free.

Before you open a new request, you are warmly invited to vote on a few open ones. It is an invitation, never a requirement.

Some reactions are not counted: the issue author's own, reactions from bots, and reactions from accounts younger than 7 days. Bugs are not voted on; they are fixed in order of severity, as described in the [maintainer runbook](https://github.com/anis-marrouchi/agentx/blob/main/.github/maintainer/TRIAGE.md).

Every day, a GitHub Action counts the votes. The top 5 requests with at least 5 votes appear in the README, and the full list is on [Most requested](../community/most-requested.md). The numbers live in `contrib/voting.json`. Votes help guide the roadmap; maintainers make the final decisions and explain them.

## Check it worked

1. In a terminal, run `agentx contribute check-model claude-sonnet-5`. It says the model is on the recommended list.
2. Run `agentx contribute search voice`. It lists open issues with their 👍 counts, or says none match.
3. After you vote, the next day's [Most requested](../community/most-requested.md) list includes your vote, unless it is one of the reactions that are not counted.

## If something is wrong

- **`agentx: unknown command 'contribute'`.** Your AgentX is older than this feature. Update AgentX, or use the web form.
- **"Could not read the model list".** Your computer cannot reach GitHub. Try again later, pass `--models` with a local copy, or use the web form.
- **"GitHub search failed (HTTP 403)".** GitHub limits searches without an account to a few per minute. Wait a minute and try again.
- **"The draft is too long for a pre-filled link".** Shorten the draft, or paste it into the web form yourself.
- **The form opens but a field is empty.** Copy the text from the draft into that field before you press **Create**.

# Follow workflows in a floating window

![The progress widget: four running workflows. The first waits for your yes or no, the second is blocked and has a box to answer the agent, the third waits for a client's reply, the fourth is running.](/screenshots/workflows/widget.png)

When agents run [follow-up workflows](./follow-up-workflows.md) for you, the **progress widget** shows them in a small window that can stay above your other windows. You see each running workflow without opening the Workflows page:

- its title, the step it is on, and who that step waits for (you, an agent, a person or a timer);
- whether it is **running**, **waiting**, **blocked** (an agent cannot go on without you) or **needs you** (a yes/no question for you);
- when it last moved, its tags (such as `client:example-co`) and the computer it runs on.

The list updates by itself as steps move on. Workflows that wait on you come first, and you can answer them from the widget. The phone app shows the same list on its Activity tab.

## Open it on your computer

1. **Terminal:** run `agentx workflow widget`. Your browser opens the widget. You can also open it from the dashboard: in the **Workflows** tab, click **Floating view** next to **Follow-ups**.
2. **Browser:** click **Keep on top**.
3. In Chrome or Edge (on macOS, Windows or Linux), the list moves into a small window that stays above all your other windows. Drag it wherever you like; the browser remembers where you put it. Click **Put back**, or close the small window, to bring the list back into the tab.
4. In other browsers (Safari, Firefox), **Keep on top** opens the list in a small separate window in the corner set by `position`. These browsers cannot keep a window above the others, so put it where it stays visible.

To see only one client or project, open it with a tag: `agentx workflow widget --tag client:example-co`.

The widget needs the [dashboard](../dashboard/index.md) running on the computer (`agentx board`, or the service that `agentx setup` installs).

## Answer from the widget

A workflow that waits on you has a yellow border.

**Needs you** means a step asks you a yes/no question on a [decision card](../dashboard/approvals.md):

1. **Browser:** read the step and the question under the title.
2. **Browser:** click **Yes** or **No**. The workflow goes on with your answer.
3. If the card offers more than yes or no, it shows **Choose in Approvals** instead: click it and pick in the Approvals inbox. **Details** opens the inbox for any card.

**Blocked** means an agent step cannot go on without you, for example because it needs a password:

1. **Browser:** read why it is blocked, under the step.
2. **Browser:** type what the agent should do in the box, for example where to find the password.
3. **Browser:** click **Send**. The agent gets your answer with the workflow's name and step, and carries on. Its reminders start again, and if it still cannot go on it tells you once more.

While you type an answer, the widget holds its updates and the line under the heading says **Paused while you type**, so a new update never wipes your answer. It catches up right after you send. If you empty the box or switch to another window instead, it catches up at its next read, within `refreshSeconds` (10 seconds by default).

Each answer names the step you saw. If the workflow moved on in the meantime, for example someone answered first or a new question replaced the one on screen, your answer is refused rather than given to a different step.

## On your phone

![The phone app's Activity tab with a Workflows section: the same four workflows, with Yes and No on the first and Answer helper on the second.](/screenshots/mobile-app/activity-workflows.png)

1. **Phone:** open the AgentX phone app (see [the phone app](../dashboard/mobile-app.md)).
2. **Phone:** tap **Activity**.
3. **Phone:** scroll to **Workflows**. You see the same list as the widget.
4. **Phone:** tap **Yes** or **No** on a workflow that needs you, then confirm. A card that offers choices says so; answer it under **Needs you** at the top of the tab.
5. **Phone:** on a blocked workflow, tap **Answer** followed by the agent's name, type your answer and tap **Send**.

![The answer sheet on the phone: the blocked step's reason above a message box, with Cancel and Send.](/screenshots/mobile-app/activity-workflow-answer.png)

The Activity tab reads again every 15 seconds while it is open.

## Change the settings

The settings live under `workflows.widget` in `agentx.json`. Change them from the terminal:

1. **Terminal:** run `agentx workflow widget --no-open` to see the current settings without opening the browser.
2. **Terminal:** change what you need. One flag per setting:

| Flag | Default | What it changes |
|---|---|---|
| `--enabled on` or `--enabled off` | `on` | Turns the widget off or on, on the computer and in the phone app. |
| `--position <corner>` | `top-right` | Where the small window opens in browsers that cannot keep it on top: `top-right`, `top-left`, `bottom-right` or `bottom-left`. |
| `--tags <list>` | all | Only workflows with one of these tags, comma separated, for example `--tags client:example-co,project:site`. `--tags ""` shows all again. |
| `--size <WxH>` | `360x420` | Size of the small window in pixels. |
| `--refresh-seconds <n>` | `10` | How often the widget reads again when no live update arrives (3 to 600). |

3. **Terminal:** the command prints `✓ saved` and the new settings.
4. **Browser:** reload the widget to use them.

See also [the configuration reference](../reference/config-automation.md) and [the command reference](../reference/cli-commands.md#agentx-workflow-widget).

## Check it worked

1. **Terminal:** run `agentx workflow progress`. Note how many runs it lists.
2. **Terminal:** run `agentx workflow widget`.
3. **Browser:** the heading reads **Workflows** with the same number of runs, and the line under it says **Updated** with the time.
4. **Browser:** click **Keep on top**, then click another window. In Chrome or Edge the widget stays in front.

## If something is wrong

- **The widget says "Nothing is being followed right now."** No follow-up workflow is running, or none has the tags you set. Run `agentx workflow progress` to check, and `agentx workflow widget --tags ""` to show every tag.
- **It says "The progress widget is off."** Run `agentx workflow widget --enabled on`.
- **It says "Could not load" with `unauthorized`.** The dashboard has a token set (`dashboard.token` in `agentx.json`), and the Workflows page cannot load either. Open the widget on the computer that runs the dashboard, at the address `agentx workflow widget` prints, and check the dashboard settings in [the dashboard guide](../dashboard/index.md).
- **The browser does not open.** The command prints the address; open it yourself. On a computer without a screen, use the phone app.
- **Keep on top opens a normal window instead.** Your browser has no picture-in-picture for pages. Use Chrome or Edge, or place the small window where it stays visible.
- **The browser blocked the small window.** Allow pop-ups for the dashboard's address, then click **Keep on top** again.
- **"Not answered: this step no longer waits on you."** Someone answered first, or the step moved on. The list updates within a few seconds.
- **"N node(s) not reachable" next to the time.** One of the computers the dashboard follows does not answer. Its workflows are missing until it is back; see [the dashboard's computers](../dashboard/index.md).

# Keep each rule on one page

Agents often look up the same rule again and again: when a payroll declaration is due, what a late filing costs, who it is filed with. The answer was found before, but it stayed inside a note or a chat, so nobody finds it the next time.

`agentx wiki rules` gathers those answers. It reads the wiki pages that state rules, and writes each rule once, on its own **rule page** (an **obligation** page, under **Law & Obligations**). A rule page says, in plain words:

- **What to do**, and **who** must do it;
- the **deadline**, as the rule states it (for example "by the 15th of the following month");
- the **amount** and who it is **filed with**, when the source says;
- the **penalty** for being late;
- the **source**: the law or document it comes from, and the wiki page and conversation it was read from;
- the **source date**: the date of the conversation or page it was read from. The run does not check the rule with the law or the authority, so this is never the day of the run.

The page of each person or organization that must follow the rule links to it, under **Obligations**. The penalty gets a small page of its own, linked from the rule's **Penalties and reliefs** panel.

When an agent is asked about the rule again, `agentx wiki query` and the agent's wiki search find the rule page, so the answer comes from the page instead of new research.

- **Nothing is invented.** A rule needs an action and a source the run was shown. A missing deadline or penalty is written as "not found in the sources yet", never guessed.
- **One page per rule.** When a rule page with the same title exists, the run updates it. Facts other agents wrote on it are kept.
- **A later source adds, it does not erase.** When a second page mentions the same rule but leaves out the deadline or the penalty, the page keeps what the first source said, and shows which source it came from: "by the 15th (from entry-0412, 2026-03-02)".
- **Facts wait for you.** Every fact the run writes is marked **proposed**. The page shows it under **Needs attention** until you confirm it. A fact you confirmed is never changed by a later run.
- **Your text stays.** On a rule page an agent wrote by hand, the summary goes in its own **Rule summary** section. The page's own **Overview** is left as it was.
- **Private stays private.** A rule page can be read by exactly the agents who can read the page it came from. A link is added to a person's or organization's page only when everyone who can read that page can also read the rule.
- **The model gets no tools.** The call that reads the page can't run commands, use connected services or send messages. It only returns text.
- **Old text is kept.** Each write saves the previous version of the page.
- **Spending has a cap.** Each source page costs one model call. A run stops before the next call once it has spent `--max-cost`.
- **Only what changed is read again.** A page is read again only when its text or its sources change. `--force` reads it anyway.

## Which pages it reads

1. Legal source pages (laws, decrees, codes).
2. Obligation pages agents already wrote, to fill in what they miss.
3. Any other page whose title or text uses a rule word: deadline, due date, penalty, late fee, filing, obligation, and the same words in French and Arabic. Pages about events, people, devices, servers, apps and agents are left out.

Pages this job wrote itself are never read as a source. To read other pages, name them on the command line, or change the words with `--words`.

## Before you start

- The [typed wiki view](../dashboard/wiki.md) shows the pages it reads and writes. Open `/admin/wiki/` to see them.
- The machine runs the `claude` command line tool, which the agents already use.

## Try it on one page

1. **Terminal:** in the folder with `agentx.json`, run `agentx wiki rules "<page title>" --dry-run`. It prints each rule it found, what the rule page would say, and which pages would link to it. Nothing is written.
2. **Terminal:** run it again without `--dry-run` to write it.
3. **Browser:** open `/admin/wiki/`, click **Law & Obligations**, then the rule. The summary at the top shows the deadline, the penalty, the source and the source date.

   ![A rule page: what to do, who, deadline, amount, filed with, penalty, source and source date at the top, a deadline kept from an earlier source, then the "Who must do what, by when" panel with proposed facts](/screenshots/wiki/rule.png)

4. **Browser:** open the page of the organization that must follow it. The **Obligations** panel lists the rule.

   ![An organization page whose "Obligations and next due dates" panel lists the rule](/screenshots/wiki/rule-bearer.png)

To read every page that changed, leave out the title:

```bash
agentx wiki rules --max 20 --max-cost 2
```

## Run it on a schedule

Add a job with a `command` to `crons` in `agentx.json`. The `agent` field picks the agent that runs it. This job runs every night and spends at most $1.

A job is stopped after its `timeout`, in seconds (600 by default). Each page can take up to 4 minutes, so give the job about 270 seconds per page in `--max`. For `--max 10`, that is 2700:

```json
{
  "crons": {
    "wiki-rules": {
      "schedule": "30 3 * * *",
      "agent": "<agent>",
      "command": "agentx wiki rules --max 10 --max-cost 1",
      "timeout": 2700
    }
  }
}
```

## Settings

| Flag | Default | What it does |
|---|---|---|
| `--words <list>` | rule words in English, French and Arabic | Comma-separated words that mark a page as stating rules. A word matches at the start of a word, so `penalt` matches "penalty" and "penalties". |
| `--max <n>` | `10` | Most source pages per run. A whole number, 1 or more. |
| `--max-cost <usd>` | `1` | The run stops before the next call once it has spent this much. |
| `--model <m>` | `sonnet` | The model that reads the pages. |
| `--force` | — | Read again pages that did not change. |
| `--dry-run` | — | Show what would be written. Writes nothing. |
| `--json` | — | Print the run as JSON. |
| `--dir <path>` | `.agentx/wiki` | Wiki folder. |

The run remembers what it read in `.agentx/wiki/_rules/state.json`, after every page. A run that is stopped part-way, and then retried, does not pay again for the pages it already read. Delete that file to start over.

## What it writes

- A new rule page goes in `obligations/` in the wiki of the agent whose page stated it, tagged `wiki-rules`, with `class: obligation`.
- Its facts (action, bearer, due, amount, authority, created by, procedure) carry the source, the source's date (`checked_at`), `status: proposed` and `"by":"wiki-rules"`. A later run replaces a fact only when its source states that field; otherwise the earlier fact stays, with its own source and date. Facts others wrote, and facts you confirmed, stay.
- A penalty page goes in `penalties/`, linked to the rule with `penalty for`. When you confirmed the penalty on that page, a later run leaves the page as it is, and the rule page shows the penalty you confirmed.
- A person's or organization's page gets one `subject to` fact pointing at the rule, when the source page names or links that person or organization. Adding that link does not change the page's last-updated date.
- Each page is read again just before it is written, so text another job added during the run is kept.

## Check it worked

1. **Terminal:** run `agentx wiki rules "<page title>" --dry-run`. It prints at least one rule with its page path.
2. **Browser:** open the rule page. The top shows **Deadline**, **Penalty**, **Source** and **Source date**.
3. **Browser:** open the organization that must follow it. **Obligations** lists the rule.
4. **Terminal:** run the same command without `--dry-run` a second time. It prints `unchanged`, because the page did not change.

## If something is wrong

- **`dropped: source not among those given`:** the model cited something the run did not show it. The rule is left out. Nothing to fix.
- **`dropped: a page of type organization already has this title`:** another page already uses the rule's name. Rename one of them, then run again with `--force`.
- **`dropped: … cannot read the source` or `cannot read the rule`:** the pages have different readers. Share the source page with the same agents, or add the fact by hand.
- **`Deadline: not found in the sources yet`:** no source states it. Add it to the source page (or ask an agent to), then run again.
- **A page that states a rule is not read:** it does not use a rule word, or it is an event or person page. Name it on the command line, or add a word with `--words`.
- **No organization links to the rule:** the source page does not name it. Add `[[Organization name]]` to the source page, then run again.
- **`ontology.yaml has no obligation type`:** your `ontology.yaml` removed it. Add the type back to write rule pages.
- **`stopped at the cap`:** the run reached `--max-cost`. The rest wait for the next run, or raise the cap.
- **The source date is old:** the rule was read from an old conversation or page. Check it with the law or the authority, then confirm the facts (or correct them) on the page.
- **A rule is wrong:** fix or remove its facts in the page header. Facts this job wrote carry `"by":"wiki-rules"`. Each write kept the old version of the page.

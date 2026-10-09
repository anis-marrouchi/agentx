# Sort wiki events by importance

About half the pages in a wiki are **events**: something that happened on a date. A disk that filled up sits beside a contract that was signed, and nothing says which one matters more. A new event page also has no link to the thing it happened to, so the page of a laptop or a client does not list it.

`agentx wiki events` fixes both. For each event page it writes:

- **An importance level**: **minor**, **normal** or **major**.
- **What the event is about**: the person, organization, project or machine it happened to. The event then shows in the **History** of that page.

After a run, a page's History shows major and normal events. Minor ones fold under a count:

![A device page: state now with disk used 91%, history with six minor disk warnings folded into one recurring line, installed apps, and the owner](/screenshots/wiki/device.png)

Three words used on this page:

- **Level**: the importance of one event.
- **Rule**: a line in `ontology.yaml` that gives a level to events by their title or tags, with no model call.
- **Proposal**: a level the run suggests but does not set. Only you set **major**, so a run stores "major" as a proposal and leaves the event at normal until you decide.

How the run works:

- **Rules go first, and cost nothing.** Routine upkeep (a full disk, a cleared cache, a restart) is minor by default. You can change the rules.
- **A model sorts the rest**, 20 events per call. It reads the title and the first lines of each event page, never the raw conversations.
- **Nothing is invented.** The run may only say an event is about a page that the event already links to, or that its title names. Anything else is dropped, and the run tells you.
- **The model gets no tools.** The call can't run commands, use connected services or send messages. It only returns text.
- **Your own choice wins.** A level you set yourself is never changed by a later run.
- **Old text is kept.** Each write saves the previous version of the page.
- **Spending has a cap.** A run stops before the next call once it has spent `--max-cost`.

## Before you start

- The [typed wiki view](../dashboard/wiki.md) shows the events and their levels. Open `/admin/wiki/` to see them.
- The machine runs the `claude` command line tool, which the agents already use.

## Try it on a few pages first

Start with a pilot on two or three pages you know well, such as your company, one client and one machine. A dry run writes nothing.

1. **Terminal:** in the folder with `agentx.json`, run:

   ```bash
   agentx wiki events --about "Example Company" "Office Laptop" --dry-run
   ```

2. Read the list. Each line shows the date, the level, the event, whether a rule or the model decided, what the event is about, and a short reason:

   ```text
   ~ 2026-02-01  minor    Office Laptop disk full  rule · about Office Laptop · matched an importance rule
   ~ 2026-02-10  normal (proposed major) Renewal signed  model · about Example Company · contract renewed for a year
   Example Company (organization): 14 events in its History before · after: 0 major, 9 normal, 5 minor (folded)
   ```

3. Check the last lines. For each page you named, they give the number of events in its History before the run and how they split after it.
4. When the levels look right, run the same command without `--dry-run` to write them.
5. **Browser:** open one of the pages under `/admin/wiki/`. Its **History** shows the major and normal events, and **+ N minor events** below them.

## Run it on every event

1. **Terminal:** run `agentx wiki events`. It does up to 200 events that have no level yet, newest first.
2. Run it again until it prints `0 left`. Use `--max 1000 --max-cost 3` to do more in one run.

To keep new events sorted, add a scheduled job with a `command` to `agentx.json`:

```json
{
  "crons": {
    "wiki-events": {
      "schedule": "30 4 * * *",
      "agent": "<agent>",
      "command": "agentx wiki events --max 200 --max-cost 1",
      "timeout": 1800
    }
  }
}
```

A day with no new events makes no model call.

## Decide the proposed major events

1. **Terminal:** run `agentx wiki events proposed`. It lists the events a run suggests as major.
2. For each one, run `agentx wiki events set "<event title>" major` to accept it, or `agentx wiki events set "<event title>" normal` to refuse it.
3. **Browser:** open `/admin/wiki/`. The proposals also show under **Needs attention** with a **proposed** label, until you decide.

You can set any event's level this way at any time. No later run changes a level you set.

## Change the rules

1. **Terminal:** run `agentx wiki ontology init` if you have no `.agentx/wiki/ontology.yaml` yet.
2. Open the file and edit `rules` under `importance`. Rules are tried in order and the first match wins. A rule has a `level`, and a `title` pattern, a list of `tags`, or both:

   ```yaml
   importance:
     default: normal
     major_set_by: owner
     rules:
       - {level: minor, title: "\\b(restart(ed)?|health ?check)\\b"}
       - {level: minor, tags: [reminder]}
       - {level: normal, title: "\\binvoice (sent|paid)\\b"}
   ```

3. **Terminal:** run `agentx wiki ontology check`.
4. Run `agentx wiki events --rules-only --dry-run` to see what the rules alone decide.

Set `major_set_by: anyone` to let a run write **major** directly, with no proposal.

## Check it worked

1. **Terminal:** run `agentx wiki events --about "<page title>" --dry-run`. It prints a level for each event and the History split for the page.
2. Run `agentx wiki events` twice. The second run prints `nothing to do`, because every event has a level.
3. **Browser:** open `/admin/wiki/`, then **Events**. The **minor**, **normal** and **major** tabs each list events.
4. Open the page of a machine or a client. Its **History** lists the events about it, with minor ones folded.

## If something is wrong

- **`no page is titled: …`:** the name after `--about` does not match a page title or alias. Copy the title from the wiki page.
- **`dropped: about …: not in the list shown`:** the model named a page the event does not link to. That link is left out. Add `[[Page Title]]` to the event page if the event really is about it, then run again with `--force`.
- **An event has the wrong level:** run `agentx wiki events set "<event title>" <level>`. For a kind of event that is often wrong, add a rule.
- **An event does not show in a page's History:** the event neither links to that page nor names it in its title. Add `[[Page Title]]` to the event page.
- **`no-page`:** the event's pages are copied from another machine. Run the job on the machine that holds them.
- **`no-answer`:** the model's reply had no usable line for that event. It keeps no level and the next run tries it again.
- **`write refused`:** the page belongs to another agent or was copied from another machine. Run the job where the page lives.
- **`stopped at the cap`:** the run reached `--max-cost`. The rest wait for the next run, or raise the cap.
- **`--max must be a whole number`:** give `--max` or `--batch` a number such as `200`.
- **A red box says ontology.yaml has problems:** a rule has an unknown level, no `title` or `tags`, or a pattern that is not valid. Run `agentx wiki ontology check` and fix the line it prints.
- **To undo this job's work on one event:** open the page's header, remove `importance:` and the facts that carry `"by":"wiki-events"`. The next run does the event again.

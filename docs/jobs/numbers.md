# Track numbers over time

A **number** is a measure your team follows week after week: video views per channel, sign-ups per product, how many clients reached each step of their journey, how long support takes to answer. Each number has a home, an owner and a history.

A number keeps:

- an **id** (a short name such as `video-views`) and a **name** in plain words;
- an **owner**: the agent that looks after it;
- a **unit**, such as `views`, `clients` or `%`;
- an optional **target**, with a **direction**: `up` when higher is better (the target is the least you want), `down` when lower is better (the target is the most you accept);
- a **rhythm**: `daily`, `weekly` (the default) or `monthly`. It says how often the number gets a new value;
- **tags**, such as `channel:video` or `product:shop`, so you can pick out the numbers of one channel or one product;
- a **source**: where its values come from.

Each value is a **reading**. A reading covers a **window**: the days it counts. "Views from 2 to 8 November" is one reading. Days are counted in UTC, and weeks start on Monday.

Numbers are not goals. A goal ends once, and keeps no history. A goal can still close itself on a number: see [Close a goal on a number](#close-a-goal-on-a-number).

Nothing changes on a machine with no numbers set up.

## Where the values come from

| Source | What it reads | Who can set it up |
|---|---|---|
| `manual` (the default) | Nothing: you or an agent record each reading. | You, any agent |
| `count` | How many issues or pull requests a GitHub or GitLab project has, with filters. | You, any agent |
| `http-json` | A web address that answers with JSON (structured data), and where the value sits in it. | You, any agent. Request headers (for a key): only in `agentx.json` |
| `command` | A command run on this machine that prints the value. | Only you, in `agentx.json` |

AgentX reads a number with a source once per period of its rhythm, for the last whole period. A weekly number read on Tuesday gets the reading for Monday to Sunday of the week before.

When a read fails, AgentX keeps it as **no reading**, never as 0, and tries again an hour later.

## Status

| Status | Meaning |
|---|---|
| on target | The newest reading meets the target. |
| missed | The newest reading misses the target. |
| missed twice | The newest reading and the one before it both miss. |
| no reading | No reading yet, the newest read failed, or the last whole period has none. |
| no target | It has a reading but no target to compare with. |

## Add a number

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run:

   ```bash
   agentx numbers add video-views --name "Video views" --unit views --target 1000 --rhythm weekly --tags channel:video,product:shop --owner marketer
   ```

3. **Terminal:** run `agentx numbers`. The number is listed with the status **no reading**.

To change it later, run `agentx numbers add` again with the same id and only the options you want to change.

## Record a reading by hand

1. **Terminal:** run:

   ```bash
   agentx numbers record video-views 1240 --from 2026-11-02 --to 2026-11-08 --note "from the channel's stats page"
   ```

   Without `--from`, the reading is for the last whole period of the number's rhythm. Without `--to`, the window is the one day given in `--from`. Recording the same window again replaces its value.

2. **Terminal:** run `agentx numbers show video-views`. You see the number, its status and each reading, newest first.

## Let AgentX read it

Give the number a source with `--source` and a JSON object. Two examples:

- Open bugs with the label `bug` in a GitHub project, counted as they are now:

  ```bash
  agentx numbers add open-bugs --name "Open bugs" --target 5 --direction down --source '{"kind":"count","provider":"github","project":"example-org/shop","labels":["bug"]}'
  ```

- Issues closed during each week:

  ```bash
  agentx numbers add bugs-closed --name "Bugs closed" --source '{"kind":"count","provider":"github","project":"example-org/shop","state":"closed","window":"closed"}'
  ```

The `count` source takes:

| Field | Values | Default |
|---|---|---|
| `provider` | `github` or `gitlab` | required |
| `project` | `owner/repo` on GitHub, `group/project` on GitLab | required |
| `what` | `issues`, `prs` (pull or merge requests) or `all` | `issues` |
| `state` | `open`, `closed` or `all` | `open` |
| `labels` | label names; every one must be on the item | none |
| `window` | `none` (the count now), `created` (made within the reading's window), `closed` (closed within it; GitHub only) | `none` |

It reads through the GitHub or GitLab connection already set up for open requests (`channels.github`, `channels.gitlab` or `requests.checkers`).

The `http-json` source takes `url` and `path`. In `url`, `{start}` and `{end}` become the first and last day of the window, such as `2026-11-02`. `path` names where the value is in the answer: `data.views`, or `rows[0].total`. For example:

```bash
agentx numbers add signups --name "Sign-ups" --source '{"kind":"http-json","url":"https://stats.example.com/signups?from={start}&to={end}","path":"total"}'
```

## Set numbers up in agentx.json

Numbers you set up in `agentx.json` are yours: agents cannot change or archive them. Only here can a number run a command, or send request headers.

Agents never see the secret parts of a source. In the Hub, the CLI, the agent tool and read errors, header values, values after `?` in an address, a name and password written in an address (`https://name:password@host`) and command text all show as `***`.

1. **Editor:** open `agentx.json` and add a `numbers` section:

   ```json
   "numbers": {
     "items": {
       "newsletter-readers": {
         "name": "Newsletter readers",
         "owner": "marketer",
         "unit": "readers",
         "target": 500,
         "rhythm": "weekly",
         "tags": ["channel:newsletter"],
         "source": { "kind": "command", "command": "./scripts/newsletter-readers.sh", "timeoutSeconds": 30 }
       }
     }
   }
   ```

2. **Terminal:** run `agentx daemon restart`, or wait: the daemon picks the change up at its next check, within a minute.
3. **Terminal:** run `agentx numbers`. The number is listed.

A command runs from the folder that holds `agentx.json`. It gets the window in two variables, `AGENTX_PERIOD_START` and `AGENTX_PERIOD_END` (first and last day). It prints the value as its last line, or prints JSON and the source names the value with `path`. Taking a number out of `agentx.json` archives it: it is no longer read, and its readings stay.

## Let agents keep numbers

Agents use the `agentx_numbers` tool:

- `{"action": "list", "tags": ["channel:video"]}` lists numbers with every tag given.
- `{"action": "show", "id": "video-views"}` shows one number and its readings.
- `{"action": "create", "id": "video-views", "name": "Video views", "unit": "views", "target": 1000, "tags": ["channel:video"]}` makes a number. The agent becomes its owner unless it names another with `owner`.
- `{"action": "record", "id": "video-views", "value": 1240, "from": "2026-11-02", "to": "2026-11-08"}` keeps a reading.
- `{"action": "archive", "id": "video-views"}` stops tracking a number. Its readings stay.

Only a number's owner records readings for it, changes it or archives it.

## Close a goal on a number

A goal (see [A goal's own record](./open-requests.md#a-goal-s-own-record)) can close by itself when a number crosses a threshold. Give the goal the check `{"kind": "number", "number": "video-views", "atLeast": 1000}`, or `atMost` for a number that should come down. The goal closes as done once the newest reading crosses it. While the number has no reading, the goal stays open.

## Link a job's value line to a number

A scheduled job's value line (`crons.<id>.value`) says why the job runs and the number that proves it. Add `number` with the number's id to say which tracked number measures it:

```json
"value": { "why": "Grows the video audience", "metric": "Weekly views at least 1000", "number": "video-views" }
```

## Check it worked

1. **Terminal:** run `agentx numbers add test-number --name "Test number" --target 10`.
2. **Terminal:** run `agentx numbers record test-number 12`.
3. **Terminal:** run `agentx numbers`. **Test number** shows **on target** and `12` with last week's dates.
4. **Terminal:** run `agentx numbers archive test-number` to remove it from the list.

## If something is wrong

- **`no agentx.json here`:** run the command from the folder that holds `agentx.json`.
- **A number stays at no reading:** run `agentx numbers show <id>`. The newest reading shows why the read failed, in red. For a `count` source, check the GitHub or GitLab connection; for `http-json`, open the address in a browser.
- **`is set up in agentx.json`:** that number is changed in `agentx.json`, not with the command or by an agent.
- **`a command source can only be set in agentx.json`:** put the number under `numbers.items` in `agentx.json`.
- **An agent's record is refused with `belongs to`:** only the number's owner records readings. Ask the owner agent, or change the owner with `agentx numbers add <id> --owner <agent>`.
- **The daemon log says `numbers.items.<id>: …`:** that number in `agentx.json` is not valid; the message says which field to fix.

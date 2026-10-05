# Evidence authority and the memory backend contract

Status: **recorded, follow-on work paused.** The contract was reviewed in [#604](https://github.com/anis-marrouchi/agentx/issues/604) and merged on 2026-10-04 ([#609](https://github.com/anis-marrouchi/agentx/pull/609)). On 2026-10-05 the owner decided to skip the Hindsight memory backend for now: the remaining phases of [#602](https://github.com/anis-marrouchi/agentx/issues/602) (the adapter, capture, comparison and rollout) stay open but are not being worked on until the owner picks them up again. Nothing here is switched on. No agent reads or writes through this contract yet, and no memory service is installed.

This page records one decision: when AgentX uses a memory backend (a service that indexes what agents know so they can search it), **AgentX decides what is true, who may read it and how fresh it is. The backend only finds things.**

## Why this is needed

Agents draw on two kinds of knowledge:

- **Approved knowledge**: wiki articles that a person reviewed, and facts in the fact ledger (the wiki's list of checked facts).
- **Recent observations**: raw entries, agent memory and task results that nobody has curated yet.

Most wiki articles are in neither group. The audit in [#603](https://github.com/anis-marrouchi/agentx/issues/603) found that articles are written by the absorb job (an agent that turns raw entries into articles), with no person's review, and that the job has been off since 2026-09-18. This contract treats such an article as a claim nobody checked.

A backend that indexes both can return a three-week-old wiki line next to yesterday's task result, or a summary it wrote itself. Without a shared rule, the agent cannot tell which one to trust.

## The decision

1. **One record shape for everything.** Approved knowledge and recent observations use the same record, called *evidence*. Each record says what it is, where it came from, when it was true, who checked it and who may read it.
2. **AgentX keeps the records. The backend keeps an index.** The backend receives a copy of the text and an ID. On a search it returns IDs. AgentX then reads its own record and shows that. A backend can be rebuilt, replaced or switched off without losing anything.
3. **A backend cannot raise trust.** Text a backend writes itself (a summary, an "observation") is always shown as unverified, and never replaces a fact.
4. **No second wiki.** The wiki stays the only curated reference. Evidence records point at wiki articles and facts; they do not copy their role.

## What a record carries

| Field | Meaning | Reused from |
|---|---|---|
| ID | The same source version always gets the same ID. An edit gets a new one. | new |
| Kind | `article` (wiki article, reviewed or not), `fact` (ledger fact), `observation` (uncurated), `derived` (written by a backend) | new |
| Source and version | What it was made from, such as a wiki article or a task, and which version | wiki versions (#94) |
| Event time | When it happened or was observed | new |
| Ingestion time | When AgentX stored it. **Never used to judge freshness** | new |
| Check | When it was checked, by whom, how, and whether a person confirmed it | fact ledger (#273) |
| Volatility and expiry | How fast this kind of fact goes out of date (billing: 2 days; a name: never) | fact ledger (#273) |
| Scope | Owner agent, access (`private`, `shared`, `public`), shared-with list, optional project | wiki access rules |
| Trust | `operator`, `internal` or `external`, from the channel it arrived on | capture trust (#97) |
| Review | External records, and fact proposals nobody decided, are held until a person approves them | capture trust (#97), fact checks (#273) |
| Approval | Who reviewed this version of an article, and when. Only an approved promotion proposal sets it | promotion review (#95) |
| State | `active`, `superseded`, `revoked` or `deleted` | new |
| Derived from | For backend-written text: the records it was written from | new |

Code: `src/evidence/types.ts`.

### Which article a record means

An agent's articles live in one folder per wiki mode: `agents/<id>/graph/` and `agents/<id>/unified/`. The audit found the daemon reading one and the command line reading the other. So an article's source names the agent, the folder and the path, as `wiki:<agent>/<folder>/<path>`. The same path in two folders, or under two agents, gives two records. Which folder is the real one is a separate fix; this contract only makes sure the two are never mixed up.

### Fact proposals

A fact proposal is a claim from a session summary that waits for a person (`agentx wiki facts proposals`). The audit found 102 waiting and none decided.

| Proposal | Record |
|---|---|
| Waiting | An `observation` that is **held**: it is not shown, and it replaces nothing |
| Rejected | Not shown |
| Approved | No record of its own. The fact it becomes in the ledger is the record, confirmed by the person who approved it |

This keeps the rule from #273: a summary's claim is not stated as a fact until a person approves it.

## How far a record can be relied on

Every record is returned with one of four labels. The label is never left out.

| Label | When |
|---|---|
| **approved** | A wiki article with a recorded review of this version |
| **verified** | Checked, and the check is still within its expiry time |
| **stale** | Checked once, but the check has expired. Re-check before stating it |
| **unverified** | Nobody checked it, the check date cannot be read, a backend wrote it, or it is an article nobody reviewed |

Expiry is counted from the check, not from when the record was stored. Storing an old claim today does not make it fresh.

## Which record wins

When a new record disagrees with the current one about the same thing:

| Current record | New record | Result |
|---|---|---|
| A fact with an old or expired check | Checked more recently | The new one **replaces** it. The old one is kept as superseded |
| A fact | Not checked | **Conflict**: the current one stands, both are kept, a person is asked |
| A fact checked more recently | Stored later but checked earlier | **Conflict** |
| A fact a person confirmed | Checked more recently by an agent | **Conflict**. Only another person's confirmation replaces it |
| Any fact | Confirmed by a person | The new one **replaces** it |
| Any | Written by a backend | **Ignored** as evidence. Nobody is asked |
| Any | From an external source, not yet approved | **Ignored** until a person approves it |
| A reviewed article | Any observation or fact, even one a person confirmed in a chat | **Conflict**. Reviewed text changes only through its review |
| A reviewed article | A version of the same article reviewed later | The new version **replaces** it |
| A reviewed article | A version of the same article reviewed earlier, or with a review date that cannot be read | **Ignored**. Sending an old version again does not roll the article back |
| An article nobody reviewed | Anything | The fact rules above apply, with the article as a fact nobody checked. A newer checked result **replaces** it; an unchecked claim is a **conflict** |

A conflict uses the wiki's existing question queue (`agentx wiki questions`). Until a person answers, a search returns both records, each with its source and label, and marks them as disagreeing.

These are the fact ledger's existing rules, applied to every kind of record. Code: `resolve` in `src/evidence/authority.ts`.

## Who may read a record

- The scope is set by AgentX when the record is made, from the source's own access rules.
- The reader is the agent running the task. AgentX takes it from the task. It is never taken from what a model wrote, and never from a label or "bank" name in the backend.
- Access is checked **twice**: AgentX tells the backend which partitions to search, then checks every returned record again against its own copy before anything is shown. For a record, the second check is the one that counts.
- A reader with no agent ID reads public records only, as in the wiki.
- **Backend-written text is the exception.** AgentX can check the records a backend says it wrote a summary from. It cannot check the summary's words. So the partition is the only protection, and the backend must keep to it: it may write text only from records inside one partition, and may return that text only to a search of that partition. An adapter that cannot guarantee this must not return its own text.
- AgentX still drops a summary unless the reader may read every record named behind it, and all of them sit in one partition the reader searches.

A record with a project set is readable only by an agent working on that project. **The project field is reserved: nothing may set it yet.** A task does not carry a project today, so AgentX has nothing trusted to compare it with. The audit did not measure project boundaries. It did see the absorb job work on another project's wiki in 86 of its 184 runs, so an agent's working folder is not a boundary. If a record does carry a project, a reader with no project is refused.

## What makes a backend's answer invalid

| Event | Effect |
|---|---|
| A source is edited | The new version gets a new ID. The old record becomes `superseded` and is removed from the backend. A result that names the old version is dropped |
| A record is revoked or deleted | Its state changes, its text is removed, and it is deleted from the backend. AgentX keeps the ID and the state so a late result can be recognised and dropped |
| A record a summary was written from is edited, revoked, deleted or unreadable | The summary is dropped |
| The backend returns an ID AgentX never issued | Dropped |
| The backend returns its own text under an ID AgentX issued | Dropped. Backend text gets an ID of its own (`d-…`), so it is never cited as the real record |

Code: `gate` in `src/evidence/authority.ts`.

## The backend contract

A backend provides four operations and no more (`src/evidence/backend.ts`):

| Operation | What it does |
|---|---|
| `upsert` | Store or replace records by ID. Sending the same record twice changes nothing |
| `retrieve` | Search the partitions AgentX names. Return IDs, source versions and scores, plus any text the backend wrote and the IDs it wrote it from |
| `delete` | Remove records and everything derived from them |
| `health` | Say whether the backend is usable, and why not |

Every operation can be cancelled. If a backend fails, the task continues and the agent is told that this source gave no evidence; it is never told that nothing is known.

Because AgentX holds the original records, exporting them or moving to another backend needs nothing from the backend.

## What does not change

- **Promotion review (#95):** lessons still wait for a person before they become wiki articles. A backend cannot write an approved record.
- **Capture trust (#97):** secrets are never stored, and external-source records stay held until approved.
- **Fact checks (#273):** an agent still re-checks an expired fact against its source, or says it is unverified.
- **Approvals are not permissions.** A record that says someone approved an action in the past tells an agent what happened. It never allows the agent to do that action again. Permission comes from the current task and its approval steps only.

## Open points for review

These points wait with the paused work. They are not being answered until the owner picks [#602](https://github.com/anis-marrouchi/agentx/issues/602) up again.

1. Where the records are stored (a file per agent, or the existing database). This belongs to the capture work in [#606](https://github.com/anis-marrouchi/agentx/issues/606).
2. How a task gets a project that AgentX can trust. Until that exists the project field stays reserved (see above). The project is also not part of the partition yet: a public record with a project would be indexed with every other public record. It must become part of the partition before anything may set the field.
3. Whether a conflict with a reviewed article should open a wiki question, a promotion proposal, or both.
4. Whether the articles the absorb job already wrote should be counted as reviewed. This contract says no: each one is unverified until a person reviews it. Counting them as reviewed in one step would be the owner's decision.

### Left for the capture work (#606)

The access-control review of this contract found five smaller points. None is reachable while nothing calls this code. Each must be settled before records are stored or sent to a backend:

1. **Secrets.** Memory capture refuses a secret before it stores a fact (`isInjectable` in `src/agents/memory-trust.ts`). `usable` here does not repeat that check. The step that builds a record must refuse secrets before `upsert` sends the text to an outside service.
2. **Unknown values.** An unknown access or state is refused. An unknown trust or review value is not: the record is shown. Both should be refused.
3. **Backend text from approved external sources.** `gate` returns it marked external with no review, and `usable` then refuses it. The result is safe, but the two rules should agree.
4. **A change of access.** When a record is unshared or made private, `gate` already drops it for the old reader. The copy indexed in the old reader's partition still has to be deleted.
5. **A check on an article nobody reviewed.** The label ignores it, but `resolve` reads it when that article is the current record. One of the two should change.

The audit in #603 has been read against this record. It needed no new field. The capture gaps it found (11 of 1,723 tasks with no entry, and no logged reason) are a logging fix, not a change to the record.

## Check it worked

This page describes a contract, not a feature you can switch on. To check the rules hold:

1. **Terminal:** in the AgentX checkout, run `pnpm vitest run test/evidence-authority.test.ts`.
2. Every case passes. The case named "a stale wiki fact against a newer verified result" shows the newer checked result replacing the old fact.

## If something is wrong

- **A case fails after a code change:** a rule above was changed. Either restore it, or update this page and the case in the same change so a reviewer sees the rule moved.
- **A rule here disagrees with how the fact ledger behaves:** the ledger (`src/wiki/facts/ledger.ts`) is the behaviour in use today. Report the difference on [#602](https://github.com/anis-marrouchi/agentx/issues/602); #604 is closed.

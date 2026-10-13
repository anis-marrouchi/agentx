# Context assembly: start empty, pull by decision (spike #956)

Design answer for issue #956. Thinking only: nothing here is built, routed or
switched on, and no seat's live instructions change.

This note has two sources, kept apart:

- **The dev seat's answer on the issue (2026-10-13).** It is measured on
  521 main sessions of one node, 2026-10-09 to 2026-10-13, build
  0.137.3. Its figures are the ones to use, and its plan is the one this
  note backs.
- **A reading of the code on `main`** (this note's first version). It adds
  where each block is built, its caps and switches, the existing decision
  steps, and a few faults found on the way. Where the first version
  disagreed with the measurement, it is corrected below and the
  correction is named.

## Short answer

The idea is right in direction, but the money sits in a different place from
the one the idea decides first.

- **The start of a session is about 30% of spend.** Most of what it loads
  is not used in that session. (Measured.)
- **What AgentX pushes as memory is about 5% of spend.** That covers
  history, wiki catalog, agent directory, memory block and continuity memo.
  The lists the runtime loads are about 24%: skill descriptions, memory
  index, instruction files and tool names. (Measured.)
- **So the plan has two layers:**
  1. A fixed, short capability set per seat and channel. It is chosen ahead
     of time from use logs, with no decision per message.
  2. One memory decision per new session. After that, the main model pulls
     the rest itself from a described map.
- **Expected saving: 11% to 13% of spend**, with a ceiling of 30%. This is
  a calculation until the offline test in section 6.

## Words used here

- **Turn:** one incoming message and the agent's answer to it. A turn can
  make many model calls.
- **Session start:** what the model receives before it reads the message.
  That is the runtime's system prompt, tool descriptions, skill list,
  instruction files, memory index and AgentX's added text.
- **Prompt cache:** the provider stores the start of a prompt. A later
  call that begins with exactly the same text reads it at a small fraction
  of the price. The first call pays more to write it. Sessions with the
  same start text share one cached copy, so any change near the start
  breaks that sharing too.
- **Small model / main model:** the cheapest model on the node, and the
  agent's own model.
- **Seat:** a typed decision point in `src/decisions`. It can run in shadow
  mode (decides and logs, changes nothing) or in active mode.

## 1. What is loaded today, and what it costs

Measured by the dev seat. Starts are medians: **54.5k tokens on a full start**
(310 sessions: voice, app, GitLab, API) and **39.1k on a lean start** (211
sessions: GitHub, agent-to-agent, cron, workflow).

| Kind | Loaded by | Full | Lean | Share of spend | Used later in the session |
|---|---|---|---|---|---|
| Built-in tool descriptions + fixed runtime text | runtime | 14.4k | 13.6k | 3.4% | median 3 tools; Bash 99%, Read 60%, Edit 59%, Write 40%, others ≤ 4% |
| Skill descriptions (122 full, 28 lean) | runtime | 11.7k | 3.3k | 6.0% | a skill is called in 3% of sessions |
| Memory notes index | runtime | 6.6k | 5.8k | 4.6% | a note is read in 69%, written in 54% |
| Project instruction file | runtime | 2.8k | 8.0k | 3.6% | not measurable from logs |
| User-level instruction file | runtime | 5.5k | 0 | 2.3% | not measurable from logs |
| Runtime text that varies per session | runtime | 3.4k | 3.3k | 2.4% | n/a |
| Earlier turns of the chat | AgentX | 3.3k | 0 (on demand) | 2.4% | recall called in 14% |
| Deferred tool names (128 full, 45 lean) | runtime | 1.6k | 0.4k | 0.8% | tool search in 41%; a non-AgentX MCP tool in 1% |
| Seat identity | AgentX | 1.0k | 0.8k | 0.7% | always |
| Wiki catalog | AgentX | 0.9k | 0.8k | 0.6% | a wiki query in 12% |
| Sub-agent types | runtime | 0.9k | 0.6k | 0.5% | a sub-agent in 4% |
| MCP server instructions | runtime | 0.9k | 0 | 0.4% | see tool names |
| Agent directory (landscape) | AgentX | 0.75k (half of starts) | 0 | 0.3% | another agent contacted in 29% |
| Agent memory block | AgentX | 0.5k | 0.5k | 0.4% | n/a |
| Continuity memo | AgentX | 0.5k (74% of starts) | 0.3k (40%) | 0.3% | n/a |
| Message + channel header | AgentX | 1.3k | 1.0k | 0.8% | always |

The start costs **29.8% of spend**, made up of three parts:

- 16.2% on the first call;
- 11.3% because it is read again on every later call (median 18 calls per
  session);
- 2.4% because it is written again after a cache miss.

Per session, the start costs 0.46 USD (median) out of 1.35. Blocks that AgentX
pushes again on later messages of a resumed session add 0.8%. AgentX's own
share of the start is about 7.5k of 54k tokens (full) and 2.9k of 39k (lean).

> **Correction to the first version.** It estimated 0.018 USD per 1,000
> tokens of start per session, using the cache-read price in
> `src/daemon/token-tracker.ts` (0.50 per million). The runtime reports
> 0.20 per million for the current large model, and sessions have 18
> later calls, not 25. At those figures it is about 0.012 USD. The price
> table in `token-tracker.ts` may be out of date for that model, which
> would also skew `agentx usage` figures. Worth its own check.

### Where each AgentX block is built (from the code)

AgentX's text is built in two places:

- **User-message blocks:** `buildAgentContext` in `src/agents/context.ts`,
  with a total cap of 6,000 tokens and one cap per block.
- **System-prompt blocks:** `src/agents/registry.ts`, around line 2587.

| Block | When it is sent | Cap (tokens) | Switch |
|---|---|---|---|
| Landscape | Every turn, except lean, Codex, coding agents on GitHub/GitLab | 800 | `session.profileByChannel` |
| Memory facts | Every turn; with no match it falls back to the newest facts | 400 | none |
| Auto-injected skill bodies | Every turn, when an `autoInject` skill matches | 800 | per skill |
| Learned patterns | Every turn | 300 | none |
| Long-memory recall | Turns with cue words ("yesterday", "remember") | 1,500 | none |
| Cross-chat summary | Turns naming another chat | 800 | none |
| Wiki catalog | Fresh sessions only | 2,500 | wiki config |
| Today's chat history | Fresh full sessions only | 1,200 | lean profile |
| Continuity memo | Fresh sessions after a rotation, kept 7 days | 800 | none |
| Procedures, references, event digest | Fresh sessions only | 400 / 500 / 500 | `procedures.injection` and others |
| Memory index (MEMORY.md) | Every call, system prompt | `session.memoryIndexMaxChars`, default no cap | that setting |
| Group chat log | Every turn in a group, outside the 6,000 cap | 6,000 chars | none |

`session.memoryIndexMaxChars` already exists. It is one place to look when
answering the dev seat's open question: which switches can shorten the memory
index without a code change.

## 2. What is already on demand, and what is always pushed

**On demand today:**

- MCP tool descriptions and rarely used built-in tools: names are listed,
  and the description is fetched by tool search.
- Skill bodies, memory note bodies and wiki page bodies.
- On lean channels: the agent directory, earlier turns and other chats.
  One line names the tools that fetch them (`agentx_agents`,
  `agentx_recent`, `agentx_wiki_query`).
- Fresh sessions only: the wiki catalog, earlier turns, continuity memo,
  procedures and event digest.

**Always pushed, with no decision:** built-in tool descriptions, the skill
list, deferred tool names, sub-agent types, MCP instructions, all instruction
files, the memory index, seat identity and the channel header.

**Decision steps that already exist:**

| Step | What it decides | Live figures (dev seat) |
|---|---|---|
| `request-gate` seat | Whether a turn is worth a typed decision; 10% holdout | 1,113 calls, median 0.53 s, 8.8% failed; answered "select context" in 97%, so it does not separate anything |
| `request-context` seat | Which optional blocks to drop; drops only when more than 80% sure | 981 calls, median 0.32 s; dropped memory 14%, other chats 48%, two how-to sections about 70%, directory under 1%; accuracy not labelled |
| Context planner (`session.contextStrategy: "planner"`) | How many past turns; whether to pull memory or other chats | Off. Small model, 8 s limit, skipped on voice, desktop and lean |
| Resume-or-new cost gate (#778) | Whether to resume a session | Off |
| Lean start (`session.profileByChannel`) | Which channels start without history, directory and user-level settings | On for github, a2a, workflow, cron |

> **Correction to the first version.** It said `request-context` took a
> median 12.7 s per call. That figure is from
> `bench/results/context-seat-haiku-4-5.json`, which runs the seat through
> the local runtime CLI. Live, on the node's decision backend, it takes
> 0.32 s.

## 3. Map of memory places and capability kinds

The dev seat's map is the one to use. It has one map for every seat, set by
config, with one line per place given to the agent. It is reproduced here
with one change.

### Memory places, nearest first

| Place | Line given to the agent | Fresh | Lookup |
|---|---|---|---|
| This chat, last turns | "The last turns of this conversation. Read first when the message refers to something just said." | live | pushed on chat channels; else one call |
| This chat, older | "Earlier turns of this conversation by date. Use when the message refers to a past day." | live | one call |
| Continuity memo | "A summary of this chat's previous session: open tasks and facts. Not checked." | at rotation, 7 days | pushed on a fresh session |
| Seat notes | "This seat's own notes: decisions, corrections, state of open work. Titles are listed; read the note before acting on it." | as written; may be stale | one call per note |
| Other chats of this seat | "What this seat did in its other conversations today." | live | one call |
| Wiki | "Long-term knowledge shared by all seats: people, systems, decisions. Ask a question, get a cited answer." | checked dates on facts | one call, a few seconds |
| Trackers | "Issues and pull requests. The source of truth for the state of work." | live | one call per item |
| Live systems | "Health, deploys, accounts. Always check here before stating a state." | live | one call |

> **Change from the dev seat's map: "Session summaries (#855)" is not a
> place that exists yet.** #855 built one-line summaries of *wiki pages*,
> used by `wiki query` (`wiki.summaries.*`, `src/wiki/query-summaries.ts`).
> Their job is unset by default, which is why they read as "installed but
> off". The only per-session summary in the code is the continuity memo,
> written when a session rotates, so it is listed above instead. A summary
> per past session, searchable by date, would be a new store. Until it
> exists, "when was this done" goes to the older turns of the chat
> (`agentx_recent`, recall) or the trackers.

### Capability kinds

| Kind | Line given to the agent | Loaded |
|---|---|---|
| Core tools | full descriptions: shell, read, edit, write, tool search | always |
| Other tools | names only, for this seat | on demand by tool search |
| MCP servers | "Servers this seat may use: name, one line each." | on demand; only the seat's servers |
| Skills | "Skills this seat uses often: name, one line each (at most about ten). Others: search by keyword." | short list always, rest on demand |
| Sub-agent types | names only | on demand |
| Instruction files, core rules | safety, approvals, language, who to ask | always |
| Instruction sections | "Other sections: title, one line each. Read the section before doing that kind of work." | on demand |
| Other agents | "Other agents exist; list them with one call." | on demand; pushed in group chats |
| AgentX core tools | `agentx_approval`, `agentx_request`, `agentx_events`, `agentx_attach_next`, `agentx_workflow` | always: AgentX's own prompts name them (`AGENTX_CORE_TOOLS` in `src/agents/session-profile.ts`) |

Splitting instruction files into core rules and sections is a writing task
per seat, not a code task. It has to come before any section is moved to
on demand.

## 4. The decision steps

Three steps. Only one is a model decision, and it runs on a new session only.

- **Step 0 (no model, ahead of time): the capability set for each seat and
  channel.** It is chosen from the use logs and stored in config, so it
  costs nothing per message. Capabilities come first and stay fixed;
  context is decided second.
- **Step 1 (one combined decision, new session only).** It answers two
  things: is this a continuation, an older matter, or standalone, and
  which memory places should be opened? It runs on the small typed model
  that already serves the gate (median 0.3 to 0.5 s), beside the session
  start, not before it. The result is a short pack at the end of the
  prompt, with each line tagged with its source.
- **Step 2 (the main model pulls).** It reads the map lines and fetches
  what it still needs. A pull early in a session costs about 0.015 to
  0.02 USD and 3 to 5 s.

**Push or pull rule** (from those prices): a 500-token block is cheaper pushed
unless it is used in under 28% of sessions. A 5,000-token block is cheaper
pulled unless it is used in over 80%. So the skill list and most instruction
text are pulled. The memory block and the continuity memo stay pushed.

**Who does the lookups: the main model.** The #928 reader test finished on
2026-10-13:

- answers as good as today's in 4 of 9 tasks, the same as a plain repeat;
- 12% saved;
- 3 to 4 times slower.

The earlier wiki-page picker was right about half the time. Picking by a small
model is the weak part.

### Why the capability set is fixed, not picked per session

The first version of this note proposed a small-model decision at each session
start that picked tools, servers and skills. Step 0 is better for three
reasons:

1. **No picking error.** A set built from what the seat really used has no
   miss rate to measure. A miss costs one tool search, not a failed task.
2. **The shared cache is kept.** Sessions of the same seat and channel
   start with the same text and read it from one cached copy. A set picked
   per session gives each session its own start, so each pays the full
   cache write, which costs about 40 times the price of reading it.
3. **No added step or wait** before the first answer.

### What it is worth (dev seat's calculation, share of spend)

| Change | Today | Saved |
|---|---|---|
| Skill list: short per-seat list + search | 6.0% | about 5% |
| Memory index: titles only | 4.6% | about 2.8% |
| User-level instruction file: core rules only on chat channels | 2.3% | about 1.8% |
| Project instruction files: core always, sections on demand | 3.6% | about 1% |
| Tool names, sub-agent types, MCP instructions: per-seat list | 1.7% | about 0.8% |
| AgentX memory blocks by decision | 4.7% | at most 1.5% |
| **Total** | | **11% to 13%** |

Extra pulls cost under 0.5%.

**A new session for every message**, read literally, costs 10% more with
today's start, because the start is written again each time. It saves 3% to 4%
only once the start is down to about 7k written tokens. So the short start
comes first.

## 5. Safe fallbacks, and what stays always loaded

A wrong "leave it out" costs a wrong answer or a broken rule. A wrong "put it
in" costs a few hundred tokens. So any failed, slow or unsure decision loads as
today.

**Always loaded, never decided:**

- seat identity and the incoming message, with its attachments, reply-to
  text and any handover note;
- the core rules: safety, approvals, what needs a yes, language, who to
  ask;
- group-chat rules, such as staying silent when another agent was named
  (`request-context` already never offers them);
- core tools, tool search and the AgentX core tools;
- the map itself (a few hundred tokens);
- the continuity memo on a fresh session after a rotation;
- on chat channels and voice: the last turns of the same chat.

| Decision | If it fails, is slow or unsure | Why |
|---|---|---|
| Continuation / older / standalone | treat as continuation and load the last turns | forgetting mid-conversation is the costly error; 3k extra tokens cost about 0.03 USD |
| Which memory places | nearest first, fixed order | today's behaviour |
| Dropping a block | keep it unless the model is sure (drop only under 0.2) | how `request-context` already works |
| Capability set | an item not in the short list is still found by search; a failed search is logged and the item added to the seat's list | a missing tool costs one call, never a failed task |
| Instruction sections | approvals or safety sections are core by definition | a rule not loaded is a rule not followed |
| Voice | no step before the answer; the decision runs beside the start or not at all | 4.0 s to first output today |

## 6. Offline test, and the figures that decide

- **Step A (free, on logs, about half a day).** For each of the 521
  sessions, replay the proposed capability set against what the session
  really used, and count the pulls it would have needed. This turns 11% to
  13% into a checked figure per seat and gives the short lists. It also
  checks step 1: label each new session as continuation, older or
  standalone from what it went on to read, and count how often a
  continuation would have been judged standalone. Above 5%, step 1 is not
  safe to use.
- **Step B (paid, needs the owner's yes).** Take 20 past tasks and run
  each twice: once as today, once with the short start. Grade the answers
  blind, with a repeat of today as the noise floor. Three tasks are chosen
  because an instruction rule decides the right answer. The cost is about
  26 USD and half a day. The tasks are read-only, which is 9% of the bill;
  tasks that change things need a live trial on one seat.

The decision rule:

- **Build it** if step B saves 10% or more, answers are at the repeat's
  level, and no instruction rule is missed.
- **Drop it** if it saves under 5%, quality is below the repeat, or one
  safety rule is missed.
- **In between:** keep only the two changes that need no decision, the
  skill list and the memory index.

## Side findings from the code

These are not part of the design. They are not tested, and each would be its
own issue.

- **The history block is cut from the wrong end.** "Earlier turns of the
  chat" stays pushed on full starts (3.3k, 2.4% of spend). The block is
  built from the newest 12,000 characters, oldest first
  (`SessionStore.buildHistoryContext`). `buildAgentContext` then cuts it
  to its 1,200-token cap (about 4,800 characters) with
  `content.slice(0, max)`. A long chat therefore keeps its oldest turns and
  loses the newest ones, including the closing "respond to the latest
  message" line. Long-memory recall is cut the same way. This matters for
  the place the design keeps pushed, so it is worth fixing before step B.
- **Sent twice on a full start:** the agent's system prompt (in the
  generated CLAUDE.md, the appended system prompt and the identity block)
  and the memory index (in CLAUDE.md and in the appended system prompt).
  That is part of the 4.6% memory-index share.
- **No per-block sizes are stored.** `task_traces` keeps totals per turn,
  so each spike has to read the runtime's session logs again.
- **The memory block is never empty.** With no match it falls back to the
  newest facts, so it is pushed on every turn where facts exist.
- **The price table may be stale** (see the correction in section 1).

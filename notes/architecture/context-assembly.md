# Context assembly: start empty, pull by decision (spike #956)

Design answer for issue #956. Thinking only: nothing here is built, routed or
switched on, and no seat's live instructions change.

**Short answer.** Most of the machinery already exists, in pieces and switched
off: a small-model planner that decides which history and memory a turn needs
(`session.contextStrategy: "planner"`), two decision seats that can drop
optional context blocks (`request-gate`, `request-context`), and lean sessions
that start without history and fetch it with tools. What is missing is one
map of where memory lives and what each capability is, one combined decision
that uses it, and an offline test against what agents actually fetched.

Two findings set the shape of the design:

1. **The big costs are not in what AgentX pushes.** AgentX's own text is
   about 1k to 2.6k tokens of a 31k to 49k first turn. The rest is the
   runtime's own start: tool definitions, the skill list, tool servers and
   instruction files. Cutting AgentX's blocks to zero saves at most about
   5% of the first turn.
2. **Capabilities can only be chosen per session, memory can be chosen per
   turn.** Tools, tool servers, skills and instruction files are fixed
   when the runtime process starts, and they sit at the front of the
   prompt cache. Changing them on a turn means starting a new session
   with a full cache write. Memory goes in the message, after the cached
   part, so it can change on every turn for free.

My recommendation: one combined decision on the small model, made once when a
session starts (memory and capabilities) and again on each later turn (memory
only). It is checked offline against 200 real turns before anything is built.
Wait for the #928 reader result before sizing the reading side.

## Words used here

- **Turn:** one incoming message and the agent's answer to it. A turn can
  make many model calls.
- **First turn / session start:** what the model receives before it has
  read the message: the runtime's system prompt, tool definitions,
  instruction files and AgentX's added text.
- **Prompt cache:** the provider stores the start of a prompt. Later calls
  that begin with exactly the same text pay about a tenth of the price
  for it (a cache read). The first call pays more than the normal price
  to store it (a cache write). Any change near the start breaks this.
- **Small model:** the cheapest model on the node (Haiku today). **Main
  model:** the agent's own model.
- **Seat:** a typed decision point in `src/decisions`, which can run in
  shadow mode (decides and logs, changes nothing) or active mode.

## 1. What is loaded on every turn today, and what it costs

### Measured on real sessions

These figures come from earlier spikes that read one production node's
runtime session logs. I could not read session logs from this cloud
container, so I did not re-measure them.

| Part of the first turn | Tokens | Source |
|---|---|---|
| Whole first turn, full start (before #618) | 43k to 52k (median by agent) | #615, 2026-10-04 |
| Whole first turn, lean start (after #618, #629) | 31.6k to 37.6k | #615, 2026-10-06 |
| Built-in tool definitions | about 14k (smaller on runtime 2.1.291) | #615, one section removed at a time |
| User-level settings: global instruction file, user skills, plugins | 7.8k | #615 |
| Project-level settings: workspace instruction files, memory index, project skills | 8k to 9.1k | #615 |
| Tool servers (MCP), full start | 5.3k | #615 |
| Skill list | 5.3k | #615 |
| AgentX tool server descriptions, lean start | about 10k | #615 (PR #696 comment) |
| AgentX's own text (task message and its blocks) | median 1k (github) to 2.6k (a2a) | #615 |
| A sub-agent's start | 31k | #928 |

What a session start costs in money (#928, 561 main sessions over 4 days):

| Where the call sits | Cache read | Cache write | Cost per call | Share of spend |
|---|---|---|---|---|
| First call of a session | 14k | 35.6k | 0.30 USD | 14.8% to 18.4% |
| Later calls (tool chain) | 119k | 3.4k | 0.072 USD | 63% |

The start is paid twice: once as a cache write on the first call, then as a
cache read on every later call. A session has about 25 calls (#615). Using
the cache-read price in `src/daemon/token-tracker.ts`, **every 1,000 tokens of
fixed start cost about 0.018 USD per session**: about 0.006 USD on the first
call and 0.0005 USD on each of 25 later calls. At about 140 sessions a day on
that node, that is about 2.5 USD a day per 1,000 tokens. This is a
calculation from measured shares, not a separate measurement.

### Measured today on a demo agent (AgentX's part only)

`pnpm bench:context --channel <ch> --sections` runs the real start path with a
fake runtime and counts what AgentX hands over. No model is called. These are
estimates (4 characters per token) on a clean demo agent with no memory, wiki
or history yet. On a real seat the memory, wiki and history blocks add up to
their caps (see below).

| Channel | AgentX total | Largest parts |
|---|---|---|
| telegram (full) | ≈2,164 | landscape 812, workspace CLAUDE.md 624, AGENTS.md 255 |
| voice (full) | ≈1,969 | landscape 812, CLAUDE.md 624 |
| github (lean) | ≈1,209 | CLAUDE.md 624, AGENTS.md 255, on-demand line 89 |
| a2a (lean) | ≈1,205 | same as github |

### Per kind, per turn

The user-message blocks are built in `buildAgentContext`
(`src/agents/context.ts`). Their total is capped at 6,000 tokens and each block
has its own cap. The system-prompt blocks are built in
`src/agents/registry.ts` around line 2587.

| Kind | When it is sent | Cap | Typical size |
|---|---|---|---|
| Runtime system prompt and built-in tools | Every call (cached) | none | 13k to 27k |
| Tool server tool names and instructions | Every call (cached) | none | 5k to 10k |
| Skill list (names and descriptions) | Every call (cached) | none | 5.3k |
| Instruction files (CLAUDE.md, AGENTS.md, global file) | Every call (cached) | none | 8k to 17k |
| Agent memory index (MEMORY.md) | Every call, system prompt; also inside CLAUDE.md | `session.memoryIndexMaxChars`, default no cap | depends on seat |
| Identity files (IDENTITY.md, SOUL.md, USER.md) | Every call, system prompt | none | depends on seat |
| Landscape (other agents, how-to sections) | Every turn, except lean, Codex, and coding agents on GitHub/GitLab | 800 | ≈812 on demo |
| Memory facts | Every turn; falls back to the newest facts when nothing matches | 400 | up to 400 |
| Auto-injected skill bodies | Every turn, when a skill marked `autoInject` matches | 800 | 0 to 800 |
| Learned patterns | Every turn | 300 | 0 to 300 |
| Long-memory recall | Turns with words like "yesterday", "remember" | 1,500 | 0 to 1,500 |
| Cross-chat summary | Turns that name another chat | 800 | 0 to 800 |
| Wiki catalog | Fresh sessions only | 2,500 | up to 2,500 |
| Today's chat history | Fresh full sessions only | 1,200 | up to 1,200 |
| Continuity memo (after a session rotation) | Fresh sessions only | 800 | up to 800 |
| Procedures, references, event digest | Fresh sessions only | 400 / 500 / 500 | small |
| Group chat log | Every turn in a group, outside the 6,000 cap | 6,000 chars | up to 1.5k |

### Not measured, and how to measure it

The per-kind split of AgentX's own blocks on a real seat (memory block, wiki
catalog, continuity memo) is not in any stored log. `task_traces` keeps
token totals per turn, not per block. To measure it on a node, without a
model call:

1. Terminal, on the node: `pnpm bench:context --config <node config> --agent <seat> --channel <channel> --sections --exact`, once per seat and channel.
2. For the runtime's own part, repeat the #615 method: start the runtime with
   one kind removed at a time and read the first-turn size from its session
   log.

## 2. What is already loaded on demand, and what is always pushed

| Kind | Today | How |
|---|---|---|
| Tool definitions (schemas) | **On demand** for tool server tools | The runtime lists names only and loads a schema through ToolSearch. Built-in tool schemas are always pushed. A lean start can shorten both lists (`session.lean.tools`, `session.lean.agentxTools`). |
| Tool servers (MCP) | **Always pushed**, all at once | Every configured server connects at start. Lean starts keep only `agentx` and `session.lean.mcpServers`. |
| Skills | **Descriptions pushed, bodies on demand** | The runtime lists every skill it finds. AgentX also pushes full bodies of matched `autoInject` skills, and 80-character descriptions in the landscape. The runtime has no option to list only some skills. |
| Instruction files | **Always pushed, in full** | The global file (full start only), workspace CLAUDE.md, and AGENTS.md through an import. |
| Agent memory index | **Always pushed**, twice on a full start | In the system prompt and in a block inside CLAUDE.md. |
| Memory facts | **Pushed every turn** | Best match, else newest facts. |
| Wiki | **Catalog pushed** on fresh sessions, **pages on demand** | `agentx_wiki_query`. Page summaries (#855) are used only by the query, never pushed. They are built only when `wiki.summaries.schedule` is set (unset by default), which is why they read as "installed but off". |
| Chat history | **Pushed** on fresh full sessions; **on demand** on lean ones | `agentx_recent`. Resumed sessions carry it natively. |
| Continuity memo | **Pushed** on fresh sessions after a rotation | Kept 7 days. |
| Landscape | **Pushed**, except lean | `agentx_agents`. The `request-context` seat can drop its sections. |

Decision steps that already exist, all off by default:

| Step | What it decides | Model | Where |
|---|---|---|---|
| Context planner | How many past turns, whether to pull memory, whether to pull other chats | Small model, 8 s limit, skipped on voice, desktop and lean | `src/agents/context-planner.ts`, `session.contextStrategy` |
| `request-gate` seat | Whether a turn is worth a typed decision at all, with a 10% holdout | Decision backend, 3 s limit | `src/agents/request-planner.ts` |
| `request-context` seat | Which optional blocks to drop (memory, wiki, other chats, landscape sections) | Decision backend, 3 s limit | same file |
| Lean start | Which channels start without history, landscape and user-level settings | No model: a setting per channel | `session.profileByChannel` |
| `tool-set` seat | Which tools a turn needs | Shadow only | `src/decisions` |

Measured on the `request-context` seat (`bench/results/context-seat-haiku-4-5.json`):
48 calls on neutral test messages, no block wrongly dropped, but a median of
12.7 s per call through the local runtime. That is far over the 3 s a live
turn waits. The test only covered landscape sections, whose labels are easy.

## 3. Proposed map

Each place gets the one-line description an agent (or the decision step)
would be given. "Cost" is what one lookup costs today.

### Memory places, nearest first

| Place | One-line description | Fresh | Lookup cost |
|---|---|---|---|
| This chat, last turns | "What was said in this chat in the last few turns." | Live | Free if the session is resumed; one tool call otherwise |
| Continuity memo | "A summary of this chat's previous session: open tasks and facts. Not checked." | Written at rotation, 7 days | Free (file read) |
| This chat, earlier today | "Earlier messages in this chat today." | Live | One tool call (`agentx_recent`) |
| Other chats today | "Short summaries of this agent's other chats today." | Live | One tool call |
| Older conversations | "Turns from earlier days, found by words in the question." | Live | One tool call (recall) |
| Memory facts | "Short facts the agent learned in earlier conversations: people, preferences, decisions." | Written after each turn | Free (local search) |
| Agent notes | "Notes the agent wrote on purpose: who people are, how the owner wants things done, project facts." | Written when the agent decides | Free (file read) |
| Wiki | "Shared pages about projects, people, decisions and how things work. May be out of date." | Days to weeks | One small-model call to pick pages (right about half the time in one test, 2026-10-08) |
| Trackers | "Issues, merge requests and their state, from the tracker." | Live | One external read, seconds |
| Live systems | "Current state of a service, deploy or machine." | Live | One external read, seconds |

### Capability kinds

| Kind | One-line description | When it can change |
|---|---|---|
| Built-in tools | "Read, write and run things in the workspace." | Session start only |
| Tool servers | "A connected service and its tools (tracker, calendar, design tool...)." | Session start only |
| AgentX tools | "Talk to other agents, read history, query the wiki, ask for approval." | Session start only (names); schemas on demand |
| Skills | "A written method for one kind of job; read it before doing that job." | List: session start. Body: any time |
| Instruction files | "Rules for this workspace and this seat." | Session start only |
| Landscape sections | "Who the other agents are, and how to message, recall, monitor, or split work." | Every turn |

### Rule for instruction files

An instruction file is not one thing. Each file would need two parts, and the
design only works if they are kept apart:

- **Rules:** safety, permissions, who the agent may contact, what it must
  never do. Always loaded.
- **Reference:** how a project is laid out, commands, conventions. On demand,
  read by the agent like a skill body.

Today they are mixed in one file. Splitting them is a writing task per seat,
not a code task. It must come before any instruction file is left out.

## 4. The decision steps

### Options

| Option | Extra calls per turn | Added money | Added time | Main risk |
|---|---|---|---|---|
| A. Main model pulls by itself with tools (lean start today) | 0 before; 1 main-model call per pull | ≈0.07 USD per pull (one chain call, #928) | One round trip per pull | It does not know what it does not know, so it forgets to pull |
| B. One combined decision on the small model | 1 | ≈0.003 to 0.005 USD (2k to 4k tokens in, 150 out, small-model price) | Not measured on the direct API path; live limit 3 s; 12.7 s through the local runtime | One bad answer affects every kind at once |
| C. One decision per kind (5 kinds) | 5, run side by side | ≈0.015 to 0.025 USD | Slowest of the five | Five ways to fail; more calls to keep under the time limit |
| D. Reader on the small model fetches and condenses (#928) | 1 or more, its own tool calls | Reader was 10% of task cost in #928 | 4 times slower in #928's run | Notes had wrong facts that the main model repeated (2 of 10 as good as today, against 5 of 10 for a repeat) |

### Proposal

1. **At session start: one combined decision (option B).** Input: seat
   identity, the message, the map above, the skill names and tool server
   names. Output, in one answer:
   - the memory class: continuation, older question, or standalone;
   - which memory places to read, in order;
   - which tool servers, tool lists and skills to start with;
   - whether the reference parts of instruction files are needed.

   The order question goes away: one call picks both, and capabilities
   depend on the message, not on what memory returns.
2. **On each later turn of the same session: memory only.** Tools,
   tool servers, skills and instruction files stay as they were, so the
   cache is kept. Same small model, a shorter input (no capability list).
3. **The main model can ask for more** with the tools it already has
   (`agentx_recent`, `agentx_wiki_query`, `agentx_agents`, ToolSearch).
   This is option A, kept as the safety net.
4. **Fetching is done by code, not by a model**, for every place except
   the wiki. The wiki pick stays a small-model call (`wiki query`), the weak
   part.
5. **The pack** given to the main model: at most 1,500 tokens, one line per
   fact, each line tagged with its place and date, for example
   `[memo 2026-10-12] Release waits on the review of the login fix.`

Which model: the small model for the decision and the wiki pick. The main
model never makes the decision; that would cost a main-model call (about 0.07
USD) to save less than that.

Cost at about 140 sessions and 25 calls each a day (one node, #928): one
combined decision per turn, not per call, is under 1 USD a day at the price
above. It pays for itself if it removes about 400 tokens of fixed start per
session, or keeps one unneeded block out.

Where the saving can come from (upper bounds, not forecasts):

- **Session start (capabilities):** 14.8% to 18.4% of spend is first
  calls, and the fixed start is re-read on every later call. Today's lean
  start already took 20% to 28% off the first turn. A per-session choice
  of tool servers, skills and instruction-file reference parts could take
  off the 5k (skill list) plus 8k to 10k (tool server descriptions and
  instruction files) that lean still carries. That is about a third of
  a lean start.
- **Per turn (memory):** AgentX's own blocks are at most 6,000 tokens and
  usually 1k to 3k. The saving here is small in money. The gain is in
  answers: pulling the right older fact when it is needed, which today
  depends on cue words.

## 5. Safe fallbacks, and what stays always loaded

### Fallback per decision

The rule: a wrong "leave it out" costs a wrong answer or a broken rule; a
wrong "put it in" costs a few hundred tokens. So every uncertain or failed
decision includes.

| Decision | If it fails, times out or is unsure | Why |
|---|---|---|
| Memory class | Treat as **continuation**: load the last 3 turns of this chat and the continuity memo | A continuation judged standalone makes the agent forget mid-conversation |
| Memory places | Use today's layered blocks | That is today's behaviour |
| Capabilities | **Full start** for that channel (`session.profileByChannel`) | An agent missing a tool fails mid-task |
| Instruction file reference parts | Load them | Cost is small next to a missed rule |
| Wiki pick | No pages; the main model can still ask `agentx_wiki_query` | The pick is right only half the time |
| Voice | **No decision step.** Use the last pack for this chat plus the always-loaded set | Voice cannot wait for an extra step |

The existing code already follows this rule: the context planner falls back to
layered context on any error, and `request-context` only drops a block when
the seat is more than 80% sure it is unrelated.

### Always loaded, never decided

- Seat identity and the agent's system prompt.
- The **rules** part of instruction files: safety, permissions, guard
  rules, who may be contacted.
- Group-chat rules (for example, stay silent when another agent was named).
  `request-context` already never offers them.
- Channel and scope: who is talking, group or private chat.
- The message, its attachments, the reply-to text and any handover note.
- The continuity memo on a fresh session after a rotation.
- The AgentX core tools (`agentx_approval`, `agentx_request`,
  `agentx_events`, `agentx_attach_next`, `agentx_workflow`) and ToolSearch,
  because AgentX's own prompts name them.
- A one-line note of what can still be fetched, so "ask for more" works.

## 6. How to test it offline, and the figures that decide

### Data

Runtime session logs from the nodes. No new model call is needed to build the
test set.

1. Draw 200 turns at random across channels, stratified so that each
   channel and each seat has at least 20.
2. For each turn, record what the agent **actually used** later in the
   same session: history or recall tool calls, wiki queries, reads of
   memory or note files, skill bodies read, tool servers called, and
   instruction-file sections it quoted. This is the "needed" label.
3. Check 40 of them by hand before using the rest, as in #928.

### Replay

4. Run the combined decision on each turn with only identity, the message
   and the map, on the small model.
5. Compare its picks with the "needed" label. No main model runs.

### Figures

| Figure | Build it | Drop it |
|---|---|---|
| Continuations judged standalone (missed history) | under 2% | over 5% |
| Turns missing a capability they then used | under 3% | over 8% |
| Wiki pages: needed pages picked | over 70% | under 50% (today's prototype level) |
| First-turn size left after the session decision | under 70% of today's lean start | over 85% |
| Time added before the answer, chat channels, median | under 1.5 s | over 3 s |

If the replay passes, a second step is an end-to-end run: 20 past read-only
tasks with and without the design, graded blind as in #928 and #947. It goes
on only if the design is graded as good as a repeat of today's setting (5 of
10 in #928) with at least 10% saved on those tasks.

### Cost of the test (needs the owner's yes)

| Step | Cost |
|---|---|
| Labels from logs (steps 1 to 3) | No model cost; half a day |
| Decision replay, 200 turns, small model (steps 4 and 5) | About 1 USD |
| End-to-end run, 20 tasks, two settings, graded | About 15 USD, based on #928's 6.45 USD for 10 tasks per setting |

### Before sizing

- Wait for the #928 reader result. If its quoted-lines variant reaches
  today's quality, the reader becomes the fetcher for the wiki and
  trackers, and step 4 of the proposal changes.
- The `request-context` seat needs a latency figure on the direct API path
  before it can be the decision step. Through the local runtime it is
  four times over its own limit.

## Side findings (not part of the design)

These came from reading the code. They are not tested, and each would be its
own issue.

- **History is cut from the wrong end.** The history block is written
  oldest first and cut with `content.slice(0, max)` in `buildAgentContext`
  (`src/agents/context.ts`). The default history cap (12,000 characters)
  is larger than the block's own cap (1,200 tokens, about 4,800
  characters), so a long chat keeps its oldest turns and drops the newest.
  Long-memory recall is cut the same way.
- **Pushed twice on a full start:** the agent's system prompt (in the
  generated CLAUDE.md, the appended system prompt and the identity block)
  and the memory index (in CLAUDE.md and in the appended system prompt).
- **No per-block sizes are stored.** `task_traces` keeps totals per turn.
  The runtime's own session logs are the only per-call source, which is
  why each spike has to read them again.
- **The memory block is never empty.** With no match it falls back to the
  newest facts, so it is pushed on every turn where any facts exist.

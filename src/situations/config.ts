import { z } from "zod"

// --- situations: settings (#1892, phase 1: the courtesy-close gate) ---
//
//   situations:
//     mode: shadow            # off | shadow | active
//     courtesy:
//       onPerson: react       # drop | react | reply
//       reaction: "🙏"
//     backstop: { count: 6, windowMinutes: 10 }
//     maxAge: { duringHours: 12, endingMinutes: 60 }
//     closing: { enabled: false }   # phase 4: closing steps
//     seat: { noReplyBelow: 0.2, minLabeled: 50 }   # phase 5 (maxFalseNoReply unset)
//     importance: { enabled: false }                # phase 5
//     templates: { enabled: false, agentFill: false }  # phase 6
//     consent: { askMinutes: 60, defaultMinutes: 15, maxMinutes: 60, maxReads: 3, reaskMinutes: 30 }  # phase 7
//     news: { feeds: [], maxItems: 10, timeoutMs: 8000 }              # phase 7
//     learned: { enabled: false, model: opus, maxRunUsd: 2, windowDays: 28 }  # phase 8 (approver unset)
//
// `shadow` (the default) keeps the record of each chat and writes every
// message the gate WOULD drop to the gate log, but drops nothing and sends
// nothing. `active` drops. `off` does neither.

export const situationsConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "active"]).default("shadow"),
  courtesy: z.object({
    /** A person (not a bot, not one of our agents) sends only "thanks"
     *  after the talk ended: `react` puts a reaction on it where the channel
     *  has reactions (no text, no run); `drop` does nothing; `reply` lets it
     *  through to the agent as before. */
    onPerson: z.enum(["drop", "react", "reply"]).default("react"),
    /** The reaction for `onPerson: react`. */
    reaction: z.string().min(1).max(16).default("🙏"),
  }).default({}),
  /** Blunt brake under the word list: at most `count` messages from bots or
   *  our own agents start a run on one chat per `windowMinutes`. Past it the
   *  chat's talk is ended as a "courtesy loop" and further bot messages are
   *  dropped until the window clears. */
  backstop: z.object({
    count: z.number().int().min(1).max(1000).default(6),
    windowMinutes: z.number().min(1).max(1440).default(10),
  }).default({}),
  /** How long a phase lasts with no message before the talk counts as
   *  ended ("stale"). Checked when the next message arrives. */
  maxAge: z.object({
    duringHours: z.number().min(0.25).max(24 * 30).default(12),
    endingMinutes: z.number().min(1).max(24 * 60).default(60),
  }).default({}),
  /** Signal sources (phase 3), by id: `macos-focus`, `widget-hold`,
   *  `call-hold`, `calls`, `whatsapp-groups`, `telegram-members`. Every
   *  source is on where its adapter fits the node; this switches one off,
   *  limits it to some agents, or asks the person's yes before a read
   *  (`consent: person`). A sensitive source always needs that yes. The
   *  owner's hold (Focus, call, widget) does not read these switches: it
   *  holds as before.
   *
   *  Per-request sources (phase 7): `open-apps`, `browser-tabs`, `news`.
   *  These are OFF unless `enabled: true`, and read only when an agent
   *  asks for one request (`agentx_sources`). `open-apps` and
   *  `browser-tabs` are sensitive: each request needs the person's yes in
   *  the popup on this machine, and the yes ends by itself. */
  sources: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
    consent: z.enum(["none", "person"]).optional(),
  })).default({}),
  /** Closing steps (phase 4). Off by default. When on, a talk that was
   *  given closing steps (`agentx situation closing`) gets the workflow
   *  runs `situation-expiry` (ends it as stale at `maxAge`) and, when it
   *  ends, `situation-close` (one note at its home, each follow-up an open
   *  promise, one message to the owner). A talk without closing steps is
   *  unchanged: no run starts for it. */
  closing: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  /** The `situation-phase` decision seat (phase 5). Its mode is the seat's
   *  own setting, `decisions.seats.situation-phase.mode`: unset, it runs in
   *  shadow (asks and records, changes nothing) once `decisions.enabled`.
   *  It is asked only about a message the word list is unsure of, after
   *  the talk is ending or has ended. In active mode it holds such a
   *  message only when it says no reply is needed AND its calibration
   *  report is under the limit below. */
  seat: z.object({
    /** At or under this P(needs a reply), the seat says "no reply needed". */
    noReplyBelow: z.number().min(0).max(0.5).default(0.2),
    /** The false "no reply" rate the owner accepts (0.02 = 2 in 100),
     *  checked against the 95% upper bound. Unset: the seat never acts. */
    maxFalseNoReply: z.number().min(0).max(1).optional(),
    /** Labelled "no reply" answers needed before the report can pass. */
    minLabeled: z.number().int().min(1).max(100_000).default(50),
  }).default({}),
  /** Importance of each talk (phase 5): from the sender's role in
   *  `people` and an open promise on the chat, shown on the record and,
   *  when high, in the [Situation] prompt line. Off by default. */
  importance: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  /** Templates (phase 6, templates.ts): `meeting`, `meeting.external`,
   *  `job.production`, `hand-off`. Off by default: the [Situation] line
   *  and the closing note are as before, and any template name a person
   *  gives is kept as a label. On: a talk's template adds its prompt
   *  rules to the [Situation] line, its guidance to the closing note, and
   *  a person may name only a template of the catalog. */
  templates: z.object({
    enabled: z.boolean().default(false),
    /** The chat's own agent may name its talk's template and purpose in
     *  its turn (`agentx_situation`), within limits: no note home, no
     *  other writer, no extra promise owners, never over what a person
     *  set. Needs `enabled`. */
    agentFill: z.boolean().default(false),
  }).default({}),
  /** Learned templates (phase 8, learn.ts). Off by default. On: the
   *  weekly `situation-learn` workflow drafts templates from ended talks
   *  (redacted counts and lower-case purpose words only), and the
   *  `approver` agent says yes or no to each draft once. A draft carries
   *  prompt rules and closing-note guidance only; it is used (named by a
   *  person, with `templates.enabled`) only after the approver's yes. */
  learned: z.object({
    enabled: z.boolean().default(false),
    /** The agent that approves or turns down each draft. Unset: drafts
     *  wait, and nothing learned is used. */
    approver: z.string().min(1).optional(),
    /** The model that drafts (a strong one; it runs once a week). */
    model: z.string().min(1).default("opus"),
    /** Dollars one weekly run may spend, drafting and approver's reviews
     *  together, inside `improve.dailyUsd`. At most $2 (owner's answer). */
    maxRunUsd: z.number().min(0).max(2).default(2),
    /** How far back the run reads ended talks. */
    windowDays: z.number().int().min(7).max(30).default(28),
    /** Ended talks a draft must point to. */
    minEvidence: z.number().int().min(2).max(50).default(3),
    /** Drafts one run may propose. */
    maxDrafts: z.number().int().min(1).max(5).default(3),
  }).default({}),
  /** The person's yes for a per-request source (phase 7). An agent's ask
   *  is a decision card that takes a yes only in the popup on this
   *  machine; the card is the consent record. */
  consent: z.object({
    /** How long the card waits for an answer. No answer: nothing is read. */
    askMinutes: z.number().int().min(1).max(24 * 60).default(60),
    /** How long a yes lasts when the agent names no time. */
    defaultMinutes: z.number().int().min(1).max(24 * 60).default(15),
    /** The longest a yes may last, whatever the agent asks. */
    maxMinutes: z.number().int().min(1).max(24 * 60).default(60),
    /** Reads one yes allows. */
    maxReads: z.number().int().min(1).max(100).default(3),
    /** After a no or no answer, the agent may not ask again for this long. */
    reaskMinutes: z.number().int().min(0).max(24 * 60).default(30),
  }).default({}),
  /** The browser-tabs source (phase 7): only each tab's site by default;
   *  true also gives the path (which can hold names or codes). */
  browserTabs: z.object({
    includePaths: z.boolean().default(false),
  }).default({}),
  /** The `news` per-request source (phase 7): headlines from these RSS or
   *  Atom feeds. Only the owner names the feeds; an agent cannot. */
  news: z.object({
    feeds: z.array(z.string().url().refine((u) => /^https?:\/\//i.test(u), "an http(s) link")).max(20).default([]),
    maxItems: z.number().int().min(1).max(50).default(10),
    timeoutMs: z.number().int().min(500).max(60_000).default(8_000),
  }).default({}),
}).default({})

export type SituationsConfig = z.infer<typeof situationsConfigSchema>

export const DEFAULT_SITUATIONS_CONFIG: SituationsConfig = situationsConfigSchema.parse(undefined)

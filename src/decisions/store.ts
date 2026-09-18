import Database from "better-sqlite3"
import { createHash } from "crypto"
import { mkdirSync } from "fs"
import { dirname, resolve } from "path"
import { newEventId } from "@/intent/ulid"
import type { DecisionMeta } from "./backend"
import type { AnyAnswer, AnyQuestion, Questions, StateValue } from "./types"

// The shadow store: every decision the seat makes, and what actually
// happened afterwards.
//
// Deliberately NOT the intent ledger, for four reasons that are mechanical
// rather than stylistic:
//
//   1. `IntentDivergence.source` is a closed 9-member union of channel
//      names. "classifier" and "monitor-prefilter" have no representable
//      value, and that closedness is the ledger's stated design goal.
//   2. `IntentDecision.outcome` is dispatched|halted|deduped|queued.
//      A score or a probability has no projection onto it.
//   3. The ledger is canonical state. Speculative model output is derived
//      data, with a different retention and durability story.
//   4. The ledger's promotion gate is "zero divergences for >= 7 days".
//      A shadow seat is EXPECTED to disagree with the incumbent — that
//      disagreement is the measurement — so writing it into
//      intent_divergences would destroy the signal that gate depends on.
//
// Same storage discipline as the ledger, though: own file, WAL,
// synchronous=NORMAL, versioned migrations.

export interface OpenStoreOptions {
  /** Resolved relative to cwd. Default: .agentx/decisions/decisions.sqlite */
  path?: string
  readonly?: boolean
}

export type SeatMode = "off" | "shadow" | "active"
export type LabelKind = "human" | "outcome" | "replay"

/** What the policy decided to do with the answer. Recorded in shadow too,
 *  where it is the counterfactual rather than the action taken. */
export type DecisionAction = "review" | "skip"

export interface RecordCallInput {
  seat: string
  mode: SeatMode
  backend: string
  model: string
  meta: Pick<DecisionMeta, "structureMode" | "answerMode" | "retries" | "stateTruncated" | "latencyMs">
  state: StateValue
  questions: Questions
  answers: Record<string, AnyAnswer>
  usage?: { inputTokens: number; outputTokens: number }
  /** What the code would have done without the seat, per question. */
  incumbent?: Record<string, { value?: string | number; score?: number; source?: string }>
  links?: Array<{ kind: string; id: string }>
  /** A failed call is still a row. The failure rate is a measured quantity,
   *  not a hunch, and a seat that only records its successes flatters
   *  itself exactly where it matters. */
  error?: string
  /** Keep the serialized state for replay. Callers pass false once a seat
   *  has collected enough, and always false when redaction is on. */
  keepState?: boolean
  ts?: number
}

/** One decision, one question, joined to its incumbent and its truth.
 *  The unit every calibration metric consumes. */
export interface GradedRow {
  callId: string
  seat: string
  ts: number
  backend: string
  model: string
  structureMode: string
  question: string
  type: AnyQuestion["type"]
  /** The seat's answer, as a comparable scalar. */
  predicted: string
  confidence: number
  probabilities: Record<string, number>
  incumbent?: string
  truth?: string
  mode: SeatMode
  /** What the policy decided. Undefined for calls whose caller never
   *  recorded one. */
  action?: DecisionAction
  /** True when the policy said skip and exploration overrode it, so the
   *  expensive path ran anyway. These rows are the unbiased sample of the
   *  skip region — the only place a skip decision can ever be graded. */
  explored: boolean
}

export interface GradedRowFilter {
  seat?: string
  question?: string
  backend?: string
  model?: string
  structureMode?: string
  /** ms since epoch; rows at or after this time. */
  since?: number
  /** Only rows that have a ground-truth label. */
  labeledOnly?: boolean
  /** Only rows where exploration forced the expensive path. Calibration on
   *  these alone is the unbiased estimate of how the policy performs on the
   *  decisions it wants to skip. */
  exploredOnly?: boolean
  action?: DecisionAction
  limit?: number
}

export class DecisionStore {
  readonly db: Database.Database
  readonly path: string

  constructor(opts: OpenStoreOptions = {}) {
    this.path = resolve(process.cwd(), opts.path ?? ".agentx/decisions/decisions.sqlite")
    if (!opts.readonly) mkdirSync(dirname(this.path), { recursive: true })
    this.db = new Database(this.path, { readonly: opts.readonly ?? false })
    if (!opts.readonly) {
      this.db.pragma("journal_mode = WAL")
      this.db.pragma("synchronous = NORMAL")
      this.db.pragma("foreign_keys = ON")
      runMigrations(this.db)
    }
  }

  close(): void {
    this.db.close()
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(v) AS v FROM schema_version").get() as {
      v: number | null
    }
    return row.v ?? 0
  }

  /** Write one call and everything hanging off it, atomically. Returns the
   *  call id, which is what a later label or link refers to. */
  recordCall(input: RecordCallInput): string {
    const ts = input.ts ?? Date.now()
    const callId = newEventId(ts)
    const stateJson = JSON.stringify(input.state ?? null)
    const stateHash = createHash("sha256").update(stateJson).digest("hex")

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO decision_calls
             (id, ts, seat, mode, backend, model, structure_mode, answer_mode,
              state_hash, state_json, questions_json, latency_ms,
              input_tokens, output_tokens, retries, truncated, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          callId,
          ts,
          input.seat,
          input.mode,
          input.backend,
          input.model,
          input.meta.structureMode,
          input.meta.answerMode,
          stateHash,
          input.keepState === false ? null : stateJson,
          JSON.stringify(input.questions),
          input.meta.latencyMs,
          input.usage?.inputTokens ?? 0,
          input.usage?.outputTokens ?? 0,
          input.meta.retries,
          input.meta.stateTruncated ? 1 : 0,
          input.error ?? null,
        )

      const insertAnswer = this.db.prepare(
        `INSERT INTO decision_answers
           (call_id, question, type, answer_json, top_label, top_prob,
            expected_score, p_max, neg_entropy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const [question, answer] of Object.entries(input.answers)) {
        const view = answerView(answer)
        insertAnswer.run(
          callId,
          question,
          answer.type,
          JSON.stringify(answer),
          view.topLabel,
          view.topProb,
          view.expectedScore,
          view.pMax,
          view.negEntropy,
        )
      }

      if (input.incumbent) {
        const insertIncumbent = this.db.prepare(
          `INSERT OR REPLACE INTO decision_incumbent (call_id, question, value, score, source)
           VALUES (?, ?, ?, ?, ?)`,
        )
        for (const [question, row] of Object.entries(input.incumbent)) {
          insertIncumbent.run(
            callId,
            question,
            row.value === undefined ? null : String(row.value),
            row.score ?? null,
            row.source ?? null,
          )
        }
      }

      if (input.links) {
        const insertLink = this.db.prepare(
          `INSERT OR IGNORE INTO decision_links (call_id, ref_kind, ref_id) VALUES (?, ?, ?)`,
        )
        for (const link of input.links) insertLink.run(callId, link.kind, link.id)
      }
    })

    tx()
    return callId
  }

  /** Attach ground truth. Append-only: a correction is a new row, and reads
   *  take the newest, so a mislabel is fixable without losing the audit. */
  label(
    callId: string,
    question: string,
    value: string | number,
    opts: { kind?: LabelKind; labeledBy?: string; note?: string; ts?: number } = {},
  ): string {
    const ts = opts.ts ?? Date.now()
    const id = newEventId(ts)
    this.db
      .prepare(
        `INSERT INTO decision_labels (id, call_id, question, value, kind, labeled_at, labeled_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        callId,
        question,
        String(value),
        opts.kind ?? "human",
        ts,
        opts.labeledBy ?? null,
        opts.note ?? null,
      )
    return id
  }

  /** Record what the policy did with an answer. Separate from recordCall
   *  because the seat records the answer and the CALLER owns the policy —
   *  askSeat cannot know whether its caller acted on what it returned. */
  recordOutcome(callId: string, action: DecisionAction, explored = false): void {
    this.db
      .prepare("UPDATE decision_calls SET action = ?, explored = ? WHERE id = ?")
      .run(action, explored ? 1 : 0, callId)
  }

  findCallsByLink(kind: string, id: string): string[] {
    const rows = this.db
      .prepare(`SELECT call_id FROM decision_links WHERE ref_kind = ? AND ref_id = ?`)
      .all(kind, id) as Array<{ call_id: string }>
    return rows.map((r) => r.call_id)
  }

  gradedRows(filter: GradedRowFilter = {}): GradedRow[] {
    const where: string[] = ["c.error IS NULL"]
    const params: unknown[] = []
    if (filter.seat) (where.push("c.seat = ?"), params.push(filter.seat))
    if (filter.question) (where.push("a.question = ?"), params.push(filter.question))
    if (filter.backend) (where.push("c.backend = ?"), params.push(filter.backend))
    if (filter.model) (where.push("c.model = ?"), params.push(filter.model))
    if (filter.structureMode) (where.push("c.structure_mode = ?"), params.push(filter.structureMode))
    if (filter.since !== undefined) (where.push("c.ts >= ?"), params.push(filter.since))
    if (filter.action) (where.push("c.action = ?"), params.push(filter.action))
    if (filter.exploredOnly) where.push("c.explored = 1")

    // The newest label per (call, question) wins; ULIDs sort by time, so
    // MAX(id) is the newest without a second timestamp comparison.
    const sql = `
      SELECT c.id AS call_id, c.seat, c.ts, c.backend, c.model, c.structure_mode,
             c.mode, c.action, c.explored,
             a.question, a.type, a.answer_json, a.top_label, a.expected_score, a.neg_entropy,
             i.value AS incumbent,
             (SELECT l.value FROM decision_labels l
               WHERE l.call_id = c.id AND l.question = a.question
               ORDER BY l.id DESC LIMIT 1) AS truth
        FROM decision_calls c
        JOIN decision_answers a ON a.call_id = c.id
        LEFT JOIN decision_incumbent i ON i.call_id = c.id AND i.question = a.question
       WHERE ${where.join(" AND ")}
       ORDER BY c.ts DESC
       ${filter.limit ? "LIMIT ?" : ""}`
    if (filter.limit) params.push(filter.limit)

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, any>>
    return rows
      .map((r) => {
        const answer = JSON.parse(r.answer_json) as AnyAnswer
        const view = answerView(answer)
        return {
          callId: r.call_id,
          seat: r.seat,
          ts: r.ts,
          backend: r.backend,
          model: r.model,
          structureMode: r.structure_mode,
          question: r.question,
          type: answer.type,
          predicted: view.predicted,
          confidence: view.confidence,
          probabilities: view.probabilities,
          incumbent: r.incumbent ?? undefined,
          truth: r.truth ?? undefined,
          mode: r.mode as SeatMode,
          action: (r.action ?? undefined) as GradedRow["action"],
          explored: r.explored === 1,
        } as GradedRow
      })
      .filter((row) => !filter.labeledOnly || row.truth !== undefined)
  }

  /** Drop stored state once a seat has enough for replay, keeping the hash.
   *  Returns how many rows were cleared. */
  pruneState(seat: string, keepRows: number): number {
    const res = this.db
      .prepare(
        `UPDATE decision_calls SET state_json = NULL
          WHERE seat = ? AND state_json IS NOT NULL
            AND id NOT IN (
              SELECT id FROM decision_calls WHERE seat = ? ORDER BY ts DESC LIMIT ?
            )`,
      )
      .run(seat, seat, keepRows)
    return res.changes
  }
}

/** Project any answer onto the scalars the store and the metrics need.
 *  A noul becomes a two-outcome distribution so it grades through exactly
 *  the same machinery as a choice. */
export function answerView(answer: AnyAnswer): {
  predicted: string
  confidence: number
  probabilities: Record<string, number>
  topLabel: string
  topProb: number
  expectedScore: number | null
  pMax: number
  negEntropy: number
} {
  if (answer.type === "noul") {
    const p = answer.noul
    const probabilities = { yes: p, no: 1 - p }
    const predicted = p >= 0.5 ? "yes" : "no"
    // Distance from a coin flip, scaled to [0,1] — the only uncertainty a
    // binary carries, and comparable with the entropy statistic elsewhere.
    const confidence = Math.abs(p - 0.5) * 2
    return {
      predicted,
      confidence,
      probabilities,
      topLabel: predicted,
      topProb: Math.max(p, 1 - p),
      expectedScore: null,
      pMax: Math.max(p, 1 - p),
      negEntropy: confidence,
    }
  }

  if (answer.type === "choice") {
    return {
      predicted: answer.choice,
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
      topLabel: answer.choice,
      topProb: answer.probabilities[answer.choice] ?? 0,
      expectedScore: null,
      pMax: answer.pMax,
      negEntropy: answer.negEntropy,
    }
  }

  const rounded = String(Math.round(answer.score))
  return {
    predicted: rounded,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
    topLabel: rounded,
    topProb: answer.probabilities[rounded] ?? 0,
    expectedScore: answer.score,
    pMax: answer.pMax,
    negEntropy: answer.negEntropy,
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY);`)
  const current =
    (db.prepare("SELECT MAX(v) AS v FROM schema_version").get() as { v: number | null }).v ?? 0
  if (current < 1) migrationV1(db)
  if (current < 2) migrationV2(db)
}

/** What the policy decided, and whether exploration overrode it.
 *
 *  Recorded in every mode, including shadow, so the counterfactual is
 *  measurable before anything is ever actually skipped: "the policy would
 *  have skipped 40% of these, and here is how it did on them."
 *
 *  Without this the labeled sample under active mode is the set of reviews
 *  the policy chose to run, which is exactly the biased subsample its own
 *  metrics would then be computed on. */
function migrationV2(db: Database.Database): void {
  db.exec(`
    ALTER TABLE decision_calls ADD COLUMN action TEXT;
    ALTER TABLE decision_calls ADD COLUMN explored INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_decision_calls_action ON decision_calls (seat, action, explored);
    INSERT INTO schema_version (v) VALUES (2);
  `)
}

function migrationV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_calls (
      id             TEXT NOT NULL PRIMARY KEY,
      ts             INTEGER NOT NULL,
      seat           TEXT NOT NULL,
      mode           TEXT NOT NULL,
      backend        TEXT NOT NULL,
      model          TEXT NOT NULL,
      structure_mode TEXT NOT NULL,
      answer_mode    TEXT NOT NULL,
      state_hash     TEXT NOT NULL,
      state_json     TEXT,
      questions_json TEXT NOT NULL,
      latency_ms     INTEGER,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      retries        INTEGER NOT NULL DEFAULT 0,
      truncated      INTEGER NOT NULL DEFAULT 0,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_calls_seat ON decision_calls (seat, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_calls_backend ON decision_calls (backend, model, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_calls_state ON decision_calls (state_hash);

    CREATE TABLE IF NOT EXISTS decision_answers (
      call_id        TEXT NOT NULL REFERENCES decision_calls(id),
      question       TEXT NOT NULL,
      type           TEXT NOT NULL,
      answer_json    TEXT NOT NULL,
      top_label      TEXT,
      top_prob       REAL,
      expected_score REAL,
      p_max          REAL,
      neg_entropy    REAL,
      PRIMARY KEY (call_id, question)
    );

    CREATE TABLE IF NOT EXISTS decision_incumbent (
      call_id  TEXT NOT NULL REFERENCES decision_calls(id),
      question TEXT NOT NULL,
      value    TEXT,
      score    REAL,
      source   TEXT,
      PRIMARY KEY (call_id, question)
    );

    CREATE TABLE IF NOT EXISTS decision_labels (
      id         TEXT NOT NULL PRIMARY KEY,
      call_id    TEXT NOT NULL REFERENCES decision_calls(id),
      question   TEXT NOT NULL,
      value      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      labeled_at INTEGER NOT NULL,
      labeled_by TEXT,
      note       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_labels_call ON decision_labels (call_id, question);

    CREATE TABLE IF NOT EXISTS decision_links (
      call_id  TEXT NOT NULL REFERENCES decision_calls(id),
      ref_kind TEXT NOT NULL,
      ref_id   TEXT NOT NULL,
      PRIMARY KEY (call_id, ref_kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_links_ref ON decision_links (ref_kind, ref_id);

    INSERT INTO schema_version (v) VALUES (1);
  `)
}

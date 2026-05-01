import { createHash } from "crypto"
import { GraphStore } from "./store"
import {
  type GraphSchema,
  type GraphNode,
  type Classification,
} from "./types"

// --- Intent Knowledge Graph classifier ---
//
// For every incoming message, returns a path through the taxonomy:
//   1. fingerprint → cache hit → reuse path (0 LLM calls, source=cache)
//   2. miss → LLM draftAgent proposes { path, axes } → validated → pending
//   3. autoApproveConfidence met → committed + cached
//
// Pending paths are still usable immediately (caller tags artifacts with
// them); approval flips the flag and populates the fingerprint index so
// the next similar message hits the cache.

export interface ClassifyInput {
  text: string
  channel?: string
  sender?: string
  /** Agent that will RECEIVE the message after classification. When this
   *  equals `draftAgent`, classification is skipped to prevent a deadlock —
   *  the classifier's sub-task would otherwise queue behind the in-progress
   *  main task on the same agent. */
  agentId?: string
}

export interface ClassifyResult {
  /** Node ids from root to leaf. Shorter-than-full paths are allowed. */
  path: string[]
  /** Stable hash of the path — used as the `graph:<pathId>` wiki tag. */
  pathId: string
  /** Human-readable "A › B › C" path for logs + UI. */
  pathLabel: string
  /** Axis values asserted by the classifier. Keyed by node id. */
  axes: Record<string, Record<string, string>>
  leaf: { input?: string; output?: string }
  source: "cache" | "llm"
  status: "pending" | "approved"
  confidence?: number
}

export type ApprovalStructurePolicy = "strict" | "extend-leaves" | "any"

export interface ClassifierOptions {
  store: GraphStore
  /** Base URL of the daemon — used to POST /task for LLM proposals. */
  daemonUrl: string
  /** Optional bearer token for the daemon. */
  token?: string
  /** Which agent makes the proposal. Required if caller ever expects a
   *  non-cached classification (cache hits work without an agent). */
  draftAgent?: string
  /** Structural approval policy — see config.ts for semantics. Default
   *  "extend-leaves" (auto-approve pure reuse + single-leaf additions). */
  autoApproveStructure?: ApprovalStructurePolicy
  /** Minimum confidence (0..1) to commit without human approval. 1.0 = never.
   *  OR'd with the structural policy. */
  autoApproveConfidence?: number
  /** Anthropic model id for the direct classifier call. Default haiku —
   *  this is metadata, not work, so we use the cheapest fast model. */
  classifierModel?: string
  log?: (...args: unknown[]) => void
}

export class Classifier {
  private store: GraphStore
  private daemonUrl: string
  private token?: string
  private draftAgent?: string
  private autoApprove: number
  private autoApproveStructure: ApprovalStructurePolicy
  private classifierModel: string
  private log: (...args: unknown[]) => void

  constructor(opts: ClassifierOptions) {
    this.store = opts.store
    this.daemonUrl = opts.daemonUrl.replace(/\/+$/, "")
    this.token = opts.token
    this.draftAgent = opts.draftAgent
    this.autoApprove = opts.autoApproveConfidence ?? 1.0
    this.autoApproveStructure = opts.autoApproveStructure ?? "extend-leaves"
    this.classifierModel = opts.classifierModel ?? "claude-haiku-4-5-20251001"
    this.log = opts.log ?? console.error.bind(console, "[classifier]")
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult | null> {
    const fp = this.store.fingerprint({
      text: input.text,
      channel: input.channel,
      sender: input.sender,
    })

    // 1. Cache hit — instant return, zero LLM. Logged to classifications.jsonl
    //    so the cache-hit rate is measurable from the persisted record alone
    //    (otherwise hits leave no trace and ROI of the classifier is invisible).
    const cached = this.store.getFingerprint(fp)
    if (cached) {
      this.store.appendClassification({
        ts: new Date().toISOString(),
        msgHash: fp,
        agentId: input.agentId,
        channel: input.channel,
        sender: input.sender,
        path: cached.path,
        proposedAxes: {},
        leaf: cached.leaf,
        source: "cache",
        status: "approved",
        preview: input.text.slice(0, 200),
      })
      return {
        path: cached.path,
        pathId: hashPath(cached.path),
        pathLabel: pathLabel(cached.path, this.store.loadNodes().nodes),
        axes: {},
        leaf: cached.leaf,
        source: "cache",
        status: "approved",
      }
    }

    // 2. Cache miss — need an LLM proposal. Phase 2 of classifier-retire
    //    replaced the /task → graph-agent dispatch with a direct Anthropic
    //    Messages call, so we no longer need a draftAgent and the
    //    self-dispatch deadlock guard (`agentId === draftAgent`) is moot.
    //    `graph.enabled` is the only gate now.
    const schema = this.store.loadSchema()
    const nodes = this.store.loadNodes().nodes
    const proposal = await this.proposePath(input, schema, nodes).catch((e) => {
      this.log("LLM proposal failed:", e?.message || e)
      return null
    })
    if (!proposal) return null

    // 3. Validate + persist as pending. Any NEW node the LLM proposed is
    //    only committed if the whole classification auto-approves below.
    const { path, proposedAxes, confidence, leaf } = proposal
    if (path.length === 0) return null

    const classification: Classification = {
      ts: new Date().toISOString(),
      msgHash: fp,
      agentId: input.agentId,
      channel: input.channel,
      sender: input.sender,
      path,
      proposedAxes,
      leaf,
      source: "llm",
      status: "pending",
      confidence,
      preview: input.text.slice(0, 200),
    }

    // --- Auto-approval policy (see config.ts for full semantics) ---
    //
    // Two conditions, OR'd. Either approves the classification:
    //   1. Structure policy — what KIND of change the proposed path makes:
    //        strict:        nothing auto — always pending
    //        extend-leaves: auto if the path either (a) reuses only existing
    //                       nodes, or (b) adds exactly one new node at the
    //                       DEEPEST level (a new leaf). Structural changes
    //                       (new mid-path or root node) still queue.
    //        any:           auto regardless of structure.
    //   2. Confidence — LLM-self-reported confidence >= autoApproveConfidence.
    //
    // Pending classifications still persist to the log, but don't commit nodes
    // and don't populate the fingerprint cache (so similar messages re-query).
    const existingIds = new Set(nodes.map((n) => n.id))
    const newNodeIndices = path
      .map((id, idx) => (existingIds.has(id) ? -1 : idx))
      .filter((idx) => idx >= 0)

    let structureOk = false
    if (this.autoApproveStructure === "any") {
      structureOk = true
    } else if (this.autoApproveStructure === "extend-leaves") {
      const isReuseOnly = newNodeIndices.length === 0
      const isSingleLeafAddition =
        newNodeIndices.length === 1 && newNodeIndices[0] === path.length - 1
      structureOk = isReuseOnly || isSingleLeafAddition
    }
    const confidenceOk = confidence !== undefined && confidence >= this.autoApprove

    let status: "pending" | "approved" = "pending"
    if (structureOk || confidenceOk) {
      // Commit any new nodes; if ANY fail schema validation (missing axes,
      // bad ref, etc.) fall back to pending for the whole classification
      // rather than half-committing the graph and bubbling the error up to
      // the task handler.
      try {
        this.commitNewNodes(path, proposedAxes, schema, nodes, input.sender)
        this.store.setFingerprint(fp, { path, leaf })
        status = "approved"
      } catch (e: any) {
        this.log(
          `auto-approve failed — staying pending ·`,
          `path=${JSON.stringify(path)}`,
          `reason=${(e?.message || e).toString().slice(0, 200)}`,
        )
      }
    }
    classification.status = status
    this.store.appendClassification(classification)

    return {
      path,
      pathId: hashPath(path),
      pathLabel: pathLabel(path, this.store.loadNodes().nodes),
      axes: proposedAxes,
      leaf,
      source: "llm",
      status,
      confidence,
    }
  }

  /** Direct call to Anthropic to propose a path. Pure I/O; no side effects.
   *  Bypasses the mesh / dispatch / ledger pipeline so a classification
   *  doesn't surface as a sibling task in the activity graph. */
  private async proposePath(
    input: ClassifyInput,
    schema: GraphSchema,
    nodes: GraphNode[],
  ): Promise<{
    path: string[]
    proposedAxes: Record<string, Record<string, string>>
    confidence?: number
    leaf: { input?: string; output?: string }
  } | null> {
    const nodesForPrompt = nodes.map((n) => ({
      id: n.id,
      level: n.level,
      parentId: n.parentId,
      axes: n.axes,
    }))
    const userPrompt = [
      `You are the intent classifier for AgentX. You answer ONE question:`,
      `"what kind of work does this message describe?" — verb-level only.`,
      ``,
      `IMPORTANT — what NOT to encode in the path:`,
      `- Client / company / project / team names. Those are already on the event`,
      `  metadata (project, channel, agentId). Embedding them in the path causes`,
      `  duplicate nodes (one per client) for the same verb.`,
      `- The specific subject (issue number, file name, person name). Same reason.`,
      `- The agent's name or role. Pick the verb the *requester* intended.`,
      ``,
      `SCHEMA (fixed levels — pick one node per level):`,
      "```json",
      JSON.stringify(schema, null, 2),
      "```",
      ``,
      `EXISTING NODES (prefer reusing these; only invent a new node when no`,
      `existing one fits):`,
      "```json",
      JSON.stringify(nodesForPrompt, null, 2),
      "```",
      ``,
      `MESSAGE:`,
      "```",
      input.text.slice(0, 2000),
      "```",
      `channel: ${input.channel ?? "?"}`,
      `sender: ${input.sender ?? "?"}`,
      ``,
      `TASK:`,
      `1. Classify into 'category' (closed enum): code, ops, support, admin,`,
      `   knowledge, social, system. Pick the closest fit.`,
      `2. Pick or propose a 'verb' node. Verb ids are dot-namespaced lower-kebab,`,
      `   e.g. "review.merge-request", "deploy.staging", "investigate.error",`,
      `   "chat.greeting", "fix.bug". Reuse an existing verb when the message is`,
      `   the same kind of work as something already classified, even when the`,
      `   client / project / subject differs.`,
      ``,
      `Examples (right vs wrong):`,
      `- "Please review MR #957 on mtgl/system" → ["code", "review.merge-request"]`,
      `   NOT ["business", "noqta", "mtgl-v2", "review-mr-957-system"]`,
      `- "Deploy ksi-v2 to staging please" → ["ops", "deploy.staging"]`,
      `   NOT ["business", "noqta", "ksi-v2", "deploy-ksi-v2-to-staging"]`,
      `- "Hello Atlas" → ["support", "chat.greeting"]`,
      ``,
      `NODE ID RULES (strict — invalid ids get dropped):`,
      `- lowercase-kebab + dots only: [a-z0-9][a-z0-9._-]*`,
      `- no spaces, no uppercase, no Arabic/other non-Latin`,
      `- verb ids should use a "category.specific" or "verb.modifier" shape`,
      ``,
      `Return ONE JSON object on one line, no prose, no fences:`,
      `  { "path": string[], "proposedAxes": { [nodeId]: { [axisName]: string } }, "leaf": { "input"?: string, "output"?: string }, "confidence": number }`,
      `confidence in [0,1]. Prefer low confidence over guessing.`,
    ].join("\n")

    // Phase 2 of classifier-retire: direct Anthropic Messages API call.
    // Replaces the previous /task → graph-agent → mesh dispatch path
    // (which created a sibling ledger event per classification — typically
    // 60-70% of all dispatches in the activity graph). Single Haiku call,
    // ~200ms cold, no dispatch wrapper, no extra ledger row.
    //
    // The daemon's `graph.classifierModel` config knob picks the model
    // (default haiku); falls back to draftAgent's tier model if the
    // operator wired a draftAgent for back-compat.
    const data: any = await this.callAnthropicDirect(userPrompt)
    const text = extractTextContent(data)
    const parsed = extractJson(text)
    if (!parsed || !Array.isArray(parsed.path)) return null

    // LLM often returns human-readable labels ("Business", "Sales Manager").
    // The node-id schema requires a lowercase slug, so normalize here and
    // remember the original → slug mapping so proposedAxes stays attached.
    // We also drop any element that can't be slugified into a valid id (e.g.
    // a path entry of pure Arabic script) — better to classify with a shorter
    // path than to have the store reject the whole classification.
    const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
    const slugMap = new Map<string, string>()
    const path: string[] = parsed.path
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
      .map((s: string) => {
        const trimmed = s.trim()
        const slugged = slugifyNodeId(trimmed)
        if (trimmed !== slugged) slugMap.set(trimmed, slugged)
        return slugged
      })
      .filter((s: string) => NODE_ID_RE.test(s))
    if (path.length === 0) return null

    const proposedAxes: Record<string, Record<string, string>> = {}
    if (parsed.proposedAxes && typeof parsed.proposedAxes === "object") {
      for (const [rawNodeId, axes] of Object.entries(parsed.proposedAxes as Record<string, any>)) {
        if (!axes || typeof axes !== "object") continue
        const nodeId = slugMap.get(rawNodeId) ?? slugifyNodeId(rawNodeId)
        if (!nodeId) continue
        const clean: Record<string, string> = {}
        for (const [k, v] of Object.entries(axes)) {
          if (typeof v === "string") clean[k] = v
        }
        // If the LLM didn't volunteer a human-readable name but we slugified
        // one away, preserve the original as a `name` axis so the UI can
        // render "Sales Manager" not "sales-manager".
        if (!clean.name && rawNodeId !== nodeId) clean.name = rawNodeId.trim()
        proposedAxes[nodeId] = clean
      }
    }

    const leaf: { input?: string; output?: string } = {}
    if (parsed.leaf && typeof parsed.leaf === "object") {
      if (typeof parsed.leaf.input === "string") leaf.input = parsed.leaf.input
      if (typeof parsed.leaf.output === "string") leaf.output = parsed.leaf.output
    }

    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined

    return { path, proposedAxes, confidence, leaf }
  }

  /** Create any nodes along `path` that don't exist yet. Delegates to the
   *  store so level inference (for paths that skip levels) + fresh reloads
   *  between adds are shared with the review path. */
  private commitNewNodes(
    path: string[],
    proposedAxes: Record<string, Record<string, string>>,
    schema: GraphSchema,
    _existing: GraphNode[],
    createdBy?: string,
  ): void {
    this.store.commitNodesAlongPath(path, proposedAxes, schema, createdBy)
  }

  /** Resolve the Anthropic API key for direct classifier calls. Order:
   *    1. ANTHROPIC_API_KEY env var (most explicit)
   *    2. ${apiKey} resolved from daemon config providers.claude.apiKey
   *       (which is what other tier-orchestrator agents already use)
   *    3. resolveToken() from auth-store (Claude Code subscription, etc.)
   *  Throws when none is available — operator should set
   *  ANTHROPIC_API_KEY or providers.claude.apiKey for the classifier
   *  to function (it costs Haiku-class tokens per inbound event). */
  private async resolveApiKey(): Promise<string> {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
    // Lazy-import to avoid pulling auth-store into every consumer.
    try {
      const { resolveToken } = await import("@/utils/auth-store")
      const t = resolveToken()
      if (t?.token) return t.token
    } catch { /* fall through */ }
    throw new Error("Classifier: no ANTHROPIC_API_KEY available (set the env var or providers.claude.apiKey)")
  }

  /** Direct call to Anthropic Messages API. Replaces the legacy
   *  fetch(/task) → mesh → graph-agent path so the classifier no longer
   *  generates a sibling ledger event. Cheap model on purpose: this is
   *  metadata, not work. 30s timeout — Haiku usually returns in <1s. */
  private async callAnthropicDirect(userPrompt: string): Promise<unknown> {
    const apiKey = await this.resolveApiKey()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30_000)
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.classifierModel,
          max_tokens: 800,
          system:
            "You are a taxonomy classifier. Respond with a single JSON object on one line. No prose, no code fences.",
          messages: [{ role: "user", content: userPrompt }],
        }),
        signal: ac.signal,
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => "")
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`)
      }
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Pull the first text content block out of an Anthropic Messages API
 *  response. Matches the shape src/agent/providers/claude.ts uses; kept
 *  inline so the classifier doesn't depend on the agent provider stack
 *  (which has heavier tool-use plumbing the classifier doesn't need). */
function extractTextContent(response: any): string {
  if (!response || typeof response !== "object") return ""
  const content = response.content
  if (!Array.isArray(content)) return ""
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") return block.text
  }
  return ""
}

/** Normalize an LLM-proposed node label to a valid node id. Matches the
 *  schema's `^[a-z0-9][a-z0-9._-]*$` — lowercase, alnum/./-/_, leading alnum.
 *  Dots are preserved for verb ids like "review.merge-request". */
function slugifyNodeId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/-{2,}/g, "-")
  if (!s) return ""
  // Ensure leading char is alnum (schema rejects leading _ or -).
  return /^[a-z0-9]/.test(s) ? s : `n-${s}`.replace(/[-_]+$/, "")
}

// --- path helpers used by both classifier + wiki retrieval ---

/** Deterministic hash of a path, used as the `graph:<pathId>` wiki tag. */
export function hashPath(path: string[]): string {
  return createHash("sha1")
    .update(path.join("\u0001"))
    .digest("hex")
    .slice(0, 16)
}

/** "Business › Noqta › DevOps › Review MR" — for the UI + context render. */
export function pathLabel(path: string[], nodes: GraphNode[]): string {
  return path
    .map((id) => {
      const n = nodes.find((x) => x.id === id)
      if (!n) return id
      // Prefer a `name` axis when the schema has one; fall back to id.
      const name = n.axes?.name || n.axes?.what || id
      return name
    })
    .join(" › ")
}

/**
 * Depth of the deepest common ancestor between two paths, normalized to [0,1].
 * Used to score wiki articles: exact match = 1, shared grandparent = 0.5, none = 0.
 */
export function ancestryScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  let shared = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) shared++
    else break
  }
  if (shared === 0) return 0
  const depth = Math.max(a.length, b.length)
  return shared / depth
}

// --- tiny JSON extractor (agents wrap output in fences sometimes) ---

function extractJson(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* fall through */
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      return JSON.parse(fenced[1])
    } catch {
      /* fall through */
    }
  }
  // Last-ditch: grab the first balanced {...}.
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

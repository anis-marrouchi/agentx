import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs"
import { resolve, dirname } from "path"
import { createHash } from "crypto"
import {
  graphSchemaSchema,
  nodesFileSchema,
  indexFileSchema,
  classificationSchema,
  type GraphSchema,
  type GraphNode,
  type NodesFile,
  type IndexFile,
  type Classification,
  type FingerprintEntry,
} from "./types"
import { STARTER_SCHEMA } from "./starter-schema"

// --- Intent Knowledge Graph filesystem store ---
//
// Mirrors the .agentx/wiki pattern: plain JSON on disk, one directory, no DB.
// Not thread-safe across processes — writes go through safeWrite (tmp + rename).

export interface GraphStoreOptions {
  baseDir?: string
  log?: (...args: unknown[]) => void
}

export class GraphStore {
  readonly baseDir: string
  private log: (...args: unknown[]) => void

  constructor(opts: GraphStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/graph")
    this.log = opts.log ?? console.error.bind(console, "[graph]")
    mkdirSync(this.baseDir, { recursive: true })
  }

  // --- Paths ---

  schemaPath(): string { return resolve(this.baseDir, "schema.json") }
  nodesPath(): string { return resolve(this.baseDir, "nodes.json") }
  indexPath(): string { return resolve(this.baseDir, "index.json") }
  classificationsPath(): string { return resolve(this.baseDir, "classifications.jsonl") }

  // --- Schema ---

  /** Load the graph schema, seeding STARTER_SCHEMA if the file is missing. */
  loadSchema(): GraphSchema {
    const p = this.schemaPath()
    if (!existsSync(p)) {
      this.saveSchema(STARTER_SCHEMA)
      this.log("seeded starter schema at", p)
      return STARTER_SCHEMA
    }
    const raw = readFileSync(p, "utf-8")
    const parsed = graphSchemaSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Invalid ${p}: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    return parsed.data
  }

  saveSchema(schema: GraphSchema): void {
    const parsed = graphSchemaSchema.safeParse(schema)
    if (!parsed.success) {
      throw new Error(`Refusing to save invalid schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    safeWriteJson(this.schemaPath(), parsed.data)
  }

  // --- Nodes ---

  loadNodes(): NodesFile {
    const p = this.nodesPath()
    if (!existsSync(p)) return { version: 1, nodes: [] }
    const raw = readFileSync(p, "utf-8")
    const parsed = nodesFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Invalid ${p}: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    return parsed.data
  }

  saveNodes(file: NodesFile): void {
    const parsed = nodesFileSchema.safeParse(file)
    if (!parsed.success) {
      throw new Error(`Refusing to save invalid nodes file: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    safeWriteJson(this.nodesPath(), parsed.data)
  }

  /** Validate a node against the schema AND uniqueness within the nodes file. */
  validateNode(node: GraphNode, schema: GraphSchema, all: GraphNode[]): void {
    const level = schema.levels.find((l) => l.id === node.level)
    if (!level) throw new Error(`Unknown level: "${node.level}"`)

    const missing = level.axes.filter((a) => !(a.name in node.axes))
    if (missing.length) {
      throw new Error(
        `Node ${node.id} (${node.level}) missing required axes: ${missing.map((a) => a.name).join(", ")}`,
      )
    }

    for (const a of level.axes) {
      const v = node.axes[a.name]
      if (v == null) continue
      if (a.type === "enum" && a.values && !a.values.includes(v)) {
        throw new Error(`Node ${node.id}: axis ${a.name}="${v}" not in enum ${JSON.stringify(a.values)}`)
      }
      if (a.type === "ref") {
        if (!all.some((n) => n.id === v)) {
          throw new Error(`Node ${node.id}: axis ${a.name}="${v}" refers to unknown node`)
        }
        if (a.refLevel) {
          const target = all.find((n) => n.id === v)!
          if (target.level !== a.refLevel) {
            throw new Error(
              `Node ${node.id}: axis ${a.name} expected level "${a.refLevel}" but got "${target.level}"`,
            )
          }
        }
      }
    }

    const levelIdx = schema.levels.findIndex((l) => l.id === node.level)
    if (levelIdx === 0) {
      if (node.parentId !== null) {
        throw new Error(`Root-level node ${node.id} must have parentId: null`)
      }
    } else {
      if (!node.parentId) {
        throw new Error(`Non-root node ${node.id} must have a parentId`)
      }
      const parent = all.find((n) => n.id === node.parentId)
      if (!parent) throw new Error(`Node ${node.id}: parent "${node.parentId}" not found`)
      const parentLevelIdx = schema.levels.findIndex((l) => l.id === parent.level)
      // Parent may be at any higher level — intermediate levels can be skipped
      // for orgs that don't use them (e.g. remote-first: no location node).
      if (parentLevelIdx < 0 || parentLevelIdx >= levelIdx) {
        throw new Error(
          `Node ${node.id} at level "${node.level}" has parent at level "${parent.level}" — parent must be at a higher level`,
        )
      }
    }
  }

  /** Append a node. Caller is responsible for id uniqueness; we check and throw. */
  addNode(node: GraphNode): GraphNode {
    const schema = this.loadSchema()
    const file = this.loadNodes()
    if (file.nodes.some((n) => n.id === node.id)) {
      throw new Error(`Node id already exists: ${node.id}`)
    }
    this.validateNode(node, schema, [...file.nodes, node])
    file.nodes.push(node)
    this.saveNodes(file)
    return node
  }

  // --- Classifications (append-only log) ---

  appendClassification(c: Classification): void {
    const parsed = classificationSchema.safeParse(c)
    if (!parsed.success) {
      throw new Error(`Refusing to log invalid classification: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    const line = JSON.stringify(parsed.data) + "\n"
    const p = this.classificationsPath()
    if (!existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true })
    }
    appendFileSync(p, line)
  }

  /** Read the last N classifications, newest first. Cheap enough for the admin UI. */
  readRecentClassifications(limit = 50): Classification[] {
    const p = this.classificationsPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, "utf-8")
    const lines = raw.split("\n").filter(Boolean)
    const out: Classification[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const parsed = classificationSchema.safeParse(JSON.parse(lines[i]))
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip malformed line — append-only log; don't fail reads on one bad line
      }
    }
    return out
  }

  // --- Fingerprint index ---

  /**
   * Hash that represents "this kind of message" for snap-to-path caching.
   * Normalizes casing + whitespace; includes channel + sender so two people
   * writing the same words can still land on different paths if they should.
   */
  fingerprint(msg: {
    text: string
    channel?: string
    sender?: string
  }): string {
    const norm = msg.text.toLowerCase().replace(/\s+/g, " ").trim()
    const payload = [norm, msg.channel ?? "", msg.sender ?? ""].join("\u0001")
    return createHash("sha256").update(payload).digest("hex").slice(0, 32)
  }

  loadIndex(): IndexFile {
    const p = this.indexPath()
    if (!existsSync(p)) return { version: 1, entries: {} }
    const raw = readFileSync(p, "utf-8")
    const parsed = indexFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Invalid ${p}: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    return parsed.data
  }

  saveIndex(file: IndexFile): void {
    const parsed = indexFileSchema.safeParse(file)
    if (!parsed.success) {
      throw new Error(`Refusing to save invalid index: ${parsed.error.issues.map((i) => i.message).join("; ")}`)
    }
    safeWriteJson(this.indexPath(), parsed.data)
  }

  getFingerprint(fp: string): FingerprintEntry | undefined {
    return this.loadIndex().entries[fp]
  }

  setFingerprint(fp: string, entry: Omit<FingerprintEntry, "fingerprint" | "updatedAt">): void {
    const file = this.loadIndex()
    file.entries[fp] = {
      ...entry,
      fingerprint: fp,
      updatedAt: new Date().toISOString(),
    }
    this.saveIndex(file)
  }

  /** Update the axes on an existing node. Schema-validates the result. */
  updateNodeAxes(id: string, axes: Record<string, string>): GraphNode {
    const schema = this.loadSchema()
    const file = this.loadNodes()
    const node = file.nodes.find((n) => n.id === id)
    if (!node) throw new Error(`Node not found: ${id}`)
    const updated: GraphNode = { ...node, axes }
    this.validateNode(updated, schema, file.nodes.map((n) => (n.id === id ? updated : n)))
    file.nodes = file.nodes.map((n) => (n.id === id ? updated : n))
    this.saveNodes(file)
    return updated
  }

  /** Remove a node. Refuses to delete if any other node still references it
   *  (child via parentId, or axis ref). */
  deleteNode(id: string): void {
    const file = this.loadNodes()
    const child = file.nodes.find((n) => n.parentId === id)
    if (child) {
      throw new Error(`Cannot delete "${id}" — child node "${child.id}" still points to it`)
    }
    const refHolder = file.nodes.find((n) =>
      Object.values(n.axes).some((v) => v === id),
    )
    if (refHolder) {
      throw new Error(`Cannot delete "${id}" — node "${refHolder.id}" references it via an axis`)
    }
    file.nodes = file.nodes.filter((n) => n.id !== id)
    this.saveNodes(file)
  }

  /** Approve a pending classification. Commits any new nodes along its path,
   *  stamps the fingerprint index so future similar messages hit the cache,
   *  and appends an audit entry. Idempotent — no-op if already cached. */
  approveClassification(c: Classification): void {
    if (this.getFingerprint(c.msgHash)) return // already approved
    // Commit any path nodes the LLM proposed but hadn't been confirmed yet.
    const schema = this.loadSchema()
    const known = new Set(this.loadNodes().nodes.map((n) => n.id))
    for (let i = 0; i < c.path.length; i++) {
      const id = c.path[i]
      if (known.has(id)) continue
      const level = schema.levels[i]?.id
      if (!level) break
      const axes = c.proposedAxes?.[id] ?? {}
      const parentId = i === 0 ? null : c.path[i - 1]
      this.addNode({
        id,
        level,
        parentId,
        axes,
        createdAt: new Date().toISOString(),
        createdBy: c.agentId,
      })
      known.add(id)
    }
    this.setFingerprint(c.msgHash, { path: c.path, leaf: c.leaf })
    this.appendClassification({ ...c, status: "approved", ts: new Date().toISOString() })
  }

  /** Record rejection — no nodes committed, no fingerprint set. */
  rejectClassification(c: Classification): void {
    this.appendClassification({ ...c, status: "rejected", ts: new Date().toISOString() })
  }
}

/** Atomic write: tmp file + rename. Avoids half-written JSON on crashes. */
function safeWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

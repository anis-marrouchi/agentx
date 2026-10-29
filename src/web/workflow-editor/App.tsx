import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Canvas, type RunState, type Selection, type ViewBox } from "./Canvas"
import { Inspector } from "./Inspector"
import { Palette } from "./Palette"
import { Icon } from "./Icons"
import { KbdOverlay, RunPanel, Toolbar, type RunStep, type SaveStatus } from "./Toolbar"
import { ChatWidget } from "./ChatWidget"
import { blankGraph, graphToWorkflow, type GraphEdge, type GraphModel, type GraphNode, workflowToGraph, TRIGGER_NODE_ID } from "./graph"
import { deleteWorkflow, fetchAgents, fetchLayout, fetchWorkflow, saveLayout, saveWorkflow, validate, type AgentSummary } from "./api"
import { MOCK_AGENTS, type AgentInfo, type PaletteItem, type TemplateCard } from "./data"
import { arrange, needsArrange } from "./geometry"
import type { Workflow } from "./types"

// --- Editor state ---------------------------------------------------------

type EditorState = {
  meta: GraphModel["meta"]
  nodes: GraphNode[]
  edges: GraphEdge[]
  selection: Selection | null
  /** True only for the inaugural save; POST /api/workflows vs. PUT /:id. */
  isNew: boolean
}

type Action =
  | { type: "hydrate"; graph: GraphModel; isNew: boolean }
  | { type: "setTitle"; title: string }
  | { type: "patchMeta"; patch: Partial<GraphModel["meta"]> }
  | { type: "select"; selection: Selection | null; commit?: boolean }
  | { type: "moveNode"; id: string; x: number; y: number }
  | { type: "patchNode"; id: string; patch: Partial<GraphNode> }
  | { type: "patchNodeData"; id: string; patch: Record<string, unknown> }
  | { type: "patchEdge"; id: string; patch: Partial<GraphEdge> }
  | { type: "addNode"; item: PaletteItem; x: number; y: number }
  | { type: "connect"; conn: { from: string; fromPort: string | undefined; to: string } }
  | { type: "delete"; selection?: Selection }
  | { type: "duplicate"; selection?: Selection }
  | { type: "layout" }
  | { type: "setAll"; state: EditorState }

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "hydrate":
      return {
        meta: action.graph.meta,
        nodes: action.graph.nodes,
        edges: action.graph.edges,
        selection: null,
        isNew: action.isNew,
      }
    case "setTitle":
      return { ...state, meta: { ...state.meta, title: action.title } }
    case "patchMeta":
      return { ...state, meta: { ...state.meta, ...action.patch } }
    case "select":
      return { ...state, selection: action.selection }
    case "moveNode":
      return { ...state, nodes: state.nodes.map((n) => n.id === action.id ? { ...n, position: { x: action.x, y: action.y } } : n) }
    case "patchNode":
      return { ...state, nodes: state.nodes.map((n) => n.id === action.id ? { ...n, ...action.patch } : n) }
    case "patchNodeData":
      return { ...state, nodes: state.nodes.map((n) => n.id === action.id ? { ...n, config: { ...n.config, ...action.patch } } : n) }
    case "patchEdge":
      return { ...state, edges: state.edges.map((e) => (e as { id?: string }).id === action.id ? { ...e, ...action.patch } : e) }
    case "addNode": {
      const id = "n-" + Math.random().toString(36).slice(2, 8)
      const newNode: GraphNode = {
        id, type: action.item.type,
        position: { x: action.x, y: action.y },
        config: defaultConfigFor(action.item),
      }
      return { ...state, nodes: [...state.nodes, newNode], selection: { kind: "node", id } }
    }
    case "connect": {
      if (action.conn.from === action.conn.to) return state
      const id = "e-" + Math.random().toString(36).slice(2, 8)
      // The port is the edge's fromPort (ports.ts); the main port has none,
      // which is what the engine fires for a plain step or a follow-up's
      // main answer. The node draws its port names, so no label is needed.
      const edge: GraphEdge = { id, from: action.conn.from, to: action.conn.to }
      if (action.conn.fromPort !== undefined) edge.fromPort = action.conn.fromPort
      if (state.edges.some((e) => e.from === edge.from && (e.fromPort ?? "") === (edge.fromPort ?? "") && e.to === edge.to)) return state
      return { ...state, edges: [...state.edges, edge] }
    }
    case "delete": {
      const sel = action.selection ?? state.selection
      if (!sel) return state
      if (sel.kind === "node") {
        // Don't allow deleting the implicit trigger node — every workflow
        // needs one and it's always present after hydration.
        if (sel.id === TRIGGER_NODE_ID) return state
        return {
          ...state,
          nodes: state.nodes.filter((n) => n.id !== sel.id),
          edges: state.edges.filter((e) => e.from !== sel.id && e.to !== sel.id),
          selection: null,
        }
      }
      if (sel.kind === "edge") {
        return { ...state, edges: state.edges.filter((e) => e.id !== sel.id), selection: null }
      }
      return state
    }
    case "duplicate": {
      const sel = action.selection ?? state.selection
      if (!sel || sel.kind !== "node") return state
      const src = state.nodes.find((n) => n.id === sel.id)
      if (!src || src.id === TRIGGER_NODE_ID) return state
      const id = "n-" + Math.random().toString(36).slice(2, 8)
      const pos = src.position ?? { x: 0, y: 0 }
      const newNode: GraphNode = { ...src, id, position: { x: pos.x + 40, y: pos.y + 40 } }
      return { ...state, nodes: [...state.nodes, newNode], selection: { kind: "node", id } }
    }
    case "layout": {
      const pos = arrange(state.nodes, state.edges)
      return { ...state, nodes: state.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)) }
    }
    case "setAll":
      return action.state
  }
}

function defaultConfigFor(item: PaletteItem): Record<string, unknown> {
  // A dynamic palette item brings its own config; nothing to guess.
  if (item.config) return { ...item.config }
  // Each V2 node type has a minimal sane default config so dragging from
  // the palette gives the author a working starting point they can edit.
  switch (item.type) {
    case "trigger.channel": {
      const source =
        item.id.endsWith("whatsapp") ? "whatsapp-message"
        : item.id.endsWith("telegram") ? "telegram-message"
        : item.id.endsWith("gitlab")   ? "gitlab-issue"
        : "whatsapp-message"
      return { source, filter: { chat: "*" } }
    }
    case "trigger.cron":   return { spec: "0 * * * *" }
    case "trigger.manual": return {}
    case "trigger.hook":   return { event: item.id.endsWith(".n8n") ? "on:n8n" : "on:hook" }
    case "trigger.form":   return { form: { title: "New request", fields: [], submitLabel: "Submit" } }
    case "agent":          return { agentId: "", prompt: "", resultParser: "acme-result-token" }
    case "transform":      return { expr: "" }
    case "branch":         return { cases: [{ when: { kind: "equals", params: { path: "", value: "" } }, to: "case1" }], default: "fallback" }
    case "gateway.parallel": return { mode: "fanOut" }
    case "rule":             return {
      inputs: [""],
      rules: [{ when: ["*"], to: "match", output: {} }],
      default: { to: "fallback", output: {} },
    }
    case "checkpoint":     return { name: "wait", waitFor: { source: "manual" }, resumeMatch: {} }
    case "userTask":       return {
      assignTo: "role:reviewers",
      title: "",
      form: { title: "Review", fields: [], submitLabel: "Approve", secondaryAction: { key: "reject", label: "Reject" } },
    }
    case "subProcess":     return { workflowId: "", inputMap: {}, awaitCompletion: true }
    case "signal.emit":    return { name: "", scope: "workflow", payload: {} }
    case "signal.wait":    return { name: "", scope: "workflow", match: {} }
    case "timer.boundary": return { after: "PT1H" }
    case "action.send":    return { channel: "gitlab", chatId: "", text: "" }
    case "action.createIssue": return { channel: "gitlab", project: "", title: "", description: "", labels: [] }
    case "action.setLabel":    return { channel: "gitlab", add: [], remove: [] }
    case "action.readLabel":   return { channel: "gitlab" }
    case "action.react":       return { channel: "gitlab", emoji: "👀" }
    case "action.editMessage": return { channel: "gitlab", messageId: "", text: "" }
    case "action.logTime":     return { channel: "gitlab" }
    case "action.callHTTP":    return { url: "", method: "POST" }
    case "action.run":         return { actionId: "", inputs: {} }
    case "end":                return { status: "completed" }
  }
  return {}
}

// --- Undo/redo wrapper ----------------------------------------------------

function useUndoable(init: EditorState) {
  const [state, dispatch] = useReducer(reducer, init)
  const past = useRef<EditorState[]>([])
  const future = useRef<EditorState[]>([])
  const last  = useRef<EditorState>(state)

  useEffect(() => { last.current = state }, [state])

  const wrapped = useCallback((action: Action) => {
    // Non-structural mutations (selection flips, live-drag position updates)
    // shouldn't each become an undo step.
    const drafty = action.type === "select" || action.type === "moveNode"
    if (!drafty) {
      past.current.push(last.current)
      if (past.current.length > 50) past.current.shift()
      future.current = []
    }
    dispatch(action)
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(last.current)
    dispatch({ type: "setAll", state: prev })
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(last.current)
    dispatch({ type: "setAll", state: next })
  }, [])

  // A drag is many moveNode actions; it becomes one undo step when it ends.
  const moveStart = useRef<EditorState | null>(null)
  const beginMove = useCallback(() => { if (!moveStart.current) moveStart.current = last.current }, [])
  const endMove = useCallback(() => {
    const start = moveStart.current
    moveStart.current = null
    if (!start || start === last.current) return
    past.current.push(start)
    if (past.current.length > 50) past.current.shift()
    future.current = []
  }, [])

  const forceReset = useCallback((next: EditorState) => {
    past.current = []
    future.current = []
    dispatch({ type: "setAll", state: next })
  }, [])

  return { state, dispatch: wrapped, undo, redo, forceReset, beginMove, endMove, canUndo: past.current.length > 0, canRedo: future.current.length > 0 }
}

// --- Validation (client-side lint; server-side is authoritative) ----------

interface NodeIssue { message: string }

function validateGraph(state: EditorState): Record<string, NodeIssue[]> {
  const issues: Record<string, NodeIssue[]> = {}
  const add = (id: string, msg: string) => { (issues[id] ??= []).push({ message: msg }) }

  for (const n of state.nodes) {
    const cfg = n.config as Record<string, unknown>
    if (n.type === "agent" && !cfg.agentId) add(n.id, "Agent node has no agentId selected.")
    if (n.type === "branch" && (!Array.isArray(cfg.cases) || (cfg.cases as unknown[]).length === 0)) {
      add(n.id, "Branch has no cases — add at least one.")
    }
    const isTerminal = n.type === "end"
    const isTrigger = n.type.startsWith("trigger.")
    if (!isTerminal && !isTrigger && !state.edges.some((e) => e.from === n.id)) {
      add(n.id, "No outgoing connection — the flow dead-ends here.")
    }
  }
  return issues
}

// --- Fallback run script (used before we have real SSE hookup) ------------

function makeDemoRun(state: EditorState): RunStep[] {
  // Walk the graph from the trigger depth-first and emit a scripted run.
  // Purely for visualisation; real run history comes from the daemon's
  // SSE stream on /workflows.
  const steps: RunStep[] = []
  const byId = Object.fromEntries(state.nodes.map((n) => [n.id, n] as const))
  const visited = new Set<string>()
  const walk = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const n = byId[id]; if (!n) return
    const cfg = n.config as Record<string, unknown>
    steps.push({
      nodeId: n.id,
      edgeId: null,
      title: `${n.id}${cfg.agentId ? ` → ${String(cfg.agentId)}` : ""}`,
      body: cfg.prompt ? `<span class="mono">${String(cfg.prompt).slice(0, 200)}</span>` : null,
    })
    const outs = state.edges.filter((e) => e.from === id)
    for (const edge of outs) {
      const eid = (edge as { id?: string }).id ?? ""
      steps.push({ nodeId: null, edgeId: eid, title: null, body: null })
      walk(edge.to)
    }
  }
  const start = state.nodes.find((n) => n.type.startsWith("trigger."))?.id
  if (start) walk(start)
  return steps
}

// --- App ------------------------------------------------------------------

/** How the Wall opens the editor (main.tsx, wall-editor.client.ts). */
export interface EditorProps {
  /** The workflow to open; for a new one, the id it starts with. */
  workflowId: string
  isNew: boolean
  /** The owner saves and deletes; anyone else looks (#1454). The server
   *  refuses their writes either way (board-dashboard.ts). */
  owner: boolean
  /** Back to the Wall's Workflows page; `gone` after a delete. */
  onBack: (gone?: boolean) => void
  /** A new workflow was saved for the first time under this id. */
  onSaved?: (id: string) => void
  /** Unsaved changes appeared or went away. */
  onDirty?: (dirty: boolean) => void
}

type MenuTab = "add" | "edit"

const MENU_KEY = "wfe.menu"
/** Narrower than this, the side menu opens over the canvas, closed at first. */
const NARROW = "(max-width: 900px)"

function readMenuOpen(): boolean {
  try {
    const saved = localStorage.getItem(MENU_KEY)
    if (window.matchMedia(NARROW).matches) return false
    return saved !== "closed"
  } catch { return true }
}

/** The comparable part of the editor's state: what Save would write. */
function snapshotOf(s: { meta: GraphModel["meta"]; nodes: GraphNode[]; edges: GraphEdge[] }): string {
  return JSON.stringify([s.meta, s.nodes, s.edges])
}

export function App(props: EditorProps) {
  // Kick off with an empty state; the load effect replaces it via hydrate.
  const { state, dispatch, undo, redo, forceReset, beginMove, endMove, canUndo, canRedo } = useUndoable({
    meta: { id: "loading", version: 2, title: "Loading…", priority: 0, fanOut: false, envAllow: [], retention: { maxRuns: 500, maxDays: 90 } },
    nodes: [], edges: [], selection: null, isNew: true,
  })
  const { meta, nodes, edges, selection, isNew } = state
  const owner = props.owner

  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  // --- Layout: two columns, the side menu and the canvas (#1524) ----------
  // The theme is the Wall's: redesign.css maps the editor's colours onto the
  // dashboard tokens, which follow data-theme on the document.
  const [menuOpen, setMenuOpenState] = useState<boolean>(readMenuOpen)
  const [tab, setTab] = useState<MenuTab>(props.isNew ? "add" : "edit")
  const [viewBox, setViewBox] = useState<ViewBox>({ zoom: 0.75, tx: 40, ty: 60 })
  const [fitSignal, setFitSignal] = useState(0)
  const fitSoon = () => setFitSignal((n) => n + 1)
  const setMenuOpen = useCallback((open: boolean) => {
    setMenuOpenState(open)
    try { if (!window.matchMedia(NARROW).matches) localStorage.setItem(MENU_KEY, open ? "open" : "closed") } catch { /* private window */ }
  }, [])
  // The canvas grows into the space the menu leaves: refit once it has.
  const firstMenu = useRef(true)
  useEffect(() => {
    if (firstMenu.current) { firstMenu.current = false; return }
    const t = window.setTimeout(fitSoon, 180)
    return () => window.clearTimeout(t)
  }, [menuOpen])

  // --- Overlays -----------------------------------------------------------
  const [helpOpen, setHelpOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null)
  const [busy, setBusy] = useState<"" | "is-validating" | "is-running">("")
  const toastTimer = useRef<number | null>(null)
  const showToast = (msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), kind === "err" ? 5000 : 2000)
  }

  // --- Agents -------------------------------------------------------------
  const [agents, setAgents] = useState<AgentInfo[]>(MOCK_AGENTS)
  useEffect(() => {
    ;(async () => {
      const fetched = await fetchAgents()
      if (!fetched.length) return
      // Spread across the hue wheel so avatar colours are distinct.
      const mapped: AgentInfo[] = fetched.map((a: AgentSummary, i: number) => ({
        id: a.id, name: a.name || a.id,
        tags: [],
        color: (i * 37) % 360,
      }))
      setAgents(mapped)
    })()
  }, [])

  // --- Load / save --------------------------------------------------------
  // `saved` is what is on disk; the editor is dirty when its state differs.
  // A workflow with no saved places is arranged on open, and that arranged
  // state counts as clean: nothing the author did is lost by leaving.
  const [saved, setSaved] = useState<string>("")
  const open = (graph: GraphModel, fresh: boolean) => {
    let g = graph
    if (needsArrange(g.nodes)) {
      const pos = arrange(g.nodes, g.edges)
      g = { ...g, nodes: g.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)) }
    }
    const next = graphToState(g, fresh)
    forceReset(next)
    setSaved(fresh ? "" : snapshotOf(next))
    fitSoon()
  }

  useEffect(() => {
    const id = props.workflowId || "new-workflow"
    if (props.isNew) { open(blankGraph(id), true); return }
    let alive = true
    ;(async () => {
      try {
        const [wf, layout] = await Promise.all([fetchWorkflow(id), fetchLayout(id)])
        if (alive) open(workflowToGraph(wf, layout), false)
      } catch (e: any) {
        if (!alive) return
        showToast(`Could not open "${id}": ${e.message}`, "err")
        open(blankGraph(id), true)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workflowId, props.isNew])

  const loaded = meta.id !== "loading"
  const dirty = loaded && snapshotOf({ meta, nodes, edges }) !== saved
  useEffect(() => { props.onDirty?.(dirty) }, [dirty])
  const status: SaveStatus = busy || (dirty ? "is-dirty" : "is-saved")

  const save = useCallback(async () => {
    if (!owner) { showToast("Only the owner can save a workflow", "err"); return }
    const snap = stateRef.current
    const { workflow, layout } = graphToWorkflow({ meta: snap.meta, nodes: snap.nodes, edges: snap.edges })
    setBusy("is-validating")
    // A request that fails outright (the node went away mid-save) must
    // still end in a message, not a silent "checking…" (#1538).
    try {
      const v = await validate(workflow)
      if (!v.ok) {
        setBusy("")
        showToast(v.issues[0]?.message ? `Not saved: ${v.issues[0].message}` : `${v.issues.length} problem${v.issues.length === 1 ? "" : "s"} to fix first`, "err")
        return
      }
      let res = await saveWorkflow(workflow, { create: snap.isNew })
      // YAML-authored workflows refuse JSON overwrite by default. Surface the
      // path + comment-loss warning, then retry with the explicit convert flag
      // if the user agrees.
      if (!res.ok && (res as { kind?: string }).kind === "yaml-authored") {
        const yamlPath = (res as { path?: string }).path || "(unknown path)"
        const proceed = confirm(
          `This workflow is YAML-authored on disk:\n\n  ${yamlPath}\n\n` +
          `Saving from the editor will overwrite the YAML as JSON and discard any comments in the YAML file.\n\n` +
          `Continue and convert to JSON?`,
        )
        if (!proceed) {
          setBusy("")
          showToast("Not saved: the YAML file is kept as it is", "err")
          return
        }
        res = await saveWorkflow(workflow, { create: snap.isNew, convertFromYaml: true })
      }
      setBusy("")
      if (!res.ok) {
        showToast(res.issues?.[0]?.message ?? "Save failed", "err")
        return
      }
      const placed = await saveLayout(workflow.id, layout).catch(() => false)
      const next = { ...snap, isNew: false }
      setSaved(snapshotOf(next))
      showToast(placed ? "Saved" : "Saved, but the step positions were not", placed ? "ok" : "err")
      if (snap.isNew) {
        // Later saves update instead of create.
        forceReset(next)
        props.onSaved?.(workflow.id)
      }
    } catch (e: any) {
      setBusy("")
      showToast(`Not saved: ${e?.message ?? e}`, "err")
    }
  }, [owner, forceReset])

  const onDelete = useCallback((sel: Selection) => dispatch({ type: "delete", selection: sel }), [dispatch])
  const onDuplicate = useCallback((sel: Selection) => dispatch({ type: "duplicate", selection: sel }), [dispatch])
  const onAddNode = useCallback((item: PaletteItem, x: number, y: number) => {
    dispatch({ type: "addNode", item, x: Math.round(x), y: Math.round(y) })
    setTab("edit")
  }, [dispatch])
  const onConnect = useCallback((conn: { from: string; fromPort: string | undefined; to: string }) => dispatch({ type: "connect", conn }), [dispatch])
  const onMoveNode = useCallback((id: string, x: number, y: number) => { beginMove(); dispatch({ type: "moveNode", id, x, y }) }, [dispatch, beginMove])
  const setSelection = useCallback((sel: Selection | null) => {
    dispatch({ type: "select", selection: sel, commit: true })
    if (sel) setTab("edit")
  }, [dispatch])

  /** Add a step from the side menu: in the middle of what the canvas shows. */
  const addFromMenu = (item: PaletteItem) => {
    const r = document.querySelector("#wfe-root .cv")?.getBoundingClientRect()
    const cx = ((r?.width ?? 800) / 2 - viewBox.tx) / viewBox.zoom
    const cy = ((r?.height ?? 500) / 2 - viewBox.ty) / viewBox.zoom
    onAddNode(item, cx - 110, cy - 40)
    if (window.matchMedia(NARROW).matches) setMenuOpen(false)
  }

  const arrangeNow = () => { dispatch({ type: "layout" }); fitSoon() }
  const fitNow = () => document.querySelector("#wfe-root .cv")?.dispatchEvent(new Event("wfe:fit"))

  const patchSelected = (patch: Partial<GraphNode> | Partial<GraphEdge>) => {
    if (!selection) return
    if (selection.kind === "node") dispatch({ type: "patchNode", id: selection.id, patch: patch as Partial<GraphNode> })
    if (selection.kind === "edge") dispatch({ type: "patchEdge", id: selection.id, patch: patch as Partial<GraphEdge> })
  }
  const patchSelectedData = (data: Record<string, unknown>) => {
    if (!selection || selection.kind !== "node") return
    dispatch({ type: "patchNodeData", id: selection.id, patch: data })
  }

  // --- Templates ----------------------------------------------------------

  const onLoadTemplate = async (tpl: TemplateCard) => {
    if (!confirm(`Replace the current workflow with the "${tpl.title}" template?`)) return
    const graph = await loadTemplate(tpl.id, meta.id)
    const pos = arrange(graph.nodes, graph.edges)
    dispatch({ type: "setAll", state: { ...graphToState({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: n.position ?? pos[n.id] })) }, isNew), isNew } })
    fitSoon()
    showToast(`Loaded ${tpl.title}`, "ok")
  }

  // --- Run preview (demo walk; swap for SSE hookup later) -----------------
  const [running, setRunning] = useState(false)
  const [runCursor, setRunCursor] = useState(-1)
  const runScript = useMemo(() => makeDemoRun(state), [state])
  const runTimer = useRef<number | null>(null)
  const stopRun = () => { if (runTimer.current) window.clearInterval(runTimer.current); setRunning(false); setBusy("") }
  const startRun = () => {
    setRunning(true); setRunCursor(0); setBusy("is-running")
    if (runTimer.current) window.clearInterval(runTimer.current)
    runTimer.current = window.setInterval(() => {
      setRunCursor((c) => {
        if (c >= runScript.length - 1) { if (runTimer.current) window.clearInterval(runTimer.current); setRunning(false); setBusy(""); return c }
        return c + 1
      })
    }, 900)
  }
  useEffect(() => () => {
    if (runTimer.current) window.clearInterval(runTimer.current)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const runState: RunState | null = useMemo(() => {
    if (!running && runCursor < 0) return null
    const visitedNodes = new Set<string>(); const visitedEdges = new Set<string>()
    let currentNodeId: string | null = null; let currentEdgeId: string | null = null
    for (let i = 0; i <= runCursor; i++) {
      const s = runScript[i]; if (!s) continue
      if (s.nodeId) { if (i === runCursor) currentNodeId = s.nodeId; else visitedNodes.add(s.nodeId) }
      if (s.edgeId) { if (i === runCursor) currentEdgeId = s.edgeId; else visitedEdges.add(s.edgeId) }
    }
    const outputs: Record<string, string> = {}
    for (let i = 0; i <= runCursor; i++) {
      const s = runScript[i]; if (!s || !s.nodeId || !s.body) continue
      outputs[s.nodeId] = s.body
    }
    return { visitedNodes, visitedEdges, currentNodeId, currentEdgeId, outputs }
  }, [running, runCursor, runScript])

  // --- Validation ---------------------------------------------------------
  const issues = useMemo(() => validateGraph(state), [state])
  const selectedIssues = selection?.kind === "node" ? issues[selection.id] : undefined

  // --- Keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement as HTMLElement | null
      const inField = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      const mod = e.metaKey || e.ctrlKey
      if (e.key === "?" && !inField) { setHelpOpen(true); return }
      if (e.key === "Escape") {
        if (helpOpen) setHelpOpen(false)
        else if (menuOpen && window.matchMedia(NARROW).matches) setMenuOpen(false)
        return
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { if (!inField) { e.preventDefault(); undo() } }
      else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { if (!inField) { e.preventDefault(); redo() } }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save() }
      else if (mod && e.key === "Enter") { e.preventDefault(); running ? stopRun() : startRun() }
      else if (mod && e.key.toLowerCase() === "d" && !inField && selection) { e.preventDefault(); onDuplicate(selection) }
      else if (mod || e.altKey || inField) return
      else if ((e.key === "Delete" || e.key === "Backspace") && selection) { e.preventDefault(); onDelete(selection) }
      else if (e.key === "/") { e.preventDefault(); setMenuOpen(true); setTab("add"); window.setTimeout(() => (document.querySelector("#wfe-root .pal__search input") as HTMLInputElement | null)?.focus(), 0) }
      else if (e.key === "[") { e.preventDefault(); setMenuOpen(!menuOpen) }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); fitNow() }
      else if (e.key === "l" || e.key === "L") { e.preventDefault(); arrangeNow() }
      else if (e.key.startsWith("Arrow") && selection?.kind === "node") {
        const n = stateRef.current.nodes.find((x) => x.id === selection.id)
        if (!n) return
        e.preventDefault()
        const step = e.shiftKey ? 50 : 10
        const p = n.position ?? { x: 0, y: 0 }
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0]
        dispatch({ type: "patchNode", id: n.id, patch: { position: { x: p.x + d[0], y: p.y + d[1] } } })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selection, running, undo, redo, save, onDelete, onDuplicate, menuOpen, helpOpen, setMenuOpen])

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = "" } }
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [dirty])

  const onDeleteWorkflow = async () => {
    if (isNew) return
    if (!confirm(`Delete workflow "${meta.id}"? This cannot be undone.`)) return
    const ok = await deleteWorkflow(meta.id)
    if (ok) { setSaved(snapshotOf(stateRef.current)); showToast("Deleted", "ok"); window.setTimeout(() => props.onBack(true), 500) }
    else showToast(owner ? "Delete failed" : "Only the owner can delete a workflow", "err")
  }

  return (
    <div className="app" data-menu={menuOpen ? "open" : "closed"}>
      <Toolbar
        title={meta.title}
        setTitle={(v) => dispatch({ type: "setTitle", title: v })}
        status={status}
        canUndo={canUndo} canRedo={canRedo}
        onUndo={undo} onRedo={redo}
        onSave={() => void save()}
        onRun={() => running ? stopRun() : startRun()}
        running={running}
        onHelp={() => setHelpOpen(true)}
        onLayout={arrangeNow}
        onFit={fitNow}
        onBack={() => props.onBack()}
        menuOpen={menuOpen} setMenuOpen={setMenuOpen}
        canSave={owner}
      />
      <aside id="wfe-menu" className="menu" aria-label="Side menu" hidden={!menuOpen}>
        <div className="menu__tabs" role="tablist" aria-label="Side menu">
          {owner && <button type="button" role="tab" aria-selected={tab === "add"} className={tab === "add" ? "is-on" : ""} onClick={() => setTab("add")}>Add a step</button>}
          <button type="button" role="tab" aria-selected={tab === "edit" || !owner} className={tab === "edit" || !owner ? "is-on" : ""} onClick={() => setTab("edit")}>
            {selection?.kind === "node" ? "This step" : selection?.kind === "edge" ? "This connection" : "Workflow"}
          </button>
          <button type="button" className="btn btn--ghost-icon menu__close" aria-label="Hide the side menu" title="Hide the side menu ([)" onClick={() => setMenuOpen(false)}><Icon.x /></button>
        </div>
        {!owner && <p className="menu__note">Only the owner can change and save this workflow. You can look around.</p>}
        <div className="menu__body">
          {tab === "add" && owner ? (
            <Palette onLoadTemplate={onLoadTemplate} onAdd={addFromMenu} />
          ) : (
            <Inspector
              selection={selection}
              nodes={nodes} edges={edges}
              patch={patchSelected}
              patchData={patchSelectedData}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              validation={selectedIssues}
              runState={runState}
              agents={agents}
              meta={meta}
              patchMeta={(patch) => dispatch({ type: "patchMeta", patch })}
              onDeleteWorkflow={owner ? onDeleteWorkflow : undefined}
              isNew={isNew}
            />
          )}
        </div>
      </aside>
      <Canvas
        nodes={nodes} edges={edges}
        selection={selection} setSelection={setSelection}
        onNodeMove={onMoveNode} onNodeMoved={endMove} onAddNode={onAddNode}
        onConnect={onConnect} onDelete={onDelete}
        runState={runState}
        viewBox={viewBox} setViewBox={setViewBox}
        fitSignal={fitSignal}
        editable={owner}
      />
      <RunPanel running={running || runCursor >= 0} script={runScript} cursor={runCursor} onStop={() => { stopRun(); setRunCursor(-1) }} />
      <KbdOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      {owner && (
        <ChatWidget
          currentWorkflow={graphToWorkflow({ meta, nodes, edges }).workflow}
          onApplyWorkflow={(wf) => {
            const g = workflowToGraph(wf)
            const pos = arrange(g.nodes, g.edges)
            dispatch({ type: "setAll", state: { meta: g.meta, nodes: g.nodes.map((n) => ({ ...n, position: n.position ?? pos[n.id] })), edges: g.edges, selection: null, isNew } })
            fitSoon()
            showToast("Applied the workflow from the chat", "ok")
          }}
        />
      )}
      {toast && <div className={"toast" + (toast.kind === "err" ? " err" : "")} role={toast.kind === "err" ? "alert" : "status"}><span className="dot" />{toast.msg}</div>}
    </div>
  )
}

// --- Helpers --------------------------------------------------------------

function graphToState(graph: GraphModel, isNew: boolean): EditorState {
  return { meta: graph.meta, nodes: graph.nodes, edges: graph.edges, selection: null, isNew }
}

async function loadTemplate(templateId: string, currentId: string): Promise<GraphModel> {
  if (templateId === "tpl.blank") return blankGraph(currentId || "new-workflow")
  if (templateId === "tpl.whatsapp") return workflowToGraph(whatsappClientSupportTemplate(currentId))
  if (templateId === "tpl.mr")       return workflowToGraph(mrReviewTemplate(currentId))
  return blankGraph(currentId || "new-workflow")
}

function whatsappClientSupportTemplate(id: string): Workflow {
  return {
    id: id || "whatsapp-client-support",
    version: 2,
    title: "WhatsApp client support triage",
    priority: 10,
    fanOut: false,
    envAllow: ["GITLAB_TOKEN"],
    nodes: [
      { id: "trigger",       type: "trigger.channel", config: { source: "whatsapp-message", filter: { chat: "*" } } },
      { id: "classify",      type: "agent", config: { agentId: "intent-classifier", prompt: "Classify this message from {{trigger.sender.name}}:\n{{trigger.text}}\nReply with `RESULT: status-check`, `RESULT: new-request`, or `RESULT: other`." } },
      { id: "route",         type: "branch", config: { cases: [
        { when: { kind: "equals", params: { path: "classify.result", value: "status-check" } }, to: "status" },
        { when: { kind: "equals", params: { path: "classify.result", value: "new-request" } },  to: "new" },
      ], default: "fallback" } },
      { id: "lookup_ticket", type: "agent", config: { agentId: "gitlab-ticket-lookup", prompt: "Find related issues for {{trigger.sender.name}}. Summarise." } },
      { id: "reply_status",  type: "action.send", config: { channel: "whatsapp", chatId: "{{trigger.chatId}}", text: "{{lookup_ticket.reply}}" } },
      { id: "create_issue",  type: "action.createIssue", config: { channel: "gitlab", project: "acme/web", title: "WhatsApp: {{trigger.sender.name}}", description: "From: {{trigger.sender.name}} ({{trigger.fromJid}})\n\n{{trigger.text}}", labels: ["source::whatsapp", "Triage"] } },
      { id: "confirm_new",   type: "action.send", config: { channel: "whatsapp", chatId: "{{trigger.chatId}}", text: "Thanks — ticket {{create_issue.issue.webUrl}} opened." } },
      { id: "fallback",      type: "action.send", config: { channel: "whatsapp", chatId: "{{trigger.chatId}}", text: "Got it — a human will reply shortly." } },
      { id: "done",          type: "end", config: { status: "completed" } },
    ],
    edges: [
      { from: "trigger", to: "classify" },
      { from: "classify", to: "route" },
      { from: "route", fromPort: "status",   to: "lookup_ticket" },
      { from: "route", fromPort: "new",      to: "create_issue" },
      { from: "route", fromPort: "fallback", to: "fallback" },
      { from: "lookup_ticket", to: "reply_status" },
      { from: "create_issue", to: "confirm_new" },
      { from: "reply_status", to: "done" },
      { from: "confirm_new", to: "done" },
      { from: "fallback", to: "done" },
    ],
    retention: { maxRuns: 500, maxDays: 90 },
  }
}

function mrReviewTemplate(id: string): Workflow {
  return {
    id: id || "mr-review",
    version: 2,
    title: "MR review loop",
    priority: 5,
    fanOut: false,
    envAllow: ["GITLAB_TOKEN"],
    nodes: [
      { id: "trigger",  type: "trigger.channel", config: { source: "gitlab-pipeline", filter: { project: "acme/web" } } },
      { id: "review",   type: "agent", config: { agentId: "code-reviewer", prompt: "Review MR #{{trigger.pipeline.id}}. Reply `RESULT: approved` or `RESULT: changes-requested`." } },
      { id: "route",    type: "branch", config: { cases: [
        { when: { kind: "equals", params: { path: "review.result", value: "approved" } }, to: "approved" },
        { when: { kind: "equals", params: { path: "review.result", value: "changes-requested" } }, to: "rejected" },
      ], default: "done" } },
      { id: "approved", type: "action.send", config: { channel: "gitlab", chatId: "{{trigger.chatId}}", text: "✅ Approved by reviewer" } },
      { id: "rejected", type: "action.send", config: { channel: "gitlab", chatId: "{{trigger.chatId}}", text: "❌ Changes requested" } },
      { id: "done",     type: "end", config: { status: "completed" } },
    ],
    edges: [
      { from: "trigger", to: "review" },
      { from: "review", to: "route" },
      { from: "route", fromPort: "approved", to: "approved" },
      { from: "route", fromPort: "rejected", to: "rejected" },
      { from: "route", fromPort: "done", to: "done" },
      { from: "approved", to: "done" },
      { from: "rejected", to: "done" },
    ],
    retention: { maxRuns: 500, maxDays: 90 },
  }
}

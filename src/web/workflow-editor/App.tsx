import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Canvas, type RunState, type Selection, type ViewBox } from "./Canvas"
import { Inspector } from "./Inspector"
import { Palette } from "./Palette"
import { KbdOverlay, RunPanel, Toolbar, Tweaks, type RunStep, type SaveStatus } from "./Toolbar"
import { ChatWidget } from "./ChatWidget"
import { blankGraph, graphToWorkflow, type GraphEdge, type GraphModel, type GraphNode, workflowToGraph, TRIGGER_NODE_ID } from "./graph"
import { deleteWorkflow, fetchAgents, fetchDraft, fetchLayout, fetchWorkflow, promoteDraft, saveDraft, saveLayout, saveWorkflow, validate, type AgentSummary } from "./api"
import { MOCK_AGENTS, type AgentInfo, type PaletteItem, type TemplateCard } from "./data"
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
  | { type: "connect"; conn: { from: string; fromPort: string; to: string; toPort: string } }
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
      const sourceNode = state.nodes.find((n) => n.id === action.conn.from)
      // V2 carries branch-port info in `fromPort` ("true" | "false" | other);
      // there's no separate `branch` flag.
      const portLabel = action.conn.fromPort === "true" || action.conn.fromPort === "false" ? action.conn.fromPort : ""
      const edge: GraphEdge = {
        id, from: action.conn.from, fromPort: action.conn.fromPort,
        to: action.conn.to, toPort: "in",
        label: portLabel || (sourceNode?.type?.startsWith("trigger.") ? "start" : ""),
      }
      if (state.edges.some((e) => e.from === edge.from && e.fromPort === edge.fromPort && e.to === edge.to)) return state
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
      const levels = autoLayoutColumns(state.nodes, state.edges)
      return { ...state, nodes: state.nodes.map((n) => ({ ...n, ...(levels[n.id] ?? {}) })) }
    }
    case "setAll":
      return action.state
  }
}

function defaultConfigFor(item: PaletteItem): Record<string, unknown> {
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
    case "trigger.hook":   return { event: "on:hook" }
    case "trigger.form":   return { form: { title: "New request", fields: [], submitLabel: "Submit" } }
    case "agent":          return { agentId: "", prompt: "", resultParser: "noqta-result-token" }
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

function autoLayoutColumns(nodes: GraphNode[], edges: GraphEdge[]): Record<string, { x: number; y: number }> {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n] as const))
  const inc: Record<string, number> = {}
  nodes.forEach((n) => { inc[n.id] = 0 })
  edges.forEach((e) => { if (byId[e.to]) inc[e.to] = (inc[e.to] ?? 0) + 1 })
  const levels: Record<string, number> = {}
  const assign = (id: string, lvl: number) => {
    levels[id] = Math.max(levels[id] ?? 0, lvl)
    edges.filter((e) => e.from === id).forEach((e) => assign(e.to, lvl + 1))
  }
  nodes.filter((n) => (inc[n.id] ?? 0) === 0).forEach((n) => assign(n.id, 0))
  const cols: Record<number, string[]> = {}
  Object.entries(levels).forEach(([id, l]) => { (cols[l] ??= []).push(id) })
  const out: Record<string, { x: number; y: number }> = {}
  Object.entries(cols).forEach(([l, ids]) => {
    ids.forEach((id, i) => { out[id] = { x: 80 + Number(l) * 280, y: 120 + i * 170 } })
  })
  return out
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

  const forceReset = useCallback((next: EditorState) => {
    past.current = []
    future.current = []
    dispatch({ type: "setAll", state: next })
  }, [])

  return { state, dispatch: wrapped, undo, redo, forceReset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 }
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

export function App() {
  // Kick off with an empty state; the load effect replaces it via hydrate.
  const { state, dispatch, undo, redo, forceReset, canUndo, canRedo } = useUndoable({
    meta: { id: "loading", version: 2, title: "Loading…", priority: 0, fanOut: false, envAllow: [], retention: { maxRuns: 500, maxDays: 90 } },
    nodes: [], edges: [], selection: null, isNew: true,
  })
  const { meta, nodes, edges, selection, isNew } = state

  // True when the editor is mounted on a draft (`?draft=<id>`). Drafts read
  // from /api/workflows/drafts/:id and write to PUT /api/workflows/drafts/:id;
  // they never go through the active-store endpoints. Set once at load and
  // cleared after a successful promote (the workflow is then in the active
  // store and the editor URL is rewritten to `?id=<id>`).
  const [isDraft, setIsDraft] = useState(false)

  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  const isDraftRef = useRef(isDraft)
  useEffect(() => { isDraftRef.current = isDraft }, [isDraft])

  // --- Persisted UI prefs -------------------------------------------------
  const [theme, setThemeState] = useState<"dark" | "light">(() => (localStorage.getItem("wfe.theme") as "dark" | "light") ?? "dark")
  const [density, setDensity] = useState<"compact" | "cozy" | "roomy">(() => (localStorage.getItem("wfe.density") as "compact" | "cozy" | "roomy") ?? "cozy")
  const [hue, setHue] = useState<number>(() => Number(localStorage.getItem("wfe.hue") ?? 255))
  const [paletteOpen, setPaletteOpen] = useState<boolean>(() => localStorage.getItem("wfe.paletteOpen") !== "0")
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => localStorage.getItem("wfe.inspectorOpen") !== "0")
  const [viewBox, setViewBox] = useState<ViewBox>({ zoom: 0.75, tx: 40, ty: 60 })
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("wfe.theme", theme) }, [theme])
  useEffect(() => { localStorage.setItem("wfe.density", density) }, [density])
  useEffect(() => { document.documentElement.style.setProperty("--accent-hue", String(hue)); localStorage.setItem("wfe.hue", String(hue)) }, [hue])
  useEffect(() => { localStorage.setItem("wfe.paletteOpen", paletteOpen ? "1" : "0") }, [paletteOpen])
  useEffect(() => { localStorage.setItem("wfe.inspectorOpen", inspectorOpen ? "1" : "0") }, [inspectorOpen])
  const setTheme = (t: "dark" | "light") => setThemeState(t)

  // --- Overlays -----------------------------------------------------------
  const [tweaksOpen, setTweaksOpen] = useState(false)
  const [helpOpen,   setHelpOpen]   = useState(false)
  const [toast,      setToast]      = useState<{ msg: string; kind: "ok" | "err" } | null>(null)
  const [status,     setStatus]     = useState<SaveStatus>("is-saved")
  const showToast = (msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 2000)
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

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const isNewParam = params.get("new") === "1"
    const draftId = params.get("draft")
    const id = params.get("id") || draftId || "new-workflow"

    if (isNewParam) {
      forceReset(graphToState(blankGraph(id), true))
      setIsDraft(false)
      return
    }
    ;(async () => {
      try {
        // Drafts have no layout (they're not in the active store yet — the
        // layout endpoint would 404). The graph engine falls back to auto-
        // layout when layout is null, so this just means a fresh layout pass
        // on first edit.
        if (draftId) {
          const wf = await fetchDraft(draftId)
          const graph = workflowToGraph(wf, null)
          forceReset(graphToState(graph, false))
          setIsDraft(true)
          return
        }
        const [wf, layout] = await Promise.all([fetchWorkflow(id), fetchLayout(id)])
        const graph = workflowToGraph(wf, layout)
        forceReset(graphToState(graph, false))
        setIsDraft(false)
      } catch (e: any) {
        showToast(`Failed to load "${id}": ${e.message}`, "err")
        forceReset(graphToState(blankGraph(id), true))
        setIsDraft(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mark dirty on any structural mutation.
  useEffect(() => { if (meta.id !== "loading") setStatus("is-dirty") }, [nodes, edges, meta])

  const save = useCallback(async () => {
    const snap = stateRef.current
    const draftMode = isDraftRef.current
    const { workflow, layout } = graphToWorkflow({ meta: snap.meta, nodes: snap.nodes, edges: snap.edges })
    setStatus("is-validating")
    // Drafts skip the validate roundtrip — the PUT endpoint validates server-
    // side and returns issues in the same shape on 400. Active workflows still
    // hit /:id/validate first because that endpoint doesn't 400 on lint warnings,
    // letting the user save anyway.
    if (!draftMode) {
      const v = await validate(workflow)
      if (!v.ok) {
        setStatus("is-dirty")
        showToast(`${v.issues.length} validation issue${v.issues.length === 1 ? "" : "s"}`, "err")
        return
      }
    }
    let res = draftMode
      ? await saveDraft(workflow.id, workflow)
      : await saveWorkflow(workflow, { create: snap.isNew })
    // YAML-authored workflows refuse JSON overwrite by default. Surface the
    // path + comment-loss warning, then retry with the explicit convert flag
    // if the user agrees. Drafts can't hit this branch (drafts are always
    // YAML), so the cast is safe — saveDraft never sets `kind`.
    if (!draftMode && !res.ok && (res as { kind?: string }).kind === "yaml-authored") {
      const yamlPath = (res as { path?: string }).path || "(unknown path)"
      const proceed = confirm(
        `This workflow is YAML-authored on disk:\n\n  ${yamlPath}\n\n` +
        `Saving from the editor will overwrite the YAML as JSON and discard any comments in the YAML file.\n\n` +
        `Continue and convert to JSON?`,
      )
      if (!proceed) {
        setStatus("is-dirty")
        showToast("Save canceled — YAML preserved on disk", "err")
        return
      }
      res = await saveWorkflow(workflow, { create: snap.isNew, convertFromYaml: true })
    }
    if (!res.ok) {
      setStatus("is-dirty")
      showToast(res.issues?.[0]?.message ?? "Save failed", "err")
      return
    }
    // Drafts don't have a layout endpoint — the layout is regenerated on next
    // open since `_drafts/` only stores the workflow YAML.
    if (!draftMode) {
      try { await saveLayout(workflow.id, layout) } catch { /* non-fatal */ }
    }
    setStatus("is-saved")
    showToast("Saved", "ok")
    if (snap.isNew) {
      dispatch({ type: "patchMeta", patch: {} })  // no-op patch to clear isNew below
      // Flip URL so subsequent saves update instead of create.
      const u = new URL(location.href)
      u.searchParams.delete("new")
      u.searchParams.set("id", workflow.id)
      history.replaceState(null, "", u.toString())
      // Update the isNew flag via a hydrate so undo stack doesn't accumulate
      // meaningless entries for the create→update switch.
      forceReset({ ...snap, isNew: false })
    }
  }, [dispatch, forceReset])

  /** Promote the current draft into the active workflow store. After this
   *  the editor is no longer in draft mode — we rewrite the URL to
   *  `?id=<id>` and clear isDraft so subsequent saves go through the
   *  active-store endpoint. The draft file is removed by the server. */
  const promote = useCallback(async () => {
    const snap = stateRef.current
    if (!isDraftRef.current) return
    if (status === "is-dirty") {
      showToast("Save changes before promoting", "err")
      return
    }
    if (!confirm(`Promote draft "${snap.meta.id}" into the active workflow store?`)) return
    setStatus("is-validating")
    const res = await promoteDraft(snap.meta.id)
    if (!res.ok) {
      setStatus("is-saved")
      showToast(res.error ?? "Promote failed", "err")
      return
    }
    setIsDraft(false)
    const u = new URL(location.href)
    u.searchParams.delete("draft")
    u.searchParams.set("id", res.activeId ?? snap.meta.id)
    history.replaceState(null, "", u.toString())
    setStatus("is-saved")
    showToast("Promoted to active workflow", "ok")
  }, [status])

  const onDelete = useCallback((sel: Selection) => dispatch({ type: "delete", selection: sel }), [dispatch])
  const onDuplicate = useCallback((sel: Selection) => dispatch({ type: "duplicate", selection: sel }), [dispatch])
  const onAddNode = useCallback((item: PaletteItem, x: number, y: number) => dispatch({ type: "addNode", item, x, y }), [dispatch])
  const onConnect = useCallback((conn: { from: string; fromPort: string; to: string; toPort: string }) => dispatch({ type: "connect", conn }), [dispatch])
  const onMoveNode = useCallback((id: string, x: number, y: number) => dispatch({ type: "moveNode", id, x, y }), [dispatch])
  const setSelection = useCallback((sel: Selection | null) => dispatch({ type: "select", selection: sel, commit: true }), [dispatch])

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
    if (!confirm(`Replace the current workflow with the "${tpl.title}" template? (Undoable)`)) return
    const graph = await loadTemplate(tpl.id, meta.id)
    forceReset(graphToState(graph, isNew))
    showToast(`Loaded ${tpl.title}`, "ok")
  }

  // --- Run preview (demo walk; swap for SSE hookup later) -----------------
  const [running, setRunning] = useState(false)
  const [runCursor, setRunCursor] = useState(-1)
  const runScript = useMemo(() => makeDemoRun(state), [state])
  const runTimer = useRef<number | null>(null)
  const stopRun = () => { if (runTimer.current) window.clearInterval(runTimer.current); setRunning(false); setStatus("is-saved") }
  const startRun = () => {
    setRunning(true); setRunCursor(0); setStatus("is-running")
    if (runTimer.current) window.clearInterval(runTimer.current)
    runTimer.current = window.setInterval(() => {
      setRunCursor((c) => {
        if (c >= runScript.length - 1) { if (runTimer.current) window.clearInterval(runTimer.current); setRunning(false); setStatus("is-saved"); return c }
        return c + 1
      })
    }, 900)
  }
  useEffect(() => () => { if (runTimer.current) window.clearInterval(runTimer.current) }, [])

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
      const inField = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      if (e.key === "?" && !inField) setHelpOpen(true)
      if (e.key === "Escape") { setHelpOpen(false); setTweaksOpen(false) }
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo() }
      else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redo() }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save() }
      else if (mod && e.key === "Enter") { e.preventDefault(); running ? stopRun() : startRun() }
      else if (mod && e.key.toLowerCase() === "d" && !inField && selection) { e.preventDefault(); onDuplicate(selection) }
      else if ((e.key === "Delete" || e.key === "Backspace") && !inField && selection) { onDelete(selection) }
      else if (e.key === "/" && !inField) { e.preventDefault(); (document.querySelector(".pal__search input") as HTMLInputElement | null)?.focus() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selection, running, undo, redo, save, onDelete, onDuplicate])

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (status === "is-dirty") { e.preventDefault(); e.returnValue = "" } }
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [status])

  const onDeleteWorkflow = async () => {
    if (isNew) return
    if (!confirm(`Delete workflow "${meta.id}"? This cannot be undone.`)) return
    const ok = await deleteWorkflow(meta.id)
    if (ok) { showToast("Deleted", "ok"); setTimeout(() => { location.href = "/workflows" }, 500) }
    else showToast("Delete failed", "err")
  }

  return (
    <div className="app" data-density={density}
         data-palette={paletteOpen ? "open" : "closed"}
         data-inspector={inspectorOpen ? "open" : "closed"}>
      <Toolbar
        title={meta.title}
        setTitle={(v) => dispatch({ type: "setTitle", title: v })}
        status={status}
        theme={theme} setTheme={setTheme}
        canUndo={canUndo} canRedo={canRedo}
        onUndo={undo} onRedo={redo}
        onSave={() => void save()}
        onRun={() => running ? stopRun() : startRun()}
        running={running}
        tweaksOpen={tweaksOpen} setTweaksOpen={setTweaksOpen}
        onHelp={() => setHelpOpen(true)}
        onLayout={() => dispatch({ type: "layout" })}
        workflowIdLabel={isDraft ? `/workflows/_drafts/${meta.id}` : `/workflows/${meta.id}`}
        paletteOpen={paletteOpen} setPaletteOpen={setPaletteOpen}
        inspectorOpen={inspectorOpen} setInspectorOpen={setInspectorOpen}
        isDraft={isDraft}
        onPromote={() => void promote()}
      />
      {paletteOpen && <Palette onLoadTemplate={onLoadTemplate} />}
      <Canvas
        nodes={nodes} edges={edges}
        selection={selection} setSelection={setSelection}
        onNodeMove={onMoveNode} onAddNode={onAddNode}
        onConnect={onConnect} onDelete={onDelete}
        runState={runState}
        viewBox={viewBox} setViewBox={setViewBox}
      />
      {inspectorOpen && (
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
          onDeleteWorkflow={onDeleteWorkflow}
          isNew={isNew}
        />
      )}
      <RunPanel running={running || runCursor >= 0} script={runScript} cursor={runCursor} onStop={() => { stopRun(); setRunCursor(-1) }} />
      <Tweaks open={tweaksOpen} setOpen={setTweaksOpen}
              theme={theme} setTheme={setTheme}
              density={density} setDensity={setDensity}
              hue={hue} setHue={setHue} />
      <KbdOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ChatWidget
        currentWorkflow={graphToWorkflow({ meta, nodes, edges }).workflow}
        onApplyWorkflow={(wf) => {
          const g = workflowToGraph(wf)
          dispatch({ type: "setAll", state: { meta: g.meta, nodes: g.nodes, edges: g.edges, selection: null, isNew: false } })
          showToast("Applied workflow from chat", "ok")
        }}
      />
      {toast && <div className={"toast" + (toast.kind === "err" ? " err" : "")}><span className="dot" />{toast.msg}</div>}
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
      { id: "create_issue",  type: "action.createIssue", config: { channel: "gitlab", project: "noqta/web", title: "WhatsApp: {{trigger.sender.name}}", description: "From: {{trigger.sender.name}} ({{trigger.fromJid}})\n\n{{trigger.text}}", labels: ["source::whatsapp", "Triage"] } },
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
      { id: "trigger",  type: "trigger.channel", config: { source: "gitlab-pipeline", filter: { project: "noqta/web" } } },
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

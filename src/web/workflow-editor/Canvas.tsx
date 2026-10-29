import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from "react"
import { Icon, type IconName } from "./Icons"
import type { GraphEdge, GraphNode } from "./graph"
import { friendlyKind, nodeSummary } from "./data"
import type { PaletteItem } from "./data"
import { inPoint, nodeCategory, nodeSize, outPoint } from "./geometry"
import { outPorts, portY, type OutPort } from "./ports"

// --- Canvas ---
//
// Custom SVG + absolutely-positioned HTML hybrid. Sizes and port places come
// from geometry.ts, which the auto-arrange uses too, so a box, its ports and
// the edges always meet. A step draws one output port per way it can leave
// (ports.ts): a branch's cases, a classifier's labels, yes / no / expired.

/** Accessor that tolerates V2's optional `position` (fallback to 0,0). */
function nx(n: GraphNode): number { return n.position?.x ?? 0 }
function ny(n: GraphNode): number { return n.position?.y ?? 0 }

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

/** An edge back to an earlier column (a loop): out to the right, under
 *  every step it would cross, and back in from the left. */
function loopPath(a: { x: number; y: number }, b: { x: number; y: number }, low: number): string {
  const r = 28
  return `M ${a.x} ${a.y} C ${a.x + r * 2} ${a.y}, ${a.x + r * 2} ${low}, ${a.x} ${low} L ${b.x} ${low} C ${b.x - r * 2} ${low}, ${b.x - r * 2} ${b.y}, ${b.x} ${b.y}`
}

// ------------------------------------------------------------
// NODE
// ------------------------------------------------------------

interface NodeViewProps {
  n: GraphNode
  edges: GraphEdge[]
  selected: boolean
  /** A connection being drawn would land here. */
  drop?: boolean
  state: "running" | "visited" | "error" | null
  onMouseDown?: (e: ReactPointerEvent, n: GraphNode) => void
  onPortDown?: (e: ReactPointerEvent, n: GraphNode, port: OutPort | null) => void
  onPortEnter?: (n: GraphNode) => void
  onPortLeave?: () => void
  onClick?: (e: ReactMouseEvent, n: GraphNode) => void
  onDoubleClick?: (e: ReactMouseEvent, n: GraphNode) => void
}

function NodeView(props: NodeViewProps) {
  const { n, edges, selected, state } = props
  const { w, h } = nodeSize(n, edges)
  const ports = outPorts(n, edges)
  const cat = nodeCategory(n.type)   // trigger / action / agent / branch / checkpoint / transform / end
  const summary = nodeSummary(n.type, (n.config ?? {}) as Record<string, unknown>)
  const cfg = n.config as Record<string, unknown>

  const iconName: IconName =
    cat === "trigger" ? (cfg.source === "cron" ? "clock" : cfg.source === "webhook" || cfg.source === "hook" ? "hook" : cfg.source === "manual" ? "play" : "gitlab")
    : cat === "agent"  ? "box"
    : cat === "branch" ? "branch"
    : cat === "action" ? (n.type === "action.send" ? "msg" : n.type === "action.setLabel" ? "tag" : n.type === "action.react" ? "bell" : n.type === "action.callHTTP" ? "globe" : n.type === "action.logTime" ? "clock" : n.type === "action.createIssue" ? "plus" : "lightning")
    : cat === "checkpoint" ? "flag"
    : cat === "transform" ? "variable"
    : "stop"
  const I = Icon[iconName] ?? Icon.box

  const cls = [
    "node", `t-${cat}`,
    selected && "is-selected",
    props.drop && "is-drop",
    state === "running" && "is-running",
    state === "visited" && "is-visited",
    state === "error"   && "is-error",
  ].filter(Boolean).join(" ")

  const style = { left: nx(n), top: ny(n), width: w, height: h }

  const agent  = cfg.agentId as string | undefined
  const prompt = cfg.prompt as string | undefined

  return (
    <div className={cls} style={style} tabIndex={0} role="button" data-node={n.id}
         aria-label={`${friendlyKind(n.type)} ${n.id}`} aria-pressed={selected}
         onPointerDown={(e) => props.onMouseDown?.(e, n)}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onClick?.(e as unknown as ReactMouseEvent, n) } }}
         onClick={(e) => props.onClick?.(e, n)}
         onDoubleClick={(e) => props.onDoubleClick?.(e, n)}>
      <div className="node__stripe" />
      <div className="node__head">
        <div className="node__icon"><I /></div>
        <div className="node__meta">
          {/* Lead with what it does; keep the id, because templates reference
              it as {{id.path}}, but stop making it the headline. */}
          <div className="node__kind">{friendlyKind(n.type)}</div>
          <div className="node__name">{n.id}</div>
        </div>
        {cat !== "trigger" && cat !== "end" && (
          <div className="node__chev"><Icon.more /></div>
        )}
      </div>

      {/* One line of plain description, and NOTHING when there is nothing to
          say — the old bodies rendered an empty row for every trigger. */}
      {summary && (
        <div className="node__body">
          <div className="node__row node__row--summary">{summary}</div>
        </div>
      )}

      {/* HANDLES: one in, one per way out (ports.ts). */}
      {cat !== "trigger" && (
        <div className="handle h-in" title="Drop a connection here"
             onPointerDown={(e) => props.onPortDown?.(e, n, null)}
             onPointerEnter={() => props.onPortEnter?.(n)}
             onPointerLeave={() => props.onPortLeave?.()} />
      )}
      {ports.map((p, i) => (
        <div key={p.name ?? ""} className={"handle h-out" + (p.label ? " has-label" : "")}
             style={{ top: portY(h, i, ports.length) }}
             title={p.label ? `Leaves here when: ${p.label}` : "Drag to connect"}
             onPointerDown={(e) => props.onPortDown?.(e, n, p)}>
          {p.label && <span className="handle__label">{p.label}</span>}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------
// MINIMAP
// ------------------------------------------------------------

interface MinimapProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  viewBox: ViewBox
  selection: Selection | null
  hostRef: RefObject<HTMLDivElement>
}

function Minimap({ nodes, edges, viewBox, selection, hostRef }: MinimapProps) {
  const [collapsed, setCollapsed] = useState(false)
  if (!nodes.length) return null
  const pad = 60
  const xs = nodes.map((n) => nx(n))
  const ys = nodes.map((n) => ny(n))
  const ws = nodes.map((n) => nodeSize(n, edges).w)
  const hs = nodes.map((n) => nodeSize(n, edges).h)
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const maxX = Math.max(...xs.map((x, i) => x + ws[i])) + pad
  const maxY = Math.max(...ys.map((y, i) => y + hs[i])) + pad
  const w = maxX - minX
  const h = maxY - minY

  const hostRect = hostRef.current?.getBoundingClientRect()
  const vw = hostRect?.width ?? 800
  const vh = hostRect?.height ?? 500
  const viewX = (-viewBox.tx) / viewBox.zoom
  const viewY = (-viewBox.ty) / viewBox.zoom
  const viewW = vw / viewBox.zoom
  const viewH = vh / viewBox.zoom

  return (
    <div className={"cv__mini" + (collapsed ? " is-collapsed" : "")}>
      <div className="cv__mini-head">
        <span>Map</span>
        <button onClick={() => setCollapsed(!collapsed)}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d={collapsed ? "M2 4l3 3 3-3" : "M2 6l3-3 3 3"} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {!collapsed && (
        <svg viewBox={`${minX} ${minY} ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
          <rect className="mini-view" x={viewX} y={viewY} width={viewW} height={viewH} />
          {nodes.map((n) => {
            const sz = nodeSize(n, edges)
            const sel = selection?.kind === "node" && selection.id === n.id
            return <rect key={n.id} className={"mini-node" + (sel ? " sel" : "")} x={nx(n)} y={ny(n)} width={sz.w} height={sz.h} rx={3} />
          })}
        </svg>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// CANVAS
// ------------------------------------------------------------

export interface ViewBox { zoom: number; tx: number; ty: number }
export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string }
export interface RunState {
  visitedNodes: Set<string>
  visitedEdges: Set<string>
  currentNodeId: string | null
  currentEdgeId: string | null
  outputs: Record<string, string>
}

export interface CanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selection: Selection | null
  setSelection: (s: Selection | null) => void
  onNodeMove: (id: string, x: number, y: number) => void
  /** A drag ended: one undo step for the whole move. */
  onNodeMoved?: (id: string) => void
  onAddNode: (item: PaletteItem, x: number, y: number) => void
  onConnect: (conn: { from: string; fromPort: string | undefined; to: string }) => void
  onDelete: (s: Selection) => void
  runState: RunState | null
  viewBox: ViewBox
  setViewBox: Dispatch<SetStateAction<ViewBox>>
  /** Bump to fit the whole workflow in view (after opening or arranging). */
  fitSignal?: number
  /** False for a viewer who is not the owner: nothing moves or connects. */
  editable?: boolean
}

const ZOOM_MIN = 0.2
const ZOOM_MAX = 2
/** The smallest zoom at which a step's words can still be read. */
const READABLE = 0.6

/** The box around every step, in canvas coordinates. */
function bounds(nodes: GraphNode[], edges: GraphEdge[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    const sz = nodeSize(n, edges)
    minX = Math.min(minX, nx(n)); minY = Math.min(minY, ny(n))
    maxX = Math.max(maxX, nx(n) + sz.w); maxY = Math.max(maxY, ny(n) + sz.h)
  }
  return { minX, minY, maxX, maxY }
}

export function Canvas(props: CanvasProps) {
  const { nodes, edges, selection, setSelection, onNodeMove, onAddNode, onConnect, runState, viewBox, setViewBox } = props
  const editable = props.editable !== false
  const hostRef = useRef<HTMLDivElement>(null)
  const [dragNode, setDragNode] = useState<{ id: string; offX: number; offY: number } | null>(null)
  const [connecting, setConnecting] = useState<{ from: { id: string; port: OutPort }; start: { x: number; y: number }; x: number; y: number } | null>(null)
  const [isDropTarget, setDropTarget] = useState(false)
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const [panning, setPanning] = useState<{ startX: number; startY: number; tx: number; ty: number } | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)

  const { zoom, tx, ty } = viewBox
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes])

  const screenToCanvas = (clientX: number, clientY: number) => {
    const host = hostRef.current
    if (!host) return { x: 0, y: 0 }
    const r = host.getBoundingClientRect()
    return { x: (clientX - r.left - tx) / zoom, y: (clientY - r.top - ty) / zoom }
  }

  const onBgPointerDown = (e: ReactPointerEvent) => {
    const target = e.target as HTMLElement
    if (target !== e.currentTarget && !target.classList.contains("cv__viewport") && !target.classList.contains("cv__edges")) return
    if (e.button !== 0 && e.button !== 1) return
    setSelection(null)
    setPanning({ startX: e.clientX, startY: e.clientY, tx, ty })
  }

  const onNodePointerDown = (e: ReactPointerEvent, n: GraphNode) => {
    if ((e.target as HTMLElement).classList.contains("handle")) return
    e.stopPropagation()
    setSelection({ kind: "node", id: n.id })
    if (!editable) return
    const p = screenToCanvas(e.clientX, e.clientY)
    setDragNode({ id: n.id, offX: p.x - nx(n), offY: p.y - ny(n) })
  }

  const onPortDown = (e: ReactPointerEvent, n: GraphNode, port: OutPort | null) => {
    e.stopPropagation(); e.preventDefault()
    if (!editable || !port) return
    const start = outPoint(n, { from: n.id, fromPort: port.name, to: "" }, edges)
    setConnecting({ from: { id: n.id, port }, start, x: start.x, y: start.y })
  }

  const onPortEnter = (n: GraphNode) => { if (connecting) setHoverNode(n.id) }
  const onPortLeave = () => setHoverNode(null)

  useEffect(() => {
    if (!dragNode && !connecting && !panning) return
    const move = (e: PointerEvent) => {
      if (dragNode) {
        const p = screenToCanvas(e.clientX, e.clientY)
        onNodeMove(dragNode.id, Math.round(p.x - dragNode.offX), Math.round(p.y - dragNode.offY))
      } else if (connecting) {
        const p = screenToCanvas(e.clientX, e.clientY)
        setConnecting((c) => (c ? { ...c, x: p.x, y: p.y } : c))
        // Touch has no hover: find the step under the finger instead.
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node]") as HTMLElement | null
        setHoverNode(el ? el.dataset.node ?? null : null)
      } else if (panning) {
        setViewBox((v) => ({ ...v, tx: panning.tx + (e.clientX - panning.startX), ty: panning.ty + (e.clientY - panning.startY) }))
      }
    }
    const up = () => {
      if (connecting && hoverNode && hoverNode !== connecting.from.id && !byId.get(hoverNode)?.type.startsWith("trigger.")) {
        onConnect({ from: connecting.from.id, fromPort: connecting.from.port.name, to: hoverNode })
      }
      if (dragNode) props.onNodeMoved?.(dragNode.id)
      setDragNode(null); setConnecting(null); setPanning(null); setHoverNode(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [dragNode, connecting, panning, hoverNode, onConnect, onNodeMove, setViewBox, byId])

  const onWheel = (e: ReactWheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 30) {
      setViewBox((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
      return
    }
    const host = hostRef.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const delta = -e.deltaY * 0.0015
    setViewBox((v) => {
      const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * (1 + delta)))
      const k = nz / v.zoom
      return { zoom: nz, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k }
    })
  }
  // Ctrl/⌘ + wheel zooms the canvas, not the page: React's wheel listener
  // is passive, so the page-zoom default is stopped here.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const stop = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }
    host.addEventListener("wheel", stop, { passive: false })
    return () => host.removeEventListener("wheel", stop)
  }, [])

  /** Zoom about the middle of the canvas, so the view stays put. */
  const zoomBy = (k: number) => {
    const r = hostRef.current?.getBoundingClientRect()
    const mx = (r?.width ?? 800) / 2, my = (r?.height ?? 500) / 2
    setViewBox((v) => {
      const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * k))
      const f = nz / v.zoom
      return { zoom: nz, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f }
    })
  }
  /** Show the whole workflow. `readable` keeps the zoom where the words can
   *  still be read: a long workflow then starts at its trigger, on the left,
   *  and the rest is a pan away (on open and after Arrange). */
  const fit = (readable = false) => {
    const host = hostRef.current
    if (!host || !nodes.length) return
    const r = host.getBoundingClientRect()
    if (!r.width || !r.height) return
    const pad = 48
    const b = bounds(nodes, edges)
    const gw = b.maxX - b.minX + pad * 2
    const gh = b.maxY - b.minY + pad * 2 + 40
    const floor = readable ? Math.min(READABLE, 1) : ZOOM_MIN
    const z = Math.max(floor, Math.min(1, r.width / gw, r.height / gh))
    const w = (b.maxX - b.minX) * z, h = (b.maxY - b.minY) * z
    setViewBox({
      zoom: z,
      tx: (w + pad * 2 <= r.width ? (r.width - w) / 2 : pad) - b.minX * z,
      ty: (h + pad * 2 <= r.height ? (r.height - h) / 2 : pad) - b.minY * z,
    })
  }
  // Fit once the steps are in place: on open, and after Arrange.
  useEffect(() => { if (props.fitSignal) requestAnimationFrame(() => fit(true)) }, [props.fitSignal])
  // The keyboard's F and the toolbar's Fit (App.tsx), and the side menu
  // opening or closing.
  useEffect(() => {
    const onFit = () => fit()
    const host = hostRef.current
    host?.addEventListener("wfe:fit", onFit)
    return () => host?.removeEventListener("wfe:fit", onFit)
  })

  const onDragOver = (e: React.DragEvent) => { if (!editable) return; e.preventDefault(); setDropTarget(true) }
  const onDragLeave = () => setDropTarget(false)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDropTarget(false)
    if (!editable) return
    const raw = e.dataTransfer.getData("application/x-wfe-item")
    if (!raw) return
    try {
      const item = JSON.parse(raw) as PaletteItem
      const p = screenToCanvas(e.clientX, e.clientY)
      onAddNode(item, p.x - 100, p.y - 40)
    } catch { /* ignore malformed palette payload */ }
  }

  const edgeClass = (e: GraphEdge) => {
    const id = (e as { id?: string }).id ?? ""
    const cls = ["wfe-edge"]
    if (selection?.kind === "edge" && selection.id === id) cls.push("is-selected")
    if (hoverEdge === id) cls.push("is-hover")
    if (runState?.currentEdgeId === id) cls.push("is-running")
    if (id && runState?.visitedEdges?.has(id)) cls.push("is-visited")
    return cls.join(" ")
  }

  const nodeState = (n: GraphNode): "running" | "visited" | null => {
    if (runState?.currentNodeId === n.id) return "running"
    if (runState?.visitedNodes?.has(n.id)) return "visited"
    return null
  }

  // The edges' SVG covers every step, wherever it is, so none is clipped.
  const area = useMemo(() => {
    const b = nodes.length ? bounds(nodes, edges) : { minX: 0, minY: 0, maxX: 800, maxY: 600 }
    return { x: Math.min(0, b.minX) - 400, y: Math.min(0, b.minY) - 400, w: Math.max(b.maxX, 0) - Math.min(0, b.minX) + 800, h: Math.max(b.maxY, 0) - Math.min(0, b.minY) + 800 }
  }, [nodes, edges])

  /** How far below the steps between two columns a loop must pass. */
  const loopLow = (a: { x: number }, b: { x: number }, ya: number, yb: number) => {
    let low = Math.max(ya, yb)
    for (const n of nodes) {
      const sz = nodeSize(n, edges)
      if (nx(n) + sz.w >= Math.min(a.x, b.x) - 40 && nx(n) <= Math.max(a.x, b.x) + 40) low = Math.max(low, ny(n) + sz.h)
    }
    return low + 36
  }

  const connectingRender = useMemo(() => {
    if (!connecting) return null
    return (
      <svg className="cv__ghost-edge" style={{ left: area.x, top: area.y }} width={area.w} height={area.h} viewBox={`${area.x} ${area.y} ${area.w} ${area.h}`}>
        <path d={edgePath(connecting.start, { x: connecting.x, y: connecting.y })} />
      </svg>
    )
  }, [connecting, area])

  return (
    <div className={"cv" + (panning ? " is-panning" : "") + (isDropTarget ? " is-drop-target" : "") + (connecting ? " is-connecting" : "")}
         ref={hostRef} onWheel={onWheel}
         onPointerDown={onBgPointerDown}
         onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="cv__viewport" style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})` }}>
        <svg className="cv__edges" style={{ left: area.x, top: area.y }} width={area.w} height={area.h} viewBox={`${area.x} ${area.y} ${area.w} ${area.h}`}>
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="currentColor" />
            </marker>
            <marker id="arr-acc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = byId.get(e.from)
            const b = byId.get(e.to)
            if (!a || !b) return null
            const edgeId = (e as { id?: string }).id ?? `e-${i}`
            const pa = outPoint(a, e, edges)
            const pb = inPoint(b, edges)
            const back = pb.x < pa.x + 24
            const d = back ? loopPath(pa, pb, loopLow(pa, pb, ny(a) + nodeSize(a, edges).h, ny(b) + nodeSize(b, edges).h)) : edgePath(pa, pb)
            const marker = runState?.currentEdgeId === edgeId || runState?.visitedEdges?.has(edgeId) ? "url(#arr-acc)" : "url(#arr)"
            const label = e.label && !(a.type === "branch" || a.type === "rule" || a.type === "classify") ? e.label : ""
            const mid = back ? { x: (pa.x + pb.x) / 2, y: loopLow(pa, pb, ny(a) + nodeSize(a, edges).h, ny(b) + nodeSize(b, edges).h) } : { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
            return (
              <g key={edgeId}>
                <path className="edge-bg" d={d}
                  onPointerEnter={() => setHoverEdge(edgeId)}
                  onPointerLeave={() => setHoverEdge(null)}
                  onClick={() => setSelection({ kind: "edge", id: edgeId })} />
                <path className={edgeClass(e) + (back ? " is-loop" : "")} d={d} markerEnd={marker} />
                {label && (
                  <g transform={`translate(${mid.x},${mid.y})`}>
                    <rect className="edge-label-bg" x={-label.length * 3.6 - 6} y={-9} rx={3}
                          width={label.length * 7.2 + 12} height={18} />
                    <text className="edge-label" y={4} textAnchor="middle">{label}</text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>

        {connectingRender}

        {nodes.map((n) => (
          <NodeView key={n.id} n={n} edges={edges}
            selected={selection?.kind === "node" && selection.id === n.id}
            state={nodeState(n)}
            drop={!!connecting && hoverNode === n.id}
            onMouseDown={onNodePointerDown}
            onPortDown={onPortDown}
            onPortEnter={onPortEnter}
            onPortLeave={onPortLeave}
            onClick={(e, node) => { e.stopPropagation(); setSelection({ kind: "node", id: node.id }) }}
          />
        ))}
      </div>

      <div className="cv__controls" role="toolbar" aria-label="Zoom">
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}><Icon.zoomout /></button>
        <div className="cv__zoom">{Math.round(zoom * 100)}%</div>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.2)}><Icon.zoomin /></button>
        <button type="button" title="Fit the workflow in view (F)" aria-label="Fit" onClick={() => fit()}><Icon.fit /></button>
      </div>

      <Minimap nodes={nodes} edges={edges} viewBox={viewBox} selection={selection} hostRef={hostRef} />
    </div>
  )
}

export { nodeSize, edgePath, nodeCategory }

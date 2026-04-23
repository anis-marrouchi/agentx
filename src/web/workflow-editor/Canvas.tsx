import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from "react"
import { Icon, type IconName } from "./Icons"
import type { GraphEdge, GraphNode } from "./graph"
import type { PaletteItem } from "./data"

// --- Canvas ---
//
// Custom SVG + absolutely-positioned HTML hybrid. Node sizes are bucketed
// by the NodeType's top-level category (trigger / action / etc.) — the full
// V2 catalog has ~16 node types but they render in 5 visual shapes.

const NODE_W: Record<string, number> = { trigger: 220, state: 240, branch: 260, action: 220, end: 160, agent: 240, checkpoint: 220, transform: 220 }
const NODE_H: Record<string, number> = { trigger: 46,  state: 118, branch: 110, action: 78,  end: 46,  agent: 118, checkpoint: 92,  transform: 78  }

/** Map a V2 NodeType to its visual category. */
function nodeCategory(type: string): string {
  if (type.startsWith("trigger.")) return "trigger"
  if (type.startsWith("action."))  return "action"
  return type  // agent, branch, checkpoint, transform, end
}

function nodeSize(n: GraphNode): { w: number; h: number } {
  const cat = nodeCategory(n.type)
  return { w: NODE_W[cat] ?? 220, h: NODE_H[cat] ?? 100 }
}

/** Accessor that tolerates V2's optional `position` (fallback to 0,0). */
function nx(n: GraphNode): number { return n.position?.x ?? 0 }
function ny(n: GraphNode): number { return n.position?.y ?? 0 }

type PortName = "in" | "out" | "true" | "false"

function portPos(n: GraphNode, port: PortName): { x: number; y: number } {
  const { w, h } = nodeSize(n)
  const x0 = nx(n); const y0 = ny(n)
  if (port === "in")    return { x: x0,     y: y0 + h / 2 }
  if (port === "out")   return { x: x0 + w, y: y0 + h / 2 }
  if (port === "true")  return { x: x0 + w, y: y0 + h * 0.30 }
  if (port === "false") return { x: x0 + w, y: y0 + h * 0.70 }
  return { x: x0 + w / 2, y: y0 + h / 2 }
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.45)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

// ------------------------------------------------------------
// NODE
// ------------------------------------------------------------

interface NodeViewProps {
  n: GraphNode
  selected: boolean
  state: "running" | "visited" | "error" | null
  onMouseDown?: (e: ReactMouseEvent, n: GraphNode) => void
  onPortDown?: (e: ReactMouseEvent, n: GraphNode, port: PortName) => void
  onPortEnter?: (n: GraphNode, port: PortName) => void
  onPortLeave?: () => void
  onClick?: (e: ReactMouseEvent, n: GraphNode) => void
  onDoubleClick?: (e: ReactMouseEvent, n: GraphNode) => void
}

function NodeView(props: NodeViewProps) {
  const { n, selected, state } = props
  const { w } = nodeSize(n)
  const cat = nodeCategory(n.type)   // trigger / action / agent / branch / checkpoint / transform / end
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
    state === "running" && "is-running",
    state === "visited" && "is-visited",
    state === "error"   && "is-error",
  ].filter(Boolean).join(" ")

  const style = { left: nx(n), top: ny(n), width: w }

  const agent  = cfg.agentId as string | undefined
  const prompt = cfg.prompt as string | undefined

  return (
    <div className={cls} style={style}
         onMouseDown={(e) => props.onMouseDown?.(e, n)}
         onClick={(e) => props.onClick?.(e, n)}
         onDoubleClick={(e) => props.onDoubleClick?.(e, n)}>
      <div className="node__stripe" />
      <div className="node__head">
        <div className="node__icon"><I /></div>
        <div className="node__meta">
          <div className="node__kind">{n.type}</div>
          <div className="node__name">{n.id}</div>
        </div>
        {cat !== "trigger" && cat !== "end" && (
          <div className="node__chev"><Icon.more /></div>
        )}
      </div>

      {cat === "agent" && (
        <div className="node__body">
          {agent
            ? <div className="node__row"><Icon.users /><span className="mono">{agent}</span></div>
            : <div className="node__row" style={{ color: "var(--muted-2)" }}>no agent</div>}
          {prompt && (
            <div className="node__row" style={{ alignItems: "flex-start", lineHeight: 1.4 }}>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--ink-2)", fontSize: 11 }}>
                {prompt}
              </span>
            </div>
          )}
        </div>
      )}

      {cat === "branch" && (
        <div className="node__body">
          <div className="node__row">
            <span className="mono" style={{ color: "var(--ink-2)" }}>
              {Array.isArray(cfg.cases) ? (cfg.cases as unknown[]).length : 0} case{Array.isArray(cfg.cases) && (cfg.cases as unknown[]).length === 1 ? "" : "s"} · default: <span className="node__tag mono">{String(cfg.default ?? "—")}</span>
            </span>
          </div>
        </div>
      )}

      {cat === "action" && (
        <div className="node__body">
          <div className="node__row">
            <span className="mono" style={{ color: "var(--t-action)" }}>{n.type.replace(/^action\./, "")}</span>
          </div>
          <div className="node__row">
            <span style={{ fontSize: 11, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {String(cfg.text ?? cfg.body ?? cfg.title ?? cfg.url ?? "")}
            </span>
          </div>
        </div>
      )}

      {cat === "trigger" && (
        <div className="node__body">
          <div className="node__row">
            <span className="mono" style={{ color: "var(--t-trigger)" }}>{String(cfg.source ?? "")}</span>
          </div>
        </div>
      )}

      {/* HANDLES */}
      {cat !== "trigger" && (
        <div className="handle h-in"
             onMouseDown={(e) => props.onPortDown?.(e, n, "in")}
             onMouseEnter={() => props.onPortEnter?.(n, "in")}
             onMouseLeave={() => props.onPortLeave?.()} />
      )}
      {cat === "branch" ? (
        <>
          <div className="handle h-true"
               onMouseDown={(e) => props.onPortDown?.(e, n, "true")}
               onMouseEnter={() => props.onPortEnter?.(n, "true")}
               onMouseLeave={() => props.onPortLeave?.()}>
            <span className="handle__label">true</span>
          </div>
          <div className="handle h-false"
               onMouseDown={(e) => props.onPortDown?.(e, n, "false")}
               onMouseEnter={() => props.onPortEnter?.(n, "false")}
               onMouseLeave={() => props.onPortLeave?.()}>
            <span className="handle__label">false</span>
          </div>
        </>
      ) : cat !== "end" && (
        <div className="handle h-out"
             onMouseDown={(e) => props.onPortDown?.(e, n, "out")}
             onMouseEnter={() => props.onPortEnter?.(n, "out")}
             onMouseLeave={() => props.onPortLeave?.()} />
      )}
    </div>
  )
}

// ------------------------------------------------------------
// MINIMAP
// ------------------------------------------------------------

interface MinimapProps {
  nodes: GraphNode[]
  viewBox: ViewBox
  selection: Selection | null
  hostRef: RefObject<HTMLDivElement>
}

function Minimap({ nodes, viewBox, selection, hostRef }: MinimapProps) {
  const [collapsed, setCollapsed] = useState(false)
  if (!nodes.length) return null
  const pad = 60
  const xs = nodes.map((n) => nx(n))
  const ys = nodes.map((n) => ny(n))
  const ws = nodes.map((n) => nodeSize(n).w)
  const hs = nodes.map((n) => nodeSize(n).h)
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
            const sz = nodeSize(n)
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
  onAddNode: (item: PaletteItem, x: number, y: number) => void
  onConnect: (conn: { from: string; fromPort: string; to: string; toPort: string }) => void
  onDelete: (s: Selection) => void
  runState: RunState | null
  viewBox: ViewBox
  setViewBox: Dispatch<SetStateAction<ViewBox>>
}

export function Canvas(props: CanvasProps) {
  const { nodes, edges, selection, setSelection, onNodeMove, onAddNode, onConnect, runState, viewBox, setViewBox } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [dragNode, setDragNode] = useState<{ id: string; offX: number; offY: number } | null>(null)
  const [connecting, setConnecting] = useState<{ from: { id: string; port: PortName }; x: number; y: number } | null>(null)
  const [isDropTarget, setDropTarget] = useState(false)
  const [hoverPort, setHoverPort] = useState<{ id: string; port: PortName } | null>(null)
  const [panning, setPanning] = useState<{ startX: number; startY: number; tx: number; ty: number } | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)

  const { zoom, tx, ty } = viewBox

  const screenToCanvas = (clientX: number, clientY: number) => {
    const host = hostRef.current
    if (!host) return { x: 0, y: 0 }
    const r = host.getBoundingClientRect()
    return { x: (clientX - r.left - tx) / zoom, y: (clientY - r.top - ty) / zoom }
  }

  const onBgMouseDown = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement
    if (target !== e.currentTarget && !target.classList.contains("cv__viewport")) return
    if (e.button !== 0 && e.button !== 1) return
    setSelection(null)
    setPanning({ startX: e.clientX, startY: e.clientY, tx, ty })
  }

  const onNodeMouseDown = (e: ReactMouseEvent, n: GraphNode) => {
    if ((e.target as HTMLElement).classList.contains("handle")) return
    e.stopPropagation()
    setSelection({ kind: "node", id: n.id })
    const p = screenToCanvas(e.clientX, e.clientY)
    setDragNode({ id: n.id, offX: p.x - nx(n), offY: p.y - ny(n) })
  }

  const onPortDown = (e: ReactMouseEvent, n: GraphNode, port: PortName) => {
    e.stopPropagation(); e.preventDefault()
    const p = portPos(n, port)
    setConnecting({ from: { id: n.id, port }, x: p.x, y: p.y })
  }

  const onPortEnter = (n: GraphNode, port: PortName) => { if (connecting) setHoverPort({ id: n.id, port }) }
  const onPortLeave = () => setHoverPort(null)

  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      if (dragNode) {
        const p = screenToCanvas(e.clientX, e.clientY)
        onNodeMove(dragNode.id, p.x - dragNode.offX, p.y - dragNode.offY)
      } else if (connecting) {
        const p = screenToCanvas(e.clientX, e.clientY)
        setConnecting((c) => (c ? { ...c, x: p.x, y: p.y } : c))
      } else if (panning) {
        setViewBox((v) => ({ ...v, tx: panning.tx + (e.clientX - panning.startX), ty: panning.ty + (e.clientY - panning.startY) }))
      }
    }
    const up = () => {
      if (connecting) {
        if (hoverPort && hoverPort.id !== connecting.from.id) {
          onConnect({ from: connecting.from.id, fromPort: connecting.from.port, to: hoverPort.id, toPort: "in" })
        }
      }
      setDragNode(null); setConnecting(null); setPanning(null); setHoverPort(null)
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", up)
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up) }
  }, [dragNode, connecting, panning, hoverPort, onConnect, onNodeMove, setViewBox])

  const onWheel = (e: ReactWheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 30) {
      setViewBox((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
      return
    }
    e.preventDefault()
    const host = hostRef.current
    if (!host) return
    const r = host.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const delta = -e.deltaY * 0.0015
    setViewBox((v) => {
      const nz = Math.min(2, Math.max(0.3, v.zoom * (1 + delta)))
      const k = nz / v.zoom
      return { zoom: nz, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k }
    })
  }

  const zoomIn  = () => setViewBox((v) => ({ ...v, zoom: Math.min(2,   v.zoom * 1.15) }))
  const zoomOut = () => setViewBox((v) => ({ ...v, zoom: Math.max(0.3, v.zoom / 1.15) }))
  const fit = () => {
    const host = hostRef.current
    if (!host || !nodes.length) return
    const r = host.getBoundingClientRect()
    const pad = 60
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    nodes.forEach((n) => {
      const sz = nodeSize(n)
      const x0 = nx(n); const y0 = ny(n)
      minX = Math.min(minX, x0); minY = Math.min(minY, y0)
      maxX = Math.max(maxX, x0 + sz.w); maxY = Math.max(maxY, y0 + sz.h)
    })
    const gw = maxX - minX + pad * 2
    const gh = maxY - minY + pad * 2
    const z  = Math.min(1, Math.min(r.width / gw, r.height / gh))
    setViewBox({ zoom: z, tx: (r.width - gw * z) / 2 - (minX - pad) * z, ty: (r.height - gh * z) / 2 - (minY - pad) * z })
  }

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDropTarget(true) }
  const onDragLeave = () => setDropTarget(false)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDropTarget(false)
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
    // V2: branch-port information is carried on fromPort, not a dedicated
    // `branch` flag. Colour the true/false edges for visual contrast.
    if (e.fromPort === "true")  cls.push("is-true")
    if (e.fromPort === "false") cls.push("is-false")
    return cls.join(" ")
  }

  const nodeState = (n: GraphNode): "running" | "visited" | null => {
    if (runState?.currentNodeId === n.id) return "running"
    if (runState?.visitedNodes?.has(n.id)) return "visited"
    return null
  }

  const connectingRender = useMemo(() => {
    if (!connecting) return null
    const src = nodes.find((n) => n.id === connecting.from.id)
    if (!src) return null
    const pa = portPos(src, connecting.from.port)
    const pb = { x: connecting.x, y: connecting.y }
    return (
      <svg className="cv__ghost-edge" width="4000" height="2400">
        <path d={edgePath(pa, pb)} />
      </svg>
    )
  }, [connecting, nodes])

  return (
    <div className={"cv" + (panning ? " is-panning" : "") + (isDropTarget ? " is-drop-target" : "")}
         ref={hostRef} onWheel={onWheel}
         onMouseDown={onBgMouseDown}
         onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="cv__viewport" style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})` }}>
        <svg className="cv__edges" width="4000" height="2400">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="currentColor" />
            </marker>
            <marker id="arr-ok" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--ok)" />
            </marker>
            <marker id="arr-err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--err)" />
            </marker>
            <marker id="arr-acc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = nodes.find((n) => n.id === e.from)
            const b = nodes.find((n) => n.id === e.to)
            if (!a || !b) return null
            const edgeId = (e as { id?: string }).id ?? `e-${i}`
            const pa = portPos(a, (e.fromPort as PortName) ?? "out")
            const pb = portPos(b, (e.toPort as PortName) ?? "in")
            const d = edgePath(pa, pb)
            const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
            const marker =
              runState?.currentEdgeId === edgeId || runState?.visitedEdges?.has(edgeId) ? "url(#arr-acc)"
              : e.fromPort === "true" ? "url(#arr-ok)"
              : e.fromPort === "false" ? "url(#arr-err)"
              : "url(#arr)"
            return (
              <g key={edgeId}>
                <path className="edge-bg" d={d}
                  onMouseEnter={() => setHoverEdge(edgeId)}
                  onMouseLeave={() => setHoverEdge(null)}
                  onClick={() => setSelection({ kind: "edge", id: edgeId })} />
                <path className={edgeClass(e)} d={d} markerEnd={marker} />
                {e.label && (
                  <g transform={`translate(${mid.x},${mid.y})`}>
                    <rect className="edge-label-bg" x={-e.label.length * 3.6 - 6} y={-9} rx={3}
                          width={e.label.length * 7.2 + 12} height={18} />
                    <text className="edge-label" y={4} textAnchor="middle">{e.label}</text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>

        {connectingRender}

        {nodes.map((n) => (
          <NodeView key={n.id} n={n}
            selected={selection?.kind === "node" && selection.id === n.id}
            state={nodeState(n)}
            onMouseDown={onNodeMouseDown}
            onPortDown={onPortDown}
            onPortEnter={onPortEnter}
            onPortLeave={onPortLeave}
            onClick={(e, node) => { e.stopPropagation(); setSelection({ kind: "node", id: node.id }) }}
          />
        ))}
      </div>

      <div className="cv__controls">
        <button title="Zoom out" onClick={zoomOut}><Icon.zoomout /></button>
        <div className="cv__zoom">{Math.round(zoom * 100)}%</div>
        <button title="Zoom in" onClick={zoomIn}><Icon.zoomin /></button>
        <button title="Fit" onClick={fit}><Icon.fit /></button>
      </div>

      <Minimap nodes={nodes} viewBox={viewBox} selection={selection} hostRef={hostRef} />
    </div>
  )
}

export { nodeSize, portPos, edgePath }

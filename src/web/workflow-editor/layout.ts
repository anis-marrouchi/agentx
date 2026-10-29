// --- Auto-arrange: a layered layout, left to right (#1524) ---
//
// The editor's old auto-arrange put each step in the column of its longest
// path and stacked each column in the order the steps were written. It
// recursed along every edge with no guard, so a workflow with a loop (a
// retry, a "fix and test again") overflowed the stack and took the page
// down; it ignored node heights and ports, and nothing kept a branch's
// cases in order.
//
// This is the classic layered method (Sugiyama), written out here instead
// of pulled in from a library: dagre has no notion of a port order, and
// ELK is a megabyte-sized engine for graphs of ten to forty steps
// (notes/design/workflow-editor-on-the-wall.md). Plain code keeps
// the result deterministic and testable (test/workflow-layout.test.ts).
//
//   1. Loops: a depth-first walk from the starting steps marks each edge
//      that goes back to a step still on the walk. Those edges are left
//      out of the layout; the canvas draws them as a loop underneath.
//   2. Columns: each step goes one column right of the furthest step that
//      leads to it (longest path).
//   3. Long edges get a placeholder in every column they cross, so the
//      space they run through is kept free.
//   4. Order in a column: the walk's order first (a branch's cases top to
//      bottom), then alternating sweeps that move each step to the average
//      height of its neighbours (barycentre, nudged by port); the order with
//      the fewest crossings wins.
//   5. Height: each step is centred on the ports it connects to, as close
//      as the gaps allow (least squares with a minimum gap, solved by pool-
//      adjacent-violators), sweeping left to right and back.

import { portY } from "./ports"

export interface LayoutNode {
  id: string
  w: number
  h: number
  /** How many output ports the step draws. */
  ports: number
}

export interface LayoutEdge {
  from: string
  to: string
  /** Index of the output port it leaves on (see ports.ts). */
  port: number
}

export interface LayoutOptions {
  /** Space between columns. */
  gapX?: number
  /** Space between steps in one column. */
  gapY?: number
  /** Where the top-left step lands. */
  margin?: number
}

export type Positions = Record<string, { x: number; y: number }>

interface V {
  id: string
  w: number
  h: number
  ports: number
  dummy: boolean
  layer: number
  /** Downward neighbours: (vertex, port it leaves on). */
  out: Array<{ v: number; port: number }>
  inn: Array<{ v: number; port: number }>
  key: number
  pos: number
  c: number
}

/** The edges the layout leaves out because they close a loop. */
export function backEdges(nodes: LayoutNode[], edges: LayoutEdge[]): Set<number> {
  const index = new Map(nodes.map((n, i) => [n.id, i] as const))
  const adj: number[][] = nodes.map(() => [])
  const indeg = nodes.map(() => 0)
  edges.forEach((e, i) => {
    const a = index.get(e.from), b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) return
    adj[a].push(i)
    indeg[b]++
  })
  for (const list of adj) list.sort((x, y) => edges[x].port - edges[y].port)
  const back = new Set<number>()
  const state = nodes.map(() => 0) // 0 new, 1 on the walk, 2 done
  const roots = [...nodes.keys()].filter((i) => indeg[i] === 0).concat([...nodes.keys()])
  for (const r of roots) {
    if (state[r]) continue
    const stack: Array<[number, number]> = [[r, 0]]
    state[r] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]
      const [v, k] = top
      if (k >= adj[v].length) { state[v] = 2; stack.pop(); continue }
      top[1]++
      const ei = adj[v][k]
      const w = index.get(edges[ei].to)!
      if (state[w] === 1) back.add(ei)
      else if (state[w] === 0) { state[w] = 1; stack.push([w, 0]) }
    }
  }
  // Self-loops are loops too.
  edges.forEach((e, i) => { if (e.from === e.to) back.add(i) })
  return back
}

export function layered(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions = {}): Positions {
  const gapX = opts.gapX ?? 110
  const gapY = opts.gapY ?? 40
  const margin = opts.margin ?? 40
  if (!nodes.length) return {}

  const index = new Map(nodes.map((n, i) => [n.id, i] as const))
  const skip = backEdges(nodes, edges)
  const vs: V[] = nodes.map((n) => ({ id: n.id, w: n.w, h: n.h, ports: Math.max(1, n.ports), dummy: false, layer: 0, out: [], inn: [], key: 0, pos: 0, c: 0 }))
  const dag: Array<{ a: number; b: number; port: number }> = []
  edges.forEach((e, i) => {
    if (skip.has(i)) return
    const a = index.get(e.from), b = index.get(e.to)
    if (a === undefined || b === undefined) return
    dag.push({ a, b, port: e.port })
  })

  // 2. Columns, by longest path, in topological order.
  const indeg = vs.map(() => 0)
  const succ: number[][] = vs.map(() => [])
  for (const e of dag) { succ[e.a].push(e.b); indeg[e.b]++ }
  const queue = [...vs.keys()].filter((i) => indeg[i] === 0)
  const topo: number[] = []
  while (queue.length) {
    const v = queue.shift()!
    topo.push(v)
    for (const w of succ[v]) {
      vs[w].layer = Math.max(vs[w].layer, vs[v].layer + 1)
      if (--indeg[w] === 0) queue.push(w)
    }
  }

  // 4a. The walk's order: a depth-first preorder that takes ports in order.
  {
    const kids: Array<Array<{ b: number; port: number }>> = vs.map(() => [])
    for (const e of dag) kids[e.a].push({ b: e.b, port: e.port })
    kids.forEach((k) => k.sort((x, y) => x.port - y.port))
    let n = 0
    const seen = new Set<number>()
    const visit = (r: number) => {
      const stack = [r]
      while (stack.length) {
        const v = stack.pop()!
        if (seen.has(v)) continue
        seen.add(v)
        vs[v].key = n++
        for (let i = kids[v].length - 1; i >= 0; i--) stack.push(kids[v][i].b)
      }
    }
    topo.forEach((v) => { if (!dag.some((e) => e.b === v)) visit(v) })
    topo.forEach(visit)
  }

  // 3. Placeholders on long edges.
  for (const e of dag) {
    let prev = e.a, port = e.port
    for (let l = vs[e.a].layer + 1; l < vs[e.b].layer; l++) {
      const d = vs.length
      vs.push({ id: "", w: 0, h: 0, ports: 1, dummy: true, layer: l, out: [], inn: [], key: vs[e.a].key + (l - vs[e.a].layer) / 100, pos: 0, c: 0 })
      vs[prev].out.push({ v: d, port })
      vs[d].inn.push({ v: prev, port })
      prev = d
      port = 0
    }
    vs[prev].out.push({ v: e.b, port })
    vs[e.b].inn.push({ v: prev, port })
  }

  const depth = Math.max(...vs.map((v) => v.layer)) + 1
  const layers: number[][] = Array.from({ length: depth }, () => [])
  vs.forEach((v, i) => layers[v.layer].push(i))
  layers.forEach((l) => l.sort((a, b) => vs[a].key - vs[b].key))
  const setPos = () => layers.forEach((l) => l.forEach((v, i) => { vs[v].pos = i }))
  setPos()

  // Where on a vertex's height a port sits, as a fraction in (−0.5, 0.5).
  const bias = (v: number, port: number) => (port + 1) / (vs[v].ports + 1) - 0.5

  // 4b. Sweeps; keep the order with the fewest crossings.
  const crossings = () => {
    let n = 0
    for (let l = 0; l + 1 < depth; l++) {
      const segs: Array<[number, number]> = []
      for (const a of layers[l]) for (const o of vs[a].out) segs.push([vs[a].pos + bias(a, o.port) * 0.9, vs[o.v].pos])
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) n++
      }
    }
    return n
  }
  let best = layers.map((l) => [...l]), bestN = crossings()
  for (let it = 0; it < 12 && bestN > 0; it++) {
    const down = it % 2 === 0
    const order = down ? [...Array(depth).keys()].slice(1) : [...Array(depth).keys()].reverse().slice(1)
    for (const l of order) {
      const bary = new Map<number, number>()
      for (const v of layers[l]) {
        const nb = down ? vs[v].inn.map((x) => vs[x.v].pos + bias(x.v, x.port) * 0.9)
          : vs[v].out.map((x) => vs[x.v].pos - bias(v, x.port) * 0.9)
        bary.set(v, nb.length ? nb.reduce((s, x) => s + x, 0) / nb.length : vs[v].pos)
      }
      layers[l].sort((a, b) => bary.get(a)! - bary.get(b)!)
      layers[l].forEach((v, i) => { vs[v].pos = i })
    }
    const n = crossings()
    if (n < bestN) { bestN = n; best = layers.map((x) => [...x]) }
  }
  best.forEach((l, i) => { layers[i] = l })
  setPos()

  // 5. Heights. Placeholders are thin and give way to real steps.
  const size = (v: number) => (vs[v].dummy ? 8 : vs[v].h)
  const gap = (a: number, b: number) => (vs[a].dummy && vs[b].dummy ? 12 : vs[a].dummy || vs[b].dummy ? gapY / 2 : gapY)
  const sep = (a: number, b: number) => size(a) / 2 + gap(a, b) + size(b) / 2
  for (const l of layers) {
    let y = 0
    l.forEach((v, i) => { if (i) y += sep(l[i - 1], v); vs[v].c = y })
    const mid = y / 2
    l.forEach((v) => { vs[v].c -= mid })
  }
  // The centre of the port a vertex's edge uses.
  const portC = (v: number, port: number) => vs[v].c - size(v) / 2 + (vs[v].dummy ? size(v) / 2 : portY(size(v), port, vs[v].ports))
  const place = (l: number[], want: number[]) => {
    // Least squares under c[i+1] − c[i] ≥ sep: shift out the gaps, make the
    // targets non-decreasing (pool adjacent violators), shift back.
    const off = [0]
    for (let i = 1; i < l.length; i++) off.push(off[i - 1] + sep(l[i - 1], l[i]))
    const blocks: Array<{ sum: number; w: number; n: number }> = []
    l.forEach((v, i) => {
      const w = vs[v].dummy ? 0.3 : 1
      blocks.push({ sum: (want[i] - off[i]) * w, w, n: 1 })
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2]
        if (a.sum / a.w <= b.sum / b.w) break
        blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, n: a.n + b.n })
      }
    })
    let i = 0
    for (const b of blocks) for (let k = 0; k < b.n; k++, i++) vs[l[i]].c = b.sum / b.w + off[i]
  }
  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0
    const order = down ? [...Array(depth).keys()].slice(1) : [...Array(depth).keys()].reverse().slice(1)
    for (const l of order) {
      const want = layers[l].map((v) => {
        const nb = down ? vs[v].inn.map((x) => portC(x.v, x.port))
          : vs[v].out.map((x) => vs[x.v].c - (portC(v, x.port) - vs[v].c))
        return nb.length ? nb.reduce((s, x) => s + x, 0) / nb.length : vs[v].c
      })
      place(layers[l], want)
    }
  }

  // Columns, left-aligned, as wide as their widest step.
  const colX: number[] = []
  let x = margin
  for (const l of layers) {
    colX.push(x)
    const w = Math.max(0, ...l.filter((v) => !vs[v].dummy).map((v) => vs[v].w))
    x += (w || 40) + gapX
  }
  const real = vs.filter((v) => !v.dummy)
  const top = Math.min(...real.map((v) => v.c - v.h / 2))
  const out: Positions = {}
  for (const v of real) out[v.id] = { x: Math.round(colX[v.layer]), y: Math.round(v.c - v.h / 2 - top + margin) }
  return out
}

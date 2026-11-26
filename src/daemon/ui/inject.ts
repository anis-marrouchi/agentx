// --- Shipping a server function to the browser ----------------------------
//
// Pages send small pure helpers to the client by stringifying them, which
// keeps one implementation instead of two that drift. The trap: the bundler
// minifies, so `export function decayOf` ships as `function Fe(...)` and any
// sibling that CALLS it emits `Fe(...)`. Assigning it to `const decayOf`
// leaves `Fe` unbound — a named function expression binds its name only
// inside its own body — and the page throws ReferenceError at runtime with a
// perfectly clean build and green type-check.
//
// So bind each function under BOTH names: the readable one the page code
// uses, and its own `.name`, which is whatever the minifier chose.

export function injectFns(fns: Record<string, Function>): string {
  // A page can carry more than one of these — its own helpers plus whatever
  // the shell injects — and two top-level `const __bind` declarations in one
  // document is a SyntaxError that kills both scripts. Hang it off globalThis
  // instead, and only once.
  const bind = "globalThis.__axBind=globalThis.__axBind||((n,f)=>{globalThis[f.name]=f;globalThis[n]=f;return f});"
  return bind + Object.entries(fns)
    .map(([name, fn]) => `const ${name}=globalThis.__axBind(${JSON.stringify(name)},${fn.toString()});` + dataOf(name, fn))
    .join("")
}

// A shipped function cannot import, so server values it needs (the lucide
// SVG strings of icons.ts, for one) ride on it as own properties:
// `wflIcon.svg = { ... }`, read in its body as `wflIcon.svg`. A function's
// name is bound inside its own body, so that still works once minified.
// They are written into the page as JSON, with "<" escaped so no string can
// close the <script>.
function dataOf(name: string, fn: Function): string {
  const own = Object.keys(fn)
  if (!own.length) return ""
  const json = JSON.stringify(Object.fromEntries(own.map((k) => [k, (fn as unknown as Record<string, unknown>)[k]]))).replace(/</g, "\\u003c")
  return `Object.assign(${name},${json});`
}

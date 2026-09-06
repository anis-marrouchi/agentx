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
  const bind = "const __bind=(n,f)=>{globalThis[f.name]=f;globalThis[n]=f;return f};"
  return bind + Object.entries(fns)
    .map(([name, fn]) => `const ${name}=__bind(${JSON.stringify(name)},${fn.toString()});`)
    .join("")
}

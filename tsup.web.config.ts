import { defineConfig } from "tsup"

// --- Web bundle config ---
//
// Separate from the main tsup.config.ts which builds the server (Node ESM).
// Each entry bundles a browser IIFE that loads directly via
// <script src="/assets/<name>.js"></script> — no module resolution, no
// additional fetches, no separate CSS file.
//
// Uses esbuild (via tsup) under the hood.

export default defineConfig({
  entry: {
    "activity-graph": "src/web/activity-graph/main.tsx",
    "workflow-editor": "src/web/workflow-editor/main.tsx",
  },
  outDir: "dist/web",
  format: ["iife"],
  // tsup ignores globalName when entry is a record — each entry gets its own
  // anonymous IIFE. For our pages that's fine: the bundle finds its mount
  // point via DOM id and self-bootstraps.
  platform: "browser",
  target: "es2020",
  splitting: false,
  sourcemap: true,
  minify: true,
  dts: false,                    // no .d.ts for browser asset
  clean: false,                  // don't nuke dist/ — it also holds server bundle
  external: [],                  // bundle EVERYTHING (react, reactflow, ...)
  loader: { ".css": "text" },    // so `import css from "...css"` returns a string
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "react"
    // React dev warnings are huge — strip to keep the bundle small.
    options.define = { ...(options.define || {}), "process.env.NODE_ENV": JSON.stringify("production") }
  },
})

import { defineConfig } from "tsup"
import { cpSync, mkdirSync } from "fs"
import { resolve } from "path"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  sourcemap: true,
  minify: true,
  target: "esnext",
  outDir: "dist",
  // Copy the workflow templates into dist/ so the bundled CLI's
  // `agentx workflow init` can find them at the same relative path
  // resolved from import.meta.dirname. tsup tree-shakes non-imported
  // code paths; a fileURL-based readFileSync survives because the
  // path is computed at runtime.
  onSuccess: async () => {
    const src = resolve("src/workflows/templates")
    const dst = resolve("dist/workflows/templates")
    mkdirSync(dst, { recursive: true })
    for (const name of ["linear", "branching", "extract", "human-in-the-loop", "retry"]) {
      cpSync(resolve(src, `${name}.yaml`), resolve(dst, `${name}.yaml`))
    }
  },
})

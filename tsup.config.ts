import { defineConfig } from "tsup"
import { cpSync, mkdirSync, readFileSync, realpathSync } from "fs"
import { resolve } from "path"
import { execSync } from "child_process"

// Baked into the bundle so GET /health reports the build the process
// loaded, not what is on disk now (src/utils/build-info.ts).
// AGENTX_BUILD_COMMIT wins, for deploy tools that know what they shipped.
// Otherwise git is trusted only when this package is the repository root
// (not a vendored copy or a stale .git), and a changed tree gets "-dirty".
function gitCommit(): string | null {
  if (process.env.AGENTX_BUILD_COMMIT) return process.env.AGENTX_BUILD_COMMIT
  const git = (args: string) => execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  try {
    if (realpathSync(git("rev-parse --show-toplevel")) !== realpathSync(process.cwd())) return null
    const sha = git("rev-parse --short=7 HEAD")
    return git("status --porcelain --untracked-files=no") ? `${sha}-dirty` : sha
  } catch {
    return null // built outside a git checkout
  }
}
const { version } = JSON.parse(readFileSync("package.json", "utf8"))

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  sourcemap: true,
  minify: true,
  target: "esnext",
  outDir: "dist",
  define: {
    __AGENTX_VERSION__: JSON.stringify(version),
    __AGENTX_COMMIT__: JSON.stringify(gitCommit()),
  },
  // Copy the workflow templates into dist/ so the bundled CLI's
  // `agentx workflow init` can find them at the same relative path
  // resolved from import.meta.dirname. tsup tree-shakes non-imported
  // code paths; a fileURL-based readFileSync survives because the
  // path is computed at runtime.
  onSuccess: async () => {
    const src = resolve("src/workflows/templates")
    const dst = resolve("dist/workflows/templates")
    mkdirSync(dst, { recursive: true })
    for (const name of ["linear", "branching", "extract", "retry"]) {
      cpSync(resolve(src, `${name}.yaml`), resolve(dst, `${name}.yaml`))
    }
  },
})

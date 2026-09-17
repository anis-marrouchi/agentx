import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Worker threads segfault this suite (exit 139, no failing test, no
    // summary printed) once it passes roughly 130 files. Reproduced with
    // four test files whose only assertion is `1 + 1 === 2`, so it is the
    // runner and not any one test: at 127 files the suite is green, and
    // adding any four trivial files crashes it. Forks isolate per process
    // and cost a second or two of startup.
    //
    // This is load-bearing, not a preference. Without it the suite fails
    // in a way that looks exactly like a code regression — no FAIL lines,
    // just a dead process — which is the worst possible signal to hand
    // someone debugging their own diff.
    pool: "forks",
  },
  plugins: [tsconfigPaths()],
})

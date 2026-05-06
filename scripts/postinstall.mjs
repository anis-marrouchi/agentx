#!/usr/bin/env node
// --- Postinstall: rebuild better-sqlite3 if its prebuilt ABI doesn't
// match the current Node major. ---
//
// better-sqlite3 ships prebuilt binaries for a handful of Node majors.
// On Macs that have nvm/asdf, the Node major used to install can differ
// from the one used to run the daemon (the launchd plist pins
// /Users/.../v22.../bin), and on Linux package managers may not match
// the binary distribution. Either way we silently no-op SQLite at boot
// — see `src/storage/sqlite.ts`'s NODE_MODULE_VERSION error handling.
//
// This script is best-effort: if it can't load better-sqlite3, OR if
// loading throws an ABI error, OR if `npm rebuild` is unavailable, we
// print a hint and exit 0 so install doesn't fail. Operators on niche
// setups can still proceed; they'll just see the boot warning until
// they fix it manually.
//
// To skip entirely, set AGENTX_SKIP_POSTINSTALL=1.

import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs"

if (process.env.AGENTX_SKIP_POSTINSTALL === "1") process.exit(0)

const here = path.dirname(new URL(import.meta.url).pathname)
const repoRoot = path.resolve(here, "..")

// We only run this in the agentx repo itself, not when agentx is installed
// as a dependency in another project (where this script wouldn't make sense).
const ourPkgJson = path.join(repoRoot, "package.json")
try {
  const ourPkg = JSON.parse(fs.readFileSync(ourPkgJson, "utf8"))
  if (ourPkg.name !== "agentx" && ourPkg.name !== "@noqta/agentx" && ourPkg.name !== "agentix-cli") process.exit(0)
} catch { process.exit(0) }

// better-sqlite3 may live at the workspace root (top-level install) or
// nested under node_modules; createRequire from our package handles both.
const require = createRequire(ourPkgJson)
let needsRebuild = false
try {
  require.resolve("better-sqlite3")
} catch {
  // better-sqlite3 isn't installed — that's fine, the daemon's optional
  // SQLite path will simply no-op.
  process.exit(0)
}

try {
  const Database = require("better-sqlite3")
  // Open an in-memory db to actually exercise the native binding. If the
  // ABI doesn't match, the constructor throws "NODE_MODULE_VERSION ...".
  new Database(":memory:").close()
} catch (err) {
  const msg = String(err?.message ?? err)
  if (/NODE_MODULE_VERSION|was compiled against|Module version mismatch/i.test(msg)) {
    needsRebuild = true
  } else {
    // Non-ABI failure (likely missing system libs); leave it for the user.
    console.warn(`[agentx postinstall] better-sqlite3 load failed: ${msg.slice(0, 200)}`)
    process.exit(0)
  }
}

if (!needsRebuild) process.exit(0)

console.log(`[agentx postinstall] better-sqlite3 ABI mismatch — rebuilding for Node ${process.version} (modules ${process.versions.modules})...`)
const cmd = process.env.npm_execpath?.includes("pnpm") ? "pnpm rebuild better-sqlite3"
          : process.env.npm_execpath?.includes("yarn") ? "yarn rebuild better-sqlite3"
          : "npm rebuild better-sqlite3"
try {
  execSync(cmd, { stdio: "inherit", cwd: repoRoot })
  console.log("[agentx postinstall] better-sqlite3 rebuilt OK.")
} catch (err) {
  // Don't fail install — operator gets a hint and can run it manually.
  console.warn(`[agentx postinstall] rebuild failed; daemon will run with SQLite no-op until you fix it manually:`)
  console.warn(`  ${cmd}`)
  process.exit(0)
}

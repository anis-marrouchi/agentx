import path from "path"
import fs from "fs-extra"
import { type PackageJson } from "type-fest"

/**
 * Read the agentx-cli package.json so commands like --version work.
 *
 * Looks in three places, in order:
 *   1. A package.json beside the compiled entry (dist/cli.js → ../package.json),
 *      which is how npm-installed usage finds it.
 *   2. A package.json in the CWD, which is what `pnpm dev` / `tsx src/cli.ts`
 *      implicitly relies on.
 *   3. A safe fallback so the CLI never crashes on a truly bare environment
 *      (e.g. a fresh user running `agentx setup` from an empty temp dir).
 */
export function getPackageInfo(): PackageJson {
  const candidates: string[] = []

  // npm / tsup bundled output puts cli.js in dist/; package.json is one dir up.
  // import.meta.dirname is dist/ at runtime, so resolve relative to that.
  // Bundle is ESM (tsup format: ["esm"]) — CommonJS __dirname is not defined.
  try {
    const here = import.meta.dirname
    if (here) {
      candidates.push(path.resolve(here, "..", "package.json"))
      candidates.push(path.resolve(here, "package.json"))
    }
  } catch { /* import.meta.dirname may be undefined in exotic setups */ }

  candidates.push(path.resolve(process.cwd(), "package.json"))

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const pkg = fs.readJSONSync(p) as PackageJson
        if (pkg && pkg.name) return pkg
      }
    } catch { /* try next candidate */ }
  }

  // Minimal fallback — lets --version and help output still work.
  return { name: "agentix-cli", version: "0.0.0" } as PackageJson
}

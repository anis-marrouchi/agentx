// Print the user-facing surface of the checkout in the current directory as
// JSON: every CLI command with its flags, and every config key in the schema.
// The docs gate compares this against docs/ (see scripts/docs-gate.mjs).
//
//   pnpm exec tsx scripts/docs-surface.mts [--config <path>] > surface.json
//
// Run it from the checkout you want to read; tsx resolves the "@/" imports
// through that checkout's tsconfig.json.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const configArg = args.indexOf("--config")
const configPath = configArg >= 0 ? args[configArg + 1] : new URL("./docs-gate.config.json", import.meta.url)
const { extract } = JSON.parse(readFileSync(configPath, "utf8"))

const load = async (spec: { module: string; export: string }) => {
  const mod = await import(pathToFileURL(resolve(process.cwd(), spec.module)).href)
  if (!(spec.export in mod)) throw new Error(`${spec.module} has no export "${spec.export}"`)
  return mod[spec.export]
}

// Hidden commands are included and marked: they still run, so removing one
// that the docs mention must still fail the gate.
type Cmd = { path: string; flags: string[]; hidden: boolean }

function walkCommands(cmd: any, prefix: string[], out: Cmd[], parentHidden = false): Cmd[] {
  for (const sub of cmd.commands) {
    const path = [...prefix, sub.name()]
    const flags = sub.options.filter((o: any) => !o.hidden).map((o: any) => o.long ?? o.short).filter(Boolean)
    const hidden = Boolean(parentHidden || sub._hidden)
    out.push({ path: path.join(" "), flags, hidden })
    walkCommands(sub, path, out, hidden)
  }
  return out
}

// Zod v3 internals: unwrap wrappers, then descend into objects, records,
// arrays and unions. Records and arrays add a "*" segment.
function walkSchema(schema: any, prefix: string[], out: Set<string>): Set<string> {
  const def = schema?._def
  if (!def) return out
  switch (def.typeName) {
    case "ZodDefault":
    case "ZodOptional":
    case "ZodNullable":
    case "ZodCatch":
    case "ZodReadonly":
      return walkSchema(def.innerType, prefix, out)
    case "ZodEffects":
      return walkSchema(def.schema, prefix, out)
    case "ZodLazy":
      return walkSchema(def.getter(), prefix, out)
    case "ZodPipeline":
      return walkSchema(def.in, prefix, out)
    case "ZodObject":
      for (const [key, child] of Object.entries(schema.shape)) {
        out.add([...prefix, key].join("."))
        walkSchema(child, [...prefix, key], out)
      }
      return out
    case "ZodRecord":
      return walkSchema(def.valueType, [...prefix, "*"], out)
    case "ZodArray":
      return walkSchema(def.type, [...prefix, "*"], out)
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      for (const option of def.options) walkSchema(option, prefix, out)
      return out
    case "ZodIntersection":
      walkSchema(def.left, prefix, out)
      return walkSchema(def.right, prefix, out)
    default:
      return out
  }
}

const program = await (await load(extract.program))()
const schema = await load(extract.configSchema)

const surface = {
  binName: extract.binName,
  commands: walkCommands(program, [], []),
  configKeys: [...walkSchema(schema, [], new Set())].sort(),
}
process.stdout.write(JSON.stringify(surface, null, 2) + "\n")
// Importing the program can start timers or open handles; the JSON is out.
process.exit(0)

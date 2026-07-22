import { describe, it, expect } from "vitest"
import { expandVars, extractHost, resolveTargets, normalizeProtectedSet, matchProtected } from "../../src/guard/resolve"
import { protectedSetSchema } from "../../src/guard/types"

describe("expandVars", () => {
  it("expands $VAR and ${VAR}", () => {
    const env = { DATABASE_URL: "postgres://u:p@db.prod:5432/app", X: "y" }
    const { expanded, vars } = expandVars('psql "$DATABASE_URL" -c "select 1" ${X}', env)
    expect(expanded).toContain("postgres://u:p@db.prod:5432/app")
    expect(expanded).toContain(" y")
    expect(vars).toEqual(["DATABASE_URL", "X"])
  })
  it("unknown vars expand to empty", () => {
    expect(expandVars("$NOPE done", {}).expanded).toBe(" done")
  })
})

describe("extractHost", () => {
  it("pulls host from connection strings", () => {
    expect(extractHost("postgres://user:pw@api.hackathonat.com:5432/db")).toBe("api.hackathonat.com")
    expect(extractHost("mongodb://root@10.0.0.5:27017")).toBe("10.0.0.5")
    expect(extractHost("clawd@64.226.102.124")).toBe("64.226.102.124")
    expect(extractHost("just-a-word")).toBeNull()
  })
})

describe("resolveTargets — the incident case", () => {
  it("resolves $DATABASE_URL to the prod host so the shadow command is catchable", () => {
    const env = { DATABASE_URL: "postgres://user:pw@api.hackathonat.com:5432/app" }
    const cmd =
      'npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --script'
    const { candidates, expandedCommand } = resolveTargets(cmd, env)
    expect(expandedCommand).toContain("api.hackathonat.com")
    expect(candidates).toContain("api.hackathonat.com")
    expect(candidates.some((c) => c.startsWith("postgres://"))).toBe(true)
  })
})

describe("matchProtected", () => {
  const set = protectedSetSchema.parse({ hosts: ["api.hackathonat.com"], db_urls: ["${PROD_DATABASE_URL}"] })
  it("matches a candidate host against a protected host", () => {
    const tokens = normalizeProtectedSet(set, { PROD_DATABASE_URL: "" })
    expect(matchProtected(["api.hackathonat.com", "unrelated.dev"], tokens)).toBe("api.hackathonat.com")
  })
  it("matches a protected host inside a full candidate URL (substring)", () => {
    const tokens = normalizeProtectedSet(set, {})
    expect(matchProtected(["postgres://u:p@api.hackathonat.com:5432/x"], tokens)).toBe("api.hackathonat.com")
  })
  it("no match for an unrelated target", () => {
    const tokens = normalizeProtectedSet(set, {})
    expect(matchProtected(["localhost", "127.0.0.1"], tokens)).toBeNull()
  })
})

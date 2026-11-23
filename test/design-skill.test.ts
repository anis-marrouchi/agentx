import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { AX_TOKENS_CSS } from "../src/daemon/ui/tokens"
import { AX_COMPONENTS_CSS } from "../src/daemon/ui/components.css"

// The design skill (#2101 PR 1d) quotes token values for people and design
// tools. These tests fail when tokens.ts changes and the skill does not, so
// the skill can never describe a look the app no longer has.

const SKILL = readFileSync("skills/agentx-design/SKILL.md", "utf-8")

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf("\n}", start))
  return new Map([...body.matchAll(/(--ax-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
}

const light = block(AX_TOKENS_CSS, ":root")
const dark = new Map([...light, ...block(AX_TOKENS_CSS, '[data-theme="dark"]')])

function resolve(theme: Map<string, string>, token: string): string | undefined {
  let v = theme.get(token)
  for (let i = 0; v && i < 5; i++) {
    const ref = /^var\((--ax-[a-z0-9-]+)\)$/.exec(v)
    if (!ref) break
    v = theme.get(ref[1])
  }
  return v?.toLowerCase()
}

describe("agentx-design skill", () => {
  it("has the frontmatter the skill loader needs", () => {
    expect(SKILL).toMatch(/^---\nname: agentx-design\n/)
    expect(SKILL).toMatch(/\ndescription: .+\n/)
  })

  it("names only tokens that tokens.ts defines", () => {
    const named = new Set([...SKILL.matchAll(/`(--ax-[a-z0-9-]+)`/g)].map(m => m[1]))
    expect(named.size).toBeGreaterThan(10)
    expect([...named].filter(t => !light.has(t))).toEqual([])
  })

  it("names only part classes that components.css.ts defines", () => {
    const named = new Set([...SKILL.matchAll(/`\.(ax-[a-z0-9-]+)`/g)].map(m => m[1]))
    expect(named.size).toBeGreaterThan(5)
    expect([...named].filter(c => !AX_COMPONENTS_CSS.includes(`.${c}`))).toEqual([])
  })

  it("quotes the colour values tokens.ts has, in both themes", () => {
    const rows = [...SKILL.matchAll(/^\| [^|]+\| `(--ax-[a-z0-9-]+)`[^|]*\| (.+?) \| (.+?) \|$/gm)]
    expect(rows.length).toBeGreaterThan(10)
    const wrong: string[] = []
    for (const [, token, l, d] of rows) {
      for (const [cell, theme, name] of [[l, light, "light"], [d, dark, "dark"]] as const) {
        const hex = /`(#[0-9a-fA-F]{6})`/.exec(cell)?.[1].toLowerCase()
        if (hex && resolve(theme, token) !== hex) wrong.push(`${token} ${name}: skill ${hex}, tokens ${resolve(theme, token)}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("quotes the shape values tokens.ts has", () => {
    for (const t of ["--ax-border-w", "--ax-radius", "--ax-radius-lg", "--ax-radius-sm", "--ax-radius-pill", "--ax-shadow"]) {
      const row = new RegExp("^\\| `" + t + "` \\| `([^`]+)`", "m").exec(SKILL)
      expect(row?.[1], t).toBe(light.get(t))
    }
  })
})

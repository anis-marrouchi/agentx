import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import * as lib from "../scripts/ui-evidence-lib.mjs"

const config = JSON.parse(readFileSync(new URL("../scripts/ui-evidence.config.json", import.meta.url), "utf8"))
const { evaluate, evidenceSection, findMedia, parseMode, uiPaths } = lib

const IMG = "https://github.com/user-attachments/assets/0b3c6f6e-1d2a-4b8e-9c3f-5a6b7c8d9e0f"
const run = (files: string[], body = "", labels: string[] = []) => evaluate({ files, pr: { body, labels }, config })

describe("parseMode", () => {
  it("defaults to advisory when unset or unknown", () => {
    for (const raw of [undefined, null, "", "  ", "advisory", "Advisory", "true", "requird"]) expect(parseMode(raw), String(raw)).toBe("advisory")
  })

  it("reads required and the off values, ignoring case and spaces", () => {
    expect(parseMode("required")).toBe("required")
    expect(parseMode(" REQUIRED ")).toBe("required")
    for (const raw of ["false", "FALSE", "off", "Off", "0", " 0 "]) expect(parseMode(raw), raw).toBe("off")
  })
})

describe("uiPaths", () => {
  it("matches the configured UI directories", () => {
    expect(
      uiPaths(
        [
          "src/web/workflow-editor/canvas.ts",
          "src/daemon/ui/pages/live.ts",
          "src/daemon/agent-panel.ts",
          "src/daemon/topbar.ts",
          "src/voice/orb-palettes.ts",
          "src/desktop/install.ts",
          "src/tui/App.tsx",
          "apps/mac-voice/Sources/Orb.swift",
          "apps/mac-helper/Sources/Main.swift",
          "apps/phone/lib/main.dart",
          "apps/android/app/src/main/res/layout/main.xml",
          "integrations/raycast/src/index.tsx",
          "src/wiki/serve.ts",
          "src/approvals/card-window.ts",
          "src/approvals/popup.ts",
          "src/daemon/ui-labels.ts",
        ],
        config,
      ),
    ).toHaveLength(16)
  })

  it("leaves out non-UI code, tests and docs", () => {
    expect(
      uiPaths(
        [
          "src/daemon/config.ts",
          "src/daemon/app-chat.ts",
          "src/crons/scheduler.ts",
          "test/app-chat-ui.test.ts",
          "src/web/activity-graph/layout.test.ts",
          "apps/mac-voice/Tests/OrbTests.swift",
          "apps/phone/test/widget_test.dart",
          "apps/android/README.md",
          ".github/workflows/ci.yml",
          "docs/guide/dashboard.md",
          "src/daemon/board-dashboard.ts",
          "apps/android/build.gradle.kts",
          "apps/phone/pubspec.lock",
          "apps/mac-voice/build.sh",
          "apps/phone/ios/Podfile",
        ],
        config,
      ),
    ).toEqual([])
  })

  it("lists only real directories of the repo", () => {
    // Guard against a renamed directory silently turning the check off.
    for (const glob of config.paths as string[]) {
      const dir = glob.split("/").filter((s) => !s.includes("*")).join("/")
      expect(existsSync(new URL(`../${dir}`, import.meta.url)), glob).toBe(true)
    }
  })
})

describe("evidenceSection", () => {
  it("returns the text up to the next heading of the same level", () => {
    const body = "## Why\n\nx\n\n## Evidence\n\n![a](a.png)\n\n### Before\n\nb\n\n## Docs\n\nc"
    expect(evidenceSection(body)).toBe("\n![a](a.png)\n\n### Before\n\nb\n")
  })

  it("is case insensitive and accepts other heading levels", () => {
    expect(evidenceSection("### evidence\nshot")).toBe("shot")
  })

  it("accepts a colon or a note in brackets after the name", () => {
    expect(evidenceSection("## Evidence:\nshot")).toBe("shot")
    expect(evidenceSection("## Evidence (before / after)\nshot")).toBe("shot")
    expect(evidenceSection("## Evidence of nothing\nshot")).toBeNull()
  })

  it("returns null without the heading, and ignores it inside comments or code", () => {
    expect(evidenceSection("## Why\n\nnothing")).toBeNull()
    expect(evidenceSection("<!--\n## Evidence\n![a](a.png)\n-->")).toBeNull()
    expect(evidenceSection("```\n## Evidence\n```")).toBeNull()
  })
})

describe("findMedia", () => {
  it("finds GitHub attachments without an extension", () => {
    expect(findMedia(`<img width="400" alt="x" src="${IMG}" />`, config)).toEqual([IMG])
    expect(findMedia(`Recording:\n${IMG}`, config)).toEqual([IMG])
    expect(findMedia("![x](https://github.com/acme/app/assets/123/abc-def)", config)).toHaveLength(1)
    expect(findMedia("![x](https://user-images.githubusercontent.com/1/2.png)", config)).toHaveLength(1)
  })

  it("finds links and repo paths with a media extension", () => {
    expect(findMedia("See https://example.com/demo.MP4.", config)).toEqual(["https://example.com/demo.MP4"])
    expect(findMedia("[clip](https://example.com/clip.mov?raw=1)", config)).toEqual(["https://example.com/clip.mov?raw=1"])
    expect(findMedia("![after](docs/public/screenshots/live/after.png)", config)).toEqual(["docs/public/screenshots/live/after.png"])
  })

  it("ignores other links and plain words", () => {
    expect(findMedia("https://example.com/pr/1 and https://github.com/user-attachments/files/1/log.txt", config)).toEqual([])
    expect(findMedia("I took a screenshot.png locally", config)).toEqual([])
  })
})

describe("evaluate", () => {
  it("skips a PR that changes no UI path", () => {
    expect(run(["src/crons/scheduler.ts"]).status).toBe("skipped")
  })

  it("passes with an image under ## Evidence", () => {
    const v = run(["src/daemon/ui/pages/live.ts"], `## What changed\n\nx\n\n## Evidence\n\n![after](${IMG})`)
    expect(v.status).toBe("passed")
    expect(v.media).toEqual([IMG])
  })

  it("fails without the heading and says so", () => {
    const v = run(["src/tui/App.tsx"], `## What changed\n\n![after](${IMG})`)
    expect(v.status).toBe("failed")
    expect(v.summary).toMatch(/no "## Evidence" heading/)
    expect(v.summary).toContain("src/tui/App.tsx")
  })

  it("fails when the section holds only the template hint", () => {
    const body = "## Evidence\n\n<!-- Drag a screenshot here: ![x](x.png) -->\n\n## Docs"
    expect(run(["src/web/activity-graph/panel.ts"], body)).toMatchObject({ status: "failed", summary: expect.stringMatching(/has no image or video/) })
  })

  it("passes with the override label and a reason, and records the reason", () => {
    const v = run(["src/voice/hotkey.ts"], "UI evidence: not needed because the hotkey has no visible change", ["no-ui-evidence-needed"])
    expect(v.status).toBe("overridden")
    expect(v.reason).toBe("UI evidence: not needed because the hotkey has no visible change")
    expect(v.summary).toContain(v.reason)
  })

  it("fails with the label but no reason, or a reason but no label", () => {
    const label = run(["src/voice/hotkey.ts"], "", ["no-ui-evidence-needed"])
    expect(label.status).toBe("failed")
    expect(label.summary).toMatch(/label is set/)
    const reason = run(["src/voice/hotkey.ts"], "UI evidence: not needed because no change")
    expect(reason.status).toBe("failed")
    expect(reason.summary).toMatch(/only a maintainer/)
  })

  it("does not take the template placeholder as a reason", () => {
    for (const body of ["UI evidence: not needed because <your reason>", "UI evidence: not needed because <reason>  "]) {
      const v = run(["src/voice/hotkey.ts"], body, ["no-ui-evidence-needed"])
      expect(v.status, body).toBe("failed")
      expect(v.reason).toBeNull()
    }
  })

  it("accepts the PR template with evidence filled in", () => {
    const template = readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8")
    expect(run(["src/tui/App.tsx"], template).status).toBe("failed")
    const filled = template.replace(/## Evidence\n/, `## Evidence\n\n${IMG}\n`)
    expect(run(["src/tui/App.tsx"], filled).status).toBe("passed")
  })
})

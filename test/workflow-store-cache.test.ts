import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { WorkflowStore } from "../src/workflows/store"
import * as yamlMod from "../src/workflows/yaml"

// list() runs twice per message (router pre-hook and registry) on a store
// that is rebuilt each time. Parsing every file again was the cost; the
// result is now keyed on the directory's names, mtimes and sizes.

let tmp: string

const wf = (id: string, title = id) => `
id: ${id}
version: 2
title: ${title}
nodes:
  - id: trigger
    type: trigger.manual
    config: {}
  - id: done
    type: end
    config: { status: completed }
edges:
  - { from: trigger, to: done }
`

function writeLater(file: string, text: string): void {
  writeFileSync(file, text)
  const later = new Date(Date.now() + 5_000)
  utimesSync(file, later, later)
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-wf-cache-"))
  writeFileSync(path.join(tmp, "one.yaml"), wf("one"))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

describe("WorkflowStore.list cache", () => {
  it("parses once across stores on the same directory", () => {
    expect(new WorkflowStore({ baseDir: tmp }).list().map((w) => w.id)).toEqual(["one"])
    const parse = vi.spyOn(yamlMod, "parseYamlWorkflow")
    for (let i = 0; i < 3; i++) expect(new WorkflowStore({ baseDir: tmp }).list()).toHaveLength(1)
    expect(parse).not.toHaveBeenCalled()
  })

  it("re-parses when a file is added, edited or removed", () => {
    const store = new WorkflowStore({ baseDir: tmp })
    store.list()
    writeLater(path.join(tmp, "two.yaml"), wf("two"))
    expect(store.list().map((w) => w.id)).toEqual(["one", "two"])
    writeLater(path.join(tmp, "one.yaml"), wf("one", "Renamed"))
    expect(store.list().find((w) => w.id === "one")?.title).toBe("Renamed")
    rmSync(path.join(tmp, "two.yaml"))
    expect(store.list().map((w) => w.id)).toEqual(["one"])
  })
})

import { describe, expect, it } from "vitest"
import { APP_SHEET_SCRIPT } from "../src/daemon/ui/pages/app-sheet.client"

function fixture() {
  const element = () => {
    const handlers: Record<string, Function> = {}
    return {
      handlers,
      style: {} as Record<string, string>,
      addEventListener: (name: string, handler: Function) => {
        handlers[name] = handler
      },
      setAttribute() {},
      setPointerCapture() {},
    }
  }
  const handle = element(),
    sheet = {
      ...element(),
      firstChild: null,
      insertBefore() {},
      getBoundingClientRect: () => ({
        left: 0,
        right: 390,
        top: 400,
        bottom: 844,
      }),
      close(value: string) {
        closed.push(value)
        sheet.handlers.close()
      },
    }
  const closed: string[] = []
  let notified = 0
  const window: any = {}
  new Function("window", "document", APP_SHEET_SCRIPT)(window, {
    createElement: () => handle,
  })
  window.AXSheet(sheet, () => {
    notified++
  })
  return { handle, sheet, closed, notified: () => notified }
}

describe("phone bottom sheets", () => {
  it("dismisses from the backdrop without confirming the pending action", () => {
    const f = fixture()
    f.sheet.handlers.click({ target: f.sheet, clientX: 100, clientY: 200 })
    expect(f.closed).toEqual(["cancel"])
    expect(f.notified()).toBe(1)
  })
  it("keeps taps inside the sheet open", () => {
    const f = fixture()
    f.sheet.handlers.click({ target: f.sheet, clientX: 100, clientY: 500 })
    expect(f.closed).toEqual([])
  })
  it("restores a short pull and ignores its synthetic click", () => {
    const f = fixture()
    f.handle.handlers.pointerdown({ button: 0, clientY: 410, pointerId: 1 })
    f.handle.handlers.pointermove({ clientY: 440 })
    f.handle.handlers.pointerup()
    f.handle.handlers.click({ preventDefault() {} })
    expect(f.sheet.style.transform).toBe("")
    expect(f.closed).toEqual([])
  })
  it("dismisses a long pull and resets a cancelled gesture", () => {
    const f = fixture()
    f.handle.handlers.pointerdown({ button: 0, clientY: 410, pointerId: 1 })
    f.handle.handlers.pointermove({ clientY: 510 })
    f.handle.handlers.pointerup()
    expect(f.closed).toEqual(["cancel"])
    expect(f.sheet.style.transform).toBe("")
    f.handle.handlers.pointerdown({ button: 0, clientY: 410, pointerId: 2 })
    f.handle.handlers.pointermove({ clientY: 450 })
    f.handle.handlers.pointercancel()
    expect(f.sheet.style.transform).toBe("")
    expect(f.closed).toHaveLength(1)
  })
})

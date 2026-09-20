import AppKit

// agentx-mac-helper — the native half of computer use.
//
// Swift owns only what Node cannot reach: the Accessibility API and the
// window server. Everything else — which element to choose, whether the
// operation is allowed, what to do next — stays in agentx, so the
// capability belongs to every agent rather than to one app.
//
// Two verbs in this cut, and deliberately no third:
//
//   read   dump the focused window's accessibility tree as JSON
//   point  move the cursor to an element and highlight it
//
// There is no `click`. The point tier makes a model's choice visible and
// reviewable before anything irreversible happens, which is worth having
// on its own and is the only tier that is safe while the guard is still
// soaking.

func fail(_ message: String, code: Int32 = 1) -> Never {
    let payload = ["ok": false, "error": message] as [String: Any]
    if let d = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(d)
    }
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let verb = args.first else {
    fail("usage: agentx-mac-helper read | point --x N --y N --w N --h N [--label TEXT] [--hold SECONDS] [--instant] | trusted")
}

func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch verb {
case "read":
    guard AXTree.trusted() else {
        fail("accessibility permission not granted — System Settings › Privacy & Security › Accessibility, then add this binary")
    }
    let snap = AXTree.snapshot(maxElements: Int(flag("max") ?? "400") ?? 400)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(snap) else { fail("failed to encode tree") }
    FileHandle.standardOutput.write(data)

case "point":
    guard let x = Double(flag("x") ?? ""), let y = Double(flag("y") ?? ""),
          let w = Double(flag("w") ?? ""), let h = Double(flag("h") ?? "") else {
        fail("point needs --x --y --w --h")
    }
    Pointer.point(x: x, y: y, width: w, height: h,
                  label: flag("label") ?? "",
                  // Hold long enough to be seen, short enough not to be an
                  // obstruction. 0 is useful for scripted sequences where
                  // the next point follows immediately.
                  holdSeconds: Double(flag("hold") ?? "") ?? 2.5,
                  // Skip the human-speed move when something is stepping
                  // through many targets and the motion would just be slow.
                  instant: args.contains("--instant"))
    FileHandle.standardOutput.write(#"{"ok":true,"pointed":true}"#.data(using: .utf8)!)

case "hittest":
    // What is actually on top at this point. The occlusion check.
    guard let x = Double(flag("x") ?? ""), let y = Double(flag("y") ?? "") else {
        fail("hittest needs --x --y")
    }
    var expect: CGRect?
    if let ex = Double(flag("ex") ?? ""), let ey = Double(flag("ey") ?? ""),
       let ew = Double(flag("ew") ?? ""), let eh = Double(flag("eh") ?? "") {
        expect = CGRect(x: ex, y: ey, width: ew, height: eh)
    }
    guard let hit = Vision.hitTest(x: x, y: y, expect: expect) else {
        fail("nothing at (\(Int(x)), \(Int(y)))")
    }
    guard let hd = try? JSONEncoder().encode(hit) else { fail("failed to encode hit") }
    FileHandle.standardOutput.write(hd)

case "capture":
    guard let x = Double(flag("x") ?? ""), let y = Double(flag("y") ?? ""),
          let w = Double(flag("w") ?? ""), let h = Double(flag("h") ?? ""),
          let out = flag("out") else {
        fail("capture needs --x --y --w --h --out")
    }
    guard Vision.capture(CGRect(x: x, y: y, width: w, height: h), to: out) else {
        fail("capture failed — check Screen Recording permission")
    }
    FileHandle.standardOutput.write(#"{"ok":true,"captured":true}"#.data(using: .utf8)!)

case "focused":
    // What has keyboard focus right now. The safety check before typing.
    guard let f = Focus.current() else { fail("nothing focused") }
    let enc = JSONEncoder()
    guard let d = try? enc.encode(f) else { fail("failed to encode focus") }
    FileHandle.standardOutput.write(d)

case "type":
    // Typing goes wherever focus is, and cannot tell a search box from a
    // post composer. Refuses by default when focus looks publishable —
    // this exists because a lesson once got one keystroke from posting a
    // search query to a public timeline.
    guard let text = flag("text") else { fail("type needs --text") }
    if !args.contains("--force") {
        guard let f = Focus.current() else {
            fail("refusing to type: nothing has keyboard focus")
        }
        if !f.editable {
            fail("refusing to type: focus is \(f.role) \"\(f.label)\", which does not accept text")
        }
        if f.publishRisk {
            fail("refusing to type: focus looks like a compose or send field (\(f.role) \"\(f.label)\") — pass --force only if publishing is intended")
        }
    }
    Typer.type(text, wpm: Double(flag("wpm") ?? "") ?? 260)
    FileHandle.standardOutput.write(#"{"ok":true,"typed":true}"#.data(using: .utf8)!)

case "key":
    guard let name = flag("name") else { fail("key needs --name (return, tab, escape, a…z, 0…9)") }
    // Return is the commit key. Pressing it into a composer publishes.
    if !args.contains("--force"), ["return", "enter"].contains(name.lowercased()),
       let f = Focus.current(), f.publishRisk {
        fail("refusing to press \(name): focus looks like a compose or send field (\(f.role) \"\(f.label)\")")
    }
    let mods = (flag("mod") ?? "").split(separator: "+").map(String.init)
    guard Typer.press(name, modifiers: mods) else { fail("unknown key \"\(name)\"") }
    FileHandle.standardOutput.write(#"{"ok":true,"pressed":true}"#.data(using: .utf8)!)

case "click":
    // Clicks where the cursor already is, so a caller must point first.
    // Deliberately not folded into `point`: locating something should
    // never be the same act as pressing it.
    //
    // Before pressing, LOOK. The accessibility tree reports what exists,
    // not what is visible, so a control can be reported exactly where an
    // overlay is covering it — this tool's own HUD did precisely that.
    // The hit test resolves through the window server and sees what a
    // click would really land on.
    if !args.contains("--force"), let p = CGEvent(source: nil)?.location {
        if let hit = Vision.hitTest(x: p.x, y: p.y),
           let expected = flag("expect"), !expected.isEmpty {
            let seen = "\(hit.role) \(hit.label)".lowercased()
            if !seen.contains(expected.lowercased()) {
                fail("refusing to click: \(hit.app) shows \(hit.role) \"\(hit.label)\" at the cursor, not \"\(expected)\" — something is covering it")
            }
        }
    }
    // Visual first: a press people can see leads the reaction slightly,
    // the way a real one does.
    if !args.contains("--quiet") { Pointer.clickFlourish() }

    // Snapshot a patch around the cursor so the caller can be told whether
    // anything actually happened, rather than inferring it from a
    // successful call.
    var beforeShot: CGImage?
    var patch = CGRect.zero
    if let p = CGEvent(source: nil)?.location {
        patch = CGRect(x: p.x - 90, y: p.y - 60, width: 180, height: 120)
        beforeShot = Vision.snapshot(patch)
    }

    Typer.click(button: flag("button") ?? "left",
                clicks: Int(flag("clicks") ?? "1") ?? 1,
                modifiers: (flag("mod") ?? "").split(separator: "+").map(String.init))

    // A UI needs a frame or two to react.
    Thread.sleep(forTimeInterval: Double(flag("settle") ?? "") ?? 0.45)
    var changed: Bool?
    if beforeShot != nil, let diff = Vision.difference(patch, beforeShot) {
        // 1.5% mean absolute difference over a 16x16 grid: enough to catch
        // a button state or a menu opening, high enough to ignore a
        // blinking caret.
        changed = diff > 0.015
    }
    let payload: [String: Any] = [
        "ok": true, "clicked": true,
        "changed": changed as Any,
    ]
    FileHandle.standardOutput.write(
        (try? JSONSerialization.data(withJSONObject: payload)) ?? Data())

case "scroll":
    Typer.scroll(dx: Int32(flag("dx") ?? "0") ?? 0,
                 dy: Int32(flag("dy") ?? "0") ?? 0,
                 steps: Int(flag("steps") ?? "10") ?? 10)
    FileHandle.standardOutput.write(#"{"ok":true,"scrolled":true}"#.data(using: .utf8)!)

case "drag":
    guard let tx = Double(flag("to-x") ?? ""), let ty = Double(flag("to-y") ?? "") else {
        fail("drag needs --to-x --to-y (press starts wherever the cursor is)")
    }
    Typer.drag(to: CGPoint(x: tx, y: ty),
               durationSeconds: Double(flag("duration") ?? "") ?? 0.6)
    FileHandle.standardOutput.write(#"{"ok":true,"dragged":true}"#.data(using: .utf8)!)

case "hud":
    // Long-lived: reads update lines on stdin until EOF.
    HUD.run()

case "trusted":
    let payload = ["ok": true, "trusted": AXTree.trusted()] as [String: Any]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: payload))

default:
    fail("unknown verb \"\(verb)\" — expected read, point or trusted")
}

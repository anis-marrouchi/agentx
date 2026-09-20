import AppKit

/// ⌘⌥V — paste the clipboard in the shape the destination wants.
///
/// The decision, the transforms and the safety checks all live in agentx
/// (`agentx paste`), not here. Same split as pointing and looking: Swift
/// owns the hotkey and the panel, and the capability itself belongs to
/// every agent rather than to this one app. The widget is a trigger.
///
/// Resolved through a LOGIN SHELL rather than an absolute path. A GUI app
/// launched from Finder inherits almost no environment, so a hardcoded
/// path is the difference between working from a terminal and failing
/// mysteriously on double-click — and the path would differ per machine
/// anyway. `AGENTX_PASTE_COMMAND` overrides it.
enum SmartPaste {

    struct Result {
        let applied: String
        let reason: String
        let changed: Bool
    }

    /// Runs off the main thread: a login shell costs ~100ms to start, and
    /// blocking the main thread would freeze the panel mid-keystroke.
    static func run(completion: @escaping (Result?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = execute()
            DispatchQueue.main.async { completion(result) }
        }
    }

    private static func execute() -> Result? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // -l so PATH includes the places node and the CLI actually live.
        process.arguments = ["-lc", Config.pasteCommand + " --json"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            Log.info("smart paste: could not start (\(error.localizedDescription))")
            return nil
        }

        // Read before waiting: a full pipe buffer with nobody draining it
        // deadlocks the child, and this one prints the whole clipboard.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            Log.info("smart paste: no JSON from `\(Config.pasteCommand)`")
            return nil
        }
        return Result(
            applied: object["applied"] as? String ?? "asIs",
            reason: object["reason"] as? String ?? "",
            changed: object["changed"] as? Bool ?? false,
        )
    }

    /// What to show after a paste. Deliberately quiet when nothing changed:
    /// the common case is "pasted as copied", and announcing that every
    /// time would make the feature feel like it is in the way.
    static func summary(_ result: Result) -> String? {
        guard result.changed else { return nil }
        return result.applied
    }
}

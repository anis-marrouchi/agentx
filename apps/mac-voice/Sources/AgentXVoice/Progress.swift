import Foundation

/// Live activity from the daemon while a turn runs.
///
/// A voice assistant that goes silent for ten seconds reads as broken, and
/// the honest fix is not a spinner — it is saying what is actually
/// happening. The daemon already publishes `task:step` on its /events SSE
/// with a step name, action and input summary, so the widget can narrate
/// real work instead of inventing reassurance.
///
/// Deliberately best-effort: if the stream drops or the shape changes, the
/// turn still completes and the answer is still spoken. Progress is
/// decoration over a working path, never a dependency of it.
final class Progress: NSObject, URLSessionDataDelegate {
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var buffer = Data()
    private let agentID: String
    private let onStep: (String) -> Void

    /// Every touch of `buffer`, `task` and `session` happens here.
    ///
    /// URLSession delivers on its own queue while stop() is called from the
    /// main thread at the end of a turn, and both mutated `buffer`. Two
    /// threads mutating a Data value is not a race you get to lose
    /// gracefully — it corrupts the heap, and the process traps later in
    /// unrelated code (a CATransaction flush, in the crash that prompted
    /// this). Serialising is the fix; a lock around only removeAll() would
    /// not be, because the append path mutates it too.
    private let queue = DispatchQueue(label: "tn.noqta.agentx.voice.progress")
    private var stopped = false

    init(agentID: String, onStep: @escaping (String) -> Void) {
        self.agentID = agentID
        self.onStep = onStep
    }

    func start() {
        queue.async { [weak self] in self?.startLocked() }
    }

    private func startLocked() {
        guard !stopped else { return }
        guard let url = URL(string: "\(Config.daemonURL)/events?type=task") else { return }
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 3600
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 3600
        // Deliver on our own serial queue rather than an arbitrary one, so
        // didReceive and stop() cannot interleave.
        let opQueue = OperationQueue()
        opQueue.maxConcurrentOperationCount = 1
        opQueue.underlyingQueue = queue
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: opQueue)
        session = s
        task = s.dataTask(with: req)
        task?.resume()
    }

    func stop() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.task?.cancel(); self.task = nil
            // invalidateAndCancel breaks the session's strong reference to
            // this delegate; without it the object leaks for the life of
            // the app and keeps receiving events after the turn ended.
            self.session?.invalidateAndCancel(); self.session = nil
            self.buffer.removeAll()
        }
    }

    deinit { task?.cancel(); session?.invalidateAndCancel() }

    // Already on `queue` — see the delegateQueue wiring in startLocked().
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !stopped else { return }
        buffer.append(data)
        // SSE frames are separated by a blank line. Anything not yet
        // terminated stays buffered for the next packet.
        while let range = buffer.range(of: Data("\n\n".utf8)) {
            let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            handle(String(data: frame, encoding: .utf8) ?? "")
        }
    }

    private func handle(_ frame: String) {
        var event = "message", payload = ""
        for line in frame.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("data:") { payload += line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
        }
        guard event.contains("task"), !payload.isEmpty,
              let data = payload.data(using: .utf8),
              let outer = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        // broadcastSSE wraps every frame as {time, message}, where
        // `message` is the payload re-encoded as a STRING. So the step is
        // one JSON level deeper than the frame appears to be — unwrap it,
        // while still accepting a flat frame in case that ever changes.
        var obj = outer
        if let inner = outer["message"] as? String,
           let innerData = inner.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: innerData) as? [String: Any] {
            obj = parsed
        }

        // Only this widget's agent. Other agents are busy on their own work
        // and narrating theirs would be both confusing and a privacy leak.
        guard (obj["agentId"] as? String) == agentID else { return }
        guard let label = summarise(obj) else { return }
        DispatchQueue.main.async { self.onStep(label) }
    }

    /// Turn a step event into something worth showing in 180 points of
    /// label. Prefers the human-facing action over the internal step name.
    private func summarise(_ obj: [String: Any]) -> String? {
        // Only the start of a step is worth announcing. A tool_result
        // arrives a beat later and would just repeat what was said.
        if (obj["name"] as? String) == "tool_result" { return nil }

        let tool = (obj["action"] as? String) ?? (obj["name"] as? String) ?? ""
        guard !tool.isEmpty, tool != "tool_use" else { return nil }

        // inputSummary is the tool's raw arguments as JSON. The useful
        // part is one field — a command, a path, a query — and showing the
        // braces instead would waste the whole label.
        var detail = ""
        if let input = obj["inputSummary"] as? String,
           let d = input.data(using: .utf8),
           let args = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            for key in ["command", "file_path", "path", "query", "pattern", "url", "description"] {
                if let v = args[key] as? String, !v.isEmpty { detail = v; break }
            }
        }
        // Raw tool names never reach the screen. The marquee used to show
        // things like "mcp__agentx__agentx_task", which is unreadable to
        // anyone outside this codebase and appears during exactly the long
        // waits the widget exists to explain.
        guard let text = StepLabel.describe(tool: tool, detail: detail) else { return nil }
        // Long text is fine — the panel marquees it rather than truncating.
        return text.count > 90 ? String(text.prefix(88)) + "…" : text
    }
}

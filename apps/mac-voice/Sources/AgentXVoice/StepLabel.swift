import Foundation

/// Turning a tool name into something a person would say.
///
/// The marquee was rendering the raw identifier off the event bus, so a
/// panel meant to tell you what the assistant is doing said:
///
///     mcp__agentx__agentx_task · 68s
///
/// Nobody outside this codebase can read that, and it is on screen during
/// the exact moments the widget exists for — the long waits when you want
/// to know whether anything is happening.
///
/// Deterministic on purpose. There is a decision seat that chooses what to
/// SAY out loud (seats/voice-narration.ts) and it earns its call, because
/// picking which steps are worth interrupting for is a judgement. This is
/// not that. Steps arrive several times a second, the mapping from tool to
/// verb is fixed, and a model in this path would add latency and cost to a
/// lookup table.
///
/// Two rules, from watching real steps go past:
///   - lead with the VERB, because the label is read at a glance and the
///     first word is the only one guaranteed to be seen before it scrolls
///   - carry a detail when there is a useful one, but show the file's name
///     rather than its full path — the last component is the part that
///     identifies it, and the leading directories eat the whole label
enum StepLabel {

    /// Plain-language verb per tool. Present tense, no jargon, no tool names.
    private static let verbs: [String: String] = [
        "Bash": "Running a command",
        "Read": "Reading",
        "Edit": "Editing",
        "Write": "Writing",
        "NotebookEdit": "Editing a notebook",
        "Glob": "Looking for files",
        "Grep": "Searching the code",
        "WebSearch": "Searching the web",
        "WebFetch": "Reading a web page",
        "TodoWrite": "Updating the plan",
        "Task": "Handing work to a helper",
        "Agent": "Handing work to a helper",
        "Skill": "Using a skill",
        "ToolSearch": "Finding the right tool",
        "SendMessage": "Messaging another agent",
        "ListAgents": "Checking who is available",
        "ScheduleWakeup": "Scheduling a follow-up",
        "Monitor": "Watching for something to finish",
        "TaskOutput": "Checking on background work",
        "TaskList": "Checking on background work",
        "KillShell": "Stopping a command",
        "BashOutput": "Checking a command's output",
    ]

    /// agentx's own MCP tools, keyed by the bare name after the prefixes.
    private static let agentxVerbs: [String: String] = [
        "task": "Handing work to another agent",
        "send": "Sending a message",
        "send_agent": "Messaging another agent",
        "send_contact": "Sending a message",
        "channel_reply": "Replying on the channel",
        "channel_label": "Labelling the conversation",
        "recent": "Reading recent messages",
        "agents": "Checking who is available",
        "health": "Checking the system",
        "crons": "Checking scheduled jobs",
        "debug": "Checking the logs",
        "inspect": "Inspecting the setup",
        "generate": "Generating something",
        "skill_match": "Finding a matching skill",
        "wiki_query": "Searching the wiki",
        "wiki_patch": "Updating the wiki",
        "wiki_interview": "Working through the wiki",
        "graph_review": "Reviewing the activity graph",
        "attach_next": "Picking up an attachment",
        "attach_answer": "Answering an attachment",
        "detect_output_type": "Working out the reply format",
    ]

    /// A person-facing phrase for a tool call, or nil when the step is not
    /// worth putting on screen.
    static func describe(tool: String, detail: String?) -> String? {
        guard !tool.isEmpty, tool != "tool_use" else { return nil }

        let verb = verbFor(tool)
        guard let detail, !detail.isEmpty else { return verb }

        // A skill reads better named than appended: "Using the gitlab
        // skill", not "Using a skill: gitlab".
        if tool == "Skill" {
            let name = shorten(detail, for: tool)
            if !name.isEmpty { return "Using the \(name) skill" }
        }

        // A detail only helps when it is short enough to read while it
        // scrolls past. Long ones are the whole point of the marquee, so
        // they stay — but they are cleaned up first.
        let shown = shorten(detail, for: tool)
        return shown.isEmpty ? verb : "\(verb): \(shown)"
    }

    private static func verbFor(_ tool: String) -> String {
        if let known = verbs[tool] { return known }

        // mcp__<server>__<name>. The server prefix is an implementation
        // detail; the name is the only part with meaning in it.
        if tool.hasPrefix("mcp__") {
            let parts = tool.dropFirst(5).components(separatedBy: "__")
            let server = parts.first ?? ""
            var name = parts.count > 1 ? parts[1...].joined(separator: " ") : (parts.first ?? tool)
            // agentx's tools are all named agentx_<verb>; the repetition
            // carries nothing.
            if name.hasPrefix("agentx_") { name = String(name.dropFirst("agentx_".count)) }
            if server == "agentx", let known = agentxVerbs[name] { return known }
            // For an unmapped MCP tool the NAME is the action and the
            // server is packaging. "Search files" tells you what is
            // happening; "Using Claude ai google drive" does not.
            return humanWords(name.isEmpty ? server : name)
        }

        // Something we have no phrase for. Spacing out the camel case is a
        // better guess than the identifier, and is self-correcting: a tool
        // nobody mapped reads as "Running Some Tool" rather than as code.
        return humanWords(tool)
    }

    /// `file_path` style values are long and front-loaded with directories
    /// nobody is reading. The basename identifies the file.
    private static func shorten(_ detail: String, for tool: String) -> String {
        var text = detail
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)

        if ["Read", "Edit", "Write", "NotebookEdit"].contains(tool), text.contains("/") {
            text = (text as NSString).lastPathComponent
        }
        // Collapse runs of whitespace left by flattened multi-line commands.
        while text.contains("  ") { text = text.replacingOccurrences(of: "  ", with: " ") }
        return text
    }

    /// "agentx_send_agent" / "SomeToolName" -> "Some Tool Name".
    private static func humanWords(_ raw: String) -> String {
        let spaced = raw
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        var out = ""
        var previousWasLower = false
        for ch in spaced {
            if ch.isUppercase && previousWasLower { out.append(" ") }
            out.append(ch)
            previousWasLower = ch.isLowercase || ch.isNumber
        }
        let words = out.split(separator: " ").map(String.init)
        guard let first = words.first else { return raw }
        return ([first.prefix(1).uppercased() + first.dropFirst()]
            + words.dropFirst().map { $0.lowercased() }).joined(separator: " ")
    }
}

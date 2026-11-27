// --- An agent's answer in the shell chat, rendered (#2101) ---
//
// The same renderer as the Task page conversation (#2163, AI Elements'
// Response through Streamdown): markdown, code with colours, tables, and a
// reply still being written (an open fence, a half table) without breaking.
// Raw HTML in an answer is not rendered (see Response.tsx). Loaded on its
// own (ShellPage lazy-loads this file), so Streamdown is not in the shell's
// first load.
import { Response } from "../../web/task-conversation/elements/Response"
import "../../web/task-conversation/styles.css"
import "./chat-markdown.css"

export default function ChatMarkdown({ md, streaming }: { md: string; streaming: boolean }) {
  return (
    <div className="axc-reply" data-shell="answer">
      <Response md={md} streaming={streaming} />
    </div>
  )
}

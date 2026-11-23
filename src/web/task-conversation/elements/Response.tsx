import { memo } from "react"
import { Streamdown, defaultRehypePlugins } from "streamdown"
import { createCodePlugin } from "@streamdown/code"

// AI Elements' Response: markdown through Streamdown, which renders a reply
// that is still being written (an open fence, a half table) without breaking.
//
// SECURITY: agent output is text from outside (a Telegram message can steer
// what an agent echoes). Raw HTML in it is not rendered: the rehype-raw
// step is left out, and Streamdown's sanitize and harden steps stay.
const rehypePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin)

const code = createCodePlugin({ themes: ["github-light", "github-dark"] })

export const Response = memo(function Response({ md, streaming }: { md: string; streaming: boolean }) {
  return (
    <Streamdown
      className="axc-md"
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      rehypePlugins={rehypePlugins as any}
      plugins={{ code }}
      shikiTheme={["github-light", "github-dark"]}
      controls={{ code: true, table: false, mermaid: false }}
      codeBlockMaxHeight={480}
      linkSafety={{ enabled: false }}
    >
      {md}
    </Streamdown>
  )
}, (a, b) => a.md === b.md && a.streaming === b.streaming)

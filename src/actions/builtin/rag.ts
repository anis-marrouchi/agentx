import { z } from "zod"
import { lexicalSearch } from "@/rag/lexical-index"
import type { BuiltinAction } from "./types"

// --- rag.lexical ---
//
// Improvement plan #7 — embedding-free retrieval-augmented context.
// Looks up an agent's lexical (BM25) index built via `agentx rag add`
// and returns the top hits with score + path + body excerpt. No
// embedding API call, no key, deterministic.

const ragLexicalInput = z.object({
  /** Agent whose index to query. Each agent has its own index at
   *  .agentx/rag/<agentId>/. */
  agentId: z.string().min(1),
  query: z.string().min(1),
  /** Top-k results. Default 5, hard cap 50. */
  k: z.number().int().min(1).max(50).default(5),
})
type RagLexicalInput = z.infer<typeof ragLexicalInput>

const ragLexicalOutput = z.object({
  hits: z.array(z.object({
    id: z.string(),
    title: z.string(),
    path: z.string(),
    score: z.number(),
    snippet: z.string(),
  })),
})
type RagLexicalOutput = z.infer<typeof ragLexicalOutput>

export const ragLexical: BuiltinAction<RagLexicalInput, RagLexicalOutput> = {
  name: "rag.lexical",
  description: "BM25-style lexical search over an agent's pre-built index (no embeddings, deterministic)",
  inputSchema: ragLexicalInput,
  outputSchema: ragLexicalOutput,
  timeoutMs: 5_000,
  handler: async (input) => {
    const hits = lexicalSearch(input.agentId, input.query, { k: input.k })
    return { hits }
  },
}

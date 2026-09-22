import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ askSeat: vi.fn() }))
vi.mock('../src/decisions/seat', () => ({ askSeat: mocks.askSeat }))
import { evaluateRequest, selectRequestContext } from '../src/agents/request-planner'
const input = { agentId: 'coder', agentName: 'Coder', channel: 'voice', sender: 'User', message: 'Continue the fix', sessionHistory: 'Current fix and approvals', systemPrompt: 'Permissions', wikiContext: 'Unrelated wiki', memoryContext: 'Project memory' }
beforeEach(() => mocks.askSeat.mockReset())
describe('request preprocessing', () => {
  it('uses an active gate to decide whether preprocessing helps', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { preprocess: { noul: 0.9 } } })
    expect(await evaluateRequest('continue', 'coder', 'voice')).toEqual({ active: true, preprocess: true })
  })
  it('allows an active gate to pass straight to the main agent', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { preprocess: { noul: 0.1 } } })
    expect(await evaluateRequest('hello', 'coder', 'voice')).toEqual({ active: true, preprocess: false })
  })
  it.each([null, { mode: 'shadow', answers: { preprocess: { noul: 1 } } }])('does not change behavior without an active answer', async result => {
    mocks.askSeat.mockResolvedValue(result)
    expect((await evaluateRequest('hello', 'coder', 'api')).active).toBe(false)
  })
  it('removes only confidently irrelevant optional context and preserves mandatory context', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { wikiContext: { noul: 0.05 }, memoryContext: { noul: 0.5 }, systemPrompt: { noul: 0 } } })
    const result = await selectRequestContext(input)
    expect(result.excluded).toEqual(['wikiContext'])
    expect(result.input).toEqual({ ...input, wikiContext: undefined })
    expect(input.wikiContext).toBe('Unrelated wiki')
    const state = mocks.askSeat.mock.calls[0][1]
    expect(state.context.map((block: any) => block.id)).toEqual(['memoryContext', 'wikiContext'])
    expect(state.mandatory).toContain('same-chat history')
  })
  it('keeps context on missing, malformed, uncertain, or shadow decisions', async () => {
    for (const result of [null, { mode: 'active', answers: { wikiContext: { noul: NaN } } }, { mode: 'shadow', answers: { wikiContext: { noul: 0 } } }]) {
      mocks.askSeat.mockResolvedValue(result)
      expect((await selectRequestContext(input)).input).toEqual(input)
    }
  })
  it('bounds context previews and request size', async () => {
    mocks.askSeat.mockResolvedValue(null)
    await selectRequestContext({ ...input, message: 'x'.repeat(8000), wikiContext: 'x'.repeat(8000) })
    const state = mocks.askSeat.mock.calls[0][1]
    expect(state.request.length).toBe(2000)
    expect(state.context.every((block: any) => block.preview.length <= 400)).toBe(true)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ askSeat: vi.fn(), mode: 'active', seats: {} as Record<string, { holdout?: number }> }))
vi.mock('../src/decisions/seat', () => ({
  askSeat: mocks.askSeat,
  getSeatMode: () => mocks.mode,
  decisionsRuntime: () => ({ seats: mocks.seats }),
}))
import { evaluateRequest, selectRequestContext } from '../src/agents/request-planner'
// Never lands in the holdout under the default 10% rate.
const treat = () => 0.99
const input = { agentId: 'coder', agentName: 'Coder', channel: 'voice', sender: 'User', message: 'Continue the fix', sessionHistory: 'Current fix and approvals', systemPrompt: 'Permissions', wikiContext: 'Unrelated wiki', memoryContext: 'Project memory' }
beforeEach(() => { mocks.askSeat.mockReset(); mocks.mode = 'active'; mocks.seats = {} })
describe('request preprocessing', () => {
  it('uses an active gate to decide whether preprocessing helps', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { preprocess: { noul: 0.9 } } })
    expect(await evaluateRequest('continue', 'coder', 'voice', treat)).toEqual({ active: true, preprocess: true, arm: 'treatment' })
  })
  it('allows an active gate to pass straight to the main agent', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { preprocess: { noul: 0.1 } } })
    expect(await evaluateRequest('hello', 'coder', 'voice', treat)).toEqual({ active: true, preprocess: false, arm: 'treatment' })
  })
  it.each([null, { mode: 'shadow', answers: { preprocess: { noul: 1 } } }])('does not change behavior without an active answer', async result => {
    mocks.askSeat.mockResolvedValue(result)
    expect((await evaluateRequest('hello', 'coder', 'api', treat)).active).toBe(false)
  })
  it('holds out a random share of turns without calling the gate', async () => {
    const gate = await evaluateRequest('continue', 'coder', 'voice', () => 0.05)
    // Behaves exactly like a gate "skip": existing context, own model.
    expect(gate).toEqual({ active: true, preprocess: false, arm: 'holdout' })
    expect(mocks.askSeat).not.toHaveBeenCalled()
  })
  it('defaults the holdout to 10% and honours the configured rate', async () => {
    mocks.askSeat.mockResolvedValue({ mode: 'active', answers: { preprocess: { noul: 0.9 } } })
    expect((await evaluateRequest('x', 'coder', 'api', () => 0.099)).arm).toBe('holdout')
    expect((await evaluateRequest('x', 'coder', 'api', () => 0.1)).arm).toBe('treatment')
    mocks.seats = { 'request-gate': { holdout: 0 } }
    expect((await evaluateRequest('x', 'coder', 'api', () => 0)).arm).toBe('treatment')
    mocks.seats = { 'request-gate': { holdout: 0.5 } }
    expect((await evaluateRequest('x', 'coder', 'api', () => 0.4)).arm).toBe('holdout')
  })
  it('keeps a failed gate call in the treatment arm (intent-to-treat)', async () => {
    mocks.askSeat.mockResolvedValue(null)
    expect(await evaluateRequest('x', 'coder', 'api', treat)).toEqual({ active: false, preprocess: false, arm: 'treatment' })
  })
  it.each(['off', 'shadow'])('assigns no arm and never holds out when the gate is %s', async mode => {
    mocks.mode = mode
    mocks.askSeat.mockResolvedValue(mode === 'shadow' ? { mode, answers: { preprocess: { noul: 1 } } } : null)
    const gate = await evaluateRequest('x', 'coder', 'api', () => 0)
    expect(gate).toEqual({ active: false, preprocess: false, arm: undefined })
    expect(mocks.askSeat).toHaveBeenCalledTimes(1)
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

import { describe, expect, it } from 'vitest'
import { parseAgents } from '../hooks/data/parse'
import { newState } from '../hooks/state'
import { agentView } from '../hooks/views/agent'
import type { Ctx } from '../hooks/views/common'

describe('heterogeneous agent console', () => {
  it('renders the persistent model target, recommendation and reported usage without engine calls', () => {
    const agent = parseAgents(JSON.stringify({ agents: { a: {
      agentId: 'a', agentType: 'coder', status: 'idle',
      modelTarget: { family: 'gpt', provider: 'openai', model: 'gpt-fixture', runtime: 'codex', selectedBy: 'jev' },
      recommendation: { recommendedAgents: 2, effectiveLimit: 3, spawnReason: 'test_isolation' },
      lastResult: { success: true, metering: { inputTokens: 7, outputTokens: 3 }, costUsd: 0.01, durationMs: 30 },
    } } }))[0]
    const state = newState()
    state.drill.agentId = 'a'
    state.drill.logs = []
    state.snapshot = { agents: [agent], tasks: [], claims: [] } as unknown as NonNullable<typeof state.snapshot>
    const element = (props: unknown) => props
    const ctx = { state, nowMs: Date.now(), columns: 200, pictures: new Map(),
      kit: { Text: element, Box: element, Button: element }, act: {} } as unknown as Ctx
    const tree = JSON.stringify(agentView(ctx))
    expect(tree).toContain('gpt · openai · gpt-fixture · codex')
    expect(tree).toContain('jev · test_isolation')
    expect(tree).toContain('input 7 · output 3')
    expect(tree).toContain('USD 0.01')
    expect(tree).toContain('recommended 2 · effective limit 3')
  })
})

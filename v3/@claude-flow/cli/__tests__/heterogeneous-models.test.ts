import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentTools } from '../src/mcp-tools/agent-tools.js';
import { taskTools } from '../src/mcp-tools/task-tools.js';
import { hiveMindTools } from '../src/mcp-tools/hive-mind-tools.js';
import { executeAgentTask } from '../src/mcp-tools/agent-execute-core.js';
import { AgentGovernorSchema, HeterogeneousModelsSchema } from '../src/services/model-contract.js';
import { decideAgentSpawn, normalizeWork, recommendAgents } from '../src/services/agent-governor.js';
import { normalizeLegacyTarget, registerJevAdapter, resolveRoleFamily, selectModelTarget } from '../src/services/model-selection.js';
import { ConfigFileManager, configManager } from '../src/services/config-file-manager.js';
import { getControlPanelSnapshot, renderControlPanel } from '../src/services/control-panel.js';
import { parseNativeOutput, registerModelRuntime } from '../src/services/heterogeneous-execution.js';
import { readExecutionEvents } from '../src/services/execution-telemetry.js';
import { evaluatePolicyRequest, loadPolicyState, setPolicyBudget, setPolicyMode, upsertPolicyRule } from '../src/services/policy-runtime.js';
import * as policyRuntime from '../src/services/policy-runtime.js';
import * as monitoring from '../src/production/monitoring.js';
import { resetGlobalAiBudgetForTests } from '../src/services/global-ai-budget.js';
import { parseAgents } from '../../../../plugins/ruflo-console/hooks/data/parse.js';
import { v3ConfigToSystemConfig, systemConfigToV3Config } from '../src/config-adapter.js';

const defaults = {
  claude: { family: 'claude', provider: 'anthropic', model: 'claude-test', runtime: 'api' },
  gpt: { family: 'gpt', provider: 'openai', model: 'gpt-test', runtime: 'api' },
};
const legacy = async () => ({ family: 'claude', provider: 'anthropic', model: 'sonnet', runtime: 'api', selectedBy: 'legacy' });
const feature = (overrides = {}) => HeterogeneousModelsSchema.parse({ enabled: true, defaults, selector: { type: 'static' }, ...overrides });
const tool = async (name: string, input: Record<string, unknown> = {}) =>
  await agentTools.find(t => t.name === name)!.handler(input) as Record<string, any>;
const task = async (name: string, input: Record<string, unknown>) =>
  await taskTools.find(t => t.name === name)!.handler(input) as Record<string, any>;

describe('model selection contract', () => {
  it.each([['planner', 'claude'], ['architect', 'claude'], ['coordinator', 'claude'], ['reviewer', 'claude'], ['coder', 'gpt'], ['implementer', 'gpt'], ['developer', 'gpt'], ['tester', 'gpt']])('routes %s to %s', (role, family) => {
    expect(resolveRoleFamily(role, feature())).toBe(family);
  });
  it('supports tester/custom role policy overrides and normalizes legacy aliases', () => {
    expect(resolveRoleFamily('tester', feature({ roleFamilies: { tester: 'claude' } }))).toBe('claude');
    expect(normalizeLegacyTarget({ model: 'sonnet' })).toMatchObject({ family: 'claude', model: 'sonnet', selectedBy: 'legacy' });
  });
  it('exact manual selection wins over role and selector', async () => {
    const result = await selectModelTarget({ config: feature({ selector: { type: 'jev', strict: true } }), role: 'coder',
      override: { provider: 'anthropic', model: 'sonnet' }, legacy });
    expect(result.target).toMatchObject({ family: 'claude', provider: 'anthropic', model: 'sonnet', selectedBy: 'manual' });
    await expect(selectModelTarget({ config: feature(), role: 'coder', override: {
      family: 'gpt', provider: 'anthropic', model: 'claude-test' }, legacy })).rejects.toThrow('contradicts');
  });
  it('configured family defaults take precedence over conflicting legacy routing', async () => {
    const result = await selectModelTarget({ config: feature({ selector: { type: 'legacy' } }), role: 'coder', legacy });
    expect(result.target).toMatchObject({ family: 'gpt', model: 'gpt-test', selectedBy: 'static' });
    const noDefault = await selectModelTarget({ config: feature({ selector: { type: 'legacy' }, defaults: {} }), role: 'coder', legacy });
    expect(noDefault.target.family).toBe('claude'); expect(noDefault.warning).toBeTruthy();
  });
  it('Jev receives family plus minimum metadata and chooses the native target', async () => {
    const callback = vi.fn(async request => ({ ...defaults.gpt, model: 'gpt-jev', selectedBy: 'jev' }));
    const unregister = registerJevAdapter('jev-unit', callback);
    try {
      const result = await selectModelTarget({ config: feature({ selector: { type: 'jev', adapter: 'jev-unit' } }), role: 'coder',
        request: { task: 'implementation', complexity: 0.6 }, legacy });
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ role: 'coder', family: 'gpt', task: 'implementation' }));
      expect(result.target.model).toBe('gpt-jev');
    } finally { unregister(); }
  });
  it('falls back on selector error and timeout, while strict errors surface', async () => {
    const unregister = registerJevAdapter('broken', async () => { throw new Error('offline'); });
    const timeout = registerJevAdapter('slow', async () => new Promise(() => {}));
    try {
      for (const adapter of ['broken', 'slow']) {
        const config = feature({ selector: { type: 'jev', adapter, timeoutMs: 10 } });
        expect((await selectModelTarget({ config, role: 'coder', legacy })).target.model).toBe('gpt-test');
      }
      await expect(selectModelTarget({ config: feature({ selector: { type: 'jev', adapter: 'broken', strict: true } }), role: 'coder', legacy })).rejects.toThrow('offline');
    } finally { unregister(); timeout(); }
  });
  it('legacy fallback keeps actual family truthful and cannot violate explicit family/provider', async () => {
    const config = feature({ defaults: {}, selector: { type: 'jev' } });
    expect((await selectModelTarget({ config, role: 'coder', legacy })).target.family).toBe('claude');
    await expect(selectModelTarget({ config, role: 'coder', override: { family: 'gpt' }, legacy })).rejects.toThrow('explicit family');
    await expect(selectModelTarget({ config, role: 'coder', override: { provider: 'openai' }, legacy })).rejects.toThrow('explicit provider');
  });
  it('rejects a selector that labels a Claude model as GPT', async () => {
    const unregister = registerJevAdapter('liar', async () => ({ family: 'gpt', provider: 'anthropic', model: 'claude-test', selectedBy: 'jev' }));
    try { await expect(selectModelTarget({ config: feature({ selector: { type: 'jev', adapter: 'liar', strict: true } }), role: 'coder', legacy })).rejects.toThrow('contradicts'); }
    finally { unregister(); }
  });
});

describe('deterministic Governor', () => {
  const config = AgentGovernorSchema.parse({ enabled: true });
  it('starts at one and requires evidence of independent benefit', () => {
    expect(recommendAgents(config, normalizeWork({ complexity: 1 }), 8).recommendedAgents).toBe(1);
    expect(recommendAgents(config, normalizeWork({ complexity: 1, independentWorkstreams: 10, expectedGainMs: 10 }), 8).recommendedAgents).toBe(1);
    expect(recommendAgents(config, normalizeWork({ complexity: 0.6, independentWorkstreams: 2, expectedGainMs: 10_000 }), 8).recommendedAgents).toBe(2);
  });
  it('intersects configured/swarm/hard limits at all complexity values', () => {
    for (let i = 0; i <= 100; i++) {
      const recommendation = recommendAgents(config, normalizeWork({ complexity: i / 100, independentWorkstreams: 50, expectedGainMs: 100_000 }), 2);
      expect(recommendation.recommendedAgents).toBeLessThanOrEqual(2);
      expect(recommendation.recommendedAgents).toBeLessThanOrEqual(config.hardMaxAgents);
    }
  });
  it('denies duplicates, overlapping ownership and pending dependencies', () => {
    const work = normalizeWork({ taskId: 'task', files: ['a.ts'] }, 'build module');
    const agents = [{ agentId: 'a', agentType: 'coder', config: {}, status: 'idle', work }];
    expect(decideAgentSpawn({ config, work, role: 'coder', agents, maxAgents: 8 })).toMatchObject({ allowed: false, reason: 'duplicate_work', duplicateAgentId: 'a' });
    expect(decideAgentSpawn({ config, work: normalizeWork({ files: ['a.ts'] }, 'different task'), role: 'coder', agents, maxAgents: 8 }).reason).toBe('overlapping_work');
    expect(decideAgentSpawn({ config, work: normalizeWork({ dependsOn: ['missing'] }), role: 'tester', agents: [], maxAgents: 8 }).reason).toBe('dependency_pending');
  });
  it('keeps manual escalation bounded by budgets and limits', () => {
    const work = normalizeWork({ spawnReason: 'manual_override' });
    const agents = Array.from({ length: 2 }, (_, i) => ({ agentId: String(i), agentType: 'worker', config: {}, status: 'idle' }));
    expect(decideAgentSpawn({ config, work, role: 'coder', agents, maxAgents: 2 }).allowed).toBe(false);
    for (const utilization of [0.8, 0.95, 1]) expect(decideAgentSpawn({ config, work, role: 'coder', agents, maxAgents: 8,
      budget: [{ id: 'cap', utilization, enforced: true }] }).allowed).toBe(false);
  });
  it('malformed legacy limits cannot turn a hard limit into NaN', () => {
    expect(() => recommendAgents(config, normalizeWork({}), NaN)).toThrow('positive finite');
  });
});

describe('live registry/provider/runtime integration', () => {
  let cwd: string;
  const unregister: Array<() => void> = [];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ruflo-heterogeneous-'));
    vi.stubEnv('CLAUDE_FLOW_CWD', cwd); vi.stubEnv('RUFLO_AI_BUDGET_DIR', join(cwd, 'global-budget'));
    for (const key of ['RUFLO_PROVIDER', 'OLLAMA_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDE_FLOW_CONFIG', 'CLAUDE_FLOW_CAPABILITY_ENVELOPE', 'CLAUDE_FLOW_PRINCIPAL_ID']) vi.stubEnv(key, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic'); vi.stubEnv('OPENAI_API_KEY', 'test-openai');
    resetGlobalAiBudgetForTests(); configManager.load(cwd);
    writeConfig();
  });
  afterEach(() => {
    unregister.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllEnvs();
    resetGlobalAiBudgetForTests(); configManager.load('/tmp/nonexistent-ruflo-config'); rmSync(cwd, { recursive: true, force: true });
  });
  function writeConfig(overrides: Record<string, unknown> = {}) {
    writeFileSync(join(cwd, 'claude-flow.config.json'), JSON.stringify({ heterogeneousModels: feature(), agentGovernor: { enabled: true }, controlPanel: { enabled: true }, ...overrides }));
    configManager.load(cwd);
  }
  function fakeFetch(usage: unknown = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, cost: 0.01 }) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id: 'response', model: 'gpt-test',
      choices: [{ message: { content: 'implemented' } }], ...(usage === null ? {} : { usage }) }) } as Response);
  }
  async function spawn(role = 'coder', extra: Record<string, unknown> = {}) {
    const result = await tool('agent_spawn', { agentType: role, task: 'PRIVATE SOURCE MUST NOT GO TO SELECTOR', ...extra });
    expect(result.success).toBe(true); return result;
  }
  it('applies Jev target through the actual provider wire and captures telemetry/panel', async () => {
    const callback = vi.fn(async () => ({ ...defaults.gpt, reasoningEffort: 'high', selectedBy: 'jev' }));
    unregister.push(registerJevAdapter('integration', callback));
    writeConfig({ heterogeneousModels: feature({ selector: { type: 'jev', adapter: 'integration' } }) });
    const fetch = fakeFetch(); const agent = await spawn();
    const result = await executeAgentTask({ agentId: agent.agentId, prompt: 'PRIVATE FULL SOURCE' });
    expect(result).toMatchObject({ success: true, modelTarget: { family: 'gpt', provider: 'openai', runtime: 'api', selectedBy: 'jev' }, costUsd: 0.01 });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-test', reasoning_effort: 'high' });
    expect(JSON.stringify(callback.mock.calls)).not.toContain('PRIVATE');
    const event = readExecutionEvents(cwd).find(e => e.event === 'end')!;
    expect(event).toMatchObject({ role: 'coder', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 }, success: true, spawnReason: 'initial' });
    expect((await tool('agent_control_panel')).agents[0].target.selectedBy).toBe('jev');
    expect(renderControlPanel(getControlPanelSnapshot(cwd))).toContain('RUFLO CONTROL');
    const consoleAgent = parseAgents(readFileSync(join(cwd, '.claude-flow/agents/store.json'), 'utf8'))[0];
    expect(consoleAgent).toMatchObject({ family: 'gpt', runtime: 'api', selector: 'jev', inputTokens: 100, costUsd: 0.01 });
  });
  it('does not fabricate missing usage/cost and still completes', async () => {
    fakeFetch(null); const agent = await spawn();
    const result = await executeAgentTask({ agentId: agent.agentId, prompt: 'work' });
    expect(result.success).toBe(true); expect(result.usage).toBeUndefined(); expect(result.costUsd).toBeUndefined();
    expect(getControlPanelSnapshot(cwd).agents[0]).toMatchObject({ usageUnknown: true, costUnknown: true });
  });
  it('Anthropic responses without usage still succeed with unknown measurements', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ model: 'claude-test', content: [{ type: 'text', text: 'plan' }] }) } as Response);
    const agent = await spawn('planner');
    expect(await executeAgentTask({ agentId: agent.agentId, prompt: 'plan' })).toMatchObject({ success: true, output: 'plan' });
    expect(getControlPanelSnapshot(cwd).agents[0].usageUnknown).toBe(true);
  });
  it('a broken metrics sink cannot fail provider work or bypass budget settlement', async () => {
    const broken = () => { throw new Error('metrics unavailable'); };
    vi.spyOn(monitoring, 'getMonitor').mockReturnValue({ gauge: broken, counter: broken, histogram: broken } as any);
    await setPolicyMode('enforce', cwd); await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'usd', maxCostUsd: 1, periodMs: 60_000 }, cwd);
    fakeFetch({ prompt_tokens: 3, completion_tokens: 2, cost: 0.3 });
    const agent = await spawn('coder', { work: { estimatedCostUsd: 0.1 } });
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).success).toBe(true);
    expect(loadPolicyState(cwd).usage[0].costUsd).toBeCloseTo(0.3);
  });
  it('preserves task assign → execute and prevents concurrent same-agent execution even after status update', async () => {
    let finish!: () => void;
    unregister.push(registerModelRuntime('api', async () => { await new Promise<void>(r => { finish = r; }); return { success: true, output: 'done' }; }));
    const agent = await spawn(); const created = await task('task_create', { type: 'feature', description: 'implement' });
    await task('task_assign', { taskId: created.taskId, agentIds: [agent.agentId] });
    const first = executeAgentTask({ agentId: agent.agentId, prompt: 'work' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await tool('agent_update', { agentId: agent.agentId, status: 'idle' });
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'duplicate' })).error).toContain('already executing');
    finish(); expect((await first).success).toBe(true);
  });
  it('serializes duplicate concurrent spawn attempts and routes pool scaling through admission', async () => {
    const results = await Promise.all([tool('agent_spawn', { agentType: 'coder', task: 'same' }), tool('agent_spawn', { agentType: 'coder', task: 'same' })]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(results.find(r => !r.success)?.duplicateAgentId).toBeTruthy();
    const pool = await tool('agent_pool', { action: 'scale', targetSize: 20, agentType: 'tester' });
    expect(pool.success).toBe(false); expect(getControlPanelSnapshot(cwd).activeAgents).toBe(1);
  });
  it('actual cost overruns settle into existing policy budget and block further spawn/execution', async () => {
    await setPolicyMode('enforce', cwd);
    await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'usd', action: 'agent.execute', maxCostUsd: 1, periodMs: 60_000 }, cwd);
    fakeFetch({ prompt_tokens: 100, completion_tokens: 20, cost: 1.2 });
    const agent = await spawn('coder', { work: { estimatedCostUsd: 0.1, estimatedTokens: 1000 } });
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).success).toBe(true);
    expect(loadPolicyState(cwd).usage[0].costUsd).toBeCloseTo(1.2);
    expect((await tool('agent_spawn', { agentType: 'reviewer' })).error).toContain('budget_exhausted');
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work again' })).success).toBe(false);
  });
  it('inherits caller-principal budgets for spawning and actual usage settlement', async () => {
    vi.stubEnv('CLAUDE_FLOW_PRINCIPAL_ID', 'agent:controller');
    await setPolicyMode('enforce', cwd); await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'caller', principal: 'agent:controller', maxCostUsd: 1, periodMs: 60_000 }, cwd);
    fakeFetch({ prompt_tokens: 3, completion_tokens: 2, cost: 1.2 });
    const agent = await spawn('coder', { work: { estimatedCostUsd: 0.1 } });
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).success).toBe(true);
    expect(loadPolicyState(cwd).usage.find(u => u.limitId === 'caller')?.costUsd).toBeCloseTo(1.2);
    expect((await tool('agent_spawn', { agentType: 'reviewer' })).error).toContain('budget_exhausted');
  });
  it('preserves returned work on ledger IO failure and reconciles before further spend', async () => {
    await setPolicyMode('enforce', cwd); await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'usd', maxCostUsd: 1, periodMs: 60_000 }, cwd);
    fakeFetch({ prompt_tokens: 3, completion_tokens: 2, cost: 1.2 });
    const agent = await spawn('coder', { work: { estimatedCostUsd: 0.1 } });
    const settle = vi.spyOn(policyRuntime, 'settlePolicyUsage').mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).toMatchObject({
      success: false, output: 'implemented', costUsd: 1.2, accountingPending: true });
    expect((await tool('agent_spawn', { agentType: 'reviewer' })).error).toContain('accounting_pending');
    settle.mockRestore();
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'retry' })).success).toBe(false);
    expect(loadPolicyState(cwd).usage.find(u => u.limitId === 'usd')?.costUsd).toBeCloseTo(1.2);
  });
  it('enforces inherited zero spending and shared concurrency caps even without Governor', async () => {
    execFileSync('git', ['init', '-q', cwd]);
    const envelope = { actions: ['*'], resources: ['*'], tools: ['*'], network: true, maxCostUsd: 0 };
    const agent = await spawn(); const fetch = fakeFetch();
    vi.stubEnv('CLAUDE_FLOW_CAPABILITY_ENVELOPE', JSON.stringify(envelope));
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).error).toContain('positive cost upper');
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('CLAUDE_FLOW_CAPABILITY_ENVELOPE', JSON.stringify({ ...envelope, maxCostUsd: undefined, maxConcurrency: 1 }));
    writeConfig({ agentGovernor: { enabled: false } });
    let finish!: () => void;
    unregister.push(registerModelRuntime('api', async () => { await new Promise<void>(r => { finish = r; }); return { success: true, output: 'done' }; }));
    const second = await spawn('tester'); const firstRun = executeAgentTask({ agentId: agent.agentId, prompt: 'work' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await executeAgentTask({ agentId: second.agentId, prompt: 'work' })).error).toContain('Inherited execution concurrency');
    finish(); expect((await firstRun).success).toBe(true);
  });
  it('hive shutdown releases canonical Governor slots', async () => {
    const hive = async (name: string, input = {}) => await hiveMindTools.find(t => t.name === name)!.handler(input) as Record<string, any>;
    await hive('hive-mind_init');
    const workers = await hive('hive-mind_spawn', { agentType: 'coder', count: 1 });
    expect(workers.spawned).toBe(1); expect(getControlPanelSnapshot(cwd).activeAgents).toBe(1);
    expect((await hive('hive-mind_shutdown', { force: true })).success).toBe(true);
    expect(getControlPanelSnapshot(cwd).activeAgents).toBe(0);
  });
  it('records actual Ruflo reassignment handoffs and task IDs', async () => {
    writeConfig({ agentGovernor: { enabled: false } });
    const a = await spawn('planner'), b = await spawn('coder');
    const created = await task('task_create', { type: 'feature', description: 'work' });
    await task('task_assign', { taskId: created.taskId, agentIds: [a.agentId] });
    await task('task_assign', { taskId: created.taskId, agentIds: [b.agentId] });
    expect(getControlPanelSnapshot(cwd).efficiency.handoffCount).toBe(1);
    fakeFetch(); await executeAgentTask({ agentId: b.agentId, prompt: 'work' });
    expect(readExecutionEvents(cwd).find(e => e.event === 'end')?.taskId).toBe(created.taskId);
  });
  it('zero estimates cannot bypass metered budgets and warning/critical budget ladder reduces fanout', async () => {
    await setPolicyMode('enforce', cwd); await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'usd', action: 'agent.execute', maxCostUsd: 1, periodMs: 60_000 }, cwd);
    const agent = await spawn('coder', { work: { estimatedCostUsd: 0 } }); const fetch = fakeFetch();
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'work' })).error).toContain('positive cost upper'); expect(fetch).not.toHaveBeenCalled();
    await evaluatePolicyRequest({ identity: { id: 'agent:test', type: 'agent' }, action: { type: 'agent.execute', costUsd: 0.95 } }, cwd);
    expect((await tool('agent_spawn', { agentType: 'reviewer', work: { spawnReason: 'manual_override' } })).error).toContain('budget_critical');
  });
  it('disabled features preserve legacy model alias and provider behavior', async () => {
    writeConfig({ heterogeneousModels: { enabled: false }, agentGovernor: { enabled: false } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id: 'legacy', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }) } as Response);
    const agent = await spawn('coder', { model: 'sonnet' });
    expect(agent.modelTarget).toBeUndefined();
    expect((await executeAgentTask({ agentId: agent.agentId, prompt: 'hello' })).success).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe('claude-sonnet-5');
    expect(readExecutionEvents(cwd)).toEqual([]);
  });
  it('validates configuration atomically and preserves extensions across adapters', () => {
    const manager = new ConfigFileManager(); manager.load(cwd);
    const before = readFileSync(join(cwd, 'claude-flow.config.json'), 'utf8');
    expect(() => manager.set(cwd, 'agentGovernor.hardMaxAgents', 0)).toThrow();
    expect(readFileSync(join(cwd, 'claude-flow.config.json'), 'utf8')).toBe(before);
    const v3 = systemConfigToV3Config({ orchestrator: { session: {}, health: {}, lifecycle: {} }, heterogeneousModels: feature() } as any);
    expect(v3ConfigToSystemConfig(v3).heterogeneousModels).toEqual(feature());
  });
  it('executes a real fake Codex child with structured flags and EOF, without external credentials', async () => {
    const bin = join(cwd, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(process.argv.slice(2))}}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:8,output_tokens:3,cached_input_tokens:2}}));});\n', { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    writeConfig({ heterogeneousModels: feature({ defaults: { ...defaults, gpt: { ...defaults.gpt, runtime: 'codex', reasoningEffort: 'high' } } }) });
    const fetch = vi.spyOn(globalThis, 'fetch'); const agent = await spawn();
    const result = await executeAgentTask({ agentId: agent.agentId, prompt: 'implement', timeoutMs: 5000 });
    expect(result).toMatchObject({ success: true, modelTarget: { runtime: 'codex' }, metering: { inputTokens: 8, outputTokens: 3, cachedTokens: 2 } });
    const argv = JSON.parse(result.output!); expect(argv).toContain('--json'); expect(argv).toContain('model_reasoning_effort="high"'); expect(argv).toContain('gpt-test'); expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves failed native stdout and settles its reported token usage', async () => {
    const bin = join(cwd, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"partial work"}}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:80,output_tokens:30}}));process.exitCode=1;\n', { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    writeConfig({ heterogeneousModels: feature({ defaults: { ...defaults, gpt: { ...defaults.gpt, runtime: 'codex' } } }) });
    await setPolicyMode('enforce', cwd); await upsertPolicyRule({ id: 'execute', actions: ['agent.execute'], effect: 'allow' }, cwd);
    await setPolicyBudget({ id: 'tokens', maxTokens: 100, periodMs: 60_000 }, cwd);
    const agent = await spawn('coder', { work: { estimatedTokens: 10 } });
    const result = await executeAgentTask({ agentId: agent.agentId, prompt: 'implement', timeoutMs: 5000 });
    expect(result).toMatchObject({ success: false, output: 'partial work', metering: { inputTokens: 80, outputTokens: 30 } });
    expect(loadPolicyState(cwd).usage.find(u => u.limitId === 'tokens')?.tokens).toBe(110);
  });
  it('built CLI runs Claude control → Codex implementation and monitors actual fixture work', () => {
    const bin = join(cwd, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({result:"plan",model:"claude-test",usage:{input_tokens:2,output_tokens:3},total_cost_usd:0.001}));\n', { mode: 0o700 });
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nrequire("fs").writeFileSync("implementation.txt","completed");console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"implemented"}}));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:6}}));\n', { mode: 0o700 });
    writeConfig({ heterogeneousModels: feature({ defaults: {
      claude: { ...defaults.claude, runtime: 'claude-code' }, gpt: { ...defaults.gpt, runtime: 'codex' },
    } }) });
    const cli = fileURLToPath(new URL('../../../../bin/cli.js', import.meta.url));
    const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_FLOW_PRINCIPAL_ID: 'legacy-cli', RUFLO_DAEMON_AUTOSTART: '0' } });
    run(['agent', 'spawn', '--type', 'planner', '--name', 'plan']);
    expect(run(['agent', 'execute', 'plan', '--prompt', 'plan the work'])).toContain('plan');
    run(['agent', 'spawn', '--type', 'coder', '--name', 'implement']);
    expect(() => run(['agent', 'spawn', '--type', 'tester', '--name', 'optional'])).toThrow();
    expect(run(['agent', 'execute', 'implement', '--prompt', 'implement the plan'])).toContain('implemented');
    expect(readFileSync(join(cwd, 'implementation.txt'), 'utf8')).toBe('completed');
    const text = run(['agent', 'control', '--format', 'json']);
    const panel = JSON.parse(text.slice(text.indexOf('{')));
    expect(panel.activeAgents).toBe(0);
    expect(panel.agents.map((a: any) => a.target.runtime)).toEqual(['claude-code', 'codex']);
  });
});

describe('native usage contracts', () => {
  it('normalizes Claude cached usage into total input; keeps absent cost unknown', () => {
    const result = parseNativeOutput('claude-code', JSON.stringify({ result: 'ok', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 7 } }));
    expect(result.metering).toMatchObject({ inputTokens: 9, outputTokens: 3, cachedTokens: 7 }); expect(result.costUsd).toBeUndefined();
  });
  it('reports structured native failure and malformed output without invented usage', () => {
    expect(parseNativeOutput('codex', '{"type":"turn.failed"}').success).toBe(false);
    expect(parseNativeOutput('claude-code', 'plain text').metering).toBeUndefined();
  });
});

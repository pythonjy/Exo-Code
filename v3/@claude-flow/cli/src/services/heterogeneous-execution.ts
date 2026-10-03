/** Enabled execution adapter over Ruflo's existing API and native worker lifecycles. */
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delegateEnvelope, type CapabilityEnvelope } from '@claude-flow/security';
import type { AgentRecord, AgentExecuteInput, AgentExecuteResult, AnthropicCallInput, AnthropicCallResult } from '../mcp-tools/agent-execute-core.js';
import { getProjectCwd } from '../mcp-tools/types.js';
import { loadSwarmStore } from '../mcp-tools/swarm-tools.js';
import { getMonitor } from '../production/monitoring.js';
import { ConfigFileManager } from './config-file-manager.js';
import { activeAgents, configuredAgentLimit, withAgentRegistryLock, readAgentBudgets, recommendAgents, type GovernedAgent } from './agent-governor.js';
import { normalizeLegacyTarget, selectModelTarget } from './model-selection.js';
import type { AgentGovernorConfig, HeterogeneousModelsConfig, ModelTarget } from './model-contract.js';
import { evaluatePolicyRequest, getExecutionPolicyContext, settlePolicyUsage } from './policy-runtime.js';
import { getGlobalAiBudget, isQuotaErrorText } from './global-ai-budget.js';
import { estimateExecutionCost, recordExecutionEvent, reportedNumber, type RuntimeUsage } from './execution-telemetry.js';

export interface RuntimeResult extends AnthropicCallResult { metering?: RuntimeUsage; }
export interface RuntimeRequest { target: ModelTarget; input: AgentExecuteInput; agent: AgentRecord; systemPrompt: string; envelope?: CapabilityEnvelope; executionCwd?: string; }
export type RuntimeAdapter = (request: RuntimeRequest) => Promise<RuntimeResult>;
const runtimeAdapters = new Map<string, RuntimeAdapter>();
export function registerModelRuntime(kind: string, adapter: RuntimeAdapter): () => void {
  if (runtimeAdapters.has(kind)) throw new Error(`Runtime already registered: ${kind}`);
  runtimeAdapters.set(kind, adapter);
  return () => { if (runtimeAdapters.get(kind) === adapter) runtimeAdapters.delete(kind); };
}
export function parseNativeOutput(runtime: string, output: string): RuntimeResult {
  try {
    if (runtime === 'claude-code') {
      const data = JSON.parse(output);
      const usage = data.usage;
      return { success: data.is_error !== true, output: typeof data.result === 'string' ? data.result : output,
        ...(data.is_error === true ? { error: 'Claude runtime reported failure' } : {}),
        model: typeof data.model === 'string' ? data.model : undefined,
        metering: usage ? { inputTokens: reportedNumber(usage.input_tokens) !== undefined
          ? usage.input_tokens + (reportedNumber(usage.cache_read_input_tokens) ?? 0) + (reportedNumber(usage.cache_creation_input_tokens) ?? 0) : undefined, outputTokens: reportedNumber(usage.output_tokens),
          cachedTokens: reportedNumber(usage.cache_read_input_tokens), cacheCreationTokens: reportedNumber(usage.cache_creation_input_tokens) } : undefined,
        costUsd: reportedNumber(data.total_cost_usd), toolCalls: reportedNumber(data.tool_calls) };
    }
    const events = output.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
    const completed = events.filter(e => e.type === 'turn.completed');
    const failure = events.find(e => e.type === 'turn.failed' || e.type === 'error');
    const sum = (key: string) => completed.length && completed.every(e => reportedNumber(e.usage?.[key]) !== undefined)
      ? completed.reduce((n, e) => n + e.usage[key], 0) : undefined;
    return { success: !failure,
      output: events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => String(e.item.text ?? '')).join('\n') || output,
      ...(failure ? { error: 'Codex runtime reported failure' } : {}),
      metering: completed.length ? { inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cachedTokens: sum('cached_input_tokens') } : undefined,
      toolCalls: events.some(e => typeof e.type === 'string') ? events.filter(e => e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'web_search'].includes(e.item?.type)).length : undefined,
    };
  } catch { return { success: true, output }; }
}
async function runNative(request: RuntimeRequest): Promise<RuntimeResult> {
  const { DualModeOrchestrator } = await import('@claude-flow/codex/dual-mode');
  const cwd = getProjectCwd();
  const orchestrator = new DualModeOrchestrator({ projectPath: cwd, maxConcurrent: 1, maxWriters: 1,
    timeout: request.input.timeoutMs ?? 300_000, worktreeIsolation: true,
    ...(request.envelope ? { parentCapabilityEnvelope: request.envelope } : {}) });
  const isControl = ['planner', 'architect', 'coordinator', 'reviewer'].includes(request.agent.agentType);
  await orchestrator.spawnWorker({ id: request.agent.agentId, role: request.agent.agentType,
    platform: request.target.runtime === 'codex' ? 'codex' : 'claude',
    prompt: `${request.systemPrompt}\n\n${request.input.prompt}`,
    ...(request.target.model ? { model: request.target.model } : {}),
    ...(request.target.reasoningEffort ? { reasoningEffort: request.target.reasoningEffort } : {}),
    worktreePath: request.executionCwd ?? cwd,
    readOnly: request.agent.executionLease?.readOnly ?? (request.agent.config.readOnly === true || isControl),
    structuredOutput: true, includeMemoryProtocol: false,
  });
  const result = orchestrator.getWorkerResult(request.agent.agentId);
  if (result?.status !== 'completed') return { ...(result?.output ? parseNativeOutput(request.target.runtime!, result.output) : {}),
    success: false, error: result?.error ?? 'Native runtime did not complete' };
  return parseNativeOutput(request.target.runtime!, result.output ?? '');
}

export async function executeGovernedAgent(options: {
  input: AgentExecuteInput; agent: AgentRecord;
  features: HeterogeneousModelsConfig; governor: AgentGovernorConfig;
  loadAgents: () => Record<string, AgentRecord>; saveAgent: (agent: AgentRecord) => void;
  callApi: (input: AnthropicCallInput) => Promise<AnthropicCallResult>;
  resolveLegacyModel: (model?: string) => string;
}): Promise<AgentExecuteResult> {
  const { input, features, governor } = options;
  let agent = options.agent;
  const cwd = getProjectCwd();
  const startedAt = Date.now();
  let reserved = false, permitId: string | undefined;
  let receiptId: string | undefined;
  const executionId = randomUUID();
  let target: ModelTarget | undefined;
  let endResult: RuntimeResult | undefined;
  let reportedUsage: RuntimeUsage | undefined;
  let recordedCost: number | undefined;
  let recordedCostKind: 'actual' | 'estimated' | undefined;
  const legacy = async () => {
    const provider = agent.provider ?? process.env.RUFLO_PROVIDER ??
      (!process.env.ANTHROPIC_API_KEY && process.env.OPENROUTER_API_KEY ? 'openrouter' :
        !process.env.ANTHROPIC_API_KEY && process.env.OLLAMA_API_KEY ? 'ollama' : 'anthropic');
    const normalized = normalizeLegacyTarget({ ...agent, provider });
    return { ...normalized, provider, model: normalized.model ?? 'sonnet', selectedBy: 'legacy' };
  };
  try {
    const authority = getExecutionPolicyContext(cwd);
    // A prior returned provider response may have outlived a policy-ledger IO failure.
    // Reconcile its durable receipt before admitting any new spend in this registry.
    for (const pendingAgent of Object.values(options.loadAgents()).filter(a => a.pendingSettlement)) {
      const pending = pendingAgent.pendingSettlement!;
      try { await settlePolicyUsage(pending.receiptId, { costUsd: pending.costUsd, tokens: pending.tokens }, pending.policyRoot); }
      catch (error) { if (!(error instanceof Error && error.message === 'usage-already-settled')) throw new Error('Pending usage accounting could not be reconciled'); }
      await withAgentRegistryLock(cwd, () => {
        const fresh = options.loadAgents()[pendingAgent.agentId];
        if (fresh?.pendingSettlement?.receiptId === pending.receiptId) options.saveAgent({ ...fresh, pendingSettlement: undefined });
      });
    }
    if (features.enabled) {
      const selected = await selectModelTarget({ config: features, role: agent.agentType, override: agent.modelOverride,
        request: { task: typeof agent.config.taskCategory === 'string' ? agent.config.taskCategory : 'unspecified',
          complexity: agent.work?.complexity, estimatedInputTokens: agent.work?.estimatedTokens,
          constraints: { maxCostUsd: agent.work?.estimatedCostUsd, reasoningEffort: agent.modelOverride?.reasoningEffort } }, legacy });
      target = selected.target; agent.policyFamily = selected.policyFamily; agent.selectionWarning = selected.warning;
    } else target = await legacy();
    target = { ...target, runtime: target.runtime ?? 'api' };
    if (target.runtime === 'api' && target.provider === 'anthropic') target.model = options.resolveLegacyModel(target.model);
    if (target.runtime === 'codex' && target.family !== 'gpt') throw new Error('Codex runtime requires a GPT family target');
    if (target.runtime === 'claude-code' && target.family !== 'claude') throw new Error('Claude Code runtime requires a Claude family target');
    const executionCwd = target.runtime === 'api' ? realpathSync(cwd)
      : realpathSync(resolve(cwd, String(agent.config.worktreePath ?? '.')));
    const budgets = readAgentBudgets(authority.projectRoot, agent.agentId, executionCwd, [authority.callerId]);
    if ((authority.envelope?.maxCostUsd !== undefined || budgets.some(b => b.enforced && b.maxCostUsd !== undefined)) && !(agent.work?.estimatedCostUsd && agent.work.estimatedCostUsd > 0)) {
      throw new Error('Budgeted execution requires a positive cost upper estimate');
    }
    if ((authority.envelope?.maxTokens !== undefined || budgets.some(b => b.enforced && b.maxTokens !== undefined)) && !(agent.work?.estimatedTokens && agent.work.estimatedTokens > 0)) {
      throw new Error('Budgeted execution requires a positive token upper estimate');
    }
    const admission = await withAgentRegistryLock(cwd, () => {
      const current = options.loadAgents(); const fresh = current[input.agentId];
      if (!fresh || fresh.status === 'terminated') throw new Error('Agent unavailable');
      if (fresh.executionId) throw new Error('Agent already executing');
      if (JSON.stringify([fresh.config, fresh.modelOverride, fresh.work]) !== JSON.stringify([agent.config, agent.modelOverride, agent.work])) {
        throw new Error('Agent configuration changed during selection; retry execution');
      }
      const busy = Object.values(current).filter(a => a.executionId);
      if (authority.envelope?.maxConcurrency !== undefined && busy.length >= authority.envelope.maxConcurrency) {
        throw new Error('Inherited execution concurrency limit reached');
      }
      if (governor.enabled) {
        const config = new ConfigFileManager().load(cwd);
        const concurrency = configuredAgentLimit((config?.agents as Record<string, unknown> | undefined)?.maxConcurrent);
        const liveRecommendation = Math.max(1, ...activeAgents(Object.values(current)).map(a =>
          a.recommendation?.spawnReason === 'manual_override' ? governor.hardMaxAgents
            : a.work ? recommendAgents(governor, a.work, concurrency).recommendedAgents : 1));
        const { swarms } = loadSwarmStore();
        const swarmLimit = Math.min(Infinity, ...Object.values(swarms).filter(s => s.agents.includes(agent.agentId)).map(s => configuredAgentLimit(s.maxAgents)));
        const limit = Math.min(governor.hardMaxAgents, concurrency, configuredAgentLimit((config?.swarm as Record<string, unknown> | undefined)?.maxAgents), swarmLimit, liveRecommendation);
        if (busy.length >= limit) throw new Error('Execution concurrency limit reached');
      }
      // Native writers may not share a cwd even if they use different agent IDs.
      if (target!.runtime !== 'api' && agent.config.readOnly !== true && !['planner', 'architect', 'coordinator', 'reviewer'].includes(agent.agentType)) {
        const path = executionCwd;
        if (busy.some(a => a.executionLease?.nativeWriter && a.executionLease.cwd === path)) {
          throw new Error('Concurrent native writers require distinct worktrees');
        }
      }
      const work = fresh.work;
      if (work?.dependsOn.some(id => !Object.values(current).some(a => (a.agentId === id || a.work?.taskId === id) && a.lastResult?.success))) throw new Error('Execution dependency pending');
      const budget = readAgentBudgets(authority.projectRoot, agent.agentId, executionCwd, [authority.callerId]);
      if (budget.some(b => b.enforced && b.utilization >= 1)) throw new Error('Budget exhausted');
      agent = { ...fresh, modelTarget: target, policyFamily: agent.policyFamily, selectionWarning: agent.selectionWarning,
        status: 'busy', taskCount: fresh.taskCount + 1, executionId,
        executionLease: { cwd: executionCwd, readOnly: agent.config.readOnly === true || ['planner', 'architect', 'coordinator', 'reviewer'].includes(agent.agentType),
          nativeWriter: target!.runtime !== 'api' && agent.config.readOnly !== true && !['planner', 'architect', 'coordinator', 'reviewer'].includes(agent.agentType) } };
      options.saveAgent(agent); reserved = true;
      return activeAgents(Object.values({ ...current, [agent.agentId]: agent }) as GovernedAgent[]).length;
    });
    const policy = await evaluatePolicyRequest({
      identity: { id: `agent:${agent.agentId}`, type: 'agent', roles: [agent.agentType], parentId: authority.callerId },
      action: { type: 'agent.execute', resource: executionCwd, tool: target.runtime,
        costUsd: agent.work?.estimatedCostUsd, tokens: agent.work?.estimatedTokens, concurrency: 1,
        network: true, destructive: false },
      context: { envelope: authority.envelope },
    }, authority.projectRoot, [authority.callerId]);
    if (policy.enforcedOutcome !== 'allowed') throw new Error(`Execution policy denied: ${policy.reason}`);
    receiptId = policy.receiptId;
    const refreshBudgetMetrics = () => {
      try {
      for (const budget of readAgentBudgets(authority.projectRoot, agent.agentId, executionCwd, [authority.callerId])) {
        getMonitor().gauge('budget_utilization', budget.utilization, { budget: budget.id });
      }
      } catch { /* monitoring does not own policy accounting */ }
    };
    refreshBudgetMetrics();
    recordExecutionEvent(cwd, { event: 'start', agentId: agent.agentId, role: agent.agentType, target,
      taskId: agent.work?.taskId, parentTaskId: agent.work?.parentTaskId, spawnReason: agent.recommendation?.spawnReason,
      startTime: new Date(startedAt).toISOString(), actualAgents: admission,
      idleTimeMs: agent.lastExecutionAt ? Math.max(0, startedAt - Date.parse(agent.lastExecutionAt)) : undefined,
      recommendedAgents: agent.recommendation?.recommendedAgents });
    const systemPrompt = input.systemPrompt || String(agent.config.instructions ?? `You are a ${agent.agentType} agent operating as part of a Ruflo swarm. Agent ID: ${agent.agentId}.`);
    const childEnvelope = target.runtime !== 'api' && authority.envelope
      ? delegateEnvelope(authority.envelope, { ...authority.envelope, maxConcurrency: 1,
        expiresAt: Math.min(authority.envelope.expiresAt ?? Infinity, Date.now() + (input.timeoutMs ?? 300_000)) }) : authority.envelope;
    const runtimeRequest: RuntimeRequest = { target, input, agent, systemPrompt, executionCwd, envelope: childEnvelope };
    if (target.runtime !== 'api') {
      const permit = await getGlobalAiBudget().reserve({ workerType: agent.agentType, model: target.model ?? 'unknown', workspace: cwd });
      if (!permit.allowed) throw new Error(`Global AI budget denied: ${permit.reason}`);
      permitId = permit.permitId;
    }
    const adapter = runtimeAdapters.get(target.runtime!);
    endResult = adapter ? await adapter(runtimeRequest)
      : target.runtime === 'api' ? await options.callApi({ ...input, systemPrompt, model: target.model,
        provider: target.provider, strictProvider: features.enabled, collectUsage: true, reasoningEffort: target.reasoningEffort })
      : ['claude-code', 'codex'].includes(target.runtime!) ? await runNative(runtimeRequest)
      : { success: false, error: `Unsupported model runtime: ${target.runtime}` };
    if (endResult.model) target.model = endResult.model;
    const metering = endResult.metering ? Object.fromEntries(Object.entries(endResult.metering)
      .map(([key, value]) => [key, reportedNumber(value)])) as RuntimeUsage : undefined;
    const actualCost = reportedNumber(endResult.costUsd);
    const cost = actualCost ?? estimateExecutionCost(target, metering);
    reportedUsage = metering; recordedCost = cost;
    recordedCostKind = cost !== undefined ? actualCost !== undefined ? 'actual' : 'estimated' : undefined;
    if (receiptId && (cost !== undefined || (metering?.inputTokens !== undefined && metering.outputTokens !== undefined))) {
      const pending = { receiptId, policyRoot: authority.projectRoot, costUsd: cost,
        tokens: metering?.inputTokens !== undefined && metering.outputTokens !== undefined ? metering.inputTokens + metering.outputTokens : undefined };
      agent.pendingSettlement = pending;
      await withAgentRegistryLock(cwd, () => {
        const fresh = options.loadAgents()[agent.agentId];
        if (fresh) options.saveAgent({ ...fresh, pendingSettlement: pending });
      });
      await settlePolicyUsage(receiptId, { costUsd: pending.costUsd, tokens: pending.tokens }, authority.projectRoot);
      agent.pendingSettlement = undefined;
      refreshBudgetMetrics();
    }
    const result: AgentExecuteResult = { success: endResult.success, agentId: agent.agentId,
      model: target.model, modelTarget: target, output: endResult.output, error: endResult.error,
      messageId: endResult.messageId, stopReason: endResult.stopReason, metering,
      ...(metering?.inputTokens !== undefined && metering.outputTokens !== undefined ? { usage: {
        inputTokens: metering.inputTokens, outputTokens: metering.outputTokens, totalTokens: metering.inputTokens + metering.outputTokens } } : {}),
      durationMs: Date.now() - startedAt, ...(cost !== undefined ? { costUsd: cost, costKind: actualCost !== undefined ? 'actual' : 'estimated' } : {}),
    };
    recordExecutionEvent(cwd, { event: 'end', agentId: agent.agentId, role: agent.agentType, target,
      taskId: agent.work?.taskId, parentTaskId: agent.work?.parentTaskId, spawnReason: agent.recommendation?.spawnReason,
      startTime: new Date(startedAt).toISOString(), endTime: new Date().toISOString(), latencyMs: result.durationMs,
      success: result.success, usage: metering, costUsd: cost, costKind: result.costKind,
      toolCalls: endResult.toolCalls,
      ...(result.success ? {} : { failure: 'runtime_failure' }) });
    agent.lastResult = result as unknown as Record<string, unknown>;
    getGlobalAiBudget().recordUsage(permitId, { workerType: agent.agentType, model: target.model ?? 'unknown',
      inputTokens: metering?.inputTokens, outputTokens: metering?.outputTokens, costUsd: cost, durationMs: result.durationMs });
    if (!result.success && isQuotaErrorText(endResult.error)) await getGlobalAiBudget().recordQuotaError('Governed runtime quota error');
    return result;
  } catch (error) {
    const result: AgentExecuteResult = { success: false, agentId: agent.agentId, modelTarget: target,
      error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt,
      ...(endResult ? { output: endResult.output, metering: reportedUsage, costUsd: recordedCost, costKind: recordedCostKind,
        accountingPending: !!agent.pendingSettlement } : {}) };
    if (reserved) agent.lastResult = result as unknown as Record<string, unknown>;
    recordExecutionEvent(cwd, { event: 'end', agentId: agent.agentId, role: agent.agentType, target,
      taskId: agent.work?.taskId, parentTaskId: agent.work?.parentTaskId,
      startTime: new Date(startedAt).toISOString(), endTime: new Date().toISOString(), latencyMs: result.durationMs,
      success: false, usage: reportedUsage, costUsd: recordedCost, costKind: recordedCostKind,
      failure: endResult ? 'accounting_failure' : 'selection_or_admission_failure' });
    if (endResult) getGlobalAiBudget().recordUsage(permitId, { workerType: agent.agentType, model: target?.model ?? 'unknown',
      inputTokens: reportedUsage?.inputTokens, outputTokens: reportedUsage?.outputTokens,
      costUsd: recordedCost, durationMs: result.durationMs });
    return result;
  } finally {
    await getGlobalAiBudget().release(permitId);
    if (reserved) await withAgentRegistryLock(cwd, () => {
      const fresh = options.loadAgents()[agent.agentId];
      if (fresh?.executionId === executionId) options.saveAgent({ ...fresh, status: fresh.status === 'terminated' ? 'terminated' : 'idle',
        executionId: undefined, executionLease: undefined, pendingSettlement: agent.pendingSettlement, modelTarget: target, lastResult: agent.lastResult, lastExecutionAt: new Date().toISOString() });
      const remaining = activeAgents(Object.values(options.loadAgents())).length;
      try { getMonitor().gauge('active_agent_count', remaining); } catch { /* best effort */ }
    });
  }
}

/** Read-only snapshot API. UI code consumes data rather than owning orchestration. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigFileManager } from './config-file-manager.js';
import { ControlPanelSchema } from './model-contract.js';
import { activeAgents, configuredAgentLimit, getGovernorConfig, readAgentBudgets } from './agent-governor.js';
import { readExecutionEvents } from './execution-telemetry.js';
import { getExecutionPolicyContext } from './policy-runtime.js';
import type { AgentRecord } from '../mcp-tools/agent-execute-core.js';

function readAgents(file: string): Record<string, AgentRecord> {
  if (!existsSync(file) || statSync(file).size > 4_000_000) return {};
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return data?.agents && typeof data.agents === 'object' ? data.agents : {};
}
export function getControlPanelSnapshot(cwd: string) {
  const config = new ConfigFileManager().load(cwd);
  if (!ControlPanelSchema.parse(config?.controlPanel ?? {}).enabled) throw new Error('Control panel is disabled; set controlPanel.enabled=true');
  const governor = getGovernorConfig(cwd);
  const authority = getExecutionPolicyContext(cwd);
  const registry = { ...readAgents(join(cwd, '.claude-flow', 'agents.json')), ...readAgents(join(cwd, '.claude-flow', 'agents', 'store.json')) };
  const agents = Object.values(registry);
  const active = activeAgents(agents);
  const events = readExecutionEvents(cwd), ends = events.filter(e => e.event === 'end');
  const total = (values: Array<number | undefined>) => values.some(v => v !== undefined) ? values.reduce<number>((n, v) => n + (v ?? 0), 0) : undefined;
  const rows = agents.map(agent => {
    const runs = ends.filter(e => e.agentId === agent.agentId);
    const last = runs.at(-1);
    const idle = agent.status === 'idle' && agent.lastExecutionAt ? Math.max(0, Date.now() - Date.parse(agent.lastExecutionAt)) : undefined;
    return { agentId: agent.agentId, role: agent.agentType, target: agent.modelTarget,
      status: agent.executionId ? agent.status === 'terminated' ? 'terminating' : 'running' : agent.status,
      taskId: agent.work?.taskId, parentTaskId: agent.work?.parentTaskId,
      currentTask: typeof agent.config?.task === 'string' ? agent.config.task : undefined,
      policyFamily: agent.policyFamily, selectionWarning: agent.selectionWarning,
      spawnReason: agent.recommendation?.spawnReason, recommendation: agent.recommendation,
      inputTokens: total(runs.map(e => e.usage?.inputTokens)), outputTokens: total(runs.map(e => e.usage?.outputTokens)),
      cachedTokens: total(runs.map(e => e.usage?.cachedTokens)), costUsd: total(runs.map(e => e.costUsd)),
      latencyMs: last?.latencyMs, agentIdleTimeMs: idle,
      usageUnknown: runs.length === 0 || runs.some(e => e.usage?.inputTokens === undefined || e.usage.outputTokens === undefined),
      costUnknown: runs.length === 0 || runs.some(e => e.costUsd === undefined),
      budget: readAgentBudgets(authority.projectRoot, agent.agentId, agent.executionLease?.cwd ?? cwd, [authority.callerId]),
    };
  });
  const recommendedAgents = events.filter(e => e.recommendedAgents !== undefined).at(-1)?.recommendedAgents ?? 1;
  return { currentTask: rows.filter(a => active.some(x => x.agentId === a.agentId)).map(a => ({ taskId: a.taskId, description: a.currentTask })),
    activeAgents: active.length, actualAgents: agents.filter(a => a.status !== 'terminated').length,
    busyAgents: agents.filter(a => a.executionId || a.status === 'busy').length,
    recommendedAgents, hardLimit: Math.min(governor.enabled ? governor.hardMaxAgents : Infinity,
      configuredAgentLimit((config?.swarm as Record<string, unknown> | undefined)?.maxAgents),
      configuredAgentLimit((config?.agents as Record<string, unknown> | undefined)?.maxConcurrent)),
    agents: rows,
    graph: agents.flatMap(a => (a.work?.dependsOn ?? []).map(parent => ({ from: parent, to: a.agentId }))),
    efficiency: {
      coordinationTokens: total(ends.filter(e => ['planner', 'architect', 'coordinator', 'reviewer'].includes(e.role)).map(e =>
        e.usage?.inputTokens !== undefined && e.usage.outputTokens !== undefined ? e.usage.inputTokens + e.usage.outputTokens : undefined)),
      implementationTokens: total(ends.filter(e => !['planner', 'architect', 'coordinator', 'reviewer'].includes(e.role)).map(e =>
        e.usage?.inputTokens !== undefined && e.usage.outputTokens !== undefined ? e.usage.inputTokens + e.usage.outputTokens : undefined)),
      handoffCount: total(events.map(e => e.handoffs)),
      duplicateWorkCount: events.filter(e => e.event === 'spawn_denied' && e.failure === 'duplicate_work').length,
      parallelSpeedupEstimate: events.filter(e => e.recommendation?.parallelSpeedupEstimate !== undefined).at(-1)?.recommendation?.parallelSpeedupEstimate,
      marginalAgentUtility: events.filter(e => e.recommendation?.marginalAgentUtility !== undefined).at(-1)?.recommendation?.marginalAgentUtility,
      utilization: active.length ? agents.filter(a => a.executionId || a.status === 'busy').length / active.length : undefined,
    },
    recentFailures: ends.filter(e => e.success === false).slice(-10).map(e => ({ agentId: e.agentId, failure: e.failure, at: e.endTime })),
    settings: { heterogeneousModels: config?.heterogeneousModels, agentGovernor: config?.agentGovernor },
    retention: 'Last 1000 operational events; totals are partial when old events expire or usage is unknown',
  };
}
const plain = (value: unknown) => String(value ?? 'unknown').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 180);
export function renderControlPanel(snapshot: ReturnType<typeof getControlPanelSnapshot>): string {
  const lines = ['RUFLO CONTROL',
    `Task: ${snapshot.currentTask.map(t => plain(t.description ?? t.taskId)).join(' | ') || 'none active'}`,
    `Recommended: ${snapshot.recommendedAgents}  Active: ${snapshot.activeAgents}  Registered: ${snapshot.actualAgents}  Busy: ${snapshot.busyAgents}  Hard limit: ${snapshot.hardLimit}`];
  for (const a of snapshot.agents) {
    lines.push(`\n${plain(a.agentId)} (${plain(a.role)})  ${plain(a.status)}  spawn: ${plain(a.spawnReason)}`,
      `Family: ${plain(a.target?.family)}  Provider: ${plain(a.target?.provider)}  Runtime: ${plain(a.target?.runtime)}`,
      `Model: ${plain(a.target?.model)}  Selector: ${plain(a.target?.selectedBy)}  Policy family: ${plain(a.policyFamily)}`,
      `Input: ${a.inputTokens ?? 'unknown'}  Output: ${a.outputTokens ?? 'unknown'}  Cached: ${a.cachedTokens ?? 'unknown'}  Cost: ${a.costUsd ?? 'unknown'} USD  Latency: ${a.latencyMs ?? 'unknown'} ms`,
      ...(a.usageUnknown || a.costUnknown ? ['Usage/cost totals are partial; some measurements are unknown.'] : []),
      `Budget: ${a.budget.map(b => `${plain(b.id)} ${Math.round(b.utilization * 100)}% (${b.enforced ? 'enforce' : 'observe/legacy'})`).join(', ') || 'unconfigured'}`);
    if (a.selectionWarning) lines.push(plain(a.selectionWarning));
  }
  lines.push('\nDependencies:', ...snapshot.graph.map(e => `${plain(e.from)} → ${plain(e.to)}`),
    `Efficiency: ${JSON.stringify(snapshot.efficiency)}`, `Recent failures: ${JSON.stringify(snapshot.recentFailures)}`, snapshot.retention);
  return lines.join('\n');
}

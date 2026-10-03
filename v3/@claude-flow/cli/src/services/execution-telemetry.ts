/** Sanitized operational events, using existing monitoring and price metadata. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMonitor } from '../production/monitoring.js';
import { MODEL_PRICES } from '../ruvector/model-prices.js';
import type { ModelTarget } from './model-contract.js';
import type { GovernorDecision } from './agent-governor.js';

export interface RuntimeUsage {
  inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number;
}
export interface ExecutionEvent {
  event: 'spawn' | 'spawn_denied' | 'start' | 'end' | 'handoff';
  agentId: string; role: string; target?: ModelTarget;
  taskId?: string; parentTaskId?: string; spawnReason?: string;
  recommendedAgents?: number; actualAgents?: number; recommendation?: GovernorDecision;
  startTime?: string; endTime?: string; latencyMs?: number;
  usage?: RuntimeUsage; costUsd?: number; costKind?: 'actual' | 'estimated';
  success?: boolean; failure?: string; toolCalls?: number; handoffs?: number;
  idleTimeMs?: number;
}
const fileFor = (cwd: string) => join(cwd, '.claude-flow', 'metrics', 'heterogeneous-executions.jsonl');
export function reportedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Known table entries only. The legacy unknown-model $1/M fallback is intentionally not used. */
export function estimateExecutionCost(target: ModelTarget, usage?: RuntimeUsage): number | undefined {
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined ||
    usage.cachedTokens || usage.cacheCreationTokens || !target.model) return undefined;
  const price = MODEL_PRICES[target.model] ?? MODEL_PRICES[`${target.provider}/${target.model}`];
  return price ? (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000 : undefined;
}
export function recordExecutionEvent(cwd: string, event: ExecutionEvent): void {
  const labels = { agentId: event.agentId, role: event.role, provider: event.target?.provider ?? 'unknown',
    family: event.target?.family ?? 'unknown', model: event.target?.model ?? 'unknown',
    runtime: event.target?.runtime ?? 'unknown', selector: event.target?.selectedBy ?? 'unknown' };
  try {
  const monitor = getMonitor();
  if (event.actualAgents !== undefined) monitor.gauge('active_agent_count', event.actualAgents);
  if (event.recommendedAgents !== undefined) monitor.gauge('recommended_agent_count', event.recommendedAgents);
  if (event.event === 'spawn_denied' && event.failure === 'duplicate_work') monitor.counter('duplicate_work_count', 1);
  if (event.handoffs !== undefined) monitor.counter('handoff_count', event.handoffs, labels);
  if (event.idleTimeMs !== undefined) monitor.histogram('agent_idle_time', event.idleTimeMs, labels);
  if (event.event === 'end') {
    monitor.counter('agent_execution_count', 1, { ...labels, success: String(event.success) });
    if (event.latencyMs !== undefined) monitor.histogram('task_duration', event.latencyMs, labels);
    if (event.usage?.inputTokens !== undefined && event.usage.outputTokens !== undefined) {
      const tokens = event.usage.inputTokens + event.usage.outputTokens;
      monitor.counter('tokens_per_agent', tokens, labels);
      const control = event.target?.family === 'claude' && ['planner', 'architect', 'coordinator', 'reviewer'].includes(event.role);
      monitor.counter(control ? 'coordination_tokens' : 'implementation_tokens', tokens, labels);
    }
    if (event.costUsd !== undefined) monitor.counter('cost_per_agent', event.costUsd, labels);
  }
  for (const budget of event.recommendation?.budget ?? []) monitor.gauge('budget_utilization', budget.utilization, { budget: budget.id });
  if (event.recommendation?.parallelSpeedupEstimate !== undefined) monitor.gauge('parallel_speedup_estimate', event.recommendation.parallelSpeedupEstimate);
  if (event.recommendation?.marginalAgentUtility !== undefined) monitor.gauge('marginal_agent_utility', event.recommendation.marginalAgentUtility);
  } catch { /* a broken monitoring backend cannot fail admitted work */ }
  // A failed metrics sink must not turn completed work into failed orchestration.
  try {
    const file = fileFor(cwd); mkdirSync(join(cwd, '.claude-flow', 'metrics'), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
    if (statSync(file).size > 2_000_000) {
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      writeFileSync(file, lines.slice(-1000).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* monitoring is best effort; policy accounting is separately enforced */ }
}
export function readExecutionEvents(cwd: string): ExecutionEvent[] {
  const file = fileFor(cwd);
  if (!existsSync(file) || statSync(file).size > 4_000_000) return [];
  const events: ExecutionEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n').slice(-1001)) {
    try { const value = JSON.parse(line); if (value && typeof value.agentId === 'string' && ['spawn', 'spawn_denied', 'start', 'end', 'handoff'].includes(value.event)) events.push(value); } catch { /* torn tail */ }
  }
  return events;
}

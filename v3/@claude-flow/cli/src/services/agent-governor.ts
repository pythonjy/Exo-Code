/** Deterministic admission over the existing agent/swarm registries and policy ledger. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigFileManager } from './config-file-manager.js';
import { AgentGovernorSchema, WorkSchema, type AgentWork, type AgentGovernorConfig } from './model-contract.js';
import { acquireLock, loadPolicyState } from './policy-runtime.js';

export interface GovernedAgent {
  agentId: string; agentType: string; status: string; taskCount?: number;
  config: Record<string, unknown>; lastResult?: Record<string, unknown>;
  work?: AgentWork; recommendation?: GovernorDecision;
  executionId?: string;
  pendingSettlement?: unknown;
}
export interface BudgetSnapshot {
  id: string; utilization: number; remainingCostUsd?: number; remainingTokens?: number;
  maxCostUsd?: number; usedCostUsd?: number; maxTokens?: number; usedTokens?: number;
  enforced: boolean;
}
export interface GovernorDecision {
  allowed: boolean; recommendedAgents: number; effectiveLimit: number; activeAgents: number;
  reason: string; spawnReason: string; duplicateAgentId?: string;
  estimatedParallelGainMs?: number; coordinationOverheadMs?: number; parallelSpeedupEstimate?: number;
  marginalAgentUtility?: number; budget: BudgetSnapshot[];
}
export function getGovernorConfig(cwd: string): AgentGovernorConfig {
  return AgentGovernorSchema.parse(new ConfigFileManager().load(cwd)?.agentGovernor ?? {});
}
export function activeAgents(agents: GovernedAgent[]): GovernedAgent[] {
  return agents.filter(a => a.executionId || (a.status !== 'terminated' && (a.status === 'busy' || !(a.taskCount && a.lastResult))));
}
export function normalizeWork(input: unknown, task?: string): AgentWork {
  const work = WorkSchema.parse(input ?? {});
  if (!work.signature && task?.trim()) work.signature = createHash('sha256').update(task.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
  work.files = [...new Set(work.files)].sort(); work.components = [...new Set(work.components)].sort();
  return work;
}
const matches = (pattern: string | undefined, value: string) => !pattern || pattern === '*' || pattern === value ||
  (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1)));
export function readAgentBudgets(cwd: string, agentId: string, resource = cwd, spendingPrincipals: readonly string[] = []): BudgetSnapshot[] {
  const state = loadPolicyState(cwd);
  const now = Date.now();
  return state.budgets.filter(b => [`agent:${agentId}`, ...spendingPrincipals].some(id => matches(b.principal, id)) &&
    matches(b.action, 'agent.execute') && matches(b.resource, resource)).map(limit => {
    const saved = state.usage.find(u => u.limitId === limit.id && now - u.windowStartedAt < limit.periodMs);
    const usd = saved?.costUsd ?? 0, tokens = saved?.tokens ?? 0;
    const ratio = (used: number, max: number | undefined) => max === undefined ? 0 : max === 0 ? 1 : used / max;
    return { id: limit.id, enforced: state.mode === 'enforce',
      utilization: Math.max(ratio(usd, limit.maxCostUsd), ratio(tokens, limit.maxTokens)),
      ...(limit.maxCostUsd !== undefined ? { remainingCostUsd: Math.max(0, limit.maxCostUsd - usd), maxCostUsd: limit.maxCostUsd, usedCostUsd: usd } : {}),
      ...(limit.maxTokens !== undefined ? { remainingTokens: Math.max(0, limit.maxTokens - tokens), maxTokens: limit.maxTokens, usedTokens: tokens } : {}),
    };
  });
}
export function estimateTaskComplexity(work: AgentWork): number {
  if (work.complexity !== undefined) return work.complexity;
  // Structural evidence only. Long prose does not justify a swarm.
  return Math.min(1, 0.15 + Math.max(0, work.components.length - 1) * 0.15 + work.dependsOn.length * 0.10);
}
/** Legacy numeric limits remain authoritative; malformed opt-in inputs fail closed. */
export function configuredAgentLimit(value: unknown, fallback = 8): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) throw new Error('Agent limits must be positive finite integers');
  return limit;
}
export function recommendAgents(config: AgentGovernorConfig, work: AgentWork, maxAgents: number): Omit<GovernorDecision, 'allowed' | 'activeAgents' | 'reason' | 'spawnReason' | 'budget'> {
  configuredAgentLimit(maxAgents);
  const complexity = estimateTaskComplexity(work);
  const benefit = work.expectedGainMs ?? 0;
  const evidencedParallelism = work.dependsOn.length === 0 && work.independentWorkstreams > 1;
  let count = 1;
  if (evidencedParallelism && complexity >= config.thresholds.mediumComplexity) {
    count = Math.min(work.independentWorkstreams, complexity >= config.thresholds.highComplexity ? 4 : 2, config.softMaxAgents, config.hardMaxAgents, maxAgents);
  }
  const coordination = work.handoffs * config.thresholds.handoffMs + work.coordinationMs;
  const overheadFor = (agents: number) => (agents - 1) * config.thresholds.startupMs + coordination;
  while (count > 1 && config.requireParallelBenefit && benefit <= overheadFor(count) * config.thresholds.minimumBenefitRatio) count--;
  const overhead = overheadFor(count);
  const effectiveLimit = Math.max(1, Math.min(config.hardMaxAgents, maxAgents, count));
  return { recommendedAgents: effectiveLimit, effectiveLimit,
    ...(work.expectedGainMs !== undefined ? { estimatedParallelGainMs: benefit, coordinationOverheadMs: overhead,
      parallelSpeedupEstimate: count > 1 && benefit > overhead ? 1 + (benefit - overhead) / Math.max(benefit, 1) : 1,
      ...(work.estimatedCostUsd && count > 1 ? { marginalAgentUtility: (benefit - overhead) / (work.estimatedCostUsd * (count - 1)) } : {}),
    } : {}),
  };
}
export function decideAgentSpawn(options: {
  config: AgentGovernorConfig; work: AgentWork; role: string; agents: GovernedAgent[];
  maxAgents: number; budget?: BudgetSnapshot[];
}): GovernorDecision {
  const { config, work, role } = options;
  const active = activeAgents(options.agents), budget = options.budget ?? [];
  const recommendation = recommendAgents(config, work, options.maxAgents);
  const spawnReason = work.spawnReason ?? (active.length ? 'parallelizable_subtask' : 'initial');
  const result: GovernorDecision = { ...recommendation, allowed: true, activeAgents: active.length,
    reason: 'admitted', spawnReason, budget };
  const deny = (reason: string) => ({ ...result, allowed: false, reason });
  if (options.agents.some(a => a.pendingSettlement)) return deny('accounting_pending');
  const duplicate = active.find(a => {
    if (a.agentType !== role || !a.work) return false;
    const sameScope = a.work.taskId === work.taskId && a.work.parentTaskId === work.parentTaskId;
    const sameAssignment = JSON.stringify(a.work.files) === JSON.stringify(work.files) && JSON.stringify(a.work.components) === JSON.stringify(work.components);
    return sameScope && sameAssignment && !!work.signature && a.work.signature === work.signature;
  });
  if (duplicate) return { ...deny('duplicate_work'), duplicateAgentId: duplicate.agentId };
  // Overlapping writers are not independent even when their descriptions differ.
  if (['coder', 'implementer', 'developer', 'tester'].includes(role) && active.some(a =>
    ['coder', 'implementer', 'developer', 'tester'].includes(a.agentType) && a.work &&
    (work.files.some(f => a.work!.files.includes(f)) || work.components.some(c => a.work!.components.includes(c))))) {
    return deny('overlapping_work');
  }
  if (work.dependsOn.some(id => !options.agents.some(a => (a.agentId === id || a.work?.taskId === id) && a.lastResult?.success === true))) {
    return deny('dependency_pending');
  }
  const enforced = budget.filter(b => b.enforced);
  if (enforced.some(b => b.utilization >= 1)) return deny('budget_exhausted');
  if (active.length && enforced.some(b => b.utilization >= config.thresholds.criticalBudgetRatio)) return deny('budget_critical');
  if (enforced.some(b =>
    (work.estimatedCostUsd !== undefined && b.remainingCostUsd !== undefined && work.estimatedCostUsd > b.remainingCostUsd) ||
    (work.estimatedTokens !== undefined && b.remainingTokens !== undefined && work.estimatedTokens > b.remainingTokens))) return deny('budget_insufficient');
  if (enforced.some(b => b.utilization >= config.thresholds.warningBudgetRatio)) {
    result.effectiveLimit = Math.min(result.effectiveLimit, 2);
    result.recommendedAgents = result.effectiveLimit;
  }
  if (spawnReason === 'manual_override') result.effectiveLimit = Math.min(config.hardMaxAgents, options.maxAgents,
    enforced.some(b => b.utilization >= config.thresholds.warningBudgetRatio) ? 2 : Infinity);
  if (active.length >= result.effectiveLimit) return { ...result, allowed: false, reason: 'agent_limit' };
  return result;
}
/** Reuse the policy runtime's process-safe ownership lock; only enabled mutations acquire it. */
export async function withAgentRegistryLock<T>(cwd: string, operation: () => Promise<T> | T): Promise<T> {
  const dir = join(cwd, '.claude-flow', 'agents'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(join(dir, 'governor.lock'));
  try { return await operation(); } finally { release(); }
}

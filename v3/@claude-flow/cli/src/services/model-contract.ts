/** Opt-in execution contracts. Provider, family, native ID and runtime are independent. */
import { z } from 'zod';

export type ModelFamily = 'claude' | 'gpt' | (string & {});
export type RuntimeKind = 'claude-code' | 'codex' | 'api' | (string & {});
export interface ModelTarget {
  runtime?: RuntimeKind;
  provider?: string;
  family?: ModelFamily;
  model?: string;
  reasoningEffort?: string;
  selectedBy?: string;
}
const label = z.string().trim().min(1).max(256);
export const ModelTargetSchema = z.object({
  runtime: label.optional(), provider: label.optional(), family: label.optional(),
  model: label.optional(), reasoningEffort: label.optional(), selectedBy: label.optional(),
}).strict();

export const DEFAULT_ROLE_FAMILIES: Record<string, string> = {
  planner: 'claude', architect: 'claude', coordinator: 'claude', reviewer: 'claude',
  coder: 'gpt', implementer: 'gpt', developer: 'gpt', tester: 'gpt',
};
export const HeterogeneousModelsSchema = z.object({
  enabled: z.boolean().default(false),
  roleFamilies: z.record(label).default({}),
  defaults: z.record(ModelTargetSchema).default({}),
  selector: z.object({
    type: z.enum(['legacy', 'static', 'jev']).default('legacy'),
    strict: z.boolean().default(false),
    fallback: z.enum(['static', 'legacy']).default('static'),
    adapter: label.optional(),
    timeoutMs: z.number().int().positive().max(60_000).default(5000),
  }).default({}),
}).strict();

export const AgentGovernorSchema = z.object({
  enabled: z.boolean().default(false),
  defaultAgents: z.literal(1).default(1),
  softMaxAgents: z.number().int().min(1).max(50).default(3),
  hardMaxAgents: z.number().int().min(1).max(50).default(5),
  requireParallelBenefit: z.boolean().default(true),
  thresholds: z.object({
    mediumComplexity: z.number().min(0).max(1).default(0.45),
    highComplexity: z.number().min(0).max(1).default(0.75),
    minimumBenefitRatio: z.number().min(1).default(1.2),
    startupMs: z.number().nonnegative().default(1500),
    handoffMs: z.number().nonnegative().default(500),
    warningBudgetRatio: z.number().min(0).max(1).default(0.75),
    criticalBudgetRatio: z.number().min(0).max(1).default(0.90),
  }).default({}),
}).strict().superRefine((v, ctx) => {
  if (v.softMaxAgents > v.hardMaxAgents) ctx.addIssue({ code: 'custom', message: 'softMaxAgents exceeds hardMaxAgents' });
  if (v.thresholds.mediumComplexity > v.thresholds.highComplexity) ctx.addIssue({ code: 'custom', message: 'mediumComplexity exceeds highComplexity' });
  if (v.thresholds.warningBudgetRatio > v.thresholds.criticalBudgetRatio) ctx.addIssue({ code: 'custom', message: 'warningBudgetRatio exceeds criticalBudgetRatio' });
});
export const ControlPanelSchema = z.object({ enabled: z.boolean().default(false) }).strict();
export type HeterogeneousModelsConfig = z.output<typeof HeterogeneousModelsSchema>;
export type AgentGovernorConfig = z.output<typeof AgentGovernorSchema>;

export const WorkSchema = z.object({
  taskId: label.optional(), parentTaskId: label.optional(),
  files: z.array(label).max(1000).default([]), components: z.array(label).max(1000).default([]),
  dependsOn: z.array(label).max(1000).default([]),
  signature: label.optional(),
  complexity: z.number().min(0).max(1).optional(),
  independentWorkstreams: z.number().int().min(1).max(50).default(1),
  expectedGainMs: z.number().finite().nonnegative().optional(),
  coordinationMs: z.number().finite().nonnegative().default(0),
  handoffs: z.number().int().nonnegative().default(0),
  contextDuplicationTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  spawnReason: z.enum(['initial', 'parallelizable_subtask', 'test_isolation', 'review_requirement', 'bottleneck', 'manual_override']).optional(),
}).strict();
export type AgentWork = z.output<typeof WorkSchema>;

/** Validate only opt-in sections; do not reinterpret existing configuration. */
export function validateModelFeatures(config: Record<string, unknown>): void {
  if (config.heterogeneousModels !== undefined) HeterogeneousModelsSchema.parse(config.heterogeneousModels);
  if (config.agentGovernor !== undefined) AgentGovernorSchema.parse(config.agentGovernor);
  if (config.controlPanel !== undefined) ControlPanelSchema.parse(config.controlPanel);
}

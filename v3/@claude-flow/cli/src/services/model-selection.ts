import { ConfigFileManager } from './config-file-manager.js';
import { DEFAULT_ROLE_FAMILIES, HeterogeneousModelsSchema, ModelTargetSchema,
  type ModelTarget, type HeterogeneousModelsConfig } from './model-contract.js';

export type { ModelTarget, ModelFamily, RuntimeKind } from './model-contract.js';
export interface ModelSelectionRequest {
  role: string;
  /** Category only by default; never the source or full prompt. */
  task: string;
  family: string;
  complexity?: number;
  estimatedInputTokens?: number;
  contextTokens?: number;
  constraints?: { maxCostUsd?: number; maxLatencyMs?: number; reasoningEffort?: string };
}
export interface ModelSelection extends ModelTarget {
  provider: string;
  model: string;
  selectedBy: string;
}
export interface ModelSelector { select(request: ModelSelectionRequest): Promise<ModelSelection>; }
export type JevAdapter = (request: Readonly<ModelSelectionRequest>) => Promise<ModelSelection>;
const adapters = new Map<string, JevAdapter>();
/** Trusted host/plugin injection. Config names an adapter; it cannot load code or invent a URL. */
export function registerJevAdapter(name: string, adapter: JevAdapter): () => void {
  if (adapters.has(name)) throw new Error(`Selector adapter already registered: ${name}`);
  adapters.set(name, adapter);
  return () => { if (adapters.get(name) === adapter) adapters.delete(name); };
}
export class JevModelSelector implements ModelSelector {
  constructor(private adapter?: JevAdapter) {}
  async select(request: ModelSelectionRequest): Promise<ModelSelection> {
    if (!this.adapter) throw new Error('Jev adapter unavailable');
    return this.adapter(Object.freeze(structuredClone(request)));
  }
}
export class LegacyModelSelector implements ModelSelector {
  constructor(private resolve: () => Promise<ModelSelection>) {}
  select(_request: ModelSelectionRequest): Promise<ModelSelection> { return this.resolve(); }
}
export class StaticModelSelector implements ModelSelector {
  constructor(private defaults: Record<string, ModelTarget>) {}
  async select(request: ModelSelectionRequest): Promise<ModelSelection> {
    const target = this.defaults[request.family];
    if (!target?.provider || !target.model) throw new Error(`No static model configured for family ${request.family}`);
    return { ...target, family: request.family, provider: target.provider, model: target.model, selectedBy: 'static' };
  }
}
export function getModelFeatures(cwd: string): HeterogeneousModelsConfig {
  return HeterogeneousModelsSchema.parse(new ConfigFileManager().load(cwd)?.heterogeneousModels ?? {});
}
export function inferFamily(model?: string, provider?: string): string | undefined {
  if (model && /^(haiku|sonnet(?:-.*)?|opus(?:-.*)?|inherit|(?:anthropic[/:])?claude-)/.test(model)) return 'claude';
  if (model && /^(?:openai[/:])?(?:gpt-|o\d)/.test(model)) return 'gpt';
  return provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'gpt' : undefined;
}
export function normalizeLegacyTarget(legacy: { model?: string; modelId?: string; provider?: string }): ModelTarget {
  return { runtime: 'api', provider: legacy.provider ?? 'anthropic',
    family: inferFamily(legacy.modelId ?? legacy.model, legacy.provider ?? 'anthropic'),
    model: legacy.modelId ?? legacy.model, selectedBy: 'legacy' };
}
export function resolveRoleFamily(role: string, config: HeterogeneousModelsConfig, override: ModelTarget = {}, legacy: ModelTarget = {}): string {
  return override.family ?? inferFamily(override.model, override.provider)
    ?? config.roleFamilies[role] ?? DEFAULT_ROLE_FAMILIES[role] ?? legacy.family ?? 'claude';
}
function selection(value: unknown, family?: string): ModelSelection {
  const target = ModelTargetSchema.parse(value);
  if (!target.provider || !target.model) throw new Error('Selector must return provider and native model ID');
  const inferred = inferFamily(target.model, target.provider);
  if (target.family && inferred && target.family !== inferred) throw new Error('Selector family contradicts its model/provider');
  const actualFamily = target.family ?? inferred;
  if (family && actualFamily && actualFamily !== family) throw new Error(`Selector returned ${actualFamily} for ${family} policy`);
  return { ...target, family: actualFamily ?? family, provider: target.provider, model: target.model, selectedBy: target.selectedBy ?? 'selector' };
}
async function boundedSelect(selector: ModelSelector, request: ModelSelectionRequest, timeoutMs: number): Promise<ModelSelection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([selector.select(request), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model selector timeout')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
/** explicit agent > role policy > existing router > default; exact IDs stay outside role logic. */
export async function selectModelTarget(options: {
  config: HeterogeneousModelsConfig; role: string; override?: ModelTarget;
  request?: Partial<Omit<ModelSelectionRequest, 'role' | 'family'>>;
  legacy: () => Promise<ModelSelection>;
}): Promise<{ target: ModelTarget; policyFamily: string; warning?: string }> {
  const { config, role } = options;
  const override = ModelTargetSchema.parse(options.override ?? {});
  const family = resolveRoleFamily(role, config, override);
  const request: ModelSelectionRequest = { ...options.request, task: options.request?.task ?? 'unspecified', role, family };
  const staticSelector = new StaticModelSelector(config.defaults);
  const legacySelector = new LegacyModelSelector(options.legacy);
  // Exact manual selection does not call Jev. Provider-only overrides still constrain its result.
  if (override.model) {
    return { target: selection({ ...config.defaults[family], ...override, family,
      provider: override.provider ?? config.defaults[family]?.provider ?? (family === 'gpt' ? 'openai' : 'anthropic'),
      runtime: override.runtime ?? config.defaults[family]?.runtime ?? 'api', selectedBy: 'manual' }, family), policyFamily: family };
  }
  const selector = config.selector.type === 'jev'
    ? new JevModelSelector(adapters.get(config.selector.adapter ?? 'jev'))
    : config.selector.type === 'static' ? staticSelector : legacySelector;
  try {
    let chosen = selection(await boundedSelect(selector, request, config.selector.timeoutMs),
      config.selector.type === 'legacy' ? undefined : family);
    if (config.selector.type === 'legacy' && chosen.family !== family) {
      try { chosen = selection(await staticSelector.select(request), family); } catch { /* existing routing is the final fallback */ }
    }
    if (chosen.family !== family && config.selector.strict) throw new Error('Existing routing cannot satisfy requested model family');
    if (override.provider && chosen.provider !== override.provider) throw new Error('Selector conflicts with explicit provider');
    if (override.family && chosen.family && override.family !== chosen.family) throw new Error('Selector conflicts with explicit family');
    return { target: { ...chosen, ...override, runtime: override.runtime ?? chosen.runtime ?? config.defaults[chosen.family ?? family]?.runtime ?? 'api' }, policyFamily: family,
      ...(chosen.family !== family ? { warning: 'Existing routing retained a different family; configure a static family default or selector' } : {}) };
  } catch (error) {
    if (config.selector.strict) throw error;
    const warning = `Selector unavailable or rejected; configured fallback used (${config.selector.type})`;
    let chosen: ModelSelection;
    try {
      if (config.selector.fallback !== 'static') throw new Error('legacy fallback configured');
      chosen = selection(await staticSelector.select(request), family);
    } catch { chosen = selection(await legacySelector.select(request)); }
    if (override.provider && chosen.provider !== override.provider) {
      throw new Error('No fallback satisfies the explicit provider; configure a static family default');
    }
    // Keep the actual fallback family truthful when existing routing uses a different family.
    const fallbackOverride = { ...override };
    delete fallbackOverride.family;
    if (override.family && chosen.family && override.family !== chosen.family) {
      throw new Error('No fallback satisfies the explicit family; configure a static family default');
    }
    return { target: { ...chosen, ...fallbackOverride, runtime: override.runtime ?? chosen.runtime ?? 'api' }, policyFamily: family, warning };
  }
}

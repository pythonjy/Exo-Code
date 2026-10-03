/**
 * V3 CLI Type Definitions — re-export shim (ADR-100, alpha.5).
 *
 * Authoritative source: @claude-flow/cli-core/types. Was a byte-identical
 * 287-line copy until alpha.5 published the cli-core subpath. The 60+
 * `import './types.js'` call sites inside cli keep working unchanged
 * because the file path is preserved.
 *
 * To extend the type system, edit v3/@claude-flow/cli-core/src/types.ts
 * — changes flow through here automatically.
 */

export * from '@claude-flow/cli-core/types';
import type { V3Config as CoreV3Config } from '@claude-flow/cli-core/types';
/** Package-owned opt-in extensions; the installed legacy cli-core contract stays compatible. */
export interface V3Config extends CoreV3Config {
  heterogeneousModels?: Record<string, unknown>;
  agentGovernor?: Record<string, unknown>;
  controlPanel?: Record<string, unknown>;
}

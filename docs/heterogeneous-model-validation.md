# Heterogeneous orchestration validation

Validated against checkout `fe2884060f60110f8ccbcb93b442f67b585887d6`, with
Node 24.19.0 and npm 11.9.0. Current checkout and call relationships, rather
than upstream marketing documentation, determined the integration points.

## Results

| Check | Result |
| --- | --- |
| CLI build (`npm run build` in CLI package) | PASS |
| CLI typecheck (`npx tsc -p tsconfig.json --noEmit`) | PASS |
| Security/shared/swarm/Codex dependency build | PASS |
| CLI ESLint with the checked-in CLI rules | PASS |
| Additional modified security/Codex/console files, parser and safety rules | PASS |
| New CLI routing/Governor/runtime/CLI/control tests | 40 PASS |
| Existing CLI regression tests | 146 PASS |
| Security policy/ledger/settlement tests | 29 PASS |
| Existing Codex worker/stdin tests | 33 PASS |
| Console pure/graph/layout/new model-view tests | 39 PASS |
| `git diff --check` | PASS |
| Root all-V3 `npm run build` | FAIL: 429 pre-existing diagnostics |
| Console engine typecheck | BLOCKED: generated Claude Code type libraries absent |

Total: **287 passing tests**, including **46 added tests**. No paid API call
or external Claude/Codex worker was invoked. The native and built CLI tests
spawn actual local executable fixtures, exercise stdout/argv/stdin EOF,
perform fixture file changes, then inspect persisted telemetry and the panel.

The root compiler includes every V3 package, examples, benchmarks and generated
declarations, including components outside this change. To distinguish
regressions, a TypeScript CompilerHost supplied each changed tracked file's
`git show HEAD:<path>` content, excluded new files, and used the same current
dependencies/configuration. Diagnostic `(path, code, message)` multisets were
compared: **current 429, baseline 429, added 0, removed 0**. Examples include
unbuilt deployment/hooks packages, claims type re-exports, legacy benchmark
global declarations and unrelated plugin WebAssembly types. No changed
feature module introduced a root diagnostic.

The existing console tsconfig requires `claude-code`, `claude-code-tools`
and `claude-code-mcp` declarations generated when Claude Code loads/validates
the plugin. They are absent here. Its pure tests and the new real view-tree
smoke test pass; the engine-hosted `claude-code/testing` suite was not run.
No generated engine types or new frontend dependencies were fabricated.

## Commands executed

From repository root, install used the checked-in package-lock, without
lifecycle scripts:

```bash
npm ci --ignore-scripts --omit=optional --legacy-peer-deps
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps @rolldown/binding-linux-x64-gnu @rollup/rollup-linux-x64-gnu @esbuild/linux-x64 nostr-tools @typescript-eslint/parser
npx tsc -b v3/@claude-flow/security v3/@claude-flow/shared v3/@claude-flow/swarm v3/@claude-flow/codex
npm run build
git diff --check
```

The no-save install supplied native test-runner binaries and an existing
optional import/type dependency; **no dependency or lockfile change is
included**. CLI scripts are authoritative for the executable CLI build.
The root `build:ts` and `lint` wrapper scripts suppress failures with
`|| true`, and CLI has no lint script, so checks used direct commands instead.

From `v3/@claude-flow/cli`:

```bash
npm run build
npx tsc -p tsconfig.json --noEmit
npx vitest run __tests__/heterogeneous-models.test.ts
npx vitest run __tests__/agent-execute-models.test.ts __tests__/agent-provider-model-propagation.test.ts __tests__/agent-config-instructions-3149.test.ts __tests__/config-adapter.test.ts __tests__/config-adapter-deep.test.ts __tests__/config-loading.test.ts __tests__/config-malformed-preservation.test.ts __tests__/config-prototype-safety.test.ts __tests__/task-agent-ownership.test.ts __tests__/task-create-assignment-parity.test.ts __tests__/validate-input-agent-spawn.test.ts __tests__/policy-runtime.test.ts __tests__/services/global-ai-budget.test.ts __tests__/agent-logs-hive-resolution.test.ts __tests__/swarm-status-id-and-stop.test.ts
npx eslint src/services/model-contract.ts src/services/model-selection.ts src/services/agent-governor.ts src/services/heterogeneous-execution.ts src/services/execution-telemetry.ts src/services/control-panel.ts src/services/config-file-manager.ts src/services/policy-runtime.ts src/mcp-tools/agent-tools.ts src/mcp-tools/agent-execute-core.ts src/mcp-tools/hive-mind-tools.ts src/mcp-tools/task-tools.ts src/commands/agent.ts src/config-adapter.ts src/types.ts __tests__/heterogeneous-models.test.ts --parser @typescript-eslint/parser --parser-options '{"ecmaVersion":2022,"sourceType":"module"}'
```

From `v3/@claude-flow/security`:

```bash
npx vitest run __tests__/agentic-policy-engine.test.ts __tests__/policy-ledger-anchor.test.ts __tests__/policy-usage-settlement.test.ts
```

From `v3/@claude-flow/codex`:

```bash
npx vitest run tests/dual-mode.test.ts tests/dual-mode-stdin-2947.test.ts
```

From repository root:

```bash
npx vitest run plugins/ruflo-console/tests/pure.spec.ts plugins/ruflo-console/tests/logic.spec.ts plugins/ruflo-console/tests/band.spec.ts plugins/ruflo-console/tests/diagrams.spec.ts plugins/ruflo-console/tests/catalog.spec.ts plugins/ruflo-console/tests/heterogeneous.spec.ts
npx eslint v3/@claude-flow/codex/src/dual-mode/orchestrator.ts v3/@claude-flow/security/src/policy/engine.ts v3/@claude-flow/security/__tests__/policy-usage-settlement.test.ts plugins/ruflo-console/hooks/data/parse.ts plugins/ruflo-console/hooks/views/agent.ts plugins/ruflo-console/hooks/views/swarm.ts --no-eslintrc --parser @typescript-eslint/parser --parser-options '{"ecmaVersion":2022,"sourceType":"module"}' --rule 'no-eval:error' --rule 'no-implied-eval:error' --rule 'no-new-func:error' --rule 'no-dupe-args:error'
npx tsc -p plugins/ruflo-console/tsconfig.json
```

## Change inventory

Paths below `v3/@claude-flow/cli/`:

| File | Purpose and significant change |
| --- | --- |
| `src/services/model-contract.ts` | Optional independent target fields; Zod opt-in config/work schemas and standard role families |
| `src/services/model-selection.ts` | Stable selector contract, legacy/static/injected Jev selectors, timeout/fallback/strict, manual precedence and truthful family validation |
| `src/services/agent-governor.ts` | Benefit/overhead recommendations, existing-limit intersection, duplicate/ownership/dependency suppression, budget snapshots and registry locking |
| `src/services/heterogeneous-execution.ts` | Admission, immutable lease, inherited authority, API/native dispatch, usage settlement/reconciliation and result preservation |
| `src/services/execution-telemetry.ts` | Sanitized operational events, existing monitoring sink, known-price-only estimates and truthful optional metrics |
| `src/services/control-panel.ts` | Decoupled read-only registry/event snapshot and terminal rendering, unknown/partial totals |
| `src/services/config-file-manager.ts` | Atomic validation of only the new configuration sections |
| `src/services/policy-runtime.ts` | Trusted usage settlement and verified caller/common-root execution context |
| `src/mcp-tools/agent-execute-core.ts` | Shared enabled routing chokepoint; existing OpenAI-compatible helper extended to OpenAI; opt-in reported metering |
| `src/mcp-tools/agent-tools.ts` | Target/work MCP schema, governed spawn/pool/lifecycle, control snapshot tool, CLI ID alias only when enabled |
| `src/mcp-tools/hive-mind-tools.ts` | Enabled hive spawn and shutdown use canonical governed lifecycle |
| `src/mcp-tools/task-tools.ts` | Enabled locked agent synchronization, task IDs and observed reassignment handoffs |
| `src/commands/agent.ts` | Native target/work flags, tracked execution and read-only control commands; denial exits correctly |
| `src/config-adapter.ts` | Preserve opt-in sections through existing config conversions |
| `src/types.ts` | Backward-compatible optional config extension of existing shared types |
| `package.json` | Public selector/runtime/panel subpath exports; dependencies unchanged |
| `__tests__/heterogeneous-models.test.ts` | Family/manual/legacy/Jev/failure/budget/concurrency/telemetry/hive/CLI/native contracts and integration |

Other paths:

| File | Purpose and significant change |
| --- | --- |
| `v3/@claude-flow/codex/src/dual-mode/orchestrator.ts` | Optional JSON/effort flags, inherited envelope validation, result access, failed stdout preservation and timeout cleanup |
| `v3/@claude-flow/security/src/policy/engine.ts` | Host-only actual overrun settlement; inherited spending scope; reserved metadata cannot spoof receipts |
| `v3/@claude-flow/security/__tests__/policy-usage-settlement.test.ts` | Ledger integrity, overrun, conservative reservation, parent scope and forged metadata regressions |
| `plugins/ruflo-console/hooks/data/parse.ts` | Safely read optional target/usage/recommendation fields; preserve legacy parsing |
| `plugins/ruflo-console/hooks/views/agent.ts` | Display actual model/runtime/selector/spawn/usage/latency/failure |
| `plugins/ruflo-console/hooks/views/swarm.ts` | Display recommendations/active count alongside the existing agent graph |
| `plugins/ruflo-console/tests/heterogeneous.spec.ts` | Render actual extended agent view with a pure element fixture |
| `docs/heterogeneous-model-orchestration.md` | Architecture, policy, configuration, Jev injection, escalation, budgets, telemetry and compatibility |
| `docs/heterogeneous-model-validation.md` | Executed checks, baseline comparison, limitations and per-file inventory |

# Heterogeneous model orchestration

This is an opt-in extension of the checked-out Ruflo V3 CLI, not a replacement
orchestrator. All three new configuration sections default to disabled.

Ruflo determines **who** should work. Role policy determines **which model
family** should work. A selector such as Jev determines **which exact model**
should work. The provider/runtime executes the task. Governor determines
**how many agents** should work. Observability measures **whether that choice
was efficient**.

## Source architecture and decisions

The executable path is `bin/cli.js` → V3 CLI → `mcp-client.ts` → registered
`mcp-tools/agent-tools.ts` handlers. `agent_spawn` creates a persistent
coordination record, a memory branch when requested, and swarm membership.
It does not itself run an LLM. Both `agent_execute` and workflow execution
use `mcp-tools/agent-execute-core.ts::executeAgentTask`.

Before this extension, that core dispatched Anthropic/OpenRouter/Ollama
through existing fetch helpers; aliases and router-selected native IDs were
stored on the agent. The separate `@claude-flow/providers` package already
has Anthropic/OpenAI provider abstractions, but is not called by this CLI
execution path. Adding direct OpenAI support to the existing compatibility
helper avoids replacing its credential, timeout and response handling.

Native execution reuses `@claude-flow/codex/dual-mode` worker lifecycle,
argument construction, stdin EOF, bounded output, timeout and capability
envelopes. It calls `spawnWorker`, rather than `runCollaboration`, whose
existing memory/policy helpers invoke the separately installed `ruflo@latest`.
Enabled execution authorizes and settles against **this checkout's** policy
runtime and registry instead. Optional native memory prompt injection is
disabled on this path; Ruflo task state, swarm membership and COW memory
remain managed by the existing lifecycle tools.

Existing extensions retained:

| Capability | Source |
| --- | --- |
| Alias/neural/provider routing | CLI `ruvector/model-router.ts`, `enhanced-model-router.ts`, `neural-router.ts` and `agent-tools.ts` |
| Swarm registry, maxAgents, adaptive eligibility | CLI `mcp-tools/swarm-tools.ts`; swarm package `unified-coordinator.ts` |
| Task assignment, ownership, dependencies | CLI `mcp-tools/task-tools.ts`, `workflow-tools.ts` |
| Memory and COW branches | CLI memory services and `agent_spawn`/`agent_terminate` |
| Metrics sink | CLI `production/monitoring.ts` |
| Price metadata | CLI `ruvector/model-prices.ts` |
| Atomic budget/receipt authority | CLI `services/policy-runtime.ts`; security `policy/engine.ts` |
| Native launch concurrency/quota fuse | CLI `services/global-ai-budget.ts` |
| Configuration/commands | CLI `services/config-file-manager.ts`, `config-adapter.ts`, `commands/config.ts` |
| Existing console | `plugins/ruflo-console/hooks/data/parse.ts`, `views/agent.ts`, `views/swarm.ts` |

The new path is:

```text
Task → role → Governor admission → family policy → ModelSelector
     → provider/runtime → persistent agent execution → telemetry → control panel
```

Admission is checked at spawn and again at execution. Task assignment's
`busy` status is distinct from an execution lease. The shared lease prevents
two simultaneous calls to one agent even after a status update. Native
writers must use distinct physical worktrees; configured paths are resolved
through symlinks. Configuration cannot change while a lease is active.

## Configuration

Use the existing `claude-flow.config.json`, `.claude-flow/config.json`, or
`CLAUDE_FLOW_CONFIG` configuration path. New sections are validated with the
existing Zod dependency; invalid updates/imports do not overwrite a valid
file. Existing configuration adapters preserve the sections in both directions.

This example has placeholders: replace the two native model identifiers
with models available in your installation. Ruflo supplies no new fixed
GPT or Claude model ID in role policy or Governor logic.

```json
{
  "heterogeneousModels": {
    "enabled": true,
    "roleFamilies": {
      "planner": "claude", "architect": "claude",
      "coordinator": "claude", "reviewer": "claude",
      "coder": "gpt", "implementer": "gpt",
      "developer": "gpt", "tester": "gpt"
    },
    "defaults": {
      "claude": {
        "provider": "anthropic", "runtime": "claude-code",
        "model": "<your-claude-model-id>"
      },
      "gpt": {
        "provider": "openai", "runtime": "codex",
        "model": "<your-gpt-model-id>"
      }
    },
    "selector": {
      "type": "jev", "adapter": "jev",
      "fallback": "static", "strict": false, "timeoutMs": 5000
    }
  },
  "agentGovernor": {
    "enabled": true, "defaultAgents": 1,
    "softMaxAgents": 3, "hardMaxAgents": 5,
    "requireParallelBenefit": true,
    "thresholds": {
      "mediumComplexity": 0.45, "highComplexity": 0.75,
      "minimumBenefitRatio": 1.2, "startupMs": 1500,
      "handoffMs": 500, "warningBudgetRatio": 0.75,
      "criticalBudgetRatio": 0.90
    }
  },
  "controlPanel": { "enabled": true }
}
```

Use `runtime: "api"` for direct provider calls. OpenAI reads
`OPENAI_API_KEY`/`OPENAI_BASE_URL` or an enabled `openai` entry in existing `agents.providers`;
Anthropic/OpenRouter/Ollama retain their current environment/config handling.
Keep keys out of examples and committed configuration. Native binaries must
be installed and authenticated using their existing local mechanisms.
The reused worker environment intentionally does not forward arbitrary secrets.

CLI configuration and execution:

```bash
node bin/cli.js config set heterogeneousModels.enabled true
node bin/cli.js config set agentGovernor.enabled true
node bin/cli.js config set controlPanel.enabled true
node bin/cli.js agent spawn --type planner --name plan-1 --task "Plan the change"
node bin/cli.js agent execute plan-1 --prompt "Design the implementation"
node bin/cli.js agent control
node bin/cli.js agent control --format json
```

`agent spawn` also accepts `--family`, `--provider`, `--model`, `--runtime`
and `--reasoning-effort`. Rich assignments/estimates use `--work '<JSON>'`
or the existing MCP `agent_spawn` tool's new `work` object (`config.work`
is also accepted).

## Model contract, policy and selectors

`ModelTarget` separates optional runtime, provider, family, native model ID,
reasoning effort and selectedBy. Existing `model`, `modelId` and provider
hints normalize into this contract; `sonnet`, `opus`, `haiku`, `inherit`
and prior pinned aliases retain their existing API resolution.

Precedence: **explicit per-agent override > role family policy > existing
Ruflo routing > default**. The standard control roles use Claude; coder,
implementer, developer and tester use GPT. `roleFamilies` can override tester
or any custom role. An explicit model/provider can override the role family;
contradictory explicit families are rejected. Runtime and provider remain
separate concepts; gateway providers can serve different model families.

`ModelSelector.select(ModelSelectionRequest)` returns provider, model,
selectedBy and optional runtime/reasoning effort. Available implementations:

- `LegacyModelSelector`: existing router/alias target.
- `StaticModelSelector`: configured family defaults.
- `JevModelSelector`: a named, trusted injected callback.

No Jev API, endpoint, authentication scheme or SDK was found in this source.
A host/plugin can inject the **real** integration in the same process:

```ts
import { registerJevAdapter, type ModelSelector } from '@claude-flow/cli/model-selection';

// suppliedJevSelector implements the real, externally documented Jev contract.
export function installJev(suppliedJevSelector: ModelSelector) {
  return registerJevAdapter('jev', request => suppliedJevSelector.select(request));
}
```

The returned function unregisters the adapter. Configuration names an already
registered callback; it cannot load arbitrary code or initiate guessed HTTP
requests. A separate CLI process needs its own trusted host bootstrap.
`@claude-flow/cli/model-runtime` similarly exposes `registerModelRuntime`
for additional trusted runtimes; adapters receive the inherited envelope
and admitted physical cwd, and must honor that authority.

Default Jev requests contain only role, family, task category (`unspecified`
unless `config.taskCategory` is supplied), complexity, token estimate and
constraints. They contain no prompt, source code, assigned file names,
secrets or unrestricted metadata. The request is copied before injection.

Unavailable, failing, invalid or timed-out selectors use the configured
static fallback, then existing routing if no usable static target exists.
Strict mode surfaces the error. Manual exact selection skips Jev.
Fallback never silently violates an explicit family/provider constraint.
If only legacy routing is available, a GPT role can fall back to a Claude
model: telemetry records the **actual** family plus requested `policyFamily`
and a warning. Configure both family defaults (or strict mode) when family
execution must be guaranteed without Jev.

## Governor, escalation and duplicate suppression

Spawn starts with one agent. Extra agents need independent workstreams,
adequate complexity and expected benefit exceeding startup/handoff/coordination
overhead by `minimumBenefitRatio`. Medium work recommends at most two;
high complexity at most four, additionally bounded by the soft limit.
Long task descriptions alone do not justify parallelism. There is no
automatic fan-out or duplicate model voting.

Supply measurable estimates for escalation, for example:

```json
{
  "agentType": "tester",
  "task": "Test the completed component independently",
  "work": {
    "taskId": "tests", "parentTaskId": "feature",
    "files": ["tests/auth.test.ts"], "components": ["auth-tests"],
    "complexity": 0.6, "independentWorkstreams": 2,
    "expectedGainMs": 12000, "coordinationMs": 1000,
    "estimatedTokens": 8000, "estimatedCostUsd": 0.20,
    "spawnReason": "test_isolation"
  }
}
```

Effective admission intersects the recommendation, Governor hard limit,
existing configuration `swarm.maxAgents`/`agents.maxConcurrent`, selected
swarm's maxAgents, remaining budget and inherited concurrency authority.
Pool scaling and enabled hive spawning use the same admission. Manual
escalation can exceed the recommendation/soft limit but cannot exceed hard
limits or budget authority. Spawn reasons include initial,
parallelizable_subtask, test_isolation, review_requirement, bottleneck and
manual_override. Recommendations are bounds, not an automatic optimizer
that launches agents when progress stalls.

Duplicates compare active task/parent scope, role, sorted assignments
and a normalized task-text hash (or explicit signature). Overlapping
implementation file/component ownership is denied. Dependencies must already
have successful results. No semantic similarity service is introduced.
Registry admissions and enabled lifecycle mutations reuse process-safe
policy locking. Completed agents release active slots; retained records
remain available for monitoring. Hive shutdown terminates canonical workers.

## Budget authority and security

Governor reads the existing policy budget ledger. Warning utilization caps
parallelism at two; critical utilization blocks optional spawns; exhaustion
blocks new execution. Already running essential work is not retroactively
cancelled, and existing policy denial still prevents side effects.

Example using existing policy commands (configure your normal allow rules
before enabling enforcement):

```bash
node bin/cli.js policy budget set '{"id":"agent-day","action":"agent.execute","maxCostUsd":10,"periodMs":86400000}'
```

Policy `legacy`/`observe` budget rules remain nonblocking; `enforce` is the
existing hard-stop authority. A metered enforced budget or inherited spending
cap requires **positive upper estimates** in `work`. Zero/missing estimates
cannot bypass it. Reservations and actual overrun settlement use the same
atomic, hashed policy ledger. Verified caller-principal budgets also apply
to child executions and are charged once per matching limit.

Settlement is a trusted host operation, not an exposed MCP command. It
charges observed excess even beyond a ceiling, preventing later spend, and
does not refund a reservation when usage is smaller or unknown. Caller
metadata cannot forge settlement receipts or additional spending principals.
If settlement IO fails after a provider response, output and usage remain
available with `accountingPending`; a durable pending receipt blocks spend
until reconciliation succeeds. These are conservative local controls, not
a replacement for provider-side billing limits or proof that an estimate is
an accurate upper bound.

Native launch also retains Ruflo's global AI launch/quota fuse, whose default
concurrency is one. Raising Governor limits does not bypass that fuse.
Inherited envelopes, expiry, spend and concurrency apply independently of
Governor. Claude control workers expose read-only built-in tools and disable
MCP tools; Codex uses the existing read-only/workspace-write sandbox. Child
permissions are never widened. Registry termination preserves an active
lease until its runtime finishes; it is not an API cancellation mechanism.

## Telemetry and control panel

`agent control`, MCP `agent_control_panel` and the exported
`@claude-flow/cli/control-panel` snapshot API are read-only and consume the
registry/event layer. Existing console agent/swarm views display the new
model and Governor data. No UI framework dependency is added. Change
settings through existing config/policy commands, then refresh monitoring.

Snapshots show current tasks, recommended/active/registered/busy counts,
effective hard limit, dependency graph, role, provider, actual family/model,
runtime, selector, spawn reason, input/output/cache tokens, cost, latest
latency, idle time, budget utilization and recent sanitized failures.

The existing monitor receives active_agent_count, recommended_agent_count,
tokens_per_agent, cost_per_agent, coordination_tokens, implementation_tokens,
handoff_count, agent_idle_time, duplicate_work_count, task_duration,
parallel_speedup_estimate, budget_utilization and marginal_agent_utility.

Semantics and limits:

- Input tokens include cache reads/creation; cached tokens are a subset and
  are not added a second time. API/Claude JSON/Codex JSONL reported usage is
  captured on success and on native failure when stdout includes usage.
- Cost is provider-reported actual cost, otherwise an estimate from a **known**
  existing price-table entry. Cached usage without cache rates, unknown models
  and absent provider usage remain unknown. No zero or price is fabricated.
- Coordination tokens cover planner/architect/coordinator/reviewer runs;
  implementation tokens cover remaining roles. This is role attribution,
  not a measurement of every internal reasoning or synchronization token.
- Handoffs count observed Ruflo task reassignments, not planned handoffs or
  unreported runtime-internal delegation. Tool calls count reported native
  events; unsupported reporting stays unknown.
- Idle time is elapsed time since the previous execution. Utilization is
  busy slots divided by currently active slots, not CPU utilization.
- Speedup is a deterministic forecast from supplied benefit/overhead, not a
  measured serial-vs-parallel benchmark. Marginal utility is estimated saved
  milliseconds per additional estimated dollar and is omitted without cost.
- Duplicate work counts denied exact duplicate admissions, not all semantic
  duplication. `contextDuplicationTokens` is descriptive input in this first
  heuristic; actual overhead should be supplied in `coordinationMs`.
- Sanitized `.claude-flow/metrics/heterogeneous-executions.jsonl` events never
  include prompts, source, raw failures or keys. Snapshots read at most the
  last 1000 events; expired/unknown measurements make totals partial. Policy
  accounting is separate, durable and enforced even if telemetry fails.

## Compatibility and validation

With flags absent/disabled, existing roles, alias routing, provider inference,
swarm defaults, execution retries and registry results retain their previous
behavior. No new limits apply to legacy users. The native structured-output
and reasoning flags apply only when requested; old dual-mode workers keep
their existing text output. The existing provider/router is not removed.

Relevant checks are recorded in [heterogeneous-model-validation.md](heterogeneous-model-validation.md).
Real paid provider calls are optional and require credentials; contract tests
and actual fixture child processes cover the integration without them.

Native wire flags/output were checked against the official
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex noninteractive reference](https://developers.openai.com/codex/noninteractive)
and [Codex configuration reference](https://developers.openai.com/codex/config-reference).
Reasoning levels are runtime/model-specific strings; unsupported values are
surfaced by that runtime rather than translated to invented equivalents.

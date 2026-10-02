import { describe, expect, it } from 'vitest';
import { AgenticPolicyEngine, type PolicyRequest } from '../src/policy/index.js';

const execution = (costUsd = 0.1, tokens = 10): PolicyRequest => ({
  identity: { id: 'agent:coder', type: 'agent', parentId: 'agent:controller' },
  action: { type: 'agent.execute', costUsd, tokens },
});
const engine = () => new AgenticPolicyEngine({ mode: 'enforce',
  rules: [{ id: 'allow', effect: 'allow', actions: ['*'] }],
  budgets: [{ id: 'all', maxCostUsd: 1, maxTokens: 100, periodMs: 60_000 },
    { id: 'parent', principal: 'agent:controller', maxCostUsd: 1, periodMs: 60_000 }],
});

describe('trusted usage settlement', () => {
  it('charges an overrun once to each inherited budget and retains a verifiable receipt chain', () => {
    const policy = engine(); const receipt = policy.evaluate(execution(), ['agent:controller']).receiptId!;
    policy.settleUsage(receipt, { costUsd: 1.2, tokens: 120 });
    expect(policy.exportState().usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ limitId: 'all', costUsd: 1.2, tokens: 120 }),
      expect.objectContaining({ limitId: 'parent', costUsd: 1.2 }),
    ]));
    expect(policy.verifyLedger().valid).toBe(true);
    expect(policy.evaluate(execution()).enforcedOutcome).toBe('denied');
    expect(() => policy.settleUsage(receipt, { costUsd: 1.2 })).toThrow('usage-already-settled');
  });
  it('does not refund reservations when reported or unknown usage is smaller', () => {
    const policy = engine(); const receipt = policy.evaluate(execution(0.5, 50)).receiptId!;
    policy.settleUsage(receipt, { costUsd: 0.2 });
    expect(policy.exportState().usage[0]).toMatchObject({ costUsd: 0.5, tokens: 50 });
  });
  it('caller-authored settlement and parent-budget metadata cannot forge host receipts', () => {
    const policy = engine(); const receipt = policy.evaluate({ ...execution(), context: { metadata: { settlementFor: 'forged' } } }).receiptId!;
    policy.evaluate({ ...execution(0, 0), context: { metadata: { settlementFor: receipt, spendingPrincipals: ['agent:controller'] } } });
    policy.settleUsage(receipt, { costUsd: 1.2 });
    expect(policy.exportState().usage[0].costUsd).toBeCloseTo(1.2);
    expect(policy.exportState().usage.some(u => u.limitId === 'parent')).toBe(false);
    expect(policy.verifyLedger().valid).toBe(true);
  });
  it('inherited principal scope survives serialized engine reload and settlement', () => {
    const policy = engine(); const receipt = policy.evaluate(execution(), ['agent:controller']).receiptId!;
    const reloaded = AgenticPolicyEngine.fromState(policy.exportState());
    reloaded.settleUsage(receipt, { costUsd: 0.9 });
    expect(reloaded.exportState().usage.find(u => u.limitId === 'parent')?.costUsd).toBeCloseTo(0.9);
  });
  it('rejects denied, nonexistent, settlement, invalid-usage and tampered receipts', () => {
    const policy = engine(); const denied = policy.evaluate(execution(2)).receiptId!;
    expect(() => policy.settleUsage(denied, { costUsd: 2 })).toThrow('authorized-receipt');
    expect(() => policy.settleUsage('missing', {})).toThrow('authorized-receipt');
    const receipt = policy.evaluate(execution()).receiptId!;
    expect(() => policy.settleUsage(receipt, { tokens: NaN })).toThrow('invalid-settlement-usage');
    policy.settleUsage(receipt, {});
    const settlement = policy.exportState().receipts.at(-1)!.payload.receiptId;
    expect(() => policy.settleUsage(settlement, {})).toThrow('cannot-settle-a-settlement');
    const state = policy.exportState(); state.receipts[0].payload.request.action.costUsd = 0;
    expect(() => AgenticPolicyEngine.fromState(state).settleUsage(receipt, {})).toThrow('invalid-settlement-ledger');
  });
});

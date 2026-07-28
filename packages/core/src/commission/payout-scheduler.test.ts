/**
 * payout-scheduler.ts 单元测试（Phase 3 打款调度器）。
 */
import { describe, expect, it } from 'vitest';
import { CommissionEngine } from './engine.js';
import { ManualPayoutProvider, PayoutService } from './payouts.js';
import { runScheduledPayouts } from './payout-scheduler.js';
import { ReferralService } from './referrals.js';
import { InMemoryCommissionStorage } from './storage-memory.js';
import type { CommissionRuleRow, PayoutProvider } from './types.js';

/** 冻结期 30 天后的时刻（规则 holdPeriodDays=30，此时佣金已解冻可结算） */
const AFTER_HOLD = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

function setup(provider?: PayoutProvider) {
  const storage = new InMemoryCommissionStorage();
  const referrals = new ReferralService({ storage });
  const engine = new CommissionEngine({ config: { programId: 'default', storage } });
  const rule: CommissionRuleRow = {
    id: 'rule_sched',
    programId: 'default',
    planKey: null,
    triggerScope: 'FIRST_PAYMENT',
    tierLevel: null,
    components: [{ componentType: 'CASH_PERCENT', valueMode: 'FIXED', fixedValue: 0.2 }],
    commissionBase: 'GROSS_BASED',
    platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
    holdPeriodDays: 30,
    autoApproveUnderCents: null,
    requireReviewOverCents: null,
    isActive: true,
    priority: 0,
  };
  storage.addRule(rule);
  const payouts = new PayoutService({ engine, provider: provider ?? new ManualPayoutProvider() });
  return { storage, referrals, engine, payouts };
}

/** 给指定推荐人产生一笔 APPROVED 佣金（10000 × 20% = 2000 cents） */
async function seedCommission(s: ReturnType<typeof setup>, referrer: string, orderId: string) {
  const code = (await s.referrals.getOrCreateCode(referrer)).code;
  await s.referrals.bindReferee(`buyer_${orderId}`, code);
  await s.engine.calculateCommissions({
    userId: `buyer_${orderId}`,
    orderId,
    planKey: 'pro',
    planType: 'one_time',
    triggerScope: 'FIRST_PAYMENT',
    amountTotal: 10000,
    currency: 'USD',
  });
}

describe('runScheduledPayouts', () => {
  it('冻结期已过且达门槛 → 按推荐人聚合发起打款', async () => {
    const s = setup();
    await seedCommission(s, 'alice', 'order_1');
    await seedCommission(s, 'alice', 'order_2'); // alice 合计 4000
    await seedCommission(s, 'bob', 'order_3'); // bob 合计 2000

    const report = await runScheduledPayouts({
      payouts: s.payouts,
      storage: s.storage,
      minPayoutThresholdCents: 3000,
      now: AFTER_HOLD,
    });
    expect(report.evaluatedGroups).toBe(2);
    expect(report.created).toHaveLength(1);
    expect(report.created[0].referrerUserId).toBe('alice');
    expect(report.created[0].amount).toBe(4000);
    // bob 不足门槛
    expect(report.skipped).toEqual([
      expect.objectContaining({ referrerUserId: 'bob', totalCents: 2000, reason: 'BELOW_THRESHOLD' }),
    ]);
  });

  it('冻结期内不结算；respectHoldPeriod=false 可提前结算', async () => {
    const s = setup();
    await seedCommission(s, 'alice', 'order_1');

    // 冻结期内（now = 当前时间，validUntil 在 30 天后）
    const frozen = await runScheduledPayouts({
      payouts: s.payouts,
      storage: s.storage,
      minPayoutThresholdCents: 1000,
    });
    expect(frozen.scannedCommissions).toBe(1);
    expect(frozen.evaluatedGroups).toBe(0);
    expect(frozen.created).toHaveLength(0);

    const early = await runScheduledPayouts({
      payouts: s.payouts,
      storage: s.storage,
      minPayoutThresholdCents: 1000,
      respectHoldPeriod: false,
    });
    expect(early.created).toHaveLength(1);
  });

  it('重复执行幂等：第二轮已无 APPROVED 佣金可结算', async () => {
    const s = setup();
    await seedCommission(s, 'alice', 'order_1');
    const opts = { payouts: s.payouts, storage: s.storage, minPayoutThresholdCents: 1000, now: AFTER_HOLD };
    const first = await runScheduledPayouts(opts);
    const second = await runScheduledPayouts(opts);
    expect(first.created).toHaveLength(1);
    expect(second.evaluatedGroups).toBe(0);
    expect(second.created).toHaveLength(0);
  });

  it('单轮上限 maxPayoutsPerRun：超出的分组留待下轮', async () => {
    const s = setup();
    await seedCommission(s, 'alice', 'order_1');
    await seedCommission(s, 'bob', 'order_2');
    const report = await runScheduledPayouts({
      payouts: s.payouts,
      storage: s.storage,
      minPayoutThresholdCents: 1000,
      maxPayoutsPerRun: 1,
      now: AFTER_HOLD,
    });
    expect(report.created).toHaveLength(1);
    expect(report.skipped).toEqual([expect.objectContaining({ reason: 'RUN_LIMIT_REACHED' })]);
  });

  it('收款账户未就绪 → skipped 带 missingSteps，佣金保持 APPROVED', async () => {
    const notReady: PayoutProvider = {
      name: 'STRIPE_CONNECT',
      isRecipientReady: async () => ({ ready: false, missingSteps: ['connect_onboarding'] }),
      createPayout: async () => {
        throw new Error('不应到达');
      },
      getPayoutStatus: async () => 'PROCESSING',
      handleProviderEvent: async () => null,
      listTransactions: async () => [],
    };
    const s = setup(notReady);
    await seedCommission(s, 'alice', 'order_1');
    const report = await runScheduledPayouts({
      payouts: s.payouts,
      storage: s.storage,
      minPayoutThresholdCents: 1000,
      now: AFTER_HOLD,
    });
    expect(report.created).toHaveLength(0);
    expect(report.skipped).toEqual([
      expect.objectContaining({ reason: 'RECIPIENT_NOT_READY', missingSteps: ['connect_onboarding'] }),
    ]);
    const row = s.storage.allCommissions()[0];
    expect(row.status).toBe('APPROVED');
  });
});

import { describe, expect, it } from 'vitest';
import { CommissionEngine } from './engine.js';
import { enqueueCommissionJob, processCommissionJobs } from './jobs.js';
import { ManualPayoutProvider, PayoutService } from './payouts.js';
import { ReferralService } from './referrals.js';
import { InMemoryCommissionStorage } from './storage-memory.js';
import type { CommissionRuleRow, PayoutProvider, PayoutStatus } from './types.js';

/** 组装：20% 现金规则（自动过审 → 佣金直接 APPROVED，可打款） */
function setup(provider?: PayoutProvider) {
  const storage = new InMemoryCommissionStorage();
  const referrals = new ReferralService({ storage });
  const engine = new CommissionEngine({ config: { programId: 'default', storage } });
  const rule: CommissionRuleRow = {
    id: 'rule_payout',
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

/** 产生一笔 APPROVED 佣金（10000 × 20% = 2000），返回佣金 ID */
async function seedApprovedCommission(s: ReturnType<typeof setup>, orderId: string): Promise<string> {
  const code = (await s.referrals.getOrCreateCode('referrer')).code;
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
  const row = s.storage.allCommissions().find((c) => c.orderId === orderId)!;
  expect(row.status).toBe('APPROVED');
  return row.id;
}

describe('PayoutService（打款腿）', () => {
  it('createPayout：汇总 APPROVED 佣金 → 佣金流转 PAID → 打款 PROCESSING（MANUAL 通道）', async () => {
    const s = setup();
    const c1 = await seedApprovedCommission(s, 'order_1');
    const c2 = await seedApprovedCommission(s, 'order_2');

    const result = await s.payouts.createPayout({ referrerUserId: 'referrer' });
    expect(result.created).toBe(true);
    expect(result.payout!.amount).toBe(4000); // 2000 × 2
    expect(result.payout!.commissionIds.sort()).toEqual([c1, c2].sort());
    expect(result.payout!.status).toBe('PROCESSING');
    expect(result.payout!.idempotencyKey).toBe(result.payout!.id); // Layer 4
    expect(result.payout!.providerTransactionId).toBe(`manual_${result.payout!.id}`);
    // Layer 3：佣金已流转 PAID
    expect(s.storage.getCommission(c1)!.status).toBe('PAID');
    expect(s.storage.getCommission(c2)!.status).toBe('PAID');
  });

  it('createPayout：无可打款佣金 / 重复打款返回 NO_PAYABLE_COMMISSIONS', async () => {
    const s = setup();
    expect((await s.payouts.createPayout({ referrerUserId: 'referrer' })).reason).toBe('NO_PAYABLE_COMMISSIONS');

    await seedApprovedCommission(s, 'order_1');
    expect((await s.payouts.createPayout({ referrerUserId: 'referrer' })).created).toBe(true);
    // 再次打款：佣金已 PAID，Layer 3 拦截
    const second = await s.payouts.createPayout({ referrerUserId: 'referrer' });
    expect(second.created).toBe(false);
    expect(second.reason).toBe('NO_PAYABLE_COMMISSIONS');
  });

  it('createPayout：通道异常 → 打款 FAILED + 佣金回滚 APPROVED 可重试', async () => {
    const failing: PayoutProvider = {
      name: 'STRIPE_CONNECT',
      isRecipientReady: async () => ({ ready: true }),
      createPayout: async () => {
        throw new Error('connect boom');
      },
      getPayoutStatus: async () => 'FAILED' as PayoutStatus,
      handleProviderEvent: async () => null,
      listTransactions: async () => [],
    };
    const s = setup(failing);
    const c1 = await seedApprovedCommission(s, 'order_1');

    const result = await s.payouts.createPayout({ referrerUserId: 'referrer' });
    expect(result.created).toBe(false);
    expect(result.reason).toBe('PROVIDER_ERROR');
    // 佣金回滚 APPROVED，可重新提现
    expect(s.storage.getCommission(c1)!.status).toBe('APPROVED');
    const [payout] = await s.storage.listPayouts();
    expect(payout!.status).toBe('FAILED');
    expect(payout!.failureReason).toContain('connect boom');
  });

  it('createPayout：收款账户未就绪返回 RECIPIENT_NOT_READY，佣金不受影响', async () => {
    const notReady: PayoutProvider = {
      name: 'PAYPAL',
      isRecipientReady: async () => ({ ready: false, missingSteps: ['填写 PayPal 邮箱'] }),
      createPayout: async () => ({ providerTransactionId: 'txn', status: 'PROCESSING' as PayoutStatus }),
      getPayoutStatus: async () => 'PROCESSING' as PayoutStatus,
      handleProviderEvent: async () => null,
      listTransactions: async () => [],
    };
    const s = setup(notReady);
    const c1 = await seedApprovedCommission(s, 'order_1');

    const result = await s.payouts.createPayout({ referrerUserId: 'referrer' });
    expect(result.reason).toBe('RECIPIENT_NOT_READY');
    expect(result.missingSteps).toEqual(['填写 PayPal 邮箱']);
    expect(s.storage.getCommission(c1)!.status).toBe('APPROVED');
  });

  it('applyProviderStatus：PROCESSING → SUCCEEDED 落 settledAt；重复/乱序回调被状态机拒绝', async () => {
    const s = setup();
    await seedApprovedCommission(s, 'order_1');
    const { payout } = await s.payouts.createPayout({ referrerUserId: 'referrer' });

    expect(await s.payouts.applyProviderStatus(payout!.id, 'SUCCEEDED')).toBe(true);
    const settled = await s.storage.getPayout(payout!.id);
    expect(settled!.status).toBe('SUCCEEDED');
    expect(settled!.settledAt).toBeInstanceOf(Date);
    // 终态后重复回调 → 拒绝
    expect(await s.payouts.applyProviderStatus(payout!.id, 'FAILED')).toBe(false);
    expect(await s.payouts.applyProviderStatus('missing', 'SUCCEEDED')).toBe(false);
  });

  it('applyProviderStatus：FAILED/RETURNED → 佣金自动回滚 APPROVED', async () => {
    const s = setup();
    const c1 = await seedApprovedCommission(s, 'order_1');
    const { payout } = await s.payouts.createPayout({ referrerUserId: 'referrer' });
    expect(s.storage.getCommission(c1)!.status).toBe('PAID');

    expect(await s.payouts.applyProviderStatus(payout!.id, 'FAILED', { failureReason: '账户冻结' })).toBe(true);
    expect(s.storage.getCommission(c1)!.status).toBe('APPROVED'); // 可重新提现
    expect((await s.storage.getPayout(payout!.id))!.failureReason).toBe('账户冻结');
  });

  it('createPayout：显式 commissionIds 剔除他人/非 APPROVED 佣金', async () => {
    const s = setup();
    const c1 = await seedApprovedCommission(s, 'order_1');
    const c2 = await seedApprovedCommission(s, 'order_2');
    await s.engine.markCommissionPaid(c2); // c2 已打款

    const result = await s.payouts.createPayout({
      referrerUserId: 'referrer',
      commissionIds: [c1, c2, 'missing'],
    });
    expect(result.created).toBe(true);
    expect(result.payout!.commissionIds).toEqual([c1]); // 只结算 c1
    expect(result.payout!.amount).toBe(2000);
  });
});

describe('Outbox 异步任务（5.4.2）', () => {
  it('enqueueCommissionJob：eventId 幂等，重放不重复入队', async () => {
    const storage = new InMemoryCommissionStorage();
    const input = { eventId: 'evt_1', jobType: 'CALC_COMMISSION' as const, payload: { orderId: 'o1' } };
    expect(await enqueueCommissionJob(storage, input)).toBe(true);
    expect(await enqueueCommissionJob(storage, input)).toBe(false); // webhook 重放
  });

  it('processCommissionJobs：成功任务 DONE，失败任务指数退避重试直至 DEAD', async () => {
    const storage = new InMemoryCommissionStorage();
    const now = new Date('2026-07-01T00:00:00Z');
    await enqueueCommissionJob(storage, { eventId: 'evt_ok', jobType: 'CALC_COMMISSION', payload: {}, now });
    await enqueueCommissionJob(storage, { eventId: 'evt_bad', jobType: 'CLAWBACK', payload: {}, now });

    const handled: string[] = [];
    const handlers = {
      CALC_COMMISSION: async () => {
        handled.push('calc');
      },
      CLAWBACK: async () => {
        throw new Error('boom');
      },
    };

    // 第 1 轮：ok → DONE；bad → 失败退避（attempts=1）
    const r1 = await processCommissionJobs(storage, handlers, { now, maxAttempts: 2, backoffBaseMs: 1000 });
    expect(r1).toEqual({ claimed: 2, done: 1, failed: 1, dead: 0 });
    expect(handled).toEqual(['calc']);

    // 未到退避时间 → 领不到任务
    const r2 = await processCommissionJobs(storage, handlers, { now, maxAttempts: 2, backoffBaseMs: 1000 });
    expect(r2.claimed).toBe(0);

    // 越过退避时间重试 → 再失败达到上限 → DEAD
    const later = new Date(now.getTime() + 60_000);
    const r3 = await processCommissionJobs(storage, handlers, { now: later, maxAttempts: 2, backoffBaseMs: 1000 });
    expect(r3).toEqual({ claimed: 1, done: 0, failed: 0, dead: 1 });

    // DEAD 后不再领取
    const muchLater = new Date(now.getTime() + 3_600_000);
    expect((await processCommissionJobs(storage, handlers, { now: muchLater })).claimed).toBe(0);
  });

  it('processCommissionJobs：缺失 handler 的任务按失败重试处理，不中断其余任务', async () => {
    const storage = new InMemoryCommissionStorage();
    const now = new Date();
    await enqueueCommissionJob(storage, { eventId: 'evt_1', jobType: 'PAYOUT', payload: {}, now });
    await enqueueCommissionJob(storage, { eventId: 'evt_2', jobType: 'CALC_COMMISSION', payload: {}, now });

    const r = await processCommissionJobs(storage, { CALC_COMMISSION: async () => {} }, { now });
    expect(r.done).toBe(1);
    expect(r.failed).toBe(1); // PAYOUT 无 handler → 退避重试
  });
});

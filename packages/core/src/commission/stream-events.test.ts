import { describe, expect, it } from 'vitest';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { ReferralService } from './referrals.js';
import { CommissionEngine } from './engine.js';
import { InMemoryReferralEventBus, type ReferralStreamEvent } from './stream-events.js';
import type { CommissionRuleRow } from './types.js';

/** 组装带事件总线的引擎 + 邀请服务 */
function setup() {
  const storage = new InMemoryCommissionStorage();
  const events = new InMemoryReferralEventBus();
  const referrals = new ReferralService({ storage, events });
  const engine = new CommissionEngine({ config: { programId: 'default', storage, events } });
  const rule: CommissionRuleRow = {
    id: 'rule_sse',
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
  return { storage, events, referrals, engine };
}

async function seedCommission(s: ReturnType<typeof setup>, orderId: string): Promise<string> {
  const code = (await s.referrals.getOrCreateCode('referrer')).code;
  await s.referrals.bindReferee('buyer', code);
  await s.engine.calculateCommissions({
    userId: 'buyer',
    orderId,
    planKey: 'pro',
    planType: 'one_time',
    triggerScope: 'FIRST_PAYMENT',
    amountTotal: 10000,
    currency: 'USD',
  });
  return s.storage.allCommissions()[0]!.id;
}

describe('InMemoryReferralEventBus', () => {
  it('按 userId 定向分发；退订后不再收到；其他用户收不到', () => {
    const bus = new InMemoryReferralEventBus();
    const received: ReferralStreamEvent[] = [];
    const other: ReferralStreamEvent[] = [];
    const unsubscribe = bus.subscribe('u1', (e) => received.push(e));
    bus.subscribe('u2', (e) => other.push(e));

    bus.publish('u1', { type: 'commission.approved', data: { commissionId: 'c1', amount: 100 } });
    expect(received).toHaveLength(1);
    expect(other).toHaveLength(0);

    unsubscribe();
    bus.publish('u1', { type: 'commission.approved', data: { commissionId: 'c2', amount: 200 } });
    expect(received).toHaveLength(1);
    expect(bus.subscriberCount('u1')).toBe(0);
  });

  it('监听器抛错不影响其他订阅者', () => {
    const bus = new InMemoryReferralEventBus();
    const received: ReferralStreamEvent[] = [];
    bus.subscribe('u1', () => {
      throw new Error('boom');
    });
    bus.subscribe('u1', (e) => received.push(e));
    bus.publish('u1', { type: 'commission.paid', data: { commissionId: 'c1', amount: 100 } });
    expect(received).toHaveLength(1);
  });
});

describe('引擎/邀请服务事件推送', () => {
  it('计佣落库推送 commission.created；webhook 重放不重复推送', async () => {
    const s = setup();
    const received: ReferralStreamEvent[] = [];
    s.events.subscribe('referrer', (e) => received.push(e));

    await seedCommission(s, 'order_sse1');
    const created = received.filter((e) => e.type === 'commission.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({ amount: 2000, currency: 'USD', tierLevel: 1 });

    // 重放：幂等跳过，不再推送
    await s.engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_sse1',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(received.filter((e) => e.type === 'commission.created')).toHaveLength(1);
  });

  it('审批通过推送 commission.approved，打款完成推送 commission.paid', async () => {
    const s = setup();
    const received: ReferralStreamEvent[] = [];
    s.events.subscribe('referrer', (e) => received.push(e));
    const id = await seedCommission(s, 'order_sse2');

    // AUTO_APPROVED 场景下佣金已是 APPROVED，直接打款
    expect(await s.engine.markCommissionPaid(id)).toBe(true);
    const paid = received.filter((e) => e.type === 'commission.paid');
    expect(paid).toHaveLength(1);
    expect(paid[0]!.data).toMatchObject({ commissionId: id, amount: 2000 });

    // 重复打款被状态机拒绝 → 不重复推送
    expect(await s.engine.markCommissionPaid(id)).toBe(false);
    expect(received.filter((e) => e.type === 'commission.paid')).toHaveLength(1);
  });

  it('绑定推荐关系推送 referral.registered（邮箱脱敏）', async () => {
    const s = setup();
    const received: ReferralStreamEvent[] = [];
    s.events.subscribe('referrer', (e) => received.push(e));

    const code = (await s.referrals.getOrCreateCode('referrer')).code;
    await s.referrals.bindReferee('newbie', code, { email: 'alice@example.com' });

    const registered = received.filter((e) => e.type === 'referral.registered');
    expect(registered).toHaveLength(1);
    expect(registered[0]!.data).toEqual({ maskedEmail: 'al****@example.com' });
  });

  it('未配置事件总线时计佣/审批照常工作', async () => {
    const storage = new InMemoryCommissionStorage();
    const referrals = new ReferralService({ storage });
    const engine = new CommissionEngine({ config: { programId: 'default', storage } });
    storage.addRule({
      id: 'rule_no_bus',
      programId: 'default',
      planKey: null,
      triggerScope: 'FIRST_PAYMENT',
      tierLevel: null,
      components: [{ componentType: 'CASH_FIXED', valueMode: 'FIXED', fixedValue: 500 }],
      commissionBase: 'GROSS_BASED',
      platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
      holdPeriodDays: 30,
      autoApproveUnderCents: null,
      requireReviewOverCents: null,
      isActive: true,
      priority: 0,
    });
    const code = (await referrals.getOrCreateCode('referrer')).code;
    await referrals.bindReferee('buyer', code);
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_no_bus',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(result.successful).toBe(true);
    const id = storage.allCommissions()[0]!.id;
    expect(await engine.markCommissionPaid(id)).toBe(true);
  });
});

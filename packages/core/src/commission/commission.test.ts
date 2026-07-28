import { describe, expect, it, vi } from 'vitest';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { ReferralService, generateCode } from './referrals.js';
import { buildReferralChain } from './chain.js';
import { CommissionEngine, calculateStripeFee, matchRule } from './engine.js';
import { resolveTriggerScope } from './events.js';
import type { CommissionConfig, CommissionRuleRow, RewardComponent } from './types.js';

// ── 测试辅助 ──

function makeConfig(storage: InMemoryCommissionStorage, overrides?: Partial<CommissionConfig>): CommissionConfig {
  return { programId: 'default', storage, ...overrides };
}

function makeRule(storage: InMemoryCommissionStorage, overrides: Partial<CommissionRuleRow>): CommissionRuleRow {
  const rule: CommissionRuleRow = {
    id: overrides.id ?? `rule_${Math.random().toString(36).slice(2, 8)}`,
    programId: 'default',
    planKey: null,
    triggerScope: 'FIRST_PAYMENT',
    tierLevel: null,
    components: [],
    commissionBase: 'NET_BASED',
    platformFeeHandlingMode: 'CONSUMED_BY_PLATFORM',
    holdPeriodDays: 30,
    autoApproveUnderCents: null,
    requireReviewOverCents: null,
    isActive: true,
    priority: 0,
    ...overrides,
  };
  storage.addRule(rule);
  return rule;
}

/** 为用户生成邀请码 */
async function giveCode(svc: ReferralService, userId: string): Promise<string> {
  const row = await svc.getOrCreateCode(userId);
  return row.code;
}

/** 建立 referrer -> referee 的生效（ACTIVE）关系 */
async function linkActive(
  storage: InMemoryCommissionStorage,
  svc: ReferralService,
  referrerUserId: string,
  refereeUserId: string,
): Promise<void> {
  const code = await giveCode(svc, referrerUserId);
  const res = await svc.bindReferee(refereeUserId, code);
  if (!res.bound || !res.relationshipId) throw new Error('bind failed');
  await svc.activateRelationship(res.relationshipId);
}

const percent = (value: number, extra?: Partial<RewardComponent>): RewardComponent => ({
  componentType: 'CASH_PERCENT',
  valueMode: 'FIXED',
  fixedValue: value,
  ...extra,
});

// ── 邀请码 ──

describe('referrals', () => {
  it('generateCode 生成 8 位码且不含易混淆字符', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toHaveLength(8);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('getOrCreateCode 幂等：同一用户返回同一码', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    const a = await svc.getOrCreateCode('u1');
    const b = await svc.getOrCreateCode('u1');
    expect(a.code).toBe(b.code);
  });

  it('validateCode 区分 未找到/已停用/自推/有效', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    const code = await giveCode(svc, 'referrer');

    expect((await svc.validateCode(null)).valid).toBe(false);
    expect((await svc.validateCode('NOPE1234')).reason).toBe('NOT_FOUND');

    await storage.setReferralCodeActive(code, false);
    expect((await svc.validateCode(code)).reason).toBe('INACTIVE');
    await storage.setReferralCodeActive(code, true);

    expect((await svc.validateCode(code, 'referrer')).reason).toBe('SELF_REFERRAL');
    expect((await svc.validateCode(code, 'newbie')).valid).toBe(true);
  });

  it('铁律：无效邀请码不阻断注册（bindReferee 返回 bound=false 而不抛错）', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    expect((await svc.bindReferee('newbie', null)).bound).toBe(false);
    expect((await svc.bindReferee('newbie', 'BADCODE9')).bound).toBe(false);
    // 注册流程可照常继续，无异常抛出
  });

  it('有效码绑定成功并累计邀请统计', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    const code = await giveCode(svc, 'referrer');
    const res = await svc.bindReferee('newbie', code);
    expect(res.bound).toBe(true);
    const row = await storage.getReferralCodeByCode(code);
    expect(row?.totalInvites).toBe(1);
  });

  it('changeReferrer 使旧关系 EXPIRED 并建立新关系', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    const codeA = await giveCode(svc, 'A');
    const codeB = await giveCode(svc, 'B');

    await svc.bindReferee('user', codeA);
    const before = await storage.getActiveReferrer('user');
    expect(before?.referrerUserId).toBe('A');

    const res = await svc.changeReferrer('user', codeB);
    expect(res.bound).toBe(true);
    const after = await storage.getActiveReferrer('user');
    expect(after?.referrerUserId).toBe('B');
  });
});

// ── 推荐链 ──

describe('chain', () => {
  it('构建 3 级链：C 付费 → B → A', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'A', 'B');
    await linkActive(storage, svc, 'B', 'C');

    const { chain, cycleDetected } = await buildReferralChain('C', storage);
    expect(cycleDetected).toBe(false);
    expect(chain.map((n) => n.referrerUserId)).toEqual(['B', 'A']);
    expect(chain.map((n) => n.tierLevel)).toEqual([1, 2]);
  });

  it('链深硬上限：超过 maxLevels 截断', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'A', 'B');
    await linkActive(storage, svc, 'B', 'C');
    await linkActive(storage, svc, 'C', 'D');

    const { chain } = await buildReferralChain('D', storage, 2);
    expect(chain).toHaveLength(2);
    expect(chain.map((n) => n.referrerUserId)).toEqual(['C', 'B']);
  });

  it('断链即止：无推荐人时返回空链', async () => {
    const storage = new InMemoryCommissionStorage();
    const { chain } = await buildReferralChain('lonely', storage);
    expect(chain).toEqual([]);
  });

  it('防环：检测到环时截断并标记', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    // 构造环 A->B->C->A（手动注入关系绕过绑定校验）
    await linkActive(storage, svc, 'A', 'B'); // B 的推荐人是 A
    await linkActive(storage, svc, 'B', 'C'); // C 的推荐人是 B
    await linkActive(storage, svc, 'C', 'A'); // A 的推荐人是 C → 环

    const { chain, cycleDetected } = await buildReferralChain('A', storage);
    expect(cycleDetected).toBe(true);
    // A -> C -> B 后回到 A（已访问）截断
    expect(chain.map((n) => n.referrerUserId)).toEqual(['C', 'B']);
  });
});

// ── 计算引擎 ──

describe('engine', () => {
  it('calculateStripeFee = 2.9% + $0.30', () => {
    const storage = new InMemoryCommissionStorage();
    const fee = calculateStripeFee(10000, makeConfig(storage));
    expect(fee).toBe(Math.round(10000 * 0.029) + 30); // 290 + 30 = 320
  });

  it('NET_BASED 按净收入计佣（$100 → 佣金 $19.36）', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, { components: [percent(0.2)] });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_1',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });

    expect(result.successful).toBe(true);
    expect(result.details?.stripeFee).toBe(320);
    expect(result.details?.netAmount).toBe(9680);
    // 9680 * 0.2 = 1936
    expect(result.tiers[0]?.amount).toBe(1936);
    expect(result.tiers[0]?.status).toBe('APPROVED');
  });

  it('GROSS_BASED 按毛额计佣（$100 → 佣金 $20.00）', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, { commissionBase: 'GROSS_BASED', components: [percent(0.2)] });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_g',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(result.tiers[0]?.amount).toBe(2000);
  });

  it('maxValueCents 单笔封顶生效', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, {
      commissionBase: 'GROSS_BASED',
      components: [percent(0.5, { maxValueCents: 1000 })],
    });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_cap',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000, // 50% = 5000，封顶 1000
      currency: 'USD',
    });
    expect(result.tiers[0]?.amount).toBe(1000);
  });

  it('DYNAMIC ORDER_AMOUNT 阶梯命中高档', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, {
      commissionBase: 'GROSS_BASED',
      components: [
        {
          componentType: 'CASH_PERCENT',
          valueMode: 'DYNAMIC',
          dynamicConfig: {
            driverVariable: 'ORDER_AMOUNT',
            ladder: [
              { from: 0, to: 100000, value: 0.1 },
              { from: 100000, to: null, value: 0.2 },
            ],
          },
        },
      ],
    });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_dyn',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 150000, // 命中第二档 20%
      currency: 'USD',
    });
    expect(result.tiers[0]?.amount).toBe(30000);
    expect(result.tiers[0]?.rateBreakdown[0]?.hitLadderStep).toBe(1);
  });

  it('minCommissionableAmountCents 防穿仓：小额订单组件跳过', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, {
      commissionBase: 'GROSS_BASED',
      components: [percent(0.2, { minCommissionableAmountCents: 5000 })],
    });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_min',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 3000, // 低于 5000，组件跳过
      currency: 'USD',
    });
    expect(result.tiers[0]?.amount).toBe(0);
    expect(result.tiers[0]?.rateBreakdown[0]?.skipped).toBe(true);
  });

  it('多级分销：L1 20% / L2 10% 逐级独立匹配', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'A', 'B');
    await linkActive(storage, svc, 'B', 'C');
    makeRule(storage, { tierLevel: 1, commissionBase: 'GROSS_BASED', components: [percent(0.2)] });
    makeRule(storage, { tierLevel: 2, commissionBase: 'GROSS_BASED', components: [percent(0.1)] });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'C',
      orderId: 'order_multi',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(result.tiers).toHaveLength(2);
    const l1 = result.tiers.find((t) => t.tierLevel === 1);
    const l2 = result.tiers.find((t) => t.tierLevel === 2);
    expect(l1?.referrerUserId).toBe('B');
    expect(l1?.amount).toBe(2000);
    expect(l2?.referrerUserId).toBe('A');
    expect(l2?.amount).toBe(1000);
  });

  it('某级无规则不递补：仅 L1 有规则时 L2 不计佣', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'A', 'B');
    await linkActive(storage, svc, 'B', 'C');
    makeRule(storage, { tierLevel: 1, commissionBase: 'GROSS_BASED', components: [percent(0.2)] });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'C',
      orderId: 'order_nobackfill',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0]?.tierLevel).toBe(1);
  });

  it('幂等：同一订单重复计算不产生新记录', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, { commissionBase: 'GROSS_BASED', components: [percent(0.2)] });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const input = {
      userId: 'buyer',
      orderId: 'order_idem',
      planKey: 'pro',
      planType: 'one_time' as const,
      triggerScope: 'FIRST_PAYMENT' as const,
      amountTotal: 10000,
      currency: 'USD',
    };
    await engine.calculateCommissions(input);
    const second = await engine.calculateCommissions(input);
    expect(second.tiers[0]?.inserted).toBe(false);
    expect(storage.allCommissions()).toHaveLength(1);
  });

  it('PRODUCT 组件触发发放 hook 并回写 GRANTED', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, {
      commissionBase: 'GROSS_BASED',
      components: [
        { componentType: 'PRODUCT', valueMode: 'FIXED', fixedValue: 1, productRef: 'vip_month' },
      ],
    });
    const grant = vi.fn(async () => ({ granted: true }));
    const engine = new CommissionEngine({
      config: makeConfig(storage, { hooks: { onProductRewardGrant: grant } }),
    });

    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_prod',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({ productRef: 'vip_month', quantity: 1 }),
    );
    expect(result.tiers[0]?.grantStatus).toBe('GRANTED');
    expect(result.tiers[0]?.amount).toBe(0); // 纯产品组件无现金
  });

  it('requireReviewOver 触发人工审核（状态 PENDING）', async () => {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, {
      commissionBase: 'GROSS_BASED',
      requireReviewOverCents: 1000,
      components: [percent(0.5)],
    });

    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.calculateCommissions({
      userId: 'buyer',
      orderId: 'order_review',
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000, // 50% = 5000 > 1000
      currency: 'USD',
    });
    expect(result.tiers[0]?.reviewStatus).toBe('MANUAL_REVIEW');
    expect(result.tiers[0]?.status).toBe('PENDING');
  });

  it('matchRule：planKey 精确优先于全局', () => {
    const storage = new InMemoryCommissionStorage();
    const global = makeRule(storage, { id: 'global', planKey: null, priority: 0 });
    const specific = makeRule(storage, { id: 'specific', planKey: 'pro', priority: 0 });
    const hit = matchRule([global, specific], { planKey: 'pro', triggerScope: 'FIRST_PAYMENT', tierLevel: 1 });
    expect(hit?.id).toBe('specific');
  });
});

// ── 触发场景归一 ──

describe('resolveTriggerScope', () => {
  it('checkout：一次性/订阅首付 → FIRST_PAYMENT', () => {
    expect(resolveTriggerScope('one_time', 'checkout')).toBe('FIRST_PAYMENT');
    expect(resolveTriggerScope('subscription', 'checkout')).toBe('FIRST_PAYMENT');
    expect(resolveTriggerScope('credit_package', 'checkout')).toBe('FIRST_PAYMENT');
  });

  it('checkout：试用类/按量 → 不计佣', () => {
    expect(resolveTriggerScope('trial_no_convert', 'checkout')).toBeNull();
    expect(resolveTriggerScope('first_trial', 'checkout')).toBeNull();
    expect(resolveTriggerScope('trial_then_subscribe', 'checkout')).toBeNull();
    expect(resolveTriggerScope('metered', 'checkout')).toBeNull();
  });

  it('invoice：metered → USAGE_INVOICE；续期/proration → RECURRING；首期 → 不计佣', () => {
    expect(resolveTriggerScope('metered', 'invoice', 'subscription_cycle')).toBe('USAGE_INVOICE');
    expect(resolveTriggerScope('subscription', 'invoice', 'subscription_cycle')).toBe('RECURRING_PAYMENT');
    expect(resolveTriggerScope('subscription', 'invoice', 'subscription_update')).toBe('RECURRING_PAYMENT');
    expect(resolveTriggerScope('subscription', 'invoice', 'subscription_create')).toBeNull();
  });
});

// ── 退款追回（clawback）──

describe('clawback', () => {
  async function setupWithCommission(orderId: string) {
    const storage = new InMemoryCommissionStorage();
    const svc = new ReferralService({ storage });
    await linkActive(storage, svc, 'referrer', 'buyer');
    makeRule(storage, { commissionBase: 'GROSS_BASED', components: [percent(0.2)] });
    const engine = new CommissionEngine({ config: makeConfig(storage) });
    await engine.calculateCommissions({
      userId: 'buyer',
      orderId,
      planKey: 'pro',
      planType: 'one_time',
      triggerScope: 'FIRST_PAYMENT',
      amountTotal: 10000,
      currency: 'USD',
    });
    return { storage, engine };
  }

  it('PENDING/APPROVED 佣金回转为 REFUNDED', async () => {
    const { storage, engine } = await setupWithCommission('order_cb');
    const result = await engine.clawbackByOrder('order_cb');
    expect(result.refundedCount).toBe(1);
    expect(result.paidRequiresManual).toEqual([]);
    expect(storage.allCommissions()[0]?.status).toBe('REFUNDED');
  });

  it('幂等：重复 clawback 回转 0 条', async () => {
    const { engine } = await setupWithCommission('order_cb2');
    await engine.clawbackByOrder('order_cb2');
    const second = await engine.clawbackByOrder('order_cb2');
    expect(second.refundedCount).toBe(0);
  });

  it('PAID 佣金不自动回转，列入人工追回清单', async () => {
    const { storage, engine } = await setupWithCommission('order_cb3');
    const row = storage.allCommissions()[0]!;
    storage.getCommission(row.id)!.status = 'PAID'; // 模拟已打款
    const result = await engine.clawbackByOrder('order_cb3');
    expect(result.refundedCount).toBe(0);
    expect(result.paidRequiresManual).toEqual([row.id]);
    expect(storage.getCommission(row.id)?.status).toBe('PAID'); // Layer 3：状态不被覆盖
  });

  it('无佣金记录的订单：安静返回 0', async () => {
    const storage = new InMemoryCommissionStorage();
    const engine = new CommissionEngine({ config: makeConfig(storage) });
    const result = await engine.clawbackByOrder('order_none');
    expect(result.refundedCount).toBe(0);
    expect(result.paidRequiresManual).toEqual([]);
  });
});

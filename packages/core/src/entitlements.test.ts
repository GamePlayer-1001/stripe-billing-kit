import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import {
  getEntitlements,
  hasAccess,
  getCreditBalance,
  consumeUserCredit,
  isDailyPassActive,
  hasSubscribedPlan,
  hasUsedFirstTrial,
} from './entitlements.js';
import { BillingError } from './errors.js';
import { testConfig } from './testing.js';
import type { PlanDef } from './config.js';

describe('entitlements', () => {
  it('活跃订阅授予 features;canceled 不授予', async () => {
    const config = testConfig();
    const ctx = createBillingContext(config);

    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_1',
      userId: 'u1',
      planKey: 'pro_monthly',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
      raw: {},
    });
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_2',
      userId: 'u2',
      planKey: 'pro_monthly',
      status: 'canceled',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
      raw: {},
    });

    expect(await hasAccess(ctx, 'u1', 'pro')).toBe(true);
    expect(await hasAccess(ctx, 'u2', 'pro')).toBe(false);

    const status = await getEntitlements(ctx, 'u1');
    expect(status.entitlements).toHaveLength(1);
    expect(status.hasAccess).toEqual({ pro: true, lifetime: false });
  });

  it('买断记录授予永久权益', async () => {
    const ctx = createBillingContext(testConfig());
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_1',
      userId: 'u3',
      planKey: 'lifetime',
      amountTotal: 39900,
      currency: 'usd',
    });

    const status = await getEntitlements(ctx, 'u3');
    expect(status.hasAccess).toEqual({ pro: true, lifetime: true });
    expect(status.entitlements[0]?.currentPeriodEnd).toBeNull();
    expect(status.entitlements[0]?.source).toBe('purchase');
  });

  it('过期超过宽限期的订阅行不授予权益(webhook 迟到保护)', async () => {
    const ctx = createBillingContext(testConfig());
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_3',
      userId: 'u4',
      planKey: 'pro_monthly',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
      raw: {},
    });
    expect(await hasAccess(ctx, 'u4', 'pro')).toBe(false);
  });

  it('past_due 保留访问(扣款重试期)', async () => {
    const ctx = createBillingContext(testConfig());
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_4',
      userId: 'u5',
      planKey: 'pro_monthly',
      status: 'past_due',
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
      raw: {},
    });
    expect(await hasAccess(ctx, 'u5', 'pro')).toBe(true);
  });

  it('未知 planKey 的行被忽略', async () => {
    const ctx = createBillingContext(testConfig());
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_5',
      userId: 'u6',
      planKey: 'unknown',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      raw: {},
    });
    expect(await hasAccess(ctx, 'u6', 'pro')).toBe(false);
  });
});

const EXT_PLANS: PlanDef[] = [
  { key: 'pro_monthly', type: 'subscription', ref: { priceId: 'price_sub' }, features: ['pro'] },
  { key: 'credits_100', type: 'credit_package', ref: { priceId: 'price_credit' }, features: ['credits'], creditAmount: 100 },
  { key: 'day_pass', type: 'daily', ref: { priceId: 'price_day' }, features: ['pro'] },
  { key: 'first_taste', type: 'first_trial', ref: { priceId: 'price_first' }, features: ['pro'], trialDays: 14, trialConvertsTo: 'pro_monthly' },
];

function extCtx() {
  return createBillingContext(testConfig({ plans: EXT_PLANS }));
}

describe('额度包(credit_package)', () => {
  it('余额 = sum(creditAmount) - sum(creditUsed);仅统计 credit_package 类型', async () => {
    const ctx = extCtx();
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_c1', userId: 'u1', planKey: 'credits_100',
      amountTotal: 990, currency: 'usd', metadata: { creditAmount: '100', creditUsed: '30' },
    });
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_c2', userId: 'u1', planKey: 'credits_100',
      amountTotal: 990, currency: 'usd', metadata: { creditAmount: '100' },
    });
    // daily 购买不计入额度
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_d1', userId: 'u1', planKey: 'day_pass',
      amountTotal: 500, currency: 'usd', metadata: { dailyDays: '1' },
    });

    expect(await getCreditBalance(ctx, 'u1')).toBe(170);
    expect(await getCreditBalance(ctx, 'u_none')).toBe(0);
  });

  it('metadata 缺 creditAmount 时回退 plan.creditAmount', async () => {
    const ctx = extCtx();
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_c3', userId: 'u2', planKey: 'credits_100',
      amountTotal: 990, currency: 'usd',
    });
    expect(await getCreditBalance(ctx, 'u2')).toBe(100);
  });

  it('consumeUserCredit 跨多笔购买扣减并持久化;余额不足抛 insufficient_credits', async () => {
    const ctx = extCtx();
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_c4', userId: 'u3', planKey: 'credits_100',
      amountTotal: 990, currency: 'usd', metadata: { creditAmount: '100', creditUsed: '90' },
    });
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_c5', userId: 'u3', planKey: 'credits_100',
      amountTotal: 990, currency: 'usd', metadata: { creditAmount: '100' },
    });

    // 110 = 第一笔剩 10 + 第二笔 100
    expect(await consumeUserCredit(ctx, 'u3', 30)).toBe(80);
    // 再查余额,验证 creditUsed 已回写存储(而非只算了返回值)
    expect(await getCreditBalance(ctx, 'u3')).toBe(80);

    await expect(consumeUserCredit(ctx, 'u3', 81)).rejects.toThrow(BillingError);
    await expect(consumeUserCredit(ctx, 'u3', 81)).rejects.toThrow(/额度不足/);
    await expect(consumeUserCredit(ctx, 'u3', 0)).rejects.toThrow(/必须 > 0/);
  });

  it('storage 实现了原子接口时优先走 storage', async () => {
    const config = testConfig({ plans: EXT_PLANS });
    config.storage.getCreditBalance = vi.fn().mockResolvedValue(42);
    config.storage.consumeCredit = vi.fn().mockResolvedValue(40);
    const ctx = createBillingContext(config);

    expect(await getCreditBalance(ctx, 'u4')).toBe(42);
    expect(await consumeUserCredit(ctx, 'u4', 2)).toBe(40);
    expect(config.storage.consumeCredit).toHaveBeenCalledWith('u4', 2);
  });
});

describe('日付通行证(daily)', () => {
  it('有效期内 true;过期 false;非 daily planKey 直接 false', async () => {
    const ctx = extCtx();
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_d2', userId: 'u5', planKey: 'day_pass',
      amountTotal: 500, currency: 'usd', createdAt: new Date(Date.now() - 2 * 3600 * 1000),
      metadata: { dailyDays: '1' },
    });
    expect(await isDailyPassActive(ctx, 'u5', 'day_pass')).toBe(true);
    expect(await isDailyPassActive(ctx, 'u5', 'pro_monthly')).toBe(false);

    const ctx2 = extCtx();
    await ctx2.storage.insertPurchase({
      stripeSessionId: 'cs_d3', userId: 'u6', planKey: 'day_pass',
      amountTotal: 500, currency: 'usd', createdAt: new Date(Date.now() - 26 * 3600 * 1000),
      metadata: { dailyDays: '1' },
    });
    expect(await isDailyPassActive(ctx2, 'u6', 'day_pass')).toBe(false);
  });

  it('多日通行证按 dailyDays 计算有效期;缺 createdAt 的行跳过', async () => {
    const ctx = extCtx();
    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_d4', userId: 'u7', planKey: 'day_pass',
      amountTotal: 1500, currency: 'usd', createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
      metadata: { dailyDays: '3' },
    });
    expect(await isDailyPassActive(ctx, 'u7', 'day_pass')).toBe(true);

    await ctx.storage.insertPurchase({
      stripeSessionId: 'cs_d5', userId: 'u8', planKey: 'day_pass',
      amountTotal: 500, currency: 'usd', metadata: { dailyDays: '1' },
    });
    expect(await isDailyPassActive(ctx, 'u8', 'day_pass')).toBe(false);
  });
});

describe('单次试用套餐(first_trial)', () => {
  it('hasSubscribedPlan 只看指定 planKey', async () => {
    const ctx = extCtx();
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_ft1', userId: 'u9', planKey: 'first_taste',
      status: 'canceled', currentPeriodEnd: null, cancelAtPeriodEnd: false, raw: {},
    });
    expect(await hasSubscribedPlan(ctx, 'u9', 'first_taste')).toBe(true);
    expect(await hasSubscribedPlan(ctx, 'u9', 'pro_monthly')).toBe(false);
    expect(await hasSubscribedPlan(ctx, 'u_other', 'first_taste')).toBe(false);
  });

  it('hasUsedFirstTrial 识别 sync 落库的完整 subscription(标记在 raw.metadata)', async () => {
    const ctx = extCtx();
    // 模拟 sync.ts 落库形态:raw = 完整 Stripe subscription 对象
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_ft2', userId: 'u10', planKey: 'first_taste',
      status: 'trialing', currentPeriodEnd: new Date(Date.now() + 14 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false, raw: { id: 'sub_ft2', metadata: { isFirstTrial: 'true' } },
    });
    expect(await hasUsedFirstTrial(ctx, 'u10', 'first_taste')).toBe(true);

    // 普通订阅无标记 → false
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_n1', userId: 'u11', planKey: 'first_taste',
      status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false, raw: { metadata: {} },
    });
    expect(await hasUsedFirstTrial(ctx, 'u11', 'first_taste')).toBe(false);
  });
});

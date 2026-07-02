import { describe, expect, it } from 'vitest';
import { createBillingContext } from './config.js';
import { getEntitlements, hasAccess } from './entitlements.js';
import { testConfig } from './testing.js';

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

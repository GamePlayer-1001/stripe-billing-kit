import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import { getCatalog, invalidateCatalogCache, resolvePriceId } from './catalog.js';
import { testConfig } from './testing.js';

function stubPrices(ctx: ReturnType<typeof createBillingContext>) {
  const product = {
    name: 'Pro',
    description: 'Pro plan',
    marketing_features: [{ name: 'Feature A' }, { name: 'Feature B' }],
    images: [],
    deleted: undefined,
  };
  const list = vi.fn().mockResolvedValue({
    data: [
      {
        id: 'price_pro_m',
        lookup_key: 'pro_monthly',
        active: true,
        currency: 'usd',
        unit_amount: 1900,
        recurring: { interval: 'month', interval_count: 1, trial_period_days: null },
        product,
      },
    ],
  });
  const retrieve = vi.fn().mockResolvedValue({
    id: 'price_life_1',
    lookup_key: null,
    active: true,
    currency: 'usd',
    unit_amount: 39900,
    recurring: null,
    product,
  });
  ctx.stripe.prices.list = list as never;
  ctx.stripe.prices.retrieve = retrieve as never;
  return { list, retrieve };
}

describe('catalog', () => {
  it('lookup_key 与 price_id 两种引用都能组装,且缓存生效', async () => {
    const ctx = createBillingContext(testConfig());
    const { list, retrieve } = stubPrices(ctx);

    const catalog = await getCatalog(ctx);
    expect(catalog.plans).toHaveLength(2);

    const pro = catalog.plans.find((p) => p.key === 'pro_monthly')!;
    expect(pro.price.unitAmount).toBe(1900);
    expect(pro.price.interval).toBe('month');
    expect(pro.product.marketingFeatures).toEqual(['Feature A', 'Feature B']);

    const life = catalog.plans.find((p) => p.key === 'lifetime')!;
    expect(life.price.unitAmount).toBe(39900);
    expect(life.price.interval).toBeNull();

    // 第二次调用命中缓存,不再打 Stripe
    await getCatalog(ctx);
    expect(list).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('invalidateCatalogCache 强制回源', async () => {
    const ctx = createBillingContext(testConfig());
    const { list } = stubPrices(ctx);

    await getCatalog(ctx);
    invalidateCatalogCache(ctx);
    await getCatalog(ctx);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('缺失价格的 plan 被跳过而不是让目录挂掉', async () => {
    const ctx = createBillingContext(
      testConfig({
        plans: [
          { key: 'pro_monthly', type: 'subscription', ref: { lookupKey: 'pro_monthly' }, features: ['pro'] },
          { key: 'ghost', type: 'subscription', ref: { lookupKey: 'ghost_key' }, features: ['ghost'] },
        ],
      }),
    );
    stubPrices(ctx);

    const catalog = await getCatalog(ctx);
    expect(catalog.plans.map((p) => p.key)).toEqual(['pro_monthly']);
  });

  it('resolvePriceId:priceId 直返,lookupKey 经 catalog,未知 planKey 抛错', async () => {
    const ctx = createBillingContext(testConfig());
    stubPrices(ctx);

    expect(await resolvePriceId(ctx, 'lifetime')).toBe('price_life_1');
    expect(await resolvePriceId(ctx, 'pro_monthly')).toBe('price_pro_m');
    await expect(resolvePriceId(ctx, 'nope')).rejects.toThrow(/未知 planKey/);
  });
});

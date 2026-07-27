import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import { reportUsage, getMeterUsage } from './metered.js';
import { BillingError } from './errors.js';
import { testConfig } from './testing.js';
import type { PlanDef } from './config.js';

const METERED_PLANS: PlanDef[] = [
  { key: 'pro_monthly', type: 'subscription', ref: { priceId: 'price_sub' }, features: ['pro'] },
  { key: 'metered_tokens', type: 'metered', ref: { priceId: 'price_meter' }, features: ['api'], meterEventName: 'tokens', meterId: 'mtr_1' },
  { key: 'metered_no_id', type: 'metered', ref: { priceId: 'price_meter2' }, features: ['api'], meterEventName: 'calls' },
];

function setup() {
  const ctx = createBillingContext(testConfig({ plans: METERED_PLANS }));
  const meterCreate = vi.fn().mockResolvedValue({ identifier: 'me_1' });
  ctx.stripe.v2.billing.meterEvents.create = meterCreate as never;
  return { ctx, meterCreate };
}

describe('metered: reportUsage', () => {
  it('未知 planKey / 非 metered 类型 / 非法 value → 拒绝', async () => {
    const { ctx } = setup();
    await ctx.storage.upsertCustomer({ userId: 'u1', stripeCustomerId: 'cus_1' });

    await expect(reportUsage(ctx, { userId: 'u1', planKey: 'nope', value: 1 })).rejects.toThrow(/未知 planKey/);
    await expect(reportUsage(ctx, { userId: 'u1', planKey: 'pro_monthly', value: 1 })).rejects.toThrow(/不是 metered 类型/);
    await expect(reportUsage(ctx, { userId: 'u1', planKey: 'metered_tokens', value: 0 })).rejects.toThrow(BillingError);
    await expect(reportUsage(ctx, { userId: 'u1', planKey: 'metered_tokens', value: 1.5 })).rejects.toThrow(/正整数/);
    await expect(reportUsage(ctx, { userId: 'u1', planKey: 'metered_tokens', value: -3 })).rejects.toThrow(/正整数/);
  });

  it('上报事件:event_name/payload/秒级幂等 key 正确', async () => {
    const { ctx, meterCreate } = setup();
    await ctx.storage.upsertCustomer({ userId: 'u1', stripeCustomerId: 'cus_1' });

    const result = await reportUsage(ctx, { userId: 'u1', planKey: 'metered_tokens', value: 42, timestamp: 1_800_000_000 });
    expect(result).toEqual({ eventId: 'me_1', timestamp: 1_800_000_000 });

    const [params, options] = meterCreate.mock.calls[0]!;
    expect(params.event_name).toBe('tokens');
    expect(params.payload).toEqual({ value: '42', stripe_customer_id: 'cus_1' });
    expect(params.timestamp).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(options.idempotencyKey).toBe('bk:usage:u1:metered_tokens:1800000000');
  });

  it('附加 dimensions 合并进 payload;无 customer 记录时自动创建', async () => {
    const { ctx, meterCreate } = setup();
    ctx.stripe.customers.create = vi.fn().mockResolvedValue({ id: 'cus_auto' }) as never;

    await reportUsage(ctx, { userId: 'u_new', planKey: 'metered_tokens', value: 7, dimensions: { model: 'gpt' } });
    const [params] = meterCreate.mock.calls[0]!;
    expect(params.payload).toEqual({ value: '7', stripe_customer_id: 'cus_auto', model: 'gpt' });
    expect(ctx.stripe.customers.create).toHaveBeenCalledTimes(1);
  });
});

describe('metered: getMeterUsage', () => {
  it('未设置 meterId → config 错误', async () => {
    const { ctx } = setup();
    await ctx.storage.upsertCustomer({ userId: 'u1', stripeCustomerId: 'cus_1' });
    await expect(getMeterUsage(ctx, { userId: 'u1', planKey: 'metered_no_id' })).rejects.toThrow(/未设置 meterId/);
  });

  it('汇总周期内 aggregated_value,支持 ISO/Unix 两种周期参数', async () => {
    const { ctx } = setup();
    await ctx.storage.upsertCustomer({ userId: 'u1', stripeCustomerId: 'cus_1' });
    const listSummaries = vi.fn().mockResolvedValue({
      data: [{ aggregated_value: 100 }, { aggregated_value: 23 }],
    });
    ctx.stripe.billing.meters.listEventSummaries = listSummaries as never;

    const result = await getMeterUsage(ctx, {
      userId: 'u1',
      planKey: 'metered_tokens',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: 1_800_000_000,
    });
    expect(result.totalUsage).toBe(123);
    expect(result.periodStart).toBe('2026-07-01T00:00:00.000Z');
    expect(result.periodEnd).toBe(new Date(1_800_000_000 * 1000).toISOString());

    const [meterId, query] = listSummaries.mock.calls[0]!;
    expect(meterId).toBe('mtr_1');
    expect(query).toMatchObject({ customer: 'cus_1', end_time: 1_800_000_000 });
  });
});

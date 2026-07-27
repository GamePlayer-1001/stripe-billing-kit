import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import { reconcile } from './reconcile.js';
import { testConfig } from './testing.js';

/** 构造带 N 个已落库 customer 的 ctx,并 mock subscriptions.list */
async function setup(customerCount: number) {
  const ctx = createBillingContext(testConfig());
  for (let i = 0; i < customerCount; i++) {
    await ctx.storage.upsertCustomer({ userId: `u${String(i).padStart(3, '0')}`, stripeCustomerId: `cus_${i}` });
  }
  const subscriptionsList = vi.fn().mockImplementation((params: { customer: string }) =>
    Promise.resolve({
      data: [
        {
          id: `sub_for_${params.customer}`,
          status: 'active',
          cancel_at_period_end: false,
          metadata: { planKey: 'pro_monthly' },
          items: { data: [{ current_period_end: 1_800_000_000, price: { id: 'price_x', lookup_key: 'pro_monthly' } }] },
        },
      ],
    }),
  );
  ctx.stripe.subscriptions.list = subscriptionsList as never;
  return { ctx, subscriptionsList };
}

describe('reconcile', () => {
  it('遍历全部 customer 并把 Stripe 订阅真相写回本地', async () => {
    const { ctx, subscriptionsList } = await setup(3);
    const report = await reconcile(ctx, { delayMs: 0 });

    expect(report.customers).toBe(3);
    expect(report.synced).toBe(3);
    expect(report.failed).toBe(0);
    expect(subscriptionsList).toHaveBeenCalledTimes(3);

    // 漂移已修复:本地能查到 active 订阅
    const rows = await ctx.storage.getEntitlementRows('u001');
    expect(rows.subs[0]?.status).toBe('active');
    expect(rows.subs[0]?.planKey).toBe('pro_monthly');
  });

  it('分页遍历不漏行(pageSize 小于总数)', async () => {
    const { ctx } = await setup(5);
    const report = await reconcile(ctx, { pageSize: 2, delayMs: 0 });
    expect(report.customers).toBe(5);
    expect(report.synced).toBe(5);
  });

  it('单个 customer 失败不中断,计入 failed', async () => {
    const { ctx, subscriptionsList } = await setup(3);
    subscriptionsList.mockRejectedValueOnce(new Error('stripe boom'));

    const report = await reconcile(ctx, { delayMs: 0 });
    expect(report.customers).toBe(3);
    expect(report.synced).toBe(2);
    expect(report.failed).toBe(1);
  });

  it('onProgress 每个 customer 回调一次', async () => {
    const { ctx } = await setup(2);
    const onProgress = vi.fn();
    await reconcile(ctx, { delayMs: 0, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 0);
  });

  it('storage 未实现 listCustomers 时报 config 错', async () => {
    const config = testConfig();
    delete (config.storage as { listCustomers?: unknown }).listCustomers;
    const ctx = createBillingContext(config);
    await expect(reconcile(ctx)).rejects.toMatchObject({ code: 'config' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import { handleWebhookRequest } from './webhook.js';
import { handleBillingRequest } from './http.js';
import { BillingError } from './errors.js';
import { testConfig } from './testing.js';

function stubEvent(ctx: ReturnType<typeof createBillingContext>, event: object) {
  ctx.stripe.webhooks.constructEventAsync = vi.fn().mockResolvedValue(event) as never;
}

describe('webhook 管线', () => {
  it('缺签名/验签失败 → webhook_verification 错误', async () => {
    const ctx = createBillingContext(testConfig());
    await expect(handleWebhookRequest(ctx, '{}', null)).rejects.toThrow(BillingError);

    ctx.stripe.webhooks.constructEventAsync = vi.fn().mockRejectedValue(new Error('bad sig')) as never;
    await expect(handleWebhookRequest(ctx, '{}', 't=1,v1=x')).rejects.toThrow(/验签失败/);
  });

  it('同一 event.id 只处理一次(幂等)', async () => {
    const config = testConfig();
    const hook = vi.fn();
    config.hooks = { onCheckoutCompleted: hook };
    const ctx = createBillingContext(config);

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'payment',
          customer: 'cus_1',
          client_reference_id: 'u1',
          metadata: { userId: 'u1', planKey: 'lifetime' },
          amount_total: 39900,
          currency: 'usd',
        },
      },
    };
    stubEvent(ctx, event);

    const first = await handleWebhookRequest(ctx, '{}', 'sig');
    expect(first).toEqual({ received: true });

    const second = await handleWebhookRequest(ctx, '{}', 'sig');
    expect(second).toEqual({ received: true, duplicate: true });

    // 业务只执行了一次
    expect(hook).toHaveBeenCalledTimes(1);
    const rows = await ctx.storage.getEntitlementRows('u1');
    expect(rows.purchases).toHaveLength(1);
  });

  it('买断 checkout.session.completed 落 purchase 并触发钩子', async () => {
    const config = testConfig();
    const hook = vi.fn();
    config.hooks = { onCheckoutCompleted: hook };
    const ctx = createBillingContext(config);

    stubEvent(ctx, {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          mode: 'payment',
          customer: 'cus_2',
          client_reference_id: 'u2',
          metadata: { userId: 'u2', planKey: 'lifetime' },
          amount_total: 39900,
          currency: 'usd',
        },
      },
    });

    await handleWebhookRequest(ctx, '{}', 'sig');
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u2', planKey: 'lifetime', mode: 'payment' }),
    );
    const rows = await ctx.storage.getEntitlementRows('u2');
    expect(rows.purchases[0]?.amountTotal).toBe(39900);
  });

  it('订阅事件走 syncStripeToDb 并触发 changed/canceled 钩子', async () => {
    const config = testConfig();
    const changed = vi.fn();
    const canceled = vi.fn();
    config.hooks = { onSubscriptionChanged: changed, onSubscriptionCanceled: canceled };
    const ctx = createBillingContext(config);

    await ctx.storage.upsertCustomer({ userId: 'u3', stripeCustomerId: 'cus_3' });
    ctx.stripe.subscriptions.list = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'sub_1',
          status: 'active',
          cancel_at_period_end: false,
          metadata: { userId: 'u3', planKey: 'pro_monthly' },
          items: {
            data: [
              {
                current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
                price: { id: 'price_pro_m', lookup_key: 'pro_monthly' },
              },
            ],
          },
        },
      ],
    }) as never;

    stubEvent(ctx, {
      id: 'evt_3',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer: 'cus_3', status: 'active', cancel_at_period_end: false, metadata: { planKey: 'pro_monthly' } } },
    });
    await handleWebhookRequest(ctx, '{}', 'sig');
    expect(changed).toHaveBeenCalledTimes(1);

    const rows = await ctx.storage.getEntitlementRows('u3');
    expect(rows.subs[0]).toMatchObject({ planKey: 'pro_monthly', status: 'active' });

    stubEvent(ctx, {
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_3', status: 'canceled', cancel_at_period_end: false, metadata: {} } },
    });
    await handleWebhookRequest(ctx, '{}', 'sig');
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('price.updated 使 catalog 缓存失效', async () => {
    const ctx = createBillingContext(testConfig());
    const list = vi.fn().mockResolvedValue({ data: [] });
    ctx.stripe.prices.list = list as never;
    ctx.stripe.prices.retrieve = vi.fn().mockRejectedValue(new Error('nope')) as never;

    const { getCatalog } = await import('./catalog.js');
    await getCatalog(ctx);
    await getCatalog(ctx);
    expect(list).toHaveBeenCalledTimes(1);

    stubEvent(ctx, { id: 'evt_5', type: 'price.updated', data: { object: {} } });
    await handleWebhookRequest(ctx, '{}', 'sig');

    await getCatalog(ctx);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('未知事件 ignored 但仍 200', async () => {
    const ctx = createBillingContext(testConfig());
    stubEvent(ctx, { id: 'evt_6', type: 'customer.created', data: { object: {} } });
    const result = await handleWebhookRequest(ctx, '{}', 'sig');
    expect(result).toEqual({ received: true, ignored: true });
  });
});

describe('HTTP 契约', () => {
  it('未登录 checkout/me/portal → 401;非法 planKey → 400;未知路径 → 404', async () => {
    const config = testConfig();
    const ctx = createBillingContext(config);
    ctx.stripe.prices.list = vi.fn().mockResolvedValue({ data: [] }) as never;
    ctx.stripe.prices.retrieve = vi.fn().mockRejectedValue(new Error('nope')) as never;

    const base = { headers: {}, userId: null } as const;

    expect((await handleBillingRequest(config, { ...base, method: 'POST', path: 'checkout', jsonBody: { planKey: 'pro_monthly' } })).status).toBe(401);
    expect((await handleBillingRequest(config, { ...base, method: 'GET', path: 'me' })).status).toBe(401);
    expect((await handleBillingRequest(config, { ...base, method: 'POST', path: 'portal' })).status).toBe(401);

    const badPlan = await handleBillingRequest(config, {
      ...base,
      userId: 'u1',
      method: 'POST',
      path: 'checkout',
      jsonBody: { planKey: '' },
    });
    expect(badPlan.status).toBe(400);

    expect((await handleBillingRequest(config, { ...base, method: 'GET', path: 'nope' })).status).toBe(404);
  });

  it('webhook 验签失败经 HTTP 层返回 400,缺 raw body 返回 500', async () => {
    const config = testConfig();
    const ctx = createBillingContext(config);
    ctx.stripe.webhooks.constructEventAsync = vi.fn().mockRejectedValue(new Error('bad')) as never;

    const badSig = await handleBillingRequest(config, {
      method: 'POST',
      path: 'webhook',
      headers: { 'stripe-signature': 'sig' },
      rawBody: '{}',
      userId: null,
    });
    expect(badSig.status).toBe(400);

    const noRaw = await handleBillingRequest(config, {
      method: 'POST',
      path: 'webhook',
      headers: {},
      userId: null,
    });
    expect(noRaw.status).toBe(500);
  });

  it('登录用户 GET me 返回权益结构', async () => {
    const config = testConfig();
    const res = await handleBillingRequest(config, { method: 'GET', path: 'me', headers: {}, userId: 'u9' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entitlements: [], hasAccess: { pro: false, lifetime: false } });
  });
});

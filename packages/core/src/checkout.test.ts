import { describe, expect, it, vi } from 'vitest';
import { createBillingContext } from './config.js';
import { createCheckoutSession } from './checkout.js';
import { BillingError } from './errors.js';
import { testConfig } from './testing.js';
import type { BillingConfig, PlanDef } from './config.js';

/** 覆盖全部 9 种模式的套餐表(全部用 priceId,避免 mock prices.list) */
const ALL_MODE_PLANS: PlanDef[] = [
  { key: 'pro_monthly', type: 'subscription', ref: { priceId: 'price_sub' }, features: ['pro'] },
  { key: 'lifetime', type: 'one_time', ref: { priceId: 'price_life' }, features: ['pro', 'lifetime'] },
  { key: 'trial_card', type: 'trial_then_subscribe', ref: { priceId: 'price_trial' }, features: ['pro'], trialDays: 7 },
  { key: 'trial_free', type: 'trial_no_convert', ref: { priceId: 'price_trial2' }, features: ['pro'], trialDays: 3 },
  { key: 'metered_tokens', type: 'metered', ref: { priceId: 'price_meter' }, features: ['api'], meterEventName: 'tokens' },
  { key: 'credits_100', type: 'credit_package', ref: { priceId: 'price_credit' }, features: ['credits'], creditAmount: 100 },
  { key: 'credits_any', type: 'credit_variable', ref: { priceId: 'price_var' }, features: ['credits'], variableProductId: 'prod_var' },
  { key: 'day_pass', type: 'daily', ref: { priceId: 'price_day' }, features: ['pro'] },
  { key: 'first_taste', type: 'first_trial', ref: { priceId: 'price_first' }, features: ['pro'], trialDays: 14, trialConvertsTo: 'pro_monthly' },
];

function setup(overrides?: Partial<BillingConfig>) {
  const config = testConfig({ plans: ALL_MODE_PLANS, ...overrides });
  const ctx = createBillingContext(config);
  const sessionsCreate = vi.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' });
  ctx.stripe.checkout.sessions.create = sessionsCreate as never;
  ctx.stripe.customers.create = vi.fn().mockResolvedValue({ id: 'cus_new' }) as never;
  return { ctx, sessionsCreate };
}

/** 取 sessions.create 第 n 次调用的(params, options) */
function callOf(fn: ReturnType<typeof vi.fn>, n = 0) {
  return { params: fn.mock.calls[n]?.[0], options: fn.mock.calls[n]?.[1] };
}

describe('checkout: 通用行为', () => {
  it('未知 planKey → invalid_plan(服务端白名单)', async () => {
    const { ctx } = setup();
    await expect(createCheckoutSession(ctx, { userId: 'u1', planKey: 'price_直传' })).rejects.toThrow(BillingError);
    await expect(createCheckoutSession(ctx, { userId: 'u1', planKey: 'nope' })).rejects.toThrow(/未知 planKey/);
  });

  it('复用已有 customer,不重复创建;返回 url + sessionId', async () => {
    const { ctx, sessionsCreate } = setup();
    await ctx.storage.upsertCustomer({ userId: 'u1', stripeCustomerId: 'cus_exist' });

    const result = await createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/cs_test_1', sessionId: 'cs_test_1' });
    expect(ctx.stripe.customers.create).not.toHaveBeenCalled();
    expect(callOf(sessionsCreate).params.customer).toBe('cus_exist');
  });

  it('携带分钟级幂等 key(含 userId + planKey)', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly' });
    const { options } = callOf(sessionsCreate);
    expect(options.idempotencyKey).toMatch(/^bk:checkout:u1:pro_monthly:fixed:\d+$/);
  });

  it('successUrl/cancelUrl 支持 per-request 覆盖,默认取 config.urls', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly' });
    expect(callOf(sessionsCreate, 0).params.success_url).toBe('https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}');

    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly', successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' });
    expect(callOf(sessionsCreate, 1).params.success_url).toBe('https://x.test/ok');
    expect(callOf(sessionsCreate, 1).params.cancel_url).toBe('https://x.test/no');
  });

  it('Stripe 未返回 url → stripe 错误', async () => {
    const { ctx } = setup();
    ctx.stripe.checkout.sessions.create = vi.fn().mockResolvedValue({ id: 'cs_x', url: null }) as never;
    await expect(createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly' })).rejects.toThrow(/未返回 checkout url/);
  });
});

describe('checkout: 9 种模式参数构建', () => {
  it('subscription → mode=subscription,metadata 带 userId/planKey', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'pro_monthly' });
    const { params } = callOf(sessionsCreate);
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([{ price: 'price_sub', quantity: 1 }]);
    expect(params.client_reference_id).toBe('u1');
    expect(params.subscription_data.metadata).toEqual({ userId: 'u1', planKey: 'pro_monthly' });
  });

  it('one_time → mode=payment,quantity 可指定', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'lifetime', quantity: 2 });
    const { params } = callOf(sessionsCreate);
    expect(params.mode).toBe('payment');
    expect(params.line_items).toEqual([{ price: 'price_life', quantity: 2 }]);
    expect(params.payment_intent_data.metadata).toEqual({ userId: 'u1', planKey: 'lifetime' });
  });

  it('trial_then_subscribe → 强制绑卡 + trial_period_days', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'trial_card' });
    const { params } = callOf(sessionsCreate);
    expect(params.payment_method_collection).toBe('always');
    expect(params.subscription_data.trial_period_days).toBe(7);
  });

  it('trial_no_convert → 不强制绑卡,试用结束自动 cancel', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'trial_free' });
    const { params } = callOf(sessionsCreate);
    expect(params.payment_method_collection).toBe('if_required');
    expect(params.subscription_data.trial_settings).toEqual({ end_behavior: { missing_payment_method: 'cancel' } });
    expect(params.allow_promotion_codes).toBe(false);
  });

  it('metered → line_items 不带 quantity(由 Meter 汇总)', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'metered_tokens' });
    const { params } = callOf(sessionsCreate);
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([{ price: 'price_meter' }]);
  });

  it('credit_package → metadata.creditAmount = 点数 × quantity', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'credits_100', quantity: 3 });
    const { params } = callOf(sessionsCreate);
    expect(params.mode).toBe('payment');
    expect(params.metadata.creditAmount).toBe('300');
    expect(params.payment_intent_data.metadata.creditAmount).toBe('300');
  });

  it('credit_variable → 动态 price_data;缺 amount 报错;幂等 key 区分金额', async () => {
    const { ctx, sessionsCreate } = setup();
    await expect(createCheckoutSession(ctx, { userId: 'u1', planKey: 'credits_any' })).rejects.toThrow(/有效的 amount/);
    await expect(createCheckoutSession(ctx, { userId: 'u1', planKey: 'credits_any', amount: -5 })).rejects.toThrow(BillingError);

    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'credits_any', amount: 500 });
    const { params, options } = callOf(sessionsCreate);
    expect(params.line_items[0].price_data).toMatchObject({ product: 'prod_var', unit_amount: 500 });
    expect(params.metadata.amountCents).toBe('500');
    expect(options.idempotencyKey).toContain(':credits_any:500:');
  });

  it('daily → mode=payment,metadata.dailyDays = quantity', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'day_pass', quantity: 2 });
    const { params } = callOf(sessionsCreate);
    expect(params.mode).toBe('payment');
    expect(params.metadata.dailyDays).toBe('2');
  });

  it('first_trial → 带 isFirstTrial 标记;已订阅过同套餐则拒绝', async () => {
    const { ctx, sessionsCreate } = setup();
    await createCheckoutSession(ctx, { userId: 'u1', planKey: 'first_taste' });
    const { params } = callOf(sessionsCreate);
    expect(params.subscription_data.metadata.isFirstTrial).toBe('true');
    expect(params.metadata.trialConvertsTo).toBe('pro_monthly');
    expect(params.payment_method_collection).toBe('always');

    // u2 已订阅过 first_taste(哪怕已 canceled)→ 不可重复订阅
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: 'sub_ft',
      userId: 'u2',
      planKey: 'first_taste',
      status: 'canceled',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      raw: {},
    });
    await expect(createCheckoutSession(ctx, { userId: 'u2', planKey: 'first_taste' })).rejects.toThrow(/已订阅过/);
    // 其他用户不受影响
    await expect(createCheckoutSession(ctx, { userId: 'u3', planKey: 'first_taste' })).resolves.toBeTruthy();
  });
});

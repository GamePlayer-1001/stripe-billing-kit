import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';
import { resolvePriceId } from './catalog.js';
import { getOrCreateCustomer } from './customers.js';

export interface CreateCheckoutInput {
  userId: string;
  planKey: string;
  quantity?: number;
}

export interface CreateCheckoutResult {
  url: string;
  sessionId: string;
}

/**
 * 创建 Stripe 托管 Checkout 会话。
 * 安全:planKey 必须在 config.plans 白名单内,由服务端解析为 price,拒绝客户端直传 price_id。
 */
export async function createCheckoutSession(
  ctx: BillingContext,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const plan = ctx.plansByKey.get(input.planKey);
  if (!plan) throw new BillingError('invalid_plan', `未知 planKey:${input.planKey}`);

  const priceId = await resolvePriceId(ctx, plan.key);
  const customerId = await getOrCreateCustomer(ctx, input.userId);
  const quantity = input.quantity ?? 1;

  const session = await ctx.stripe.checkout.sessions.create(
    {
      mode: plan.type === 'subscription' ? 'subscription' : 'payment',
      customer: customerId,
      client_reference_id: input.userId,
      line_items: [{ price: priceId, quantity }],
      success_url: ctx.config.urls.checkoutSuccess,
      cancel_url: ctx.config.urls.checkoutCancel,
      allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
      metadata: { userId: input.userId, planKey: plan.key },
      ...(plan.type === 'subscription'
        ? { subscription_data: { metadata: { userId: input.userId, planKey: plan.key } } }
        : {}),
    },
    {
      // 出站幂等:分钟级时间桶,同一用户同一套餐一分钟内重复点击不会开两个会话
      idempotencyKey: `bk:checkout:${input.userId}:${plan.key}:${Math.floor(Date.now() / 60_000)}`,
    },
  );

  if (!session.url) throw new BillingError('stripe', 'Stripe 未返回 checkout url');
  ctx.logger.info('billing.checkout.created', { userId: input.userId, planKey: plan.key, sessionId: session.id });
  return { url: session.url, sessionId: session.id };
}

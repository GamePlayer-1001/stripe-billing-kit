import type Stripe from 'stripe';
import type { BillingContext } from './config.js';
import { resolveUserByCustomerId } from './customers.js';
import { BillingError } from './errors.js';

/** price → planKey 反查:优先 lookup_key,其次 price_id,最后 subscription metadata 兜底 */
function resolvePlanKey(ctx: BillingContext, price: Stripe.Price | undefined, metadataPlanKey?: string): string | null {
  if (price) {
    for (const plan of ctx.config.plans) {
      const ref = plan.ref as { lookupKey?: string; priceId?: string };
      if (ref.lookupKey && price.lookup_key === ref.lookupKey) return plan.key;
      if (ref.priceId && price.id === ref.priceId) return plan.key;
    }
  }
  if (metadataPlanKey && ctx.plansByKey.has(metadataPlanKey)) return metadataPlanKey;
  return null;
}

/**
 * API 2025-03-31.basil 起 current_period_end 从 Subscription 移到了 SubscriptionItem。
 * 取所有 item 的最大周期结束时间。
 */
function periodEndOf(sub: Stripe.Subscription): Date | null {
  let max = 0;
  for (const item of sub.items.data) {
    if (item.current_period_end && item.current_period_end > max) max = item.current_period_end;
  }
  return max > 0 ? new Date(max * 1000) : null;
}

/**
 * ★ 全套件唯一的订阅状态写入口。
 * 从 Stripe 拉取该 customer 的订阅真相并 upsert 本地表(本地库只是读副本)。
 * webhook 与成功回跳页都调它;幂等,可重复调用。
 */
export async function syncStripeToDb(ctx: BillingContext, stripeCustomerId: string): Promise<void> {
  const userId = await resolveUserByCustomerId(ctx, stripeCustomerId);
  if (!userId) {
    ctx.logger.warn('billing.sync.user_not_found', { stripeCustomerId });
    return;
  }

  const subs = await ctx.stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 10,
    expand: ['data.items.data.price'],
  });

  for (const sub of subs.data) {
    const price = sub.items.data[0]?.price;
    const planKey = resolvePlanKey(ctx, price, sub.metadata?.planKey);
    await ctx.storage.upsertSubscription({
      stripeSubscriptionId: sub.id,
      userId,
      planKey: planKey ?? 'unknown',
      status: sub.status,
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      raw: sub,
    });
  }

  ctx.logger.info('billing.sync.done', { stripeCustomerId, userId, count: subs.data.length });
}

/**
 * 成功回跳页兜底:按 checkout session id 同步。
 * 订阅 → syncStripeToDb;买断 → 落 purchase(幂等)。权益授予依然以 webhook 为准,这里只是防延迟。
 */
export async function syncCheckoutSession(ctx: BillingContext, sessionId: string): Promise<void> {
  if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) {
    throw new BillingError('invalid_plan', '非法的 checkout session id');
  }
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);
  if (session.status !== 'complete') {
    ctx.logger.info('billing.sync.session_not_complete', { sessionId, status: session.status });
    return;
  }

  const userId = session.metadata?.userId ?? session.client_reference_id ?? null;
  const planKey = session.metadata?.planKey ?? null;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

  if (session.mode === 'payment' && userId && planKey) {
    await ctx.storage.insertPurchase({
      stripeSessionId: session.id,
      userId,
      planKey,
      amountTotal: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    });
  }
  if (customerId) await syncStripeToDb(ctx, customerId);
}

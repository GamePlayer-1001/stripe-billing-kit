import type { BillingContext } from './config.js';

/** 取或建 user ↔ Stripe customer 映射(每产品一行/用户) */
export async function getOrCreateCustomer(ctx: BillingContext, userId: string): Promise<string> {
  const existing = await ctx.storage.getCustomerByUserId(userId);
  if (existing) return existing.stripeCustomerId;

  const customer = await ctx.stripe.customers.create(
    { metadata: { userId } },
    { idempotencyKey: `bk:customer:${userId}` },
  );
  await ctx.storage.upsertCustomer({ userId, stripeCustomerId: customer.id });
  ctx.logger.info('billing.customer.created', { userId, stripeCustomerId: customer.id });
  return customer.id;
}

/** stripe customer id → userId(webhook 场景反查;库里没有则回查 Stripe metadata 兜底) */
export async function resolveUserByCustomerId(ctx: BillingContext, stripeCustomerId: string): Promise<string | null> {
  const row = await ctx.storage.getCustomerByStripeCustomerId(stripeCustomerId);
  if (row) return row.userId;

  try {
    const customer = await ctx.stripe.customers.retrieve(stripeCustomerId);
    if (!customer.deleted && customer.metadata?.userId) {
      await ctx.storage.upsertCustomer({ userId: customer.metadata.userId, stripeCustomerId });
      return customer.metadata.userId;
    }
  } catch (err) {
    ctx.logger.warn('billing.customer.resolve_failed', { stripeCustomerId, err: String(err) });
  }
  return null;
}

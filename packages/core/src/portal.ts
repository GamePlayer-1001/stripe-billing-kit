import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';

/** 创建 Customer Portal 会话(升降级/取消/换卡都在 Portal 里完成) */
export async function createPortalSession(ctx: BillingContext, userId: string): Promise<{ url: string }> {
  const customer = await ctx.storage.getCustomerByUserId(userId);
  if (!customer) {
    throw new BillingError('no_customer', '该用户尚无 Stripe customer(从未发起过支付)');
  }
  const session = await ctx.stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: ctx.config.urls.portalReturn,
  });
  return { url: session.url };
}

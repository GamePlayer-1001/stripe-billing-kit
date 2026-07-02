import type Stripe from 'stripe';
import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';
import { invalidateCatalogCache } from './catalog.js';
import { syncStripeToDb } from './sync.js';
import { resolveUserByCustomerId } from './customers.js';

export interface WebhookResult {
  received: true;
  duplicate?: boolean;
  ignored?: boolean;
}

function customerIdOf(obj: { customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null }): string | null {
  if (!obj.customer) return null;
  return typeof obj.customer === 'string' ? obj.customer : obj.customer.id;
}

async function handleCheckoutCompleted(ctx: BillingContext, event: Stripe.CheckoutSessionCompletedEvent): Promise<void> {
  const session = event.data.object;
  const userId = session.metadata?.userId ?? session.client_reference_id ?? null;
  const planKey = session.metadata?.planKey ?? null;
  const customerId = customerIdOf(session);

  if (session.mode === 'payment') {
    if (userId && planKey) {
      await ctx.storage.insertPurchase({
        stripeSessionId: session.id,
        userId,
        planKey,
        amountTotal: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
      });
    } else {
      ctx.logger.warn('billing.webhook.purchase_missing_metadata', { sessionId: session.id });
    }
  } else if (customerId) {
    await syncStripeToDb(ctx, customerId);
  }

  if (userId && planKey) {
    await ctx.config.hooks?.onCheckoutCompleted?.({
      userId,
      planKey,
      mode: session.mode === 'payment' ? 'payment' : 'subscription',
      sessionId: session.id,
      amountTotal: session.amount_total,
      currency: session.currency,
    });
  }
}

async function handleSubscriptionEvent(
  ctx: BillingContext,
  event:
    | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent,
): Promise<void> {
  const sub = event.data.object;
  const customerId = customerIdOf(sub);
  if (!customerId) return;

  await syncStripeToDb(ctx, customerId);

  const userId = await resolveUserByCustomerId(ctx, customerId);
  if (!userId) return;

  const hookCtx = {
    userId,
    planKey: sub.metadata?.planKey ?? null,
    status: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    stripeSubscriptionId: sub.id,
  };
  if (event.type === 'customer.subscription.deleted') {
    await ctx.config.hooks?.onSubscriptionCanceled?.(hookCtx);
  } else {
    await ctx.config.hooks?.onSubscriptionChanged?.(hookCtx);
  }
}

async function handleInvoiceEvent(
  ctx: BillingContext,
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
): Promise<void> {
  const invoice = event.data.object;
  const customerId = customerIdOf(invoice);
  if (!customerId) return;

  await syncStripeToDb(ctx, customerId);

  if (event.type === 'invoice.payment_failed') {
    const userId = await resolveUserByCustomerId(ctx, customerId);
    await ctx.config.hooks?.onPaymentFailed?.({
      userId,
      stripeCustomerId: customerId,
      invoiceId: invoice.id ?? '',
    });
  }
}

/**
 * Webhook 处理管线(顺序固定,见 ARCHITECTURE.md 4.5):
 * verify(raw body) → claimEvent 幂等 → dispatch → 200
 * 抛 BillingError('webhook_verification') 时适配器应返回 400;其余错误 500 让 Stripe 重试(幂等表保证不双发)。
 */
export async function handleWebhookRequest(
  ctx: BillingContext,
  rawBody: string | Buffer,
  signature: string | null,
): Promise<WebhookResult> {
  if (!signature) throw new BillingError('webhook_verification', '缺少 stripe-signature 请求头');

  let event: Stripe.Event;
  try {
    event = await ctx.stripe.webhooks.constructEventAsync(rawBody, signature, ctx.config.stripe.webhookSecret);
  } catch (err) {
    throw new BillingError('webhook_verification', `webhook 验签失败:${String(err)}`);
  }

  const firstClaim = await ctx.storage.claimEvent(event.id, event.type);
  if (!firstClaim) {
    ctx.logger.info('billing.webhook.duplicate_skipped', { eventId: event.id, type: event.type });
    return { received: true, duplicate: true };
  }

  ctx.logger.info('billing.webhook.received', { eventId: event.id, type: event.type });

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(ctx, event);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await handleSubscriptionEvent(ctx, event);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
      await handleInvoiceEvent(ctx, event);
      break;
    case 'price.created':
    case 'price.updated':
    case 'product.updated':
      invalidateCatalogCache(ctx);
      break;
    default:
      ctx.logger.info('billing.webhook.ignored', { type: event.type });
      return { received: true, ignored: true };
  }

  return { received: true };
}

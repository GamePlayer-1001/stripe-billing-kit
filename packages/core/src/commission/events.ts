/**
 * Webhook 事件接入层（对应 docs/COMMISSION-SYSTEM-SPEC.md 2.3.2 / 5.3）
 *
 * 把 Stripe 事件归一到 TriggerScope 并触发佣金计算：
 * - checkout.session.completed → FIRST_PAYMENT（一次性/额度包/日付/订阅首付）
 * - invoice.paid              → RECURRING_PAYMENT（续期/proration）或 USAGE_INVOICE（metered）
 * - 试用类（trial_no_convert / first_trial / trial_then_subscribe 试用段）→ 不计佣
 *
 * 幂等由引擎层 insertCommission 的唯一键 [orderId, referrerUserId, tierLevel] 保证。
 */
import type Stripe from 'stripe';
import type { BillingContext, PlanType } from '../config.js';
import { resolveUserByCustomerId } from '../customers.js';
import type { CommissionEngine } from './engine.js';
import type { ClawbackResult, CommissionCalculationResult, TriggerScope } from './types.js';

type CheckoutSession = Stripe.CheckoutSessionCompletedEvent['data']['object'];
type Invoice = Stripe.InvoicePaidEvent['data']['object'];
type Charge = Stripe.ChargeRefundedEvent['data']['object'];

/** 试用类 / 按量类在 checkout 阶段不产生付款，不计佣 */
const NO_PAYMENT_AT_CHECKOUT: ReadonlySet<PlanType> = new Set([
  'trial_no_convert',
  'first_trial',
  'trial_then_subscribe',
  'metered',
]);

/**
 * 归一触发场景。
 * @param planType 套餐计费模式
 * @param source   事件来源：checkout=结账完成，invoice=账单支付
 * @param billingReason invoice 的 billing_reason（仅 source=invoice 时有意义）
 * @returns null 表示不计佣
 */
export function resolveTriggerScope(
  planType: PlanType,
  source: 'checkout' | 'invoice',
  billingReason?: string | null,
): TriggerScope | null {
  if (source === 'checkout') {
    if (NO_PAYMENT_AT_CHECKOUT.has(planType)) return null;
    return 'FIRST_PAYMENT';
  }
  // source === 'invoice'
  if (planType === 'metered') return 'USAGE_INVOICE';
  // 订阅首期账单由 checkout.session.completed 处理，避免重复计佣
  if (billingReason === 'subscription_create') return null;
  // subscription_cycle（续期）/ subscription_update（proration 分摊）均按实付计佣
  return 'RECURRING_PAYMENT';
}

function customerIdOf(obj: {
  customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null;
}): string | null {
  if (!obj.customer) return null;
  return typeof obj.customer === 'string' ? obj.customer : obj.customer.id;
}

/** 从 invoice 提取订阅 ID（兼容新版 parent.subscription_details 与旧版 subscription 字段） */
function subscriptionIdOf(invoice: Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (fromParent) return typeof fromParent === 'string' ? fromParent : fromParent.id;
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;
  return null;
}

/**
 * 处理 checkout.session.completed（FIRST_PAYMENT）。
 * 需要 session.metadata 含 userId 与 planKey（core checkout 已注入）。
 */
export async function processCheckoutCompleted(
  ctx: BillingContext,
  engine: CommissionEngine,
  session: CheckoutSession,
): Promise<CommissionCalculationResult | null> {
  const userId = session.metadata?.userId ?? session.client_reference_id ?? null;
  const planKey = session.metadata?.planKey ?? null;
  if (!userId || !planKey) {
    ctx.logger.warn('commission.checkout.missing_metadata', { sessionId: session.id });
    return null;
  }
  const plan = ctx.plansByKey.get(planKey);
  if (!plan) {
    ctx.logger.warn('commission.checkout.unknown_plan', { planKey, sessionId: session.id });
    return null;
  }
  const scope = resolveTriggerScope(plan.type, 'checkout');
  if (!scope) return null; // 试用/按量在结账阶段不计佣

  const amount = session.amount_total ?? 0;
  if (amount <= 0) return null;

  return engine.calculateCommissions({
    userId,
    orderId: session.id,
    planKey,
    planType: plan.type,
    triggerScope: scope,
    amountTotal: amount,
    currency: (session.currency ?? 'usd').toUpperCase(),
    periodIndex: 1,
  });
}

/**
 * 处理 invoice.paid（RECURRING_PAYMENT / USAGE_INVOICE）。
 * planKey 取自订阅 metadata；userId 由 customer 反查。
 */
export async function processInvoicePaid(
  ctx: BillingContext,
  engine: CommissionEngine,
  invoice: Invoice,
): Promise<CommissionCalculationResult | null> {
  const customerId = customerIdOf(invoice);
  if (!customerId) return null;
  const userId = await resolveUserByCustomerId(ctx, customerId);
  if (!userId) {
    ctx.logger.warn('commission.invoice.user_unresolved', { invoiceId: invoice.id });
    return null;
  }

  // 取订阅以拿 planKey 与 billing_reason
  let planKey: string | null = invoice.metadata?.planKey ?? null;
  let billingReason: string | null = invoice.billing_reason ?? null;
  const subId = subscriptionIdOf(invoice);
  if (subId) {
    try {
      const sub = await ctx.stripe.subscriptions.retrieve(subId);
      planKey = planKey ?? sub.metadata?.planKey ?? null;
      billingReason = billingReason ?? sub.metadata?.billingReason ?? null;
    } catch (err) {
      ctx.logger.warn('commission.invoice.sub_retrieve_failed', { subId, err: String(err) });
    }
  }
  if (!planKey) {
    ctx.logger.warn('commission.invoice.missing_plan', { invoiceId: invoice.id });
    return null;
  }
  const plan = ctx.plansByKey.get(planKey);
  if (!plan) return null;

  const scope = resolveTriggerScope(plan.type, 'invoice', billingReason);
  if (!scope) return null; // 首期账单（已由 checkout 处理）或试用段

  // 按实付金额计佣（amount_paid），自然消化 proration 小额/零额账单
  const amount = invoice.amount_paid ?? 0;
  if (amount <= 0) return null;

  return engine.calculateCommissions({
    userId,
    orderId: invoice.id ?? `inv_${subId ?? 'unknown'}`,
    planKey,
    planType: plan.type,
    triggerScope: scope,
    amountTotal: amount,
    currency: (invoice.currency ?? 'usd').toUpperCase(),
  });
}

/**
 * 处理 charge.refunded（5.3 clawback）。
 * 边界原则：
 * - 仅全额退款（charge.refunded === true）触发自动追回；部分退款只告警，交人工裁量
 * - orderId 反查：invoice 账单直接取 charge.invoice；checkout 订单经 payment_intent 反查 session
 */
export async function processChargeRefunded(
  ctx: BillingContext,
  engine: CommissionEngine,
  charge: Charge,
): Promise<ClawbackResult | null> {
  if (!charge.refunded) {
    ctx.logger.warn('commission.clawback.partial_refund_skipped', {
      chargeId: charge.id,
      amountRefunded: charge.amount_refunded,
    });
    return null;
  }

  const orderId = await resolveOrderIdOfCharge(ctx, charge);
  if (!orderId) {
    ctx.logger.warn('commission.clawback.order_unresolved', { chargeId: charge.id });
    return null;
  }
  return engine.clawbackByOrder(orderId);
}

/** charge → 佣金侧 orderId：invoice ID 或 checkout session ID */
async function resolveOrderIdOfCharge(ctx: BillingContext, charge: Charge): Promise<string | null> {
  // 订阅/账单场景：charge 直接挂 invoice（兼容旧版字段）
  const invoiceRef = (charge as unknown as { invoice?: string | { id: string } | null }).invoice;
  if (invoiceRef) return typeof invoiceRef === 'string' ? invoiceRef : invoiceRef.id;

  // checkout 场景：经 payment_intent 反查 session
  const pi = charge.payment_intent;
  const paymentIntentId = typeof pi === 'string' ? pi : pi?.id ?? null;
  if (!paymentIntentId) return null;
  try {
    const sessions = await ctx.stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
    return sessions.data[0]?.id ?? null;
  } catch (err) {
    ctx.logger.warn('commission.clawback.session_lookup_failed', {
      paymentIntentId,
      err: String(err),
    });
    return null;
  }
}

/**
 * 统一入口：在 core webhook 管线中按需调用（仅当启用佣金模块时）。
 * 返回 null 表示该事件与佣金无关或不计佣。
 */
export async function handleCommissionEvent(
  ctx: BillingContext,
  engine: CommissionEngine,
  event: Stripe.Event,
): Promise<CommissionCalculationResult | ClawbackResult | null> {
  switch (event.type) {
    case 'checkout.session.completed':
      return processCheckoutCompleted(ctx, engine, event.data.object);
    case 'invoice.paid':
      return processInvoicePaid(ctx, engine, event.data.object);
    case 'charge.refunded':
      return processChargeRefunded(ctx, engine, event.data.object);
    default:
      return null;
  }
}

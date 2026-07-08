/**
 * checkout.ts
 * 创建 Stripe Checkout 会话——支持全部 7 种付款模式：
 *   subscription         : 自动包月/包年
 *   one_time             : 买断/终身
 *   trial_then_subscribe : 试用期须绑卡，到期自动转订阅
 *   trial_no_convert     : 试用期无需绑卡，到期即止
 *   metered              : 按量计费订阅（Stripe Meter）
 *   credit_package       : 一次性购买额度包
 *   daily                : 单日通行证（非自动续费）
 *
 * 安全：planKey 必须在 config.plans 白名单内，由服务端解析为 price_id。
 * 绝不接受客户端直传 price_id。
 */
import type { BillingContext } from './config.js';
import { BillingError } from './errors.js';
import { resolvePriceId } from './catalog.js';
import { getOrCreateCustomer } from './customers.js';

export interface CreateCheckoutInput {
  userId: string;
  planKey: string;
  /** 额度包 / 买断可指定数量；其余模式留空 */
  quantity?: number;
}

export interface CreateCheckoutResult {
  url: string;
  sessionId: string;
}

/**
 * 创建 Stripe 托管 Checkout 会话（支持全部 7 种模式）。
 * 返回 { url, sessionId }，前端直接 window.location.href = url 跳转即可。
 */
export async function createCheckoutSession(
  ctx: BillingContext,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const plan = ctx.plansByKey.get(input.planKey);
  if (!plan) throw new BillingError('invalid_plan', `未知 planKey: ${input.planKey}`);

  const priceId = await resolvePriceId(ctx, plan.key);
  const customerId = await getOrCreateCustomer(ctx, input.userId);
  const meta = { userId: input.userId, planKey: plan.key };

  // ---------- 各模式参数构建 ----------
  type SessionParams = Parameters<typeof ctx.stripe.checkout.sessions.create>[0];
  let params: SessionParams;

  switch (plan.type) {
    // ── 自动包月/包年 ──────────────────────────────────────────────
    case 'subscription': {
      params = {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: { metadata: meta },
        allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
        metadata: meta,
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 买断/终身 ──────────────────────────────────────────────────
    case 'one_time': {
      params = {
        mode: 'payment',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: input.quantity ?? 1 }],
        payment_intent_data: { metadata: meta },
        allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
        metadata: meta,
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 试用期绑卡，到期自动转订阅 ────────────────────────────────
    case 'trial_then_subscribe': {
      if (!plan.trialDays) {
        throw new BillingError('config', `planKey ${plan.key} 的 trial_then_subscribe 必须设置 trialDays`);
      }
      params = {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: 1 }],
        // payment_method_collection: 'always' → 必须绑卡，试用结束自动扣款
        payment_method_collection: 'always',
        subscription_data: {
          trial_period_days: plan.trialDays,
          metadata: meta,
        },
        allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
        metadata: meta,
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 试用期无需绑卡，到期即止不自动扣款 ────────────────────────
    case 'trial_no_convert': {
      if (!plan.trialDays) {
        throw new BillingError('config', `planKey ${plan.key} 的 trial_no_convert 必须设置 trialDays`);
      }
      params = {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: 1 }],
        // payment_method_collection: 'if_required' → 不强制绑卡
        // 试用结束无支付方式时 Stripe 会自动 cancel 订阅
        payment_method_collection: 'if_required',
        subscription_data: {
          trial_period_days: plan.trialDays,
          trial_settings: {
            end_behavior: { missing_payment_method: 'cancel' },
          },
          metadata: meta,
        },
        allow_promotion_codes: false,
        metadata: meta,
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 按量计费（Stripe Meter）────────────────────────────────────
    case 'metered': {
      if (!plan.meterEventName) {
        throw new BillingError('config', `planKey ${plan.key} 的 metered 必须设置 meterEventName`);
      }
      // metered 价格不传 quantity（由 Stripe Meter 自动汇总）
      params = {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId }],
        subscription_data: { metadata: meta },
        allow_promotion_codes: false,
        metadata: meta,
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 额度包（一次性购买 N 点）──────────────────────────────────
    case 'credit_package': {
      if (!plan.creditAmount) {
        throw new BillingError('config', `planKey ${plan.key} 的 credit_package 必须设置 creditAmount`);
      }
      params = {
        mode: 'payment',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: input.quantity ?? 1 }],
        payment_intent_data: {
          metadata: { ...meta, creditAmount: String(plan.creditAmount * (input.quantity ?? 1)) },
        },
        allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
        metadata: { ...meta, creditAmount: String(plan.creditAmount * (input.quantity ?? 1)) },
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    // ── 单日通行证（非自动续费）───────────────────────────────────
    case 'daily': {
      params = {
        mode: 'payment',
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: priceId, quantity: input.quantity ?? 1 }],
        payment_intent_data: {
          metadata: { ...meta, dailyDays: String(input.quantity ?? 1) },
        },
        allow_promotion_codes: ctx.config.allowPromotionCodes ?? true,
        metadata: { ...meta, dailyDays: String(input.quantity ?? 1) },
        success_url: ctx.config.urls.checkoutSuccess,
        cancel_url: ctx.config.urls.checkoutCancel,
      };
      break;
    }

    default:
      throw new BillingError('config', `未处理的 planType: ${(plan as any).type}`);
  }

  const session = await ctx.stripe.checkout.sessions.create(params, {
    // 出站幂等：分钟级时间桶，同一用户同一套餐 1 分钟内重复点击不开两个会话
    idempotencyKey: `bk:checkout:${input.userId}:${plan.key}:${Math.floor(Date.now() / 60_000)}`,
  });

  if (!session.url) throw new BillingError('stripe', 'Stripe 未返回 checkout url');
  ctx.logger.info('billing.checkout.created', {
    userId: input.userId,
    planKey: plan.key,
    planType: plan.type,
    sessionId: session.id,
  });
  return { url: session.url, sessionId: session.id };
}

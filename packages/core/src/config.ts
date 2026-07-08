import Stripe from 'stripe';
import { BillingError } from './errors.js';
import type { StorageAdapter } from './storage/types.js';

/**
 * 支持的计费模式：
 * - subscription        : 自动包月/包年（持续订阅）
 * - one_time           : 买断/终身（一次性付款）
 * - trial_then_subscribe : 试用期结束后自动转订阅（需提供支付方式）
 * - trial_no_convert   : 试用期结束后到期即止，不自动扣款
 * - metered            : 按消耗量实时计费（月底汇总出账）
 * - credit_package     : 额度包（一次买 N 点，消耗完再买）
 * - credit_variable    : 可变价格额度包（用户自选金额充值）
 * - daily              : 日付（单日通行证，非自动续费）
 * - first_trial        : 单次试用套餐（只能订阅一次，订阅后不再显示）
 */
export type PlanType =
  | 'subscription'
  | 'one_time'
  | 'trial_then_subscribe'
  | 'trial_no_convert'
  | 'metered'
  | 'credit_package'
  | 'credit_variable'
  | 'daily'
  | 'first_trial';

export type PlanRef = { lookupKey: string; priceId?: never } | { priceId: string; lookupKey?: never };

export interface PlanDef {
  /** 产品内部稳定标识,业务代码只用它 */
  key: string;
  type: PlanType;
  ref: PlanRef;
  /** 该套餐解锁的能力标签 */
  features: string[];
  /** 试用天数（trial_then_subscribe / trial_no_convert / first_trial 模式必填） */
  trialDays?: number;
  /** 试用期结束后绑定的订阅 planKey（trial_then_subscribe / first_trial 模式必填） */
  trialConvertsTo?: string;
  /** 额度包包含的点数（credit_package 模式必填） */
  creditAmount?: number;
  /** 可变价格额度包的产品 ID（credit_variable 模式必填） */
  variableProductId?: string;
  /** 按量计费的 Stripe Meter event name（metered 模式必填） */
  meterEventName?: string;
  /** Stripe Meter ID，用于查询用量（metered 模式可选，填了才能查余量） */
  meterId?: string;
}

export interface BillingLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface CheckoutCompletedContext {
  userId: string;
  planKey: string;
  planType: string;
  mode: 'payment' | 'subscription';
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  /** 购买数量（额度包 / 日通行证模式） */
  quantity?: number;
  /** 固定额度包购买的点数（credit_package 模式） */
  creditAmount?: number;
  /** 可变额度包支付金额（credit_variable 模式，单位：cents） */
  amountCents?: number;
}

export interface SubscriptionChangedContext {
  userId: string;
  planKey: string | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string;
}

export interface PaymentFailedContext {
  userId: string | null;
  stripeCustomerId: string;
  invoiceId: string;
}

export interface BillingHooks {
  onCheckoutCompleted?(ctx: CheckoutCompletedContext): Promise<void> | void;
  onSubscriptionChanged?(ctx: SubscriptionChangedContext): Promise<void> | void;
  onSubscriptionCanceled?(ctx: SubscriptionChangedContext): Promise<void> | void;
  onPaymentFailed?(ctx: PaymentFailedContext): Promise<void> | void;
}

export interface BillingConfig {
  stripe: {
    secretKey: string;
    webhookSecret: string;
    publishableKey: string;
  };
  plans: PlanDef[];
  urls: {
    /** 可含 {CHECKOUT_SESSION_ID} 占位符 */
    checkoutSuccess: string;
    checkoutCancel: string;
    portalReturn: string;
  };
  storage: StorageAdapter;
  /** catalog 缓存 TTL(秒),默认 600 */
  catalogTtlSeconds?: number;
  logger?: BillingLogger;
  hooks?: BillingHooks;
  /** Checkout 是否允许输入优惠码,默认 true */
  allowPromotionCodes?: boolean;
}

/** 校验后的运行时上下文:所有模块都从它取依赖(单例复用 Stripe client 与缓存) */
export interface BillingContext {
  config: BillingConfig;
  stripe: Stripe;
  storage: StorageAdapter;
  logger: BillingLogger;
  plansByKey: Map<string, PlanDef>;
}

const NOOP_LOGGER: BillingLogger = { info() {}, warn() {}, error() {} };

function validate(config: BillingConfig): void {
  const problems: string[] = [];
  if (!config.stripe?.secretKey?.startsWith('sk_')) problems.push('stripe.secretKey 必须以 sk_ 开头');
  if (!config.stripe?.webhookSecret?.startsWith('whsec_')) problems.push('stripe.webhookSecret 必须以 whsec_ 开头');
  if (!config.stripe?.publishableKey?.startsWith('pk_')) problems.push('stripe.publishableKey 必须以 pk_ 开头');

  const secretIsTest = config.stripe?.secretKey?.startsWith('sk_test_');
  const pubIsTest = config.stripe?.publishableKey?.startsWith('pk_test_');
  if (config.stripe?.secretKey?.startsWith('sk_') && config.stripe?.publishableKey?.startsWith('pk_') && secretIsTest !== pubIsTest) {
    problems.push('secretKey 与 publishableKey 环境不一致(test/live 混用)');
  }

  if (!config.plans?.length) problems.push('plans 不能为空');
  const seen = new Set<string>();
  for (const plan of config.plans ?? []) {
    if (!plan.key) problems.push('存在缺少 key 的 plan');
    if (seen.has(plan.key)) problems.push(`plan key 重复:${plan.key}`);
    seen.add(plan.key);
    const validTypes: PlanType[] = ['subscription','one_time','trial_then_subscribe','trial_no_convert','metered','credit_package','credit_variable','daily','first_trial'];
    if (!validTypes.includes(plan.type)) problems.push(`plan ${plan.key} 的 type 非法:${String(plan.type)}`);
    if ((plan.type === 'trial_then_subscribe' || plan.type === 'trial_no_convert' || plan.type === 'first_trial') && !plan.trialDays) problems.push(`plan ${plan.key} 使用 ${plan.type} 模式，trialDays 必填`);
    if (plan.type === 'metered' && !plan.meterEventName) problems.push(`plan ${plan.key} 使用 metered 模式，meterEventName 必填`);
    if (plan.type === 'credit_package' && !plan.creditAmount) problems.push(`plan ${plan.key} 使用 credit_package 模式，creditAmount 必填`);
    if (plan.type === 'credit_variable' && !plan.variableProductId) problems.push(`plan ${plan.key} 使用 credit_variable 模式，variableProductId 必填`);
    const ref = plan.ref as { lookupKey?: string; priceId?: string } | undefined;
    if (!ref?.lookupKey && !ref?.priceId) problems.push(`plan ${plan.key} 必须提供 ref.lookupKey 或 ref.priceId`);
    if (!plan.features?.length) problems.push(`plan ${plan.key} 的 features 不能为空`);
  }

  if (!config.urls?.checkoutSuccess) problems.push('urls.checkoutSuccess 必填');
  if (!config.urls?.checkoutCancel) problems.push('urls.checkoutCancel 必填');
  if (!config.urls?.portalReturn) problems.push('urls.portalReturn 必填');
  if (!config.storage) problems.push('storage 必填');

  if (problems.length) {
    throw new BillingError('config', `BillingConfig 校验失败:\n- ${problems.join('\n- ')}`);
  }
}

const contextCache = new WeakMap<BillingConfig, BillingContext>();

/** 幂等:同一 config 对象返回同一 context(Stripe client 与 catalog 缓存得以复用) */
export function createBillingContext(config: BillingConfig): BillingContext {
  const cached = contextCache.get(config);
  if (cached) return cached;

  validate(config);
  const ctx: BillingContext = {
    config,
    stripe: new Stripe(config.stripe.secretKey, {
      appInfo: { name: 'stripe-billing-kit', version: '0.1.0' },
    }),
    storage: config.storage,
    logger: config.logger ?? NOOP_LOGGER,
    plansByKey: new Map(config.plans.map((p) => [p.key, p])),
  };
  contextCache.set(config, ctx);
  return ctx;
}

import type { BillingContext } from './config.js';

export interface Entitlement {
  planKey: string;
  features: string[];
  source: 'subscription' | 'purchase';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  /** ISO 时间;买断为 null(永久) */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingStatus {
  entitlements: Entitlement[];
  hasAccess: Record<string, boolean>;
}

/** 订阅这些状态视为有权益(past_due 在 Stripe 重试扣款期内保留访问,是业界默认做法) */
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

function narrowStatus(status: string): Entitlement['status'] {
  return status === 'active' || status === 'trialing' || status === 'past_due' || status === 'canceled'
    ? status
    : 'none';
}

/** 纯读本地表,不打 Stripe API(性能关键路径) */
export async function getEntitlements(ctx: BillingContext, userId: string): Promise<BillingStatus> {
  const { subs, purchases } = await ctx.storage.getEntitlementRows(userId);
  const entitlements: Entitlement[] = [];

  for (const sub of subs) {
    const plan = ctx.plansByKey.get(sub.planKey);
    if (!plan) continue;
    if (!ACCESS_STATUSES.has(sub.status)) continue;
    // 已到期的残留行不算权益(webhook 迟到时的保护)
    if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() < Date.now() - 24 * 3600 * 1000) continue;
    entitlements.push({
      planKey: plan.key,
      features: plan.features,
      source: 'subscription',
      status: narrowStatus(sub.status),
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    });
  }

  for (const purchase of purchases) {
    const plan = ctx.plansByKey.get(purchase.planKey);
    if (!plan) continue;
    entitlements.push({
      planKey: plan.key,
      features: plan.features,
      source: 'purchase',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
  }

  const hasAccess: Record<string, boolean> = {};
  for (const plan of ctx.config.plans) {
    for (const feature of plan.features) hasAccess[feature] ??= false;
  }
  for (const ent of entitlements) {
    for (const feature of ent.features) hasAccess[feature] = true;
  }

  return { entitlements, hasAccess };
}

/** 业务代码的唯一付费墙入口:feature 传能力标签(如 'pro') */
export async function hasAccess(ctx: BillingContext, userId: string, feature: string): Promise<boolean> {
  const status = await getEntitlements(ctx, userId);
  return status.hasAccess[feature] === true;
}

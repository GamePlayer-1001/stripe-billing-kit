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

// ══════════════════════════════════════════════════════════════
// 额度包（credit_package）工具函数
// ══════════════════════════════════════════════════════════════

/**
 * 查询用户剩余可用额度。
 * 优先走 storage.getCreditBalance（精确，由实现方保证原子性）；
 * 降级时从 purchases.metadata 推算：sum(creditAmount) - sum(creditUsed)。
 */
export async function getCreditBalance(ctx: BillingContext, userId: string): Promise<number> {
  // 优先调存储层原子余额
  if (ctx.storage.getCreditBalance) {
    const bal = await ctx.storage.getCreditBalance(userId);
    if (bal !== undefined) return bal;
  }

  // 降级：从 purchases metadata 推算
  const { purchases } = await ctx.storage.getEntitlementRows(userId);
  let balance = 0;
  for (const p of purchases) {
    const plan = ctx.plansByKey.get(p.planKey);
    if (plan?.type !== 'credit_package') continue;
    const bought = Number(p.metadata?.['creditAmount'] ?? plan.creditAmount ?? 0);
    const used   = Number(p.metadata?.['creditUsed']   ?? 0);
    balance += bought - used;
  }
  return Math.max(0, balance);
}

/**
 * 消耗用户额度（通常在每次 AI 调用 / 功能使用前调用）。
 * 优先走 storage.consumeCredit（原子，推荐生产使用）；
 * 降级时做乐观扣减（非原子，仅适合低并发场景）。
 * 返回消耗后剩余余额；额度不足时 throw BillingError('insufficient_credits')。
 */
export async function consumeUserCredit(
  ctx: BillingContext,
  userId: string,
  amount: number,
): Promise<number> {
  if (amount <= 0) throw new BillingError('invalid_plan', 'consumeUserCredit amount 必须 > 0');

  // 优先原子扣减
  if (ctx.storage.consumeCredit) {
    return ctx.storage.consumeCredit(userId, amount);
  }

  // 降级：乐观扣减（非原子，高并发须在业务层加锁）
  const balance = await getCreditBalance(ctx, userId);
  if (balance < amount) {
    throw new BillingError('insufficient_credits' as any, `额度不足：剩余 ${balance}，需要 ${amount}`);
  }
  // 找最早的未耗尽 purchase 扣减
  const { purchases } = await ctx.storage.getEntitlementRows(userId);
  let remaining = amount;
  for (const p of purchases) {
    if (remaining <= 0) break;
    const plan = ctx.plansByKey.get(p.planKey);
    if (plan?.type !== 'credit_package') continue;
    const bought = Number(p.metadata?.['creditAmount'] ?? plan.creditAmount ?? 0);
    const used   = Number(p.metadata?.['creditUsed']   ?? 0);
    const avail  = bought - used;
    if (avail <= 0) continue;
    const deduct = Math.min(avail, remaining);
    remaining -= deduct;
    await ctx.storage.updatePurchaseMetadata?.(p.stripeSessionId, {
      ...p.metadata,
      creditUsed: String(used + deduct),
    });
  }
  return balance - amount;
}

// ══════════════════════════════════════════════════════════════
// 日付通行证（daily）工具函数
// ══════════════════════════════════════════════════════════════

/**
 * 检查用户的日付通行证是否仍在有效期内。
 * @param planKey  对应 daily 类型的 planKey
 * @returns true = 今天有效；false = 已过期或未购买
 */
export async function isDailyPassActive(
  ctx: BillingContext,
  userId: string,
  planKey: string,
): Promise<boolean> {
  const plan = ctx.plansByKey.get(planKey);
  if (plan?.type !== 'daily') return false;

  const { purchases } = await ctx.storage.getEntitlementRows(userId);
  const now = Date.now();

  for (const p of purchases) {
    if (p.planKey !== planKey) continue;
    const createdAt = p.createdAt ? p.createdAt.getTime() : null;
    if (createdAt === null) continue; // 存储层未记录时间，跳过
    const days = Number(p.metadata?.['dailyDays'] ?? 1);
    const expiresAt = createdAt + days * 24 * 3600 * 1000;
    if (now < expiresAt) return true; // 找到一张有效的通行证
  }
  return false;
}

import { BillingError } from './errors.js';

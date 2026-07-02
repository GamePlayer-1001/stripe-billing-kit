import type Stripe from 'stripe';
import type { BillingContext, PlanDef } from './config.js';
import { BillingError } from './errors.js';

export interface CatalogPrice {
  /** 仅信息展示,前端不得回传 */
  id: string;
  currency: string;
  /** 最小货币单位(如美分);custom/metered 价格可能为 null */
  unitAmount: number | null;
  interval: 'day' | 'week' | 'month' | 'year' | null;
  intervalCount: number | null;
  trialPeriodDays: number | null;
}

export interface CatalogProduct {
  name: string;
  description: string | null;
  marketingFeatures: string[];
  images: string[];
}

export interface CatalogPlan {
  key: string;
  type: PlanDef['type'];
  features: string[];
  product: CatalogProduct;
  price: CatalogPrice;
}

export interface Catalog {
  plans: CatalogPlan[];
  updatedAt: string;
}

interface CacheEntry {
  catalog: Catalog;
  expiresAt: number;
}

const cache = new WeakMap<BillingContext, CacheEntry>();

/** webhook 收到 price.created/updated 或 product.updated 时调用,强制下一次请求回源 Stripe */
export function invalidateCatalogCache(ctx: BillingContext): void {
  cache.delete(ctx);
  ctx.logger.info('billing.catalog.cache_invalidated');
}

function toCatalogPlan(plan: PlanDef, price: Stripe.Price): CatalogPlan {
  const product = price.product as Stripe.Product;
  return {
    key: plan.key,
    type: plan.type,
    features: plan.features,
    product: {
      name: product.name,
      description: product.description,
      marketingFeatures: (product.marketing_features ?? [])
        .map((f) => f.name)
        .filter((n): n is string => Boolean(n)),
      images: product.images ?? [],
    },
    price: {
      id: price.id,
      currency: price.currency,
      unitAmount: price.unit_amount,
      interval: price.recurring?.interval ?? null,
      intervalCount: price.recurring?.interval_count ?? null,
      trialPeriodDays: price.recurring?.trial_period_days ?? null,
    },
  };
}

async function fetchCatalog(ctx: BillingContext): Promise<Catalog> {
  const byLookup = ctx.config.plans.filter((p) => 'lookupKey' in p.ref && p.ref.lookupKey);
  const byPriceId = ctx.config.plans.filter((p) => 'priceId' in p.ref && p.ref.priceId);

  const priceByPlanKey = new Map<string, Stripe.Price>();

  if (byLookup.length) {
    const lookupKeys = byLookup.map((p) => (p.ref as { lookupKey: string }).lookupKey);
    const res = await ctx.stripe.prices.list({
      lookup_keys: lookupKeys,
      active: true,
      limit: 100,
      expand: ['data.product'],
    });
    for (const plan of byLookup) {
      const lk = (plan.ref as { lookupKey: string }).lookupKey;
      const price = res.data.find((pr) => pr.lookup_key === lk);
      if (price) priceByPlanKey.set(plan.key, price);
    }
  }

  for (const plan of byPriceId) {
    const priceId = (plan.ref as { priceId: string }).priceId;
    try {
      const price = await ctx.stripe.prices.retrieve(priceId, { expand: ['product'] });
      if (price.active) priceByPlanKey.set(plan.key, price);
    } catch (err) {
      ctx.logger.warn('billing.catalog.price_retrieve_failed', { planKey: plan.key, priceId, err: String(err) });
    }
  }

  const plans: CatalogPlan[] = [];
  for (const plan of ctx.config.plans) {
    const price = priceByPlanKey.get(plan.key);
    if (!price) {
      // 拿不到有效价格(lookup_key 拼错 / price 归档 / 用错 account)→ 跳过并告警,不让整个目录挂掉
      ctx.logger.warn('billing.catalog.plan_missing_price', { planKey: plan.key, ref: plan.ref });
      continue;
    }
    const product = price.product;
    if (!product || typeof product === 'string' || product.deleted) {
      ctx.logger.warn('billing.catalog.plan_missing_product', { planKey: plan.key });
      continue;
    }
    plans.push(toCatalogPlan(plan, price));
  }

  return { plans, updatedAt: new Date().toISOString() };
}

export async function getCatalog(ctx: BillingContext): Promise<Catalog> {
  const entry = cache.get(ctx);
  if (entry && entry.expiresAt > Date.now()) return entry.catalog;

  const catalog = await fetchCatalog(ctx).catch((err) => {
    // 回源失败但有过期缓存 → 降级返回旧数据,保定价页可用
    if (entry) {
      ctx.logger.error('billing.catalog.refresh_failed_stale_served', { err: String(err) });
      return entry.catalog;
    }
    throw new BillingError('stripe', `拉取 Stripe 商品目录失败:${String(err)}`);
  });

  const ttl = (ctx.config.catalogTtlSeconds ?? 600) * 1000;
  cache.set(ctx, { catalog, expiresAt: Date.now() + ttl });
  return catalog;
}

/** 解析 plan → 实际 price id(checkout 用;catalog 缓存可复用) */
export async function resolvePriceId(ctx: BillingContext, planKey: string): Promise<string> {
  const plan = ctx.plansByKey.get(planKey);
  if (!plan) throw new BillingError('invalid_plan', `未知 planKey:${planKey}`);
  if ('priceId' in plan.ref && plan.ref.priceId) return plan.ref.priceId;

  const catalog = await getCatalog(ctx);
  const entry = catalog.plans.find((p) => p.key === planKey);
  if (!entry) {
    throw new BillingError('invalid_plan', `planKey ${planKey} 在 Stripe 无有效价格(检查 lookup_key 与环境)`);
  }
  return entry.price.id;
}

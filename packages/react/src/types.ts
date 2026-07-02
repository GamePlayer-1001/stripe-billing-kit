/**
 * HTTP 契约响应类型(与 @billing-kit/core 的 Catalog/BillingStatus 结构一致)。
 * 刻意不 import core:React 包只消费 HTTP 契约,保持前端零服务端依赖。
 */

export interface CatalogPrice {
  id: string;
  currency: string;
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
  type: 'subscription' | 'one_time';
  features: string[];
  product: CatalogProduct;
  price: CatalogPrice;
}

export interface Catalog {
  plans: CatalogPlan[];
  updatedAt: string;
}

export interface Entitlement {
  planKey: string;
  features: string[];
  source: 'subscription' | 'purchase';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingStatus {
  entitlements: Entitlement[];
  hasAccess: Record<string, boolean>;
}

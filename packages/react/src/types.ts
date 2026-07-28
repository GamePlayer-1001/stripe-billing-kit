/**
 * HTTP 契约响应类型(与 @billing-kit/core 的 Catalog/BillingStatus 结构一致)。
 * 刻意不 import core:React 包只消费 HTTP 契约,保持前端零服务端依赖。
 */

export interface CatalogPrice {
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

// ── 邀请返利(佣金模块 REST 契约,见 COMMISSION-SYSTEM-SPEC 6.0/6.2) ──

/** GET /referrals/:userId/stats 响应 */
export interface ReferralStats {
  totalInvites: number;
  convertedCount: number;
  activeRelationships: number;
  /** 转化率(%,1 位小数) */
  conversionRate: number;
  /** 佣金总额(cents) */
  totalEarnings: number;
  /** 待结算(cents) */
  pendingCommissions: number;
  /** 本月已打款(cents) */
  paidThisMonth: number;
}

/** POST /referrals/generate 响应 */
export interface ReferralInvite {
  code: string;
  link: string | null;
  isActive: boolean;
  totalInvites: number;
  convertedCount: number;
}

/** GET /referrals/:userId/commissions 明细项 */
export interface ReferralCommission {
  id: string;
  orderId: string;
  planKey: string;
  /** 现金佣金(cents) */
  amount: number;
  currency: string;
  tierLevel: number;
  status: 'PENDING' | 'APPROVED' | 'PAID' | 'REFUNDED' | 'REJECTED' | 'EXPIRED';
  createdAt: string;
}

/** SSE 推送事件(6.3.2);stats.refreshed 为轮询降级时的合成事件 */
export type ReferralClientEvent =
  | { type: 'commission.created'; data: { commissionId: string; amount: number; currency: string; tierLevel: number } }
  | { type: 'commission.approved'; data: { commissionId: string; amount: number } }
  | { type: 'commission.paid'; data: { commissionId: string; amount: number } }
  | { type: 'referral.registered'; data: { maskedEmail: string | null } }
  | { type: 'stats.refreshed'; data: ReferralStats };

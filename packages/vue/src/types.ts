// 从 core 透传类型
export type {
  Catalog,
  CatalogPlan,
  CatalogPrice,
  CatalogProduct,
  Entitlement,
  BillingStatus,
} from '@billing-kit/core';

// ── 邀请返利 HTTP 契约(REST 响应形状与 core 行结构不同,本地定义) ──

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

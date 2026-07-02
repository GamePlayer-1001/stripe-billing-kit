export interface CustomerRow {
  userId: string;
  stripeCustomerId: string;
}

export interface SubscriptionRow {
  stripeSubscriptionId: string;
  userId: string;
  planKey: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  raw: unknown;
}

export interface PurchaseRow {
  stripeSessionId: string;
  userId: string;
  planKey: string;
  amountTotal: number;
  currency: string;
}

/**
 * 持久化抽象:core 只依赖此接口。
 * 实现要求:
 * - claimEvent 必须原子(唯一约束/唯一键),true = 首次认领,false = 重复事件
 * - insertPurchase 必须幂等(主键冲突时静默忽略)
 */
export interface StorageAdapter {
  getCustomerByUserId(userId: string): Promise<CustomerRow | null>;
  getCustomerByStripeCustomerId(stripeCustomerId: string): Promise<CustomerRow | null>;
  upsertCustomer(row: CustomerRow): Promise<void>;
  claimEvent(eventId: string, type: string): Promise<boolean>;
  upsertSubscription(row: SubscriptionRow): Promise<void>;
  insertPurchase(row: PurchaseRow): Promise<void>;
  getEntitlementRows(userId: string): Promise<{ subs: SubscriptionRow[]; purchases: PurchaseRow[] }>;
}

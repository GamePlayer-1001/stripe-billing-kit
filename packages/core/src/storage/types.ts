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
  /** 购买时间（daily 有效期计算需要；存储层不支持时为 undefined） */
  createdAt?: Date;
  /** 扩展元数据（键值对）。约定 key:
   *  - 'dailyDays'    : 购买的天数（daily 模式）
   *  - 'creditAmount' : 本次购买的额度点数（credit_package 模式）
   *  - 'creditUsed'   : 已消耗点数（由 consumeCredit 写入）
   */
  metadata?: Record<string, string>;
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
  /**
   * 可选：返回用户剩余可用额度（credit_package 模式）。
   * 未实现时 core 会从 purchases.metadata 推算（不精确）。
   */
  getCreditBalance?(userId: string): Promise<number | undefined>;
  /**
   * 可选：原子扣减额度，返回扣减后余额；额度不足时 throw BillingError('insufficient_credits')。
   * 未实现时请自行在业务层做乐观锁。
   */
  consumeCredit?(userId: string, amount: number): Promise<number>;
  /**
   * 可选：更新 purchase metadata（用于 consumeCredit 回写 creditUsed 字段）。
   */
  updatePurchaseMetadata?(sessionId: string, metadata: Record<string, string>): Promise<void>;
}

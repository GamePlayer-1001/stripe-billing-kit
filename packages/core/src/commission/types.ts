/**
 * 佣金模块领域类型（对应 docs/COMMISSION-SYSTEM-SPEC.md 第 2.3 / 4.1 节）
 *
 * 设计原则：
 * - 不做经营模态预设，所有返佣形态由 RewardComponent 自由组合（泛用性 = 包含不局限）
 * - 驱动变量严格收口为 3 个，每新增一个必须过安全评审（防穿仓生命线）
 * - core 只依赖 CommissionStorage 接口，持久化由开发者实现（与 StorageAdapter 同风格）
 */
import type { PlanType } from '../config.js';

// ──────────────────────────────────────────────────────
// 奖励组件模型（2.3.1）
// ──────────────────────────────────────────────────────

/** 组件类型：比例金钱 / 固定金额 / 产品（额度包/VIP/时长等） */
export type ComponentType = 'CASH_PERCENT' | 'CASH_FIXED' | 'PRODUCT';

/** 取值模式：固定值 / 动态阶梯 */
export type ValueMode = 'FIXED' | 'DYNAMIC';

/**
 * 驱动变量（严格收口，MVP 仅开放 3 个）：
 * - ORDER_AMOUNT                 : 订单/账单金额 → 高价值比例（$1000 以上跳高档）
 * - REFERRER_MONTHLY_CONVERSIONS : 推荐人本月转化数 → 业绩阶梯
 * - PERIOD_INDEX                 : 账期序号 → 生命周期衰减（前 12 期 20%，之后 10%）
 */
export type DriverVariable = 'ORDER_AMOUNT' | 'REFERRER_MONTHLY_CONVERSIONS' | 'PERIOD_INDEX';

export interface LadderStep {
  /** 档位下限（含） */
  from: number;
  /** 档位上限（不含），null = 无上限 */
  to: number | null;
  /** 该档取值（含义同 fixedValue） */
  value: number;
}

export interface RewardComponent {
  componentType: ComponentType;
  valueMode: ValueMode;
  /** FIXED 模式：CASH_PERCENT=0.20(20%) | CASH_FIXED=cents | PRODUCT=发放数量 */
  fixedValue?: number;
  /** PRODUCT 组件必填：生产者系统内的产品标识（对本模块是黑盒字符串） */
  productRef?: string;
  /** DYNAMIC 模式：按驱动变量分档的阶梯表 */
  dynamicConfig?: {
    driverVariable: DriverVariable;
    ladder: LadderStep[];
  };
  /** 订单低于此金额(cents)时本组件不触发（防穿仓） */
  minCommissionableAmountCents?: number;
  /** 单笔现金封顶(cents) */
  maxValueCents?: number;
}

// ──────────────────────────────────────────────────────
// 触发场景与计佣基数（2.3.2 / 4.1）
// ──────────────────────────────────────────────────────

/**
 * 结算触发场景：九种 PlanType 归一于此。
 * NO_PAYMENT（试用类不计佣）不进入规则匹配，故枚举只含三类实付场景。
 */
export type TriggerScope = 'FIRST_PAYMENT' | 'RECURRING_PAYMENT' | 'USAGE_INVOICE';

/** 计佣基数：扣手续费后 / 按毛额 */
export type CommissionBase = 'NET_BASED' | 'GROSS_BASED';

/** 平台手续费承担方式（三选一，交给生产者） */
export type PlatformFeeHandlingMode = 'CONSUMED_BY_PLATFORM' | 'PASSED_TO_CUSTOMER' | 'SHARED';

export type RelationshipStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
export type CommissionStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REFUNDED' | 'REJECTED' | 'EXPIRED';
export type ReviewStatus = 'AUTO_APPROVED' | 'MANUAL_REVIEW' | 'FLAGGED' | 'REJECTED';
export type GrantStatus = 'NOT_APPLICABLE' | 'PENDING_GRANT' | 'GRANTED' | 'GRANT_FAILED';

// ──────────────────────────────────────────────────────
// 持久化行结构（对应 4.1 Prisma 模型）
// ──────────────────────────────────────────────────────

export interface ReferralCodeRow {
  id: string;
  code: string;
  userId: string;
  isActive: boolean;
  totalInvites: number;
  convertedCount: number;
  createdAt: Date;
}

export interface ReferralRelationshipRow {
  id: string;
  referrerUserId: string;
  refereeUserId: string;
  originalCode: string;
  status: RelationshipStatus;
  createdAt: Date;
  activatedAt: Date | null;
  metadata?: Record<string, unknown>;
}

export interface CommissionRuleRow {
  id: string;
  programId: string;
  /** null = 全局适用，否则指定套餐 */
  planKey: string | null;
  triggerScope: TriggerScope;
  /** null = 适用于所有层级，否则指定层级 */
  tierLevel: number | null;
  components: RewardComponent[];
  commissionBase: CommissionBase;
  platformFeeHandlingMode: PlatformFeeHandlingMode;
  holdPeriodDays: number;
  autoApproveUnderCents: number | null;
  requireReviewOverCents: number | null;
  isActive: boolean;
  /** 优先级，数字越高越先匹配 */
  priority: number;
}

export interface CommissionRow {
  id: string;
  referrerUserId: string;
  orderId: string;
  planKey: string;
  /** 现金佣金合计（cents，各 CASH_* 组件之和） */
  amount: number;
  currency: string;
  /** 组件计算明细快照（审计回溯） */
  rateBreakdown: RateBreakdownEntry[];
  grantStatus: GrantStatus;
  tierLevel: number;
  status: CommissionStatus;
  reviewStatus: ReviewStatus;
  validUntil: Date;
  createdAt: Date;
}

/** 单个组件的计算明细（写入 Commission.rateBreakdown） */
export interface RateBreakdownEntry {
  componentType: ComponentType;
  valueMode: ValueMode;
  driverVariable?: DriverVariable;
  /** 命中的阶梯档位索引（DYNAMIC 模式） */
  hitLadderStep?: number;
  /** 驱动变量取值 */
  driverValue?: number;
  /** 组件解析出的取值（比例/金额cents/产品数量） */
  computedValue: number;
  /** 本组件贡献的现金(cents)；PRODUCT 组件为 0 */
  cashContributionCents: number;
  productRef?: string;
  /** 是否因 minCommissionableAmountCents 被跳过 */
  skipped?: boolean;
}

// ──────────────────────────────────────────────────────
// 存储抽象（core 只依赖此接口）
// ──────────────────────────────────────────────────────

/**
 * 佣金模块持久化抽象。
 * 实现要求：
 * - insertCommission 必须幂等（唯一键 [orderId, referrerUserId, tierLevel] 冲突时静默忽略，返回 false）
 * - getActiveReferrer 只返回 status 为 PENDING/ACTIVE 的关系（链回溯用）
 */
export interface CommissionStorage {
  // 邀请码
  getReferralCodeByCode(code: string): Promise<ReferralCodeRow | null>;
  getReferralCodeByUserId(userId: string): Promise<ReferralCodeRow | null>;
  insertReferralCode(row: ReferralCodeRow): Promise<void>;
  setReferralCodeActive(code: string, isActive: boolean): Promise<void>;
  incrementCodeStats(code: string, field: 'totalInvites' | 'convertedCount'): Promise<void>;

  // 邀请关系
  /** 取被推荐人当前生效的推荐人（PENDING/ACTIVE）；无则 null */
  getActiveReferrer(refereeUserId: string): Promise<ReferralRelationshipRow | null>;
  insertRelationship(row: ReferralRelationshipRow): Promise<void>;
  setRelationshipStatus(relationshipId: string, status: RelationshipStatus, activatedAt?: Date): Promise<void>;

  // 佣金规则
  listActiveRules(programId: string): Promise<CommissionRuleRow[]>;

  // 佣金记录
  /** 幂等插入；唯一键冲突返回 false（已计过佣） */
  insertCommission(row: CommissionRow): Promise<boolean>;
  /** 推荐人本月转化数（REFERRER_MONTHLY_CONVERSIONS 驱动变量用） */
  countMonthlyConversions(referrerUserId: string, monthStart: Date): Promise<number>;
  /** 按订单查全部佣金记录（clawback 时区分可回转/已打款） */
  listCommissionsByOrder(orderId: string): Promise<CommissionRow[]>;
  /** 按推荐人分页查佣金明细（createdAt 倒序），供 REST 端点 GET /referrals/:userId/commissions */
  listCommissionsByReferrer(
    referrerUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<CommissionRow[]>;
  /**
   * 退款追回：把该订单下 PENDING/APPROVED 的佣金回转为 REFUNDED，返回回转条数。
   * Layer 3 单向流转：必须带前置状态条件（WHERE status IN …），PAID 记录不得自动回转。
   */
  markCommissionsRefunded(orderId: string): Promise<number>;
  /**
   * Layer 3 状态机单向流转：仅当当前状态在 from 集合内才更新为 to（乐观并发控制）。
   * @returns 是否实际发生流转（false = 状态不符/重复操作，调用方不得视为成功）
   */
  transitionCommissionStatus(
    commissionId: string,
    from: CommissionStatus[],
    to: CommissionStatus,
  ): Promise<boolean>;

  // 审核队列（7.1 Level 2 人工审核）
  /** 幂等插入审核队列（commissionId 唯一，重复入队返回 false） */
  insertAuditQueueItem(row: AuditQueueItemRow): Promise<boolean>;
  /** 审核队列分页查询（riskScore 倒序），status 缺省查全部 */
  listAuditQueue(opts?: {
    status?: QueueStatus;
    limit?: number;
    offset?: number;
  }): Promise<AuditQueueItemRow[]>;
  /** 按 commissionId 更新队列项状态（审批/拒绝时联动） */
  setAuditQueueStatus(
    commissionId: string,
    status: QueueStatus,
    opts?: { reviewedAt?: Date; reviewNotes?: string },
  ): Promise<void>;

  // 配置版本（8.2 快照/回滚）
  /** 插入版本快照；(programId, versionNumber) 唯一，冲突返回 false（并发创建时由调用方重试/报错） */
  insertConfigVersion(row: ConfigVersionRow): Promise<boolean>;
  /** 当前最大版本号（无版本返回 0），新建快照时 +1 */
  getMaxConfigVersionNumber(programId: string): Promise<number>;
  /** 版本列表分页（versionNumber 倒序） */
  listConfigVersions(
    programId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<ConfigVersionRow[]>;
  getConfigVersion(programId: string, versionNumber: number): Promise<ConfigVersionRow | null>;
  /** 标记指定版本为当前生效（isLatest=true + activatedAt），其余版本 isLatest=false */
  markConfigVersionActive(programId: string, versionNumber: number, activatedAt: Date): Promise<void>;
  /** 用快照规则整体替换该 program 的规则表（回滚应用快照） */
  replaceRules(programId: string, rules: CommissionRuleRow[]): Promise<void>;
}

// ──────────────────────────────────────────────────────
// 审核队列（7.1 三层审核机制）
// ──────────────────────────────────────────────────────

/** 入队原因（为什么需要人工审核） */
export type ReviewTrigger =
  | 'HIGH_AMOUNT' // 超过阈值
  | 'RAPID_GROWTH' // 快速增长异常
  | 'SAME_DEVICE' // 同设备检测
  | 'SUSPICIOUS_PATTERN' // 异常行为模式
  | 'MANUAL_FLAG' // 人工标记
  | 'PERIODIC_AUDIT'; // 周期性审查

export type QueueStatus = 'PENDING' | 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'ESCALATED';

export interface AuditQueueItemRow {
  id: string;
  /** 关联佣金（唯一：一笔佣金最多一个队列项） */
  commissionId: string;
  reason: ReviewTrigger;
  /** 风险评分 0-100 */
  riskScore: number;
  /** 风险因子标签，如 ["high_amount", "temp_email"] */
  riskFactors: string[];
  status: QueueStatus;
  assignedTo: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
}

// ──────────────────────────────────────────────────────
// 配置版本快照（8.2 版本控制：快照保存 / 切换回滚 / 变更审计）
// ──────────────────────────────────────────────────────

export interface ConfigVersionRow {
  id: string;
  programId: string;
  /** program 内自增版本号；(programId, versionNumber) 唯一 */
  versionNumber: number;
  /** 完整配置快照：当前生效的规则集（回滚时整体替换回规则表） */
  snapshot: { rules: CommissionRuleRow[] };
  /** 变更说明 */
  notes: string | null;
  /** 操作管理员 ID */
  createdBy: string | null;
  createdAt: Date;
  /** 最近一次被激活（成为生效配置）的时间 */
  activatedAt: Date | null;
  /** 是否为当前生效版本（同一 program 至多一个 true） */
  isLatest: boolean;
}

// ──────────────────────────────────────────────────────
// 配置与钩子
// ──────────────────────────────────────────────────────

export interface StripeFeeConfig {
  /** 百分比费率，默认 0.029（2.9%） */
  percentRate?: number;
  /** 固定费(cents)，默认 30（$0.30） */
  fixedCents?: number;
}

export interface ProductRewardGrantInput {
  referrerUserId: string;
  productRef: string;
  quantity: number;
  commissionId: string;
}

export interface CommissionHooks {
  /** PRODUCT 组件审核通过后触发；由开发者实现实际发放（加额度/延长会员等） */
  onProductRewardGrant?(input: ProductRewardGrantInput): Promise<{ granted: boolean }> | { granted: boolean };
}

export interface CommissionConfig {
  /** 佣金计划 ID（多计划隔离；单计划可固定 'default'） */
  programId: string;
  storage: CommissionStorage;
  /** 邀请链接模板，{CODE} 为占位符，如 https://app.example.com/r/{CODE} */
  inviteLinkTemplate?: string;
  stripeFee?: StripeFeeConfig;
  /** SHARED 模式下平台承担的手续费比例（0~1），默认 0.5 */
  platformFeeShareRatio?: number;
  /** 最大分销层级，默认 3 */
  maxTierLevels?: number;
  hooks?: CommissionHooks;
}

// ──────────────────────────────────────────────────────
// 计算输入 / 输出
// ──────────────────────────────────────────────────────

export interface CalculateCommissionInput {
  /** 付费用户 ID */
  userId: string;
  /** 订单 ID（Stripe Session ID / Invoice ID），幂等键的一部分 */
  orderId: string;
  planKey: string;
  planType: PlanType;
  triggerScope: TriggerScope;
  /** 实付金额(cents)：按 invoice.amount_paid / session.amount_total */
  amountTotal: number;
  currency: string;
  /** 账期序号（RECURRING/USAGE 用；首付为 1） */
  periodIndex?: number;
  now?: Date;
}

export interface TierCommissionResult {
  tierLevel: number;
  referrerUserId: string;
  /** 现金佣金合计(cents) */
  amount: number;
  ruleId: string;
  rateBreakdown: RateBreakdownEntry[];
  grantStatus: GrantStatus;
  reviewStatus: ReviewStatus;
  status: CommissionStatus;
  validUntil: Date;
  /** 是否实际落库（false = 幂等跳过，已计过佣） */
  inserted: boolean;
}

export interface CommissionCalculationResult {
  successful: boolean;
  /** 未计佣原因（无推荐链 / 无匹配规则等） */
  reason?: string;
  tiers: TierCommissionResult[];
  details: {
    grossAmount: number;
    stripeFee: number;
    netAmount: number;
    totalCommission: number;
    platformRevenue: number;
  } | null;
}

/** 退款追回结果（5.3 charge.refunded → clawback） */
export interface ClawbackResult {
  orderId: string;
  /** 自动回转为 REFUNDED 的佣金条数（原状态 PENDING/APPROVED） */
  refundedCount: number;
  /** 已打款（PAID）无法自动回转、需人工追回的佣金 ID */
  paidRequiresManual: string[];
}

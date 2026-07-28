/**
 * 佣金计算引擎（对应 docs/COMMISSION-SYSTEM-SPEC.md 2.3 / 6.1 / 附录 B）
 *
 * 职责：
 * - 构建多级推荐链 → 逐级匹配规则 → 解析奖励组件 → 计算现金/产品奖励
 * - Stripe 手续费三种承担模式（CONSUMED_BY_PLATFORM / PASSED_TO_CUSTOMER / SHARED）
 * - 写 rateBreakdown 审计快照、幂等落库、触发产品发放 hook
 */
import { randomUUID } from 'node:crypto';
import type { BillingLogger } from '../config.js';
import { buildReferralChain } from './chain.js';
import type {
  CalculateCommissionInput,
  ClawbackResult,
  CommissionCalculationResult,
  CommissionConfig,
  CommissionRuleRow,
  CommissionRow,
  CommissionStatus,
  ConfigVersionRow,
  DriverVariable,
  GrantStatus,
  RateBreakdownEntry,
  ReviewStatus,
  RewardComponent,
  TierCommissionResult,
  TriggerScope,
} from './types.js';

const DEFAULT_PERCENT_RATE = 0.029;
const DEFAULT_FIXED_CENTS = 30;

/** Stripe 手续费 = 百分比 + 固定费（附录 B：2.9% + $0.30） */
export function calculateStripeFee(amountCents: number, config: CommissionConfig): number {
  const percentRate = config.stripeFee?.percentRate ?? DEFAULT_PERCENT_RATE;
  const fixedCents = config.stripeFee?.fixedCents ?? DEFAULT_FIXED_CENTS;
  return Math.round(amountCents * percentRate) + fixedCents;
}

/**
 * 规则匹配：按 (planKey, triggerScope, tierLevel) 精确优先、全局兜底，priority 高者先。
 * 匹配优先级：planKey 精确 > planKey=null（全局）；tierLevel 精确 > tierLevel=null（全层级）。
 */
export function matchRule(
  rules: CommissionRuleRow[],
  scope: { planKey: string; triggerScope: TriggerScope; tierLevel: number },
): CommissionRuleRow | null {
  const candidates = rules.filter((r) => r.triggerScope === scope.triggerScope);
  if (!candidates.length) return null;

  let best: CommissionRuleRow | null = null;
  let bestScore = -1;
  for (const rule of candidates) {
    const planMatch = rule.planKey === null ? 0 : rule.planKey === scope.planKey ? 2 : -1;
    if (planMatch < 0) continue; // planKey 指定但不匹配 → 排除
    const tierMatch = rule.tierLevel === null ? 0 : rule.tierLevel === scope.tierLevel ? 1 : -1;
    if (tierMatch < 0) continue; // tierLevel 指定但不匹配 → 排除
    const score = planMatch * 10 + tierMatch * 5 + rule.priority;
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }
  return best;
}

interface DriverContext {
  baseAmount: number;
  amountTotal: number;
  referrerUserId: string;
  periodIndex: number;
  monthStart: Date;
  config: CommissionConfig;
}

async function resolveDriverValue(driver: DriverVariable, ctx: DriverContext): Promise<number> {
  switch (driver) {
    case 'ORDER_AMOUNT':
      return ctx.baseAmount;
    case 'PERIOD_INDEX':
      return ctx.periodIndex;
    case 'REFERRER_MONTHLY_CONVERSIONS':
      return ctx.config.storage.countMonthlyConversions(ctx.referrerUserId, ctx.monthStart);
    default:
      return 0;
  }
}

/** 在阶梯表中定位驱动值所在档位，返回 [档位索引, 取值]；未命中返回 null */
function resolveLadder(
  ladder: Array<{ from: number; to: number | null; value: number }>,
  driverValue: number,
): { step: number; value: number } | null {
  let step = 0;
  for (const s of ladder) {
    if (driverValue >= s.from && (s.to === null || driverValue < s.to)) {
      return { step, value: s.value };
    }
    step += 1;
  }
  return null;
}

interface ComponentResult {
  entry: RateBreakdownEntry;
  cashCents: number;
  product?: { productRef: string; quantity: number };
}

/** 解析单个奖励组件 → 现金贡献(cents) + 产品发放信息 + 审计明细 */
async function computeComponent(
  component: RewardComponent,
  ctx: DriverContext,
): Promise<ComponentResult> {
  const base: RateBreakdownEntry = {
    componentType: component.componentType,
    valueMode: component.valueMode,
    computedValue: 0,
    cashContributionCents: 0,
  };

  // 防穿仓：订单低于最低可佣金额时本组件不触发
  if (
    component.minCommissionableAmountCents != null &&
    ctx.amountTotal < component.minCommissionableAmountCents
  ) {
    return { entry: { ...base, skipped: true }, cashCents: 0 };
  }

  // 解析取值（FIXED / DYNAMIC 阶梯）
  let value = 0;
  let driverValue: number | undefined;
  let hitLadderStep: number | undefined;
  if (component.valueMode === 'DYNAMIC') {
    const driver = component.dynamicConfig?.driverVariable;
    const ladder = component.dynamicConfig?.ladder ?? [];
    if (!driver) return { entry: { ...base, skipped: true }, cashCents: 0 };
    driverValue = await resolveDriverValue(driver, ctx);
    const hit = resolveLadder(ladder, driverValue);
    if (!hit) return { entry: { ...base, driverVariable: driver, driverValue, skipped: true }, cashCents: 0 };
    value = hit.value;
    hitLadderStep = hit.step;
    base.driverVariable = driver;
    base.driverValue = driverValue;
    base.hitLadderStep = hitLadderStep;
  } else {
    value = component.fixedValue ?? 0;
  }
  base.computedValue = value;

  // 计算现金贡献
  let cashCents = 0;
  if (component.componentType === 'CASH_PERCENT') {
    cashCents = Math.floor(ctx.baseAmount * value);
  } else if (component.componentType === 'CASH_FIXED') {
    cashCents = Math.floor(value);
  }
  // 单笔封顶
  if (component.maxValueCents != null && cashCents > component.maxValueCents) {
    cashCents = component.maxValueCents;
  }
  base.cashContributionCents = cashCents;

  // 产品组件
  let product: { productRef: string; quantity: number } | undefined;
  if (component.componentType === 'PRODUCT' && component.productRef) {
    product = { productRef: component.productRef, quantity: Math.max(1, Math.floor(value)) };
    base.productRef = component.productRef;
  }

  return { entry: base, cashCents, product };
}

/** 判定审核状态与佣金状态 */
function resolveReview(rule: CommissionRuleRow, amountCents: number): {
  reviewStatus: ReviewStatus;
  status: CommissionStatus;
} {
  if (rule.requireReviewOverCents != null && amountCents > rule.requireReviewOverCents) {
    return { reviewStatus: 'MANUAL_REVIEW', status: 'PENDING' };
  }
  return { reviewStatus: 'AUTO_APPROVED', status: 'APPROVED' };
}

export interface CommissionEngineOptions {
  config: CommissionConfig;
  logger?: BillingLogger;
}

export class CommissionEngine {
  private config: CommissionConfig;
  private logger?: BillingLogger;

  constructor(opts: CommissionEngineOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
  }

  /** 暴露存储层（REST 端点层查询佣金明细用） */
  get storage() {
    return this.config.storage;
  }

  /** 佣金计划 ID（REST 端点层查询配置版本用） */
  get programId() {
    return this.config.programId;
  }

  /** 实时事件总线（适配层 SSE 端点订阅用；未配置返回 undefined） */
  get events() {
    return this.config.events;
  }

  /**
   * 退款追回（5.3 charge.refunded → clawback）：
   * - PENDING/APPROVED → REFUNDED（存储层带前置状态条件，天然幂等：重放时回转 0 条）
   * - PAID 不自动回转，返回 ID 列表交人工追回（打款腿落地后接入负余额抵扣）
   */
  async clawbackByOrder(orderId: string): Promise<ClawbackResult> {
    const storage = this.config.storage;
    const existing = await storage.listCommissionsByOrder(orderId);
    if (!existing.length) {
      return { orderId, refundedCount: 0, paidRequiresManual: [] };
    }

    const refundedCount = await storage.markCommissionsRefunded(orderId);
    const paidRequiresManual = existing.filter((c) => c.status === 'PAID').map((c) => c.id);

    this.logger?.info('commission.clawback.executed', { orderId, refundedCount });
    if (paidRequiresManual.length) {
      this.logger?.warn('commission.clawback.paid_requires_manual', {
        orderId,
        commissionIds: paidRequiresManual,
      });
    }
    return { orderId, refundedCount, paidRequiresManual };
  }

  /**
   * 审批通过：PENDING → APPROVED（Layer 3 条件流转，重复审批返回 false）。
   */
  async approveCommission(commissionId: string): Promise<boolean> {
    const ok = await this.config.storage.transitionCommissionStatus(commissionId, ['PENDING'], 'APPROVED');
    if (ok) {
      await this.config.storage.setAuditQueueStatus(commissionId, 'APPROVED', { reviewedAt: new Date() });
      this.logger?.info('commission.review.approved', { commissionId });
      await this.publishCommissionEvent('commission.approved', commissionId);
    } else {
      this.logger?.warn('commission.review.approve_rejected_by_state', { commissionId });
    }
    return ok;
  }

  /**
   * 审批拒绝：PENDING → REJECTED（拒绝原因由端点层强制必填，此处仅记审计日志）。
   */
  async rejectCommission(commissionId: string, reason?: string): Promise<boolean> {
    const ok = await this.config.storage.transitionCommissionStatus(commissionId, ['PENDING'], 'REJECTED');
    if (ok) {
      await this.config.storage.setAuditQueueStatus(commissionId, 'REJECTED', {
        reviewedAt: new Date(),
        reviewNotes: reason,
      });
      this.logger?.info('commission.review.rejected', { commissionId, reason });
    } else {
      this.logger?.warn('commission.review.reject_rejected_by_state', { commissionId });
    }
    return ok;
  }

  /**
   * 标记打款完成：APPROVED → PAID（防重复打款的最后一道闸，见 5.4.1 Layer 3）。
   * 打款腿（PayoutProvider）落地后由 payout 流程调用；返回 false 必须中止打款。
   */
  async markCommissionPaid(commissionId: string): Promise<boolean> {
    const ok = await this.config.storage.transitionCommissionStatus(commissionId, ['APPROVED'], 'PAID');
    if (ok) {
      this.logger?.info('commission.payout.marked_paid', { commissionId });
      await this.publishCommissionEvent('commission.paid', commissionId);
    } else {
      this.logger?.warn('commission.payout.mark_paid_rejected_by_state', { commissionId });
    }
    return ok;
  }

  /**
   * 推送佣金状态事件（6.3 SSE）：回查佣金行取推荐人与金额。
   * 总线缺省/查无此行时静默跳过，推送失败不影响主流程。
   */
  private async publishCommissionEvent(type: 'commission.approved' | 'commission.paid', commissionId: string): Promise<void> {
    if (!this.config.events) return;
    try {
      const row = await this.config.storage.getCommissionById(commissionId);
      if (!row) return;
      this.config.events.publish(row.referrerUserId, {
        type,
        data: { commissionId, amount: row.amount },
      });
    } catch (err) {
      this.logger?.warn('commission.events.publish_failed', { commissionId, error: String(err) });
    }
  }

  /**
   * 保存当前配置快照为新版本（8.2 版本控制）。
   * 快照内容 = 当前生效规则集；新版本即当前生效配置，自动标记为 latest。
   * @returns 版本行；null = 版本号并发冲突（罕见，管理端重试即可）
   */
  async snapshotConfigVersion(opts?: { notes?: string; createdBy?: string }): Promise<ConfigVersionRow | null> {
    const storage = this.config.storage;
    const programId = this.config.programId;
    const now = new Date();
    const rules = await storage.listActiveRules(programId);
    const versionNumber = (await storage.getMaxConfigVersionNumber(programId)) + 1;
    const row: ConfigVersionRow = {
      id: randomUUID(),
      programId,
      versionNumber,
      snapshot: { rules },
      notes: opts?.notes ?? null,
      createdBy: opts?.createdBy ?? null,
      createdAt: now,
      activatedAt: now,
      isLatest: true,
    };
    const inserted = await storage.insertConfigVersion(row);
    if (!inserted) {
      this.logger?.warn('commission.config.version_conflict', { programId, versionNumber });
      return null;
    }
    await storage.markConfigVersionActive(programId, versionNumber, now);
    this.logger?.info('commission.config.snapshot_created', { programId, versionNumber });
    return row;
  }

  /**
   * 激活/回滚到指定版本：把快照内规则整体替换回规则表，并标记该版本为 latest。
   * 只影响未来订单的计佣；历史佣金记录（含 rateBreakdown 快照）不受影响。
   * @returns false = 版本不存在
   */
  async activateConfigVersion(versionNumber: number): Promise<boolean> {
    const storage = this.config.storage;
    const programId = this.config.programId;
    const version = await storage.getConfigVersion(programId, versionNumber);
    if (!version) {
      this.logger?.warn('commission.config.version_not_found', { programId, versionNumber });
      return false;
    }
    await storage.replaceRules(programId, version.snapshot.rules);
    await storage.markConfigVersionActive(programId, versionNumber, new Date());
    this.logger?.info('commission.config.version_activated', { programId, versionNumber });
    return true;
  }

  /**
   * 计算并落库一笔订单的多级佣金（幂等）。
   */
  async calculateCommissions(input: CalculateCommissionInput): Promise<CommissionCalculationResult> {
    const now = input.now ?? new Date();
    const storage = this.config.storage;
    const maxLevels = this.config.maxTierLevels ?? 3;

    // 1. 构建推荐链
    const { chain, cycleDetected } = await buildReferralChain(
      input.userId,
      storage,
      maxLevels,
      this.logger,
    );
    if (cycleDetected) {
      this.logger?.warn('commission.calc.cycle_flagged', { orderId: input.orderId, userId: input.userId });
    }
    if (!chain.length) {
      return { successful: false, reason: 'NO_REFERRAL_CHAIN', tiers: [], details: null };
    }

    // 2. 手续费与计佣基数
    const stripeFee = calculateStripeFee(input.amountTotal, this.config);
    const rules = await storage.listActiveRules(this.config.programId);

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const tiers: TierCommissionResult[] = [];

    for (const node of chain) {
      const rule = matchRule(rules, {
        planKey: input.planKey,
        triggerScope: input.triggerScope,
        tierLevel: node.tierLevel,
      });
      if (!rule) continue; // 该级无规则 → 不计佣、不递补

      // 承担模式决定实际扣减的手续费
      const ratio =
        rule.platformFeeHandlingMode === 'SHARED'
          ? this.config.platformFeeShareRatio ?? 0.5
          : rule.platformFeeHandlingMode === 'PASSED_TO_CUSTOMER'
            ? 0
            : 1;
      const effectiveFee = Math.round(stripeFee * ratio);
      const netAmount = input.amountTotal - effectiveFee;
      const baseAmount = rule.commissionBase === 'GROSS_BASED' ? input.amountTotal : netAmount;

      const driverCtx: DriverContext = {
        baseAmount,
        amountTotal: input.amountTotal,
        referrerUserId: node.referrerUserId,
        periodIndex: input.periodIndex ?? 1,
        monthStart,
        config: this.config,
      };

      // 3. 逐组件计算
      const rateBreakdown: RateBreakdownEntry[] = [];
      let amount = 0;
      const productGrants: Array<{ productRef: string; quantity: number }> = [];
      for (const component of rule.components) {
        const result = await computeComponent(component, driverCtx);
        rateBreakdown.push(result.entry);
        amount += result.cashCents;
        if (result.product) productGrants.push(result.product);
      }

      // 4. 审核判定
      const { reviewStatus, status } = resolveReview(rule, amount);
      const validUntil = new Date(now.getTime() + rule.holdPeriodDays * 24 * 60 * 60 * 1000);

      // 5. 产品发放 hook（只记账由开发者发放；此处同步触发并回写状态）
      let grantStatus: GrantStatus = productGrants.length ? 'PENDING_GRANT' : 'NOT_APPLICABLE';
      const commissionId = randomUUID();
      if (productGrants.length && this.config.hooks?.onProductRewardGrant) {
        try {
          let allGranted = true;
          for (const grant of productGrants) {
            const res = await this.config.hooks.onProductRewardGrant({
              referrerUserId: node.referrerUserId,
              productRef: grant.productRef,
              quantity: grant.quantity,
              commissionId,
            });
            if (!res.granted) allGranted = false;
          }
          grantStatus = allGranted ? 'GRANTED' : 'GRANT_FAILED';
        } catch (err) {
          this.logger?.error('commission.product_grant.failed', {
            commissionId,
            error: String(err),
          });
          grantStatus = 'GRANT_FAILED';
        }
      }

      // 6. 幂等落库
      const row: CommissionRow = {
        id: commissionId,
        referrerUserId: node.referrerUserId,
        orderId: input.orderId,
        planKey: input.planKey,
        amount,
        currency: input.currency,
        rateBreakdown,
        grantStatus,
        tierLevel: node.tierLevel,
        status,
        reviewStatus,
        validUntil,
        createdAt: now,
      };
      const inserted = await storage.insertCommission(row);

      // 实时推送新佣金入账（6.3 SSE；幂等跳过时不重复推送）
      if (inserted) {
        this.config.events?.publish(node.referrerUserId, {
          type: 'commission.created',
          data: { commissionId, amount, currency: input.currency, tierLevel: node.tierLevel },
        });
      }

      // 7. 需人工审核的佣金自动入队（7.1 Level 2；insert 幂等，重放不双入队）
      if (inserted && reviewStatus === 'MANUAL_REVIEW') {
        const threshold = rule.requireReviewOverCents ?? 0;
        // 超阈值倍数越高风险越大：基础 50 分 + 每超 1 倍加 10 分，封顶 100
        const riskScore = Math.min(
          100,
          50 + (threshold > 0 ? Math.floor((amount / threshold - 1) * 10) : 0),
        );
        await storage.insertAuditQueueItem({
          id: randomUUID(),
          commissionId,
          reason: 'HIGH_AMOUNT',
          riskScore,
          riskFactors: ['high_amount'],
          status: 'PENDING',
          assignedTo: null,
          reviewedAt: null,
          reviewNotes: null,
          createdAt: now,
        });
        this.logger?.info('commission.audit.enqueued', { commissionId, riskScore });
      }

      tiers.push({
        tierLevel: node.tierLevel,
        referrerUserId: node.referrerUserId,
        amount,
        ruleId: rule.id,
        rateBreakdown,
        grantStatus,
        reviewStatus,
        status,
        validUntil,
        inserted,
      });
    }

    if (!tiers.length) {
      return { successful: false, reason: 'NO_MATCHING_RULE', tiers: [], details: null };
    }

    // 转化闭环：首付计佣落库后激活直接推荐关系（PENDING → ACTIVE）并累计 convertedCount（统计漏斗用）。
    // 仅 PENDING 时执行 → webhook 重放/复购不重复计数。
    if (input.triggerScope === 'FIRST_PAYMENT' && tiers.some((t) => t.tierLevel === 1 && t.inserted)) {
      const rel = await storage.getActiveReferrer(input.userId);
      if (rel && rel.status === 'PENDING') {
        await storage.setRelationshipStatus(rel.id, 'ACTIVE', now);
        await storage.incrementCodeStats(rel.originalCode, 'convertedCount');
        this.logger?.info('commission.referral.converted', {
          refereeUserId: input.userId,
          relationshipId: rel.id,
        });
      }
    }

    const totalCommission = tiers.reduce((sum, t) => sum + t.amount, 0);
    const netAmountForReport = input.amountTotal - stripeFee;
    return {
      successful: true,
      tiers,
      details: {
        grossAmount: input.amountTotal,
        stripeFee,
        netAmount: netAmountForReport,
        totalCommission,
        platformRevenue: netAmountForReport - totalCommission,
      },
    };
  }
}

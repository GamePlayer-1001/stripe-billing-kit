/**
 * 打款调度器（对应 docs/COMMISSION-SYSTEM-SPEC.md Phase 3"配置 Payouts 任务调度器"）。
 *
 * core 只提供单轮执行函数 runScheduledPayouts，由产品侧 cron 按结算周期调用
 * （batchProcessFrequency: DAILY/WEEKLY/MONTHLY、scheduledPayoutDay 等排期在产品侧落地）：
 * 1. 扫描窗口内 APPROVED 佣金，按 推荐人 × 币种 聚合；
 * 2. 冻结期过滤：validUntil <= now 才可结算（等待退款期，8.1 Step 4 holdPeriodDays）；
 * 3. 提现门槛：同币种合计 >= minPayoutThresholdCents 才发起打款（降低手续费占比）；
 * 4. 逐组调用 PayoutService.createPayout（双闸幂等由 PayoutService 保证，重复执行安全）。
 */
import type { BillingLogger } from '../config.js';
import type { CommissionRow, CommissionStorage, PayoutRow } from './types.js';
import type { PayoutService } from './payouts.js';

export interface ScheduledPayoutOptions {
  payouts: PayoutService;
  storage: CommissionStorage;
  /** 提现门槛 cents（默认 5000 = $50），同币种合计不足不打款 */
  minPayoutThresholdCents?: number;
  /** 是否遵守冻结期（validUntil <= now 才结算），默认 true */
  respectHoldPeriod?: boolean;
  /** 扫描窗口天数（默认 365，覆盖历史滞留佣金） */
  scanWindowDays?: number;
  /** 扫描分页大小（默认 200） */
  pageSize?: number;
  /** 单轮最多发起的打款笔数（默认 20，防一轮内大批量提交通道） */
  maxPayoutsPerRun?: number;
  now?: Date;
  logger?: BillingLogger;
}

/** 未打款分组的原因 */
export type ScheduledSkipReason =
  | 'BELOW_THRESHOLD' // 合计不足提现门槛
  | 'RECIPIENT_NOT_READY' // 收款账户未就绪
  | 'NO_PAYABLE_COMMISSIONS' // 并发竞争后无可结算佣金
  | 'PROVIDER_ERROR' // 通道异常（佣金已由 PayoutService 回滚）
  | 'RUN_LIMIT_REACHED'; // 超出单轮上限，留待下轮

export interface ScheduledPayoutSkip {
  referrerUserId: string;
  currency: string;
  totalCents: number;
  reason: ScheduledSkipReason;
  missingSteps?: string[];
}

export interface ScheduledPayoutResult {
  /** 窗口内扫描到的 APPROVED（含冻结中）佣金数 */
  scannedCommissions: number;
  /** 达到结算条件评估的分组数（推荐人 × 币种） */
  evaluatedGroups: number;
  /** 本轮成功创建的打款 */
  created: PayoutRow[];
  skipped: ScheduledPayoutSkip[];
  durationMs: number;
}

/**
 * 单轮批量结算。逐页扫描 APPROVED 佣金 → 冻结期/门槛过滤 →
 * 按推荐人 × 币种分组打款。幂等：已 PAID 的佣金不会再被扫到，重复执行安全。
 */
export async function runScheduledPayouts(opts: ScheduledPayoutOptions): Promise<ScheduledPayoutResult> {
  const {
    payouts,
    storage,
    minPayoutThresholdCents = 5000,
    respectHoldPeriod = true,
    scanWindowDays = 365,
    pageSize = 200,
    maxPayoutsPerRun = 20,
    logger,
  } = opts;
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const windowStart = new Date(now.getTime() - scanWindowDays * 24 * 60 * 60 * 1000);

  // 1. 扫描窗口内 APPROVED 佣金
  const approved: CommissionRow[] = [];
  let scanned = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await storage.listCommissionsSince(windowStart, { limit: pageSize, offset });
    scanned += page.filter((c) => c.status === 'APPROVED').length;
    approved.push(
      ...page.filter(
        (c) => c.status === 'APPROVED' && (!respectHoldPeriod || c.validUntil.getTime() <= now.getTime()),
      ),
    );
    if (page.length < pageSize) break;
  }

  // 2. 按 推荐人 × 币种 分组
  const groups = new Map<string, { referrerUserId: string; currency: string; rows: CommissionRow[] }>();
  for (const c of approved) {
    const key = `${c.referrerUserId}\u0000${c.currency}`;
    const group = groups.get(key) ?? { referrerUserId: c.referrerUserId, currency: c.currency, rows: [] };
    group.rows.push(c);
    groups.set(key, group);
  }

  const created: PayoutRow[] = [];
  const skipped: ScheduledPayoutSkip[] = [];

  for (const group of groups.values()) {
    const totalCents = group.rows.reduce((sum, c) => sum + c.amount, 0);
    const base = { referrerUserId: group.referrerUserId, currency: group.currency, totalCents };

    if (totalCents < minPayoutThresholdCents) {
      skipped.push({ ...base, reason: 'BELOW_THRESHOLD' });
      continue;
    }
    if (created.length >= maxPayoutsPerRun) {
      skipped.push({ ...base, reason: 'RUN_LIMIT_REACHED' });
      continue;
    }

    const result = await payouts.createPayout({
      referrerUserId: group.referrerUserId,
      commissionIds: group.rows.map((c) => c.id),
      now,
    });
    if (result.created && result.payout) {
      created.push(result.payout);
    } else {
      skipped.push({
        ...base,
        reason: (result.reason ?? 'PROVIDER_ERROR') as ScheduledSkipReason,
        missingSteps: result.missingSteps,
      });
    }
  }

  const report: ScheduledPayoutResult = {
    scannedCommissions: scanned,
    evaluatedGroups: groups.size,
    created,
    skipped,
    durationMs: Date.now() - startedAt,
  };
  logger?.info?.('commission.scheduled_payouts.done', {
    evaluatedGroups: report.evaluatedGroups,
    created: created.length,
    skipped: skipped.length,
  });
  return report;
}

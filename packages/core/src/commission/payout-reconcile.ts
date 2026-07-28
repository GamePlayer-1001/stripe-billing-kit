/**
 * 打款双向对账 + 月度财务报表（对应 docs/COMMISSION-SYSTEM-SPEC.md Phase 3）。
 *
 * 架构原则（8.1 Step 4）：对账以内部 Commission + Payout 表为唯一事实来源，
 * 定期与 Stripe/PayPal 流水双向核对：
 * - reconcilePayouts：内部 Payout 表 vs provider.listTransactions 双向比对（只读，
 *   仅输出差异清单，状态修复由调用方经 PayoutService.applyProviderStatus 执行）；
 * - generateMonthlyPayoutReport：按自然月汇总打款/佣金账目，供导出财务报表。
 *
 * 注：MANUAL 通道无通道侧流水（listTransactions 恒为空），对账时内部记录会全部
 * 报 MISSING_IN_PROVIDER，属预期——线下通道以内部记录为准，无需对账。
 */
import type { BillingLogger } from '../config.js';
import type {
  CommissionStorage,
  PayoutProvider,
  PayoutRow,
  PayoutStatus,
} from './types.js';

// ──────────────────────────────────────────────────────
// 双向对账
// ──────────────────────────────────────────────────────

export type PayoutMismatchKind =
  | 'MISSING_IN_PROVIDER' // 内部有、通道无（可能通道侧丢单）
  | 'MISSING_INTERNAL' // 通道有、内部无（可能绕过系统的手工打款）
  | 'STATUS_MISMATCH' // 两侧状态不一致（内部未收到回调等）
  | 'AMOUNT_MISMATCH'; // 金额不一致

export interface PayoutMismatch {
  kind: PayoutMismatchKind;
  providerTransactionId: string;
  payoutId?: string;
  internalStatus?: PayoutStatus;
  providerStatus?: PayoutStatus;
  internalAmount?: number;
  providerAmount?: number;
}

export interface PayoutReconcileOptions {
  storage: CommissionStorage;
  provider: PayoutProvider;
  /** 对账时段 */
  from: Date;
  to: Date;
  /** 内部打款分页扫描大小（默认 100） */
  pageSize?: number;
  logger?: BillingLogger;
}

export interface PayoutReconcileReport {
  from: Date;
  to: Date;
  provider: string;
  /** 时段内该通道的内部打款数（含未提交通道的 CREATED） */
  internalCount: number;
  /** 通道侧流水数 */
  providerCount: number;
  /** 双侧匹配且状态金额一致 */
  matched: number;
  /** 尚未提交通道的内部记录（providerTransactionId 为空，不参与比对） */
  pendingSubmission: number;
  mismatches: PayoutMismatch[];
  durationMs: number;
}

/** 分页拉取时段内该通道的全部内部打款记录 */
async function listInternalPayouts(
  storage: CommissionStorage,
  provider: string,
  from: Date,
  to: Date,
  pageSize: number,
): Promise<PayoutRow[]> {
  const result: PayoutRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await storage.listPayouts({ limit: pageSize, offset });
    result.push(
      ...page.filter(
        (p) =>
          p.provider === provider &&
          p.createdAt.getTime() >= from.getTime() &&
          p.createdAt.getTime() <= to.getTime(),
      ),
    );
    if (page.length < pageSize) break;
  }
  return result;
}

/**
 * 双向对账（只读）：内部账本 vs 通道流水。
 * 差异只报告不修复——状态修复应走 PayoutService.applyProviderStatus（含佣金回滚联动）。
 */
export async function reconcilePayouts(opts: PayoutReconcileOptions): Promise<PayoutReconcileReport> {
  const { storage, provider, from, to, pageSize = 100, logger } = opts;
  const startedAt = Date.now();

  const [internal, providerTxs] = await Promise.all([
    listInternalPayouts(storage, provider.name, from, to, pageSize),
    provider.listTransactions(from, to),
  ]);

  const txById = new Map(providerTxs.map((t) => [t.providerTransactionId, t]));
  const mismatches: PayoutMismatch[] = [];
  let matched = 0;
  let pendingSubmission = 0;

  // 内部 → 通道
  for (const payout of internal) {
    if (!payout.providerTransactionId) {
      pendingSubmission += 1; // 尚未提交通道，无从比对
      continue;
    }
    const tx = txById.get(payout.providerTransactionId);
    if (!tx) {
      mismatches.push({
        kind: 'MISSING_IN_PROVIDER',
        providerTransactionId: payout.providerTransactionId,
        payoutId: payout.id,
        internalStatus: payout.status,
        internalAmount: payout.amount,
      });
      continue;
    }
    txById.delete(payout.providerTransactionId); // 剩余的即"通道有内部无"
    if (tx.amount !== payout.amount) {
      mismatches.push({
        kind: 'AMOUNT_MISMATCH',
        providerTransactionId: payout.providerTransactionId,
        payoutId: payout.id,
        internalAmount: payout.amount,
        providerAmount: tx.amount,
      });
    } else if (tx.status !== payout.status) {
      mismatches.push({
        kind: 'STATUS_MISMATCH',
        providerTransactionId: payout.providerTransactionId,
        payoutId: payout.id,
        internalStatus: payout.status,
        providerStatus: tx.status,
      });
    } else {
      matched += 1;
    }
  }

  // 通道 → 内部（剩余未匹配的通道流水）
  for (const tx of txById.values()) {
    mismatches.push({
      kind: 'MISSING_INTERNAL',
      providerTransactionId: tx.providerTransactionId,
      providerStatus: tx.status,
      providerAmount: tx.amount,
    });
  }

  const report: PayoutReconcileReport = {
    from,
    to,
    provider: provider.name,
    internalCount: internal.length,
    providerCount: providerTxs.length,
    matched,
    pendingSubmission,
    mismatches,
    durationMs: Date.now() - startedAt,
  };
  logger?.info?.('commission.payout_reconcile.done', {
    provider: provider.name,
    internalCount: report.internalCount,
    providerCount: report.providerCount,
    matched,
    mismatches: mismatches.length,
  });
  return report;
}

// ──────────────────────────────────────────────────────
// 月度财务报表
// ──────────────────────────────────────────────────────

export interface MonthlyReportOptions {
  storage: CommissionStorage;
  /** 报表年份（如 2026） */
  year: number;
  /** 报表月份 1-12 */
  month: number;
  /** 分页扫描大小（默认 100） */
  pageSize?: number;
}

export interface MonthlyPayoutReport {
  monthStart: Date;
  /** 下月第一天（区间为 [monthStart, monthEnd)） */
  monthEnd: Date;
  payouts: {
    total: number;
    byStatus: Partial<Record<PayoutStatus, number>>;
    /** 成功打款合计 cents（SUCCEEDED） */
    succeededCents: number;
    /** 通道手续费合计 cents */
    feeCents: number;
    byCurrency: Record<string, { count: number; succeededCents: number }>;
    byProvider: Record<string, { count: number; succeededCents: number }>;
  };
  commissions: {
    /** 当月新计佣笔数 / 合计 cents */
    created: number;
    createdCents: number;
    /** 当月新计佣中已退款笔数 / cents（追缴口径） */
    refunded: number;
    refundedCents: number;
  };
}

/** 按自然月汇总打款与佣金账目（导出财务报表的数据源） */
export async function generateMonthlyPayoutReport(opts: MonthlyReportOptions): Promise<MonthlyPayoutReport> {
  const { storage, year, month, pageSize = 100 } = opts;
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const inMonth = (d: Date) => d.getTime() >= monthStart.getTime() && d.getTime() < monthEnd.getTime();

  // 打款侧
  const byStatus: Partial<Record<PayoutStatus, number>> = {};
  const byCurrency: Record<string, { count: number; succeededCents: number }> = {};
  const byProvider: Record<string, { count: number; succeededCents: number }> = {};
  let total = 0;
  let succeededCents = 0;
  let feeCents = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await storage.listPayouts({ limit: pageSize, offset });
    for (const p of page.filter((p) => inMonth(p.createdAt))) {
      total += 1;
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      feeCents += p.feeAmount;
      const succeeded = p.status === 'SUCCEEDED' ? p.amount : 0;
      succeededCents += succeeded;
      const currencyEntry = byCurrency[p.currency] ?? { count: 0, succeededCents: 0 };
      currencyEntry.count += 1;
      currencyEntry.succeededCents += succeeded;
      byCurrency[p.currency] = currencyEntry;
      const providerEntry = byProvider[p.provider] ?? { count: 0, succeededCents: 0 };
      providerEntry.count += 1;
      providerEntry.succeededCents += succeeded;
      byProvider[p.provider] = providerEntry;
    }
    if (page.length < pageSize) break;
  }

  // 佣金侧（当月新计佣）
  let created = 0;
  let createdCents = 0;
  let refunded = 0;
  let refundedCents = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await storage.listCommissionsSince(monthStart, { limit: pageSize, offset });
    for (const c of page.filter((c) => inMonth(c.createdAt))) {
      created += 1;
      createdCents += c.amount;
      if (c.status === 'REFUNDED') {
        refunded += 1;
        refundedCents += c.amount;
      }
    }
    if (page.length < pageSize) break;
  }

  return {
    monthStart,
    monthEnd,
    payouts: { total, byStatus, succeededCents, feeCents, byCurrency, byProvider },
    commissions: { created, createdCents, refunded, refundedCents },
  };
}

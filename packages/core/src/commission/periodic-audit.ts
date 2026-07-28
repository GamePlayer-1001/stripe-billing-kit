/**
 * Level 3 周期性审计（对应 docs/COMMISSION-SYSTEM-SPEC.md 7.1 Level 3: 周期性审计）。
 *
 * core 只提供单轮执行函数 runPeriodicAudit，由产品侧 cron 周期调用（如每周日凌晨 2 点）：
 * 1. checkHighRiskUsers：扫描窗口内佣金，按推荐人聚合退款率，超阈值判定高风险；
 * 2. clawbackCommissions：可选，把高风险推荐人未打款佣金（PENDING/APPROVED）追回为 REJECTED；
 * 3. generateFraudReport：返回结构化欺诈分析报告（高风险名单 + 风险评分 + 处置结果）。
 *
 * 默认只标记入人工审核队列（PERIODIC_AUDIT），不自动追回——资金动作需显式开启 clawbackSuspicious。
 */
import { randomUUID } from 'node:crypto';
import type { BillingLogger } from '../config.js';
import type { AuditQueueItemRow, CommissionRow, CommissionStorage } from './types.js';
import { calculateRiskScore, type RiskAssessment } from './fraud.js';

export interface PeriodicAuditOptions {
  storage: CommissionStorage;
  /** 审计窗口天数（默认 30 天） */
  windowDays?: number;
  /** 退款率阈值，超过判定高风险（默认 0.3，即规范"退款率 >30%"） */
  refundRateThreshold?: number;
  /** 最少佣金笔数（不足不评估，避免 1 笔退款即 100% 误伤；默认 3） */
  minCommissions?: number;
  /** 是否把高风险推荐人的未打款佣金入人工审核队列（默认 true） */
  flagSuspicious?: boolean;
  /** 是否自动追回高风险推荐人的未打款佣金 → REJECTED（默认 false，资金动作需显式开启） */
  clawbackSuspicious?: boolean;
  /** 扫描分页大小（默认 200） */
  pageSize?: number;
  now?: Date;
  logger?: BillingLogger;
}

/** 高风险推荐人条目 */
export interface HighRiskReferrer {
  referrerUserId: string;
  /** 窗口内佣金笔数 */
  totalCommissions: number;
  /** 窗口内已退款笔数 */
  refundedCount: number;
  /** 退款率 0-1 */
  refundRate: number;
  /** 风险画像（复用 7.2 评分） */
  assessment: RiskAssessment;
  /** 本轮入队的佣金 ID（flagSuspicious 时） */
  flaggedCommissionIds: string[];
  /** 本轮追回的佣金 ID（clawbackSuspicious 时） */
  clawedBackCommissionIds: string[];
}

/** 欺诈分析报告（generateFraudReport 输出） */
export interface FraudReport {
  windowStart: Date;
  windowEnd: Date;
  /** 窗口内扫描的佣金总数 */
  scannedCommissions: number;
  /** 参与评估的推荐人数 */
  evaluatedReferrers: number;
  highRiskReferrers: HighRiskReferrer[];
  /** 入队总数 / 追回总数 */
  flaggedCount: number;
  clawedBackCount: number;
  durationMs: number;
}

/**
 * 单轮周期性审计。逐页扫描窗口内佣金 → 按推荐人聚合退款率 →
 * 高风险者未打款佣金入审核队列（幂等：commissionId 唯一，重复入队跳过），
 * 可选自动追回（Layer 3 条件流转 PENDING/APPROVED → REJECTED，天然幂等）。
 */
export async function runPeriodicAudit(opts: PeriodicAuditOptions): Promise<FraudReport> {
  const {
    storage,
    windowDays = 30,
    refundRateThreshold = 0.3,
    minCommissions = 3,
    flagSuspicious = true,
    clawbackSuspicious = false,
    pageSize = 200,
    logger,
  } = opts;
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // 1. 逐页拉取窗口内全部佣金
  const all: CommissionRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await storage.listCommissionsSince(windowStart, { limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) break;
  }

  // 2. 按推荐人聚合退款率
  const byReferrer = new Map<string, CommissionRow[]>();
  for (const c of all) {
    const list = byReferrer.get(c.referrerUserId) ?? [];
    list.push(c);
    byReferrer.set(c.referrerUserId, list);
  }

  const highRiskReferrers: HighRiskReferrer[] = [];
  let flaggedCount = 0;
  let clawedBackCount = 0;

  for (const [referrerUserId, rows] of byReferrer) {
    if (rows.length < minCommissions) continue;
    const refundedCount = rows.filter((c) => c.status === 'REFUNDED').length;
    const refundRate = refundedCount / rows.length;
    if (refundRate <= refundRateThreshold) continue;

    const assessment = calculateRiskScore({ transactionHistory: { refundRate } });
    const suspicious = rows.filter((c) => c.status === 'PENDING' || c.status === 'APPROVED');
    const flaggedCommissionIds: string[] = [];
    const clawedBackCommissionIds: string[] = [];

    for (const c of suspicious) {
      if (clawbackSuspicious) {
        // 资金动作：条件流转（Layer 3），已被并发处置的记录返回 false 自动跳过
        const done = await storage.transitionCommissionStatus(c.id, ['PENDING', 'APPROVED'], 'REJECTED');
        if (done) {
          clawedBackCommissionIds.push(c.id);
          clawedBackCount += 1;
        }
        continue;
      }
      if (flagSuspicious) {
        const item: AuditQueueItemRow = {
          id: randomUUID(),
          commissionId: c.id,
          reason: 'PERIODIC_AUDIT',
          riskScore: assessment.score,
          riskFactors: assessment.reasons,
          status: 'PENDING',
          assignedTo: null,
          reviewedAt: null,
          reviewNotes: null,
          createdAt: now,
        };
        // 幂等：一笔佣金最多一个队列项，重复入队返回 false
        const inserted = await storage.insertAuditQueueItem(item);
        if (inserted) {
          flaggedCommissionIds.push(c.id);
          flaggedCount += 1;
        }
      }
    }

    highRiskReferrers.push({
      referrerUserId,
      totalCommissions: rows.length,
      refundedCount,
      refundRate,
      assessment,
      flaggedCommissionIds,
      clawedBackCommissionIds,
    });
  }

  const report: FraudReport = {
    windowStart,
    windowEnd: now,
    scannedCommissions: all.length,
    evaluatedReferrers: byReferrer.size,
    highRiskReferrers,
    flaggedCount,
    clawedBackCount,
    durationMs: Date.now() - startedAt,
  };
  logger?.info?.('commission.periodic_audit.done', {
    scannedCommissions: report.scannedCommissions,
    highRisk: highRiskReferrers.length,
    flaggedCount,
    clawedBackCount,
  });
  return report;
}

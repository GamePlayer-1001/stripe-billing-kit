/**
 * periodic-audit.ts 单元测试（7.1 Level 3 周期性审计）。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { runPeriodicAudit } from './periodic-audit.js';
import type { CommissionRow, CommissionStatus } from './types.js';

const NOW = new Date('2026-07-27T02:00:00Z');
let seq = 0;

/** 造一条窗口内的佣金记录 */
function makeCommission(referrerUserId: string, status: CommissionStatus, daysAgo = 5): CommissionRow {
  seq += 1;
  return {
    id: `c_${seq}`,
    referrerUserId,
    orderId: `order_${seq}`,
    planKey: 'pro',
    amount: 2000,
    currency: 'usd',
    rateBreakdown: [],
    grantStatus: 'NOT_APPLICABLE',
    tierLevel: 1,
    status,
    reviewStatus: 'AUTO_APPROVED',
    validUntil: NOW,
    createdAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
  };
}

async function seed(storage: InMemoryCommissionStorage, rows: CommissionRow[]) {
  for (const row of rows) await storage.insertCommission(row);
}

describe('runPeriodicAudit', () => {
  it('高退款率推荐人判定高风险，未打款佣金入审核队列（PERIODIC_AUDIT）', async () => {
    const storage = new InMemoryCommissionStorage();
    // bad：4 笔中 2 笔退款（50% > 30%），1 笔 APPROVED 待处置
    await seed(storage, [
      makeCommission('bad', 'REFUNDED'),
      makeCommission('bad', 'REFUNDED'),
      makeCommission('bad', 'APPROVED'),
      makeCommission('bad', 'PAID'),
      // good：3 笔 0 退款
      makeCommission('good', 'PAID'),
      makeCommission('good', 'APPROVED'),
      makeCommission('good', 'PENDING'),
    ]);

    const report = await runPeriodicAudit({ storage, now: NOW });
    expect(report.scannedCommissions).toBe(7);
    expect(report.highRiskReferrers).toHaveLength(1);
    const risk = report.highRiskReferrers[0];
    expect(risk.referrerUserId).toBe('bad');
    expect(risk.refundRate).toBe(0.5);
    expect(risk.assessment.reasons).toContain('high_refund_rate');
    expect(risk.flaggedCommissionIds).toHaveLength(1);
    expect(report.flaggedCount).toBe(1);

    const queue = await storage.listAuditQueue({ status: 'PENDING' });
    expect(queue).toHaveLength(1);
    expect(queue[0].reason).toBe('PERIODIC_AUDIT');
  });

  it('重复执行幂等：第二轮不重复入队', async () => {
    const storage = new InMemoryCommissionStorage();
    await seed(storage, [
      makeCommission('bad', 'REFUNDED'),
      makeCommission('bad', 'REFUNDED'),
      makeCommission('bad', 'APPROVED'),
    ]);
    const first = await runPeriodicAudit({ storage, now: NOW });
    const second = await runPeriodicAudit({ storage, now: NOW });
    expect(first.flaggedCount).toBe(1);
    expect(second.flaggedCount).toBe(0);
    expect(await storage.listAuditQueue()).toHaveLength(1);
  });

  it('clawbackSuspicious=true：未打款佣金条件流转为 REJECTED，PAID 不动', async () => {
    const storage = new InMemoryCommissionStorage();
    const approved = makeCommission('bad', 'APPROVED');
    const paid = makeCommission('bad', 'PAID');
    await seed(storage, [makeCommission('bad', 'REFUNDED'), makeCommission('bad', 'REFUNDED'), approved, paid]);

    const report = await runPeriodicAudit({ storage, now: NOW, clawbackSuspicious: true });
    expect(report.clawedBackCount).toBe(1);
    expect((await storage.getCommissionById(approved.id))?.status).toBe('REJECTED');
    expect((await storage.getCommissionById(paid.id))?.status).toBe('PAID');
    // 追回模式下不入审核队列
    expect(await storage.listAuditQueue()).toHaveLength(0);
  });

  it('笔数不足 minCommissions 不评估（防 1 笔退款 100% 误伤）', async () => {
    const storage = new InMemoryCommissionStorage();
    await seed(storage, [makeCommission('tiny', 'REFUNDED'), makeCommission('tiny', 'APPROVED')]);
    const report = await runPeriodicAudit({ storage, now: NOW });
    expect(report.highRiskReferrers).toHaveLength(0);
  });

  it('窗口外佣金不参与扫描', async () => {
    const storage = new InMemoryCommissionStorage();
    await seed(storage, [
      makeCommission('old', 'REFUNDED', 40),
      makeCommission('old', 'REFUNDED', 40),
      makeCommission('old', 'APPROVED', 40),
    ]);
    const report = await runPeriodicAudit({ storage, now: NOW, windowDays: 30 });
    expect(report.scannedCommissions).toBe(0);
    expect(report.highRiskReferrers).toHaveLength(0);
  });

  it('分页扫描完整覆盖（pageSize 小于总量）', async () => {
    const storage = new InMemoryCommissionStorage();
    const rows: CommissionRow[] = [];
    for (let i = 0; i < 5; i += 1) rows.push(makeCommission('bulk', i < 3 ? 'REFUNDED' : 'APPROVED'));
    await seed(storage, rows);
    const report = await runPeriodicAudit({ storage, now: NOW, pageSize: 2 });
    expect(report.scannedCommissions).toBe(5);
    expect(report.highRiskReferrers[0]?.refundRate).toBe(0.6);
  });
});

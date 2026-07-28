/**
 * payout-reconcile.ts 单元测试（Phase 3 双向对账 + 月度财务报表）。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCommissionStorage } from './storage-memory.js';
import { generateMonthlyPayoutReport, reconcilePayouts } from './payout-reconcile.js';
import type {
  CommissionRow,
  PayoutProvider,
  PayoutRow,
  PayoutStatus,
  ProviderTransaction,
} from './types.js';

const JULY_10 = new Date('2026-07-10T00:00:00Z');
let seq = 0;

function makePayout(patch: Partial<PayoutRow>): PayoutRow {
  seq += 1;
  return {
    id: `po_${seq}`,
    referrerUserId: 'referrer',
    commissionIds: [],
    amount: 5000,
    currency: 'usd',
    feeAmount: 25,
    provider: 'PAYPAL',
    providerTransactionId: `tx_${seq}`,
    idempotencyKey: `po_${seq}`,
    status: 'SUCCEEDED',
    failureReason: null,
    createdAt: JULY_10,
    processedAt: JULY_10,
    settledAt: JULY_10,
    ...patch,
  };
}

function makeProvider(txs: ProviderTransaction[]): PayoutProvider {
  return {
    name: 'PAYPAL',
    isRecipientReady: async () => ({ ready: true }),
    createPayout: async () => ({ providerTransactionId: 'x', status: 'PROCESSING' as PayoutStatus }),
    getPayoutStatus: async () => 'PROCESSING' as PayoutStatus,
    handleProviderEvent: async () => null,
    listTransactions: async () => txs,
  };
}

function tx(id: string, patch?: Partial<ProviderTransaction>): ProviderTransaction {
  return { providerTransactionId: id, amount: 5000, currency: 'usd', status: 'SUCCEEDED', createdAt: JULY_10, ...patch };
}

const RANGE = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

describe('reconcilePayouts', () => {
  it('双侧一致 → matched，无差异', async () => {
    const storage = new InMemoryCommissionStorage();
    const p1 = makePayout({});
    await storage.insertPayout(p1);
    const report = await reconcilePayouts({
      storage,
      provider: makeProvider([tx(p1.providerTransactionId!)]),
      ...RANGE,
    });
    expect(report.matched).toBe(1);
    expect(report.mismatches).toHaveLength(0);
  });

  it('四类差异：内部缺/通道缺/状态不一致/金额不一致', async () => {
    const storage = new InMemoryCommissionStorage();
    const missing = makePayout({}); // 通道无此流水
    const statusDiff = makePayout({ status: 'PROCESSING' }); // 通道已 SUCCEEDED，内部未收到回调
    const amountDiff = makePayout({ amount: 5000 }); // 通道金额 4000
    await storage.insertPayout(missing);
    await storage.insertPayout(statusDiff);
    await storage.insertPayout(amountDiff);

    const report = await reconcilePayouts({
      storage,
      provider: makeProvider([
        tx(statusDiff.providerTransactionId!),
        tx(amountDiff.providerTransactionId!, { amount: 4000 }),
        tx('tx_ghost'), // 内部无记录（绕过系统的打款）
      ]),
      ...RANGE,
    });
    const kinds = report.mismatches.map((m) => m.kind).sort();
    expect(kinds).toEqual(['AMOUNT_MISMATCH', 'MISSING_INTERNAL', 'MISSING_IN_PROVIDER', 'STATUS_MISMATCH']);
    expect(report.matched).toBe(0);
    const ghost = report.mismatches.find((m) => m.kind === 'MISSING_INTERNAL');
    expect(ghost?.providerTransactionId).toBe('tx_ghost');
  });

  it('未提交通道的记录（无 providerTransactionId）计入 pendingSubmission 不算差异', async () => {
    const storage = new InMemoryCommissionStorage();
    await storage.insertPayout(makePayout({ providerTransactionId: null, status: 'CREATED' }));
    const report = await reconcilePayouts({ storage, provider: makeProvider([]), ...RANGE });
    expect(report.pendingSubmission).toBe(1);
    expect(report.mismatches).toHaveLength(0);
  });

  it('时段外与其他通道的记录不参与对账', async () => {
    const storage = new InMemoryCommissionStorage();
    await storage.insertPayout(makePayout({ createdAt: new Date('2026-06-01T00:00:00Z') }));
    await storage.insertPayout(makePayout({ provider: 'STRIPE_CONNECT' }));
    const report = await reconcilePayouts({ storage, provider: makeProvider([]), ...RANGE });
    expect(report.internalCount).toBe(0);
  });
});

describe('generateMonthlyPayoutReport', () => {
  function makeCommission(patch: Partial<CommissionRow>): CommissionRow {
    seq += 1;
    return {
      id: `c_${seq}`,
      referrerUserId: 'referrer',
      orderId: `order_${seq}`,
      planKey: 'pro',
      amount: 2000,
      currency: 'usd',
      rateBreakdown: [],
      grantStatus: 'NOT_APPLICABLE',
      tierLevel: 1,
      status: 'APPROVED',
      reviewStatus: 'AUTO_APPROVED',
      validUntil: JULY_10,
      createdAt: JULY_10,
      ...patch,
    };
  }

  it('按月汇总打款（状态/币种/通道分组）与佣金账目', async () => {
    const storage = new InMemoryCommissionStorage();
    await storage.insertPayout(makePayout({ amount: 5000, feeAmount: 25 }));
    await storage.insertPayout(makePayout({ amount: 3000, feeAmount: 25, status: 'FAILED' }));
    await storage.insertPayout(
      makePayout({ amount: 8000, feeAmount: 0, provider: 'STRIPE_CONNECT', currency: 'eur' }),
    );
    // 月外打款不计入
    await storage.insertPayout(makePayout({ createdAt: new Date('2026-06-15T00:00:00Z') }));
    // 佣金：2 笔当月（1 笔退款），1 笔月外
    await storage.insertCommission(makeCommission({}));
    await storage.insertCommission(makeCommission({ status: 'REFUNDED', amount: 1500 }));
    await storage.insertCommission(makeCommission({ createdAt: new Date('2026-08-02T00:00:00Z') }));

    const report = await generateMonthlyPayoutReport({ storage, year: 2026, month: 7 });
    expect(report.payouts.total).toBe(3);
    expect(report.payouts.byStatus).toEqual({ SUCCEEDED: 2, FAILED: 1 });
    expect(report.payouts.succeededCents).toBe(13000);
    expect(report.payouts.feeCents).toBe(50);
    expect(report.payouts.byCurrency.usd).toEqual({ count: 2, succeededCents: 5000 });
    expect(report.payouts.byProvider.STRIPE_CONNECT).toEqual({ count: 1, succeededCents: 8000 });
    expect(report.commissions).toEqual({
      created: 2,
      createdCents: 3500,
      refunded: 1,
      refundedCents: 1500,
    });
  });
});

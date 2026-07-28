/**
 * 打款腿结算服务（Phase 2；对应 docs/COMMISSION-SYSTEM-SPEC.md 4.1 Payout / 6.4 PayoutProvider）
 *
 * 防重复打款的两道闸（5.4.1）：
 * - Layer 3：逐笔佣金 APPROVED → PAID 条件流转，竞争失败的佣金被剔除出本次打款
 * - Layer 4：payout.id 即 idempotencyKey，透传给通道（同 key 重复调用不会重复付款）
 *
 * 状态回滚约定（由本服务统一执行，Provider 只汇报状态）：
 * FAILED / RETURNED → 关联佣金回滚 PAID → APPROVED（可重新提现）
 */
import { randomUUID } from 'node:crypto';
import type { BillingLogger } from '../config.js';
import type { CommissionEngine } from './engine.js';
import type {
  CommissionRow,
  PayoutProvider,
  PayoutRow,
  PayoutStatus,
} from './types.js';

/** 打款状态机合法流转表（单向；重复回调/乱序回调一律拒绝） */
const PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  CREATED: ['PROCESSING', 'SUCCEEDED', 'FAILED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'UNCLAIMED'],
  UNCLAIMED: ['SUCCEEDED', 'RETURNED'],
  SUCCEEDED: [],
  FAILED: [],
  RETURNED: [],
};

/** 终态失败：关联佣金需回滚为 APPROVED */
const ROLLBACK_STATUSES: PayoutStatus[] = ['FAILED', 'RETURNED'];

/**
 * 线下打款通道（开箱即用）：不对接任何外部 API，
 * createPayout 后停在 PROCESSING，由管理员线下转账后调用
 * PayoutService.applyProviderStatus 人工标记 SUCCEEDED / FAILED。
 */
export class ManualPayoutProvider implements PayoutProvider {
  readonly name = 'MANUAL' as const;

  async isRecipientReady(): Promise<{ ready: boolean; missingSteps?: string[] }> {
    return { ready: true };
  }

  async createPayout(input: { payoutId: string }): Promise<{ providerTransactionId: string; status: PayoutStatus }> {
    return { providerTransactionId: `manual_${input.payoutId}`, status: 'PROCESSING' };
  }

  async getPayoutStatus(): Promise<PayoutStatus> {
    return 'PROCESSING'; // 线下通道无侧状态，以内部记录为准
  }

  async handleProviderEvent(): Promise<null> {
    return null; // 线下通道无回调事件
  }

  async listTransactions(): Promise<never[]> {
    return []; // 线下通道无流水可对账
  }
}

export interface PayoutServiceOptions {
  engine: CommissionEngine;
  provider: PayoutProvider;
  logger?: BillingLogger;
}

export interface CreatePayoutInput {
  referrerUserId: string;
  /** 指定结算的佣金 ID；缺省结算该推荐人全部 APPROVED 佣金（单次上限 100 笔） */
  commissionIds?: string[];
  /** 通道手续费 cents（如 PayPal $0.25/笔），仅记账 */
  feeAmount?: number;
  now?: Date;
}

export interface CreatePayoutResult {
  created: boolean;
  reason?: 'RECIPIENT_NOT_READY' | 'NO_PAYABLE_COMMISSIONS' | 'PROVIDER_ERROR';
  /** RECIPIENT_NOT_READY 时通道返回的补齐步骤（如 Connect onboarding 链接） */
  missingSteps?: string[];
  payout?: PayoutRow;
}

export class PayoutService {
  private engine: CommissionEngine;
  private provider: PayoutProvider;
  private logger?: BillingLogger;

  constructor(opts: PayoutServiceOptions) {
    this.engine = opts.engine;
    this.provider = opts.provider;
    this.logger = opts.logger;
  }

  get providerName() {
    return this.provider.name;
  }

  /**
   * 发起一次批量结算打款。
   * 流程：账户就绪检查 → 收集 APPROVED 佣金 → 逐笔 Layer 3 流转 PAID →
   * 落库 Payout（Layer 4 幂等键）→ 提交通道 → 通道异常时整体回滚。
   */
  async createPayout(input: CreatePayoutInput): Promise<CreatePayoutResult> {
    const storage = this.engine.storage;
    const now = input.now ?? new Date();

    // 1. 收款账户就绪检查
    const readiness = await this.provider.isRecipientReady(input.referrerUserId);
    if (!readiness.ready) {
      return { created: false, reason: 'RECIPIENT_NOT_READY', missingSteps: readiness.missingSteps };
    }

    // 2. 收集候选佣金：显式指定或全部 APPROVED；校验归属，币种以首笔为准（混币种拆多次打款）
    const candidates = await this.collectCandidates(input);
    if (!candidates.length) {
      return { created: false, reason: 'NO_PAYABLE_COMMISSIONS' };
    }
    const currency = candidates[0]!.currency;
    const sameCurrency = candidates.filter((c) => c.currency === currency);

    // 3. Layer 3：逐笔 APPROVED → PAID，竞争失败（已在别的打款中/已退款）的剔除
    const locked: CommissionRow[] = [];
    for (const c of sameCurrency) {
      const ok = await this.engine.markCommissionPaid(c.id);
      if (ok) locked.push(c);
    }
    if (!locked.length) {
      return { created: false, reason: 'NO_PAYABLE_COMMISSIONS' };
    }

    // 4. 落库打款记录（idempotencyKey = payout.id，唯一约束防重复入账）
    const payoutId = randomUUID();
    const row: PayoutRow = {
      id: payoutId,
      referrerUserId: input.referrerUserId,
      commissionIds: locked.map((c) => c.id),
      amount: locked.reduce((sum, c) => sum + c.amount, 0),
      currency,
      feeAmount: input.feeAmount ?? 0,
      provider: this.provider.name,
      providerTransactionId: null,
      idempotencyKey: payoutId,
      status: 'CREATED',
      failureReason: null,
      createdAt: now,
      processedAt: null,
      settledAt: null,
    };
    const inserted = await storage.insertPayout(row);
    if (!inserted) {
      // 理论不可达（uuid 冲突）；保守回滚已锁佣金
      await this.rollbackCommissions(row.commissionIds);
      return { created: false, reason: 'PROVIDER_ERROR' };
    }

    // 5. 提交通道（idempotencyKey 透传，Layer 4）；异常 → 打款 FAILED + 佣金回滚
    try {
      const result = await this.provider.createPayout({
        payoutId,
        referrerUserId: input.referrerUserId,
        amount: row.amount,
        currency,
      });
      const settled = result.status === 'SUCCEEDED';
      await storage.updatePayoutStatus(payoutId, {
        status: result.status,
        providerTransactionId: result.providerTransactionId,
        processedAt: now,
        ...(settled ? { settledAt: now } : {}),
      });
      row.status = result.status;
      row.providerTransactionId = result.providerTransactionId;
      row.processedAt = now;
      if (settled) row.settledAt = now;
      this.logger?.info('commission.payout.created', {
        payoutId,
        amount: row.amount,
        commissionCount: row.commissionIds.length,
        provider: this.provider.name,
        status: result.status,
      });
      return { created: true, payout: row };
    } catch (err) {
      await storage.updatePayoutStatus(payoutId, {
        status: 'FAILED',
        failureReason: String(err),
        processedAt: now,
      });
      await this.rollbackCommissions(row.commissionIds);
      this.logger?.error('commission.payout.provider_failed', { payoutId, error: String(err) });
      return { created: false, reason: 'PROVIDER_ERROR' };
    }
  }

  /**
   * 应用通道侧状态变更（webhook 回调 / 轮询 / MANUAL 通道人工标记）。
   * 状态机把关：非法流转（重复回调/乱序）返回 false；FAILED/RETURNED 自动回滚佣金。
   */
  async applyProviderStatus(
    payoutId: string,
    status: PayoutStatus,
    opts?: { failureReason?: string; providerTransactionId?: string; now?: Date },
  ): Promise<boolean> {
    const storage = this.engine.storage;
    const payout = await storage.getPayout(payoutId);
    if (!payout) return false;
    if (!PAYOUT_TRANSITIONS[payout.status].includes(status)) {
      this.logger?.warn('commission.payout.transition_rejected', {
        payoutId,
        from: payout.status,
        to: status,
      });
      return false;
    }

    const now = opts?.now ?? new Date();
    await storage.updatePayoutStatus(payoutId, {
      status,
      ...(opts?.providerTransactionId ? { providerTransactionId: opts.providerTransactionId } : {}),
      ...(opts?.failureReason ? { failureReason: opts.failureReason } : {}),
      ...(payout.processedAt ? {} : { processedAt: now }),
      ...(status === 'SUCCEEDED' ? { settledAt: now } : {}),
    });

    if (ROLLBACK_STATUSES.includes(status)) {
      await this.rollbackCommissions(payout.commissionIds);
      this.logger?.warn('commission.payout.rolled_back', { payoutId, status });
    } else {
      this.logger?.info('commission.payout.status_updated', { payoutId, status });
    }
    return true;
  }

  /** 处理通道回调事件（Connect webhook / PayPal IPN）；无关事件返回 null */
  async handleProviderEvent(rawEvent: unknown): Promise<{ payoutId: string; status: PayoutStatus } | null> {
    const change = await this.provider.handleProviderEvent(rawEvent);
    if (!change) return null;
    await this.applyProviderStatus(change.payoutId, change.status);
    return change;
  }

  /** 打款失败/退回：关联佣金回滚 PAID → APPROVED（条件流转，天然幂等） */
  private async rollbackCommissions(commissionIds: string[]): Promise<void> {
    for (const id of commissionIds) {
      await this.engine.storage.transitionCommissionStatus(id, ['PAID'], 'APPROVED');
    }
  }

  /** 收集候选佣金：显式 ID 逐条回查校验，缺省取该推荐人全部 APPROVED（上限 100） */
  private async collectCandidates(input: CreatePayoutInput): Promise<CommissionRow[]> {
    const storage = this.engine.storage;
    if (input.commissionIds?.length) {
      const rows: CommissionRow[] = [];
      for (const id of input.commissionIds) {
        const row = await storage.getCommissionById(id);
        // 归属与状态校验：不属于该推荐人 / 非 APPROVED 的静默剔除
        if (row && row.referrerUserId === input.referrerUserId && row.status === 'APPROVED') {
          rows.push(row);
        }
      }
      return rows;
    }
    const all = await storage.listCommissionsByReferrer(input.referrerUserId, { limit: 100 });
    return all.filter((c) => c.status === 'APPROVED');
  }
}

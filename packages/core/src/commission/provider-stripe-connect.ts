/**
 * Stripe Connect 打款通道（对应 docs/COMMISSION-SYSTEM-SPEC.md 6.4 / Phase 3）。
 *
 * 用 Transfers API 向 Connected Account 转账（同币种余额转账，同步完成）：
 * - referrerUserId → Connected Account ID 的映射由产品侧注入（resolveAccountId），
 *   core 不存储收款账户档案；
 * - 幂等：transfers.create 携带 idempotencyKey = payoutId（Layer 4）；
 * - 转账即时生效 → SUCCEEDED；后续全额 reversal 事件（transfer.reversed）→ RETURNED，
 *   PayoutService 收到后自动把关联佣金回滚为 APPROVED。
 */
import type Stripe from 'stripe';
import type { PayoutProvider, PayoutStatus, ProviderTransaction } from './types.js';

export interface StripeConnectProviderOptions {
  stripe: Stripe;
  /**
   * 推荐人 → Connected Account ID（acct_xxx）映射。
   * 未完成 onboarding 的用户返回 null（isRecipientReady 将提示先完成开户）。
   */
  resolveAccountId(referrerUserId: string): Promise<string | null>;
}

/** transfer → 打款状态：全额冲回视为 RETURNED，否则成功 */
function transferStatus(transfer: Stripe.Transfer): PayoutStatus {
  return transfer.reversed ? 'RETURNED' : 'SUCCEEDED';
}

export class StripeConnectProvider implements PayoutProvider {
  readonly name = 'STRIPE_CONNECT' as const;
  private readonly stripe: Stripe;
  private readonly resolveAccountId: StripeConnectProviderOptions['resolveAccountId'];

  constructor(opts: StripeConnectProviderOptions) {
    this.stripe = opts.stripe;
    this.resolveAccountId = opts.resolveAccountId;
  }

  /** onboarding 完成且收付能力就绪才可打款 */
  async isRecipientReady(referrerUserId: string): Promise<{ ready: boolean; missingSteps?: string[] }> {
    const accountId = await this.resolveAccountId(referrerUserId);
    if (!accountId) {
      return { ready: false, missingSteps: ['connect_onboarding'] };
    }
    const account = await this.stripe.accounts.retrieve(accountId);
    const missingSteps: string[] = [];
    if (!account.payouts_enabled) missingSteps.push('payouts_enabled');
    if (!account.details_submitted) missingSteps.push('details_submitted');
    return missingSteps.length ? { ready: false, missingSteps } : { ready: true };
  }

  async createPayout(input: {
    payoutId: string;
    referrerUserId: string;
    amount: number;
    currency: string;
  }): Promise<{ providerTransactionId: string; status: PayoutStatus }> {
    const accountId = await this.resolveAccountId(input.referrerUserId);
    if (!accountId) {
      throw new Error(`Stripe Connect 账户不存在：${input.referrerUserId}`);
    }
    // Layer 4：idempotencyKey = payoutId，Stripe 侧保证同 key 不重复转账
    const transfer = await this.stripe.transfers.create(
      {
        amount: input.amount,
        currency: input.currency,
        destination: accountId,
        metadata: { payoutId: input.payoutId, referrerUserId: input.referrerUserId },
      },
      { idempotencyKey: input.payoutId },
    );
    return { providerTransactionId: transfer.id, status: transferStatus(transfer) };
  }

  async getPayoutStatus(providerTransactionId: string): Promise<PayoutStatus> {
    const transfer = await this.stripe.transfers.retrieve(providerTransactionId);
    return transferStatus(transfer);
  }

  /** 处理 Connect webhook：transfer.reversed → RETURNED（佣金由 PayoutService 回滚） */
  async handleProviderEvent(rawEvent: unknown): Promise<{ payoutId: string; status: PayoutStatus } | null> {
    const event = rawEvent as Stripe.Event | null;
    if (!event || event.type !== 'transfer.reversed') return null;
    const transfer = event.data.object as Stripe.Transfer;
    const payoutId = transfer.metadata?.payoutId;
    if (!payoutId) return null;
    return { payoutId, status: 'RETURNED' };
  }

  /** 对账：拉取时段内全部 transfers（自动翻页） */
  async listTransactions(from: Date, to: Date): Promise<ProviderTransaction[]> {
    const result: ProviderTransaction[] = [];
    const params: Stripe.TransferListParams = {
      created: { gte: Math.floor(from.getTime() / 1000), lte: Math.floor(to.getTime() / 1000) },
      limit: 100,
    };
    for await (const transfer of this.stripe.transfers.list(params)) {
      result.push({
        providerTransactionId: transfer.id,
        amount: transfer.amount,
        currency: transfer.currency,
        status: transferStatus(transfer),
        createdAt: new Date(transfer.created * 1000),
      });
    }
    return result;
  }
}

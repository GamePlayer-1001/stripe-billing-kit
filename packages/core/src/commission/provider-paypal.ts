/**
 * PayPal Payouts 打款通道（对应 docs/COMMISSION-SYSTEM-SPEC.md 6.4 / Phase 3）。
 *
 * 零额外依赖：直接用全局 fetch 调 PayPal REST API（Node 18+）。
 * - 推荐人 → PayPal 收款邮箱映射由产品侧注入（resolveReceiverEmail）；
 * - 幂等：sender_batch_id = payoutId（PayPal 侧同 batch id 不重复打款，Layer 4）；
 * - PayPal Payouts 为异步：PENDING/PROCESSING → SUCCESS/FAILED/UNCLAIMED；
 *   UNCLAIMED（邮箱未认领）30 天后自动退回 → RETURNED，
 *   PayoutService 收到后自动把关联佣金回滚为 APPROVED；
 * - 税务提示：走 PayPal 时平台需自行收集 W-9/W-8BEN（美国 $600/年 门槛）。
 */
import type { PayoutProvider, PayoutStatus, ProviderTransaction } from './types.js';

export interface PayPalProviderOptions {
  clientId: string;
  clientSecret: string;
  /** sandbox 走 api-m.sandbox.paypal.com，live 走 api-m.paypal.com */
  mode: 'sandbox' | 'live';
  /** 推荐人 → PayPal 收款邮箱；未填写返回 null（isRecipientReady 提示补邮箱） */
  resolveReceiverEmail(referrerUserId: string): Promise<string | null>;
  /** 打款邮件主题（默认中文通用文案） */
  emailSubject?: string;
  /** 测试注入用；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

/** PayPal transaction_status / batch_status → 内部打款状态 */
export function mapPayPalStatus(status: string): PayoutStatus {
  switch (status.toUpperCase()) {
    case 'SUCCESS':
      return 'SUCCEEDED';
    case 'UNCLAIMED':
      return 'UNCLAIMED';
    case 'RETURNED':
    case 'REFUNDED':
    case 'REVERSED':
      return 'RETURNED';
    case 'FAILED':
    case 'DENIED':
    case 'BLOCKED':
    case 'CANCELED':
      return 'FAILED';
    // PENDING / PROCESSING / ONHOLD / NEW 等中间态
    default:
      return 'PROCESSING';
  }
}

/** PayPal webhook 事件类型 → 内部打款状态（无关事件返回 null） */
const PAYPAL_EVENT_STATUS: Record<string, PayoutStatus> = {
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.DENIED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'RETURNED',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED': 'RETURNED',
};

export class PayPalProvider implements PayoutProvider {
  readonly name = 'PAYPAL' as const;
  private readonly opts: PayPalProviderOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** OAuth token 缓存（过期前 60 秒刷新） */
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: PayPalProviderOptions) {
    this.opts = opts;
    this.baseUrl =
      opts.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal OAuth 失败：HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PayPal API 失败：${method} ${path} HTTP ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  /** 收款邮箱已填写即视为就绪（PayPal 无 onboarding 流程） */
  async isRecipientReady(referrerUserId: string): Promise<{ ready: boolean; missingSteps?: string[] }> {
    const email = await this.opts.resolveReceiverEmail(referrerUserId);
    return email ? { ready: true } : { ready: false, missingSteps: ['paypal_email'] };
  }

  async createPayout(input: {
    payoutId: string;
    referrerUserId: string;
    amount: number;
    currency: string;
  }): Promise<{ providerTransactionId: string; status: PayoutStatus }> {
    const email = await this.opts.resolveReceiverEmail(input.referrerUserId);
    if (!email) throw new Error(`PayPal 收款邮箱未填写：${input.referrerUserId}`);
    // Layer 4：sender_batch_id = payoutId，PayPal 侧同 batch id 不重复打款
    const data = await this.request<{
      batch_header: { payout_batch_id: string; batch_status: string };
    }>('POST', '/v1/payments/payouts', {
      sender_batch_header: {
        sender_batch_id: input.payoutId,
        email_subject: this.opts.emailSubject ?? '您有一笔佣金到账',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: email,
          amount: { value: (input.amount / 100).toFixed(2), currency: input.currency.toUpperCase() },
          sender_item_id: input.payoutId,
        },
      ],
    });
    return {
      providerTransactionId: data.batch_header.payout_batch_id,
      status: mapPayPalStatus(data.batch_header.batch_status),
    };
  }

  async getPayoutStatus(providerTransactionId: string): Promise<PayoutStatus> {
    const data = await this.request<{
      batch_header: { batch_status: string };
      items?: Array<{ transaction_status?: string }>;
    }>('GET', `/v1/payments/payouts/${providerTransactionId}`);
    // 单笔打款以 item 状态为准（UNCLAIMED 等只体现在 item 上），无 item 时退化用 batch 状态
    const itemStatus = data.items?.[0]?.transaction_status;
    return mapPayPalStatus(itemStatus ?? data.batch_header.batch_status);
  }

  /** 处理 PayPal webhook（PAYMENT.PAYOUTS-ITEM.*）；sender_item_id 即 payoutId */
  async handleProviderEvent(rawEvent: unknown): Promise<{ payoutId: string; status: PayoutStatus } | null> {
    const event = rawEvent as {
      event_type?: string;
      resource?: { payout_item?: { sender_item_id?: string } };
    } | null;
    const status = event?.event_type ? PAYPAL_EVENT_STATUS[event.event_type] : undefined;
    const payoutId = event?.resource?.payout_item?.sender_item_id;
    if (!status || !payoutId) return null;
    return { payoutId, status };
  }

  /** 对账：Transaction Search API 拉取时段流水（需开通 Transaction Search 权限） */
  async listTransactions(from: Date, to: Date): Promise<ProviderTransaction[]> {
    const params = new URLSearchParams({
      start_date: from.toISOString(),
      end_date: to.toISOString(),
      fields: 'transaction_info',
      page_size: '500',
    });
    const data = await this.request<{
      transaction_details?: Array<{
        transaction_info: {
          transaction_id: string;
          transaction_amount: { value: string; currency_code: string };
          transaction_status: string;
          transaction_initiation_date: string;
        };
      }>;
    }>('GET', `/v1/reporting/transactions?${params.toString()}`);
    return (data.transaction_details ?? []).map((d) => ({
      providerTransactionId: d.transaction_info.transaction_id,
      // PayPal 金额为字符串（元），转 cents；负数（出账）取绝对值统一口径
      amount: Math.abs(Math.round(Number(d.transaction_info.transaction_amount.value) * 100)),
      currency: d.transaction_info.transaction_amount.currency_code.toLowerCase(),
      status: mapPayPalStatus(d.transaction_info.transaction_status),
      createdAt: new Date(d.transaction_info.transaction_initiation_date),
    }));
  }
}

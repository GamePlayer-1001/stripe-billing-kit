/**
 * 打款通道单元测试（StripeConnectProvider + PayPalProvider）。
 * 通道 API 全部打桩：Stripe 用假 SDK 对象，PayPal 注入 fetchImpl。
 */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeConnectProvider } from './provider-stripe-connect.js';
import { PayPalProvider, mapPayPalStatus } from './provider-paypal.js';

// ────────────── Stripe Connect ──────────────

function makeFakeStripe(overrides?: {
  account?: Partial<Stripe.Account>;
  transfer?: Partial<Stripe.Transfer>;
}) {
  const transfersCreate = vi.fn(async () => ({ id: 'tr_1', reversed: false, ...overrides?.transfer }));
  const stripe = {
    accounts: {
      retrieve: vi.fn(async () => ({
        payouts_enabled: true,
        details_submitted: true,
        ...overrides?.account,
      })),
    },
    transfers: { create: transfersCreate },
  } as unknown as Stripe;
  return { stripe, transfersCreate };
}

describe('StripeConnectProvider', () => {
  it('无 Connected Account → 未就绪，提示 onboarding', async () => {
    const { stripe } = makeFakeStripe();
    const provider = new StripeConnectProvider({ stripe, resolveAccountId: async () => null });
    expect(await provider.isRecipientReady('u1')).toEqual({
      ready: false,
      missingSteps: ['connect_onboarding'],
    });
  });

  it('payouts 未启用 → 未就绪并列出缺失步骤', async () => {
    const { stripe } = makeFakeStripe({ account: { payouts_enabled: false } });
    const provider = new StripeConnectProvider({ stripe, resolveAccountId: async () => 'acct_1' });
    expect(await provider.isRecipientReady('u1')).toEqual({
      ready: false,
      missingSteps: ['payouts_enabled'],
    });
  });

  it('createPayout 透传 idempotencyKey=payoutId（Layer 4）并返回 SUCCEEDED', async () => {
    const { stripe, transfersCreate } = makeFakeStripe();
    const provider = new StripeConnectProvider({ stripe, resolveAccountId: async () => 'acct_1' });
    const result = await provider.createPayout({
      payoutId: 'po_1',
      referrerUserId: 'u1',
      amount: 5000,
      currency: 'usd',
    });
    expect(result).toEqual({ providerTransactionId: 'tr_1', status: 'SUCCEEDED' });
    expect(transfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5000, currency: 'usd', destination: 'acct_1' }),
      { idempotencyKey: 'po_1' },
    );
  });

  it('transfer.reversed 事件 → RETURNED；无关事件 → null', async () => {
    const { stripe } = makeFakeStripe();
    const provider = new StripeConnectProvider({ stripe, resolveAccountId: async () => 'acct_1' });
    const reversed = await provider.handleProviderEvent({
      type: 'transfer.reversed',
      data: { object: { id: 'tr_1', metadata: { payoutId: 'po_1' } } },
    });
    expect(reversed).toEqual({ payoutId: 'po_1', status: 'RETURNED' });
    expect(await provider.handleProviderEvent({ type: 'invoice.paid', data: { object: {} } })).toBeNull();
  });
});

// ────────────── PayPal ──────────────

/** 按 URL 前缀路由的 fetch 打桩 */
function makeFakeFetch(routes: Array<{ match: string; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const route = routes.find((r) => u.includes(r.match));
    if (!route) throw new Error(`未打桩的请求：${u}`);
    return {
      ok: true,
      status: 200,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const TOKEN_ROUTE = { match: '/v1/oauth2/token', body: { access_token: 'tok', expires_in: 3600 } };

function makePayPal(routes: Array<{ match: string; body: unknown }>, email: string | null = 'a@b.com') {
  const { fetchImpl, calls } = makeFakeFetch([TOKEN_ROUTE, ...routes]);
  const provider = new PayPalProvider({
    clientId: 'cid',
    clientSecret: 'secret',
    mode: 'sandbox',
    resolveReceiverEmail: async () => email,
    fetchImpl,
  });
  return { provider, calls };
}

describe('PayPalProvider', () => {
  it('未填收款邮箱 → 未就绪提示 paypal_email', async () => {
    const { provider } = makePayPal([], null);
    expect(await provider.isRecipientReady('u1')).toEqual({
      ready: false,
      missingSteps: ['paypal_email'],
    });
  });

  it('createPayout：sender_batch_id=payoutId，PENDING 映射为 PROCESSING', async () => {
    const { provider } = makePayPal([
      {
        match: '/v1/payments/payouts',
        body: { batch_header: { payout_batch_id: 'batch_1', batch_status: 'PENDING' } },
      },
    ]);
    const result = await provider.createPayout({
      payoutId: 'po_1',
      referrerUserId: 'u1',
      amount: 2050,
      currency: 'usd',
    });
    expect(result).toEqual({ providerTransactionId: 'batch_1', status: 'PROCESSING' });
  });

  it('getPayoutStatus 以 item 状态为准：UNCLAIMED；token 只取一次（缓存）', async () => {
    const { provider, calls } = makePayPal([
      {
        match: '/v1/payments/payouts/batch_1',
        body: {
          batch_header: { batch_status: 'SUCCESS' },
          items: [{ transaction_status: 'UNCLAIMED' }],
        },
      },
    ]);
    expect(await provider.getPayoutStatus('batch_1')).toBe('UNCLAIMED');
    expect(await provider.getPayoutStatus('batch_1')).toBe('UNCLAIMED');
    expect(calls.filter((u) => u.includes('/v1/oauth2/token'))).toHaveLength(1);
  });

  it('webhook 事件映射：RETURNED 回滚信号 / 无关事件 null', async () => {
    const { provider } = makePayPal([]);
    const returned = await provider.handleProviderEvent({
      event_type: 'PAYMENT.PAYOUTS-ITEM.RETURNED',
      resource: { payout_item: { sender_item_id: 'po_1' } },
    });
    expect(returned).toEqual({ payoutId: 'po_1', status: 'RETURNED' });
    expect(await provider.handleProviderEvent({ event_type: 'CHECKOUT.ORDER.APPROVED' })).toBeNull();
  });

  it('mapPayPalStatus 状态归一', () => {
    expect(mapPayPalStatus('SUCCESS')).toBe('SUCCEEDED');
    expect(mapPayPalStatus('DENIED')).toBe('FAILED');
    expect(mapPayPalStatus('REVERSED')).toBe('RETURNED');
    expect(mapPayPalStatus('ONHOLD')).toBe('PROCESSING');
  });
});

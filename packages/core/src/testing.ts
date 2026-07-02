import type { BillingConfig } from './config.js';
import { memoryStorage } from './storage/memory.js';

/** 单测用最小合法配置(memory 存储;Stripe client 在测试里被替换) */
export function testConfig(overrides?: Partial<BillingConfig>): BillingConfig {
  return {
    stripe: {
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      publishableKey: 'pk_test_123',
    },
    plans: [
      { key: 'pro_monthly', type: 'subscription', ref: { lookupKey: 'pro_monthly' }, features: ['pro'] },
      { key: 'lifetime', type: 'one_time', ref: { priceId: 'price_life_1' }, features: ['pro', 'lifetime'] },
    ],
    urls: {
      checkoutSuccess: 'https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
      checkoutCancel: 'https://app.test/pricing',
      portalReturn: 'https://app.test/account',
    },
    storage: memoryStorage(),
    ...overrides,
  };
}

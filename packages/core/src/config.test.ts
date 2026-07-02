import { describe, expect, it } from 'vitest';
import { createBillingContext } from './config.js';
import { BillingError } from './errors.js';
import { testConfig } from './testing.js';

describe('BillingConfig 校验', () => {
  it('合法配置通过并可重复取得同一 context', () => {
    const config = testConfig();
    const a = createBillingContext(config);
    const b = createBillingContext(config);
    expect(a).toBe(b);
    expect(a.plansByKey.size).toBe(2);
  });

  it('拒绝非法 secret key 前缀', () => {
    const config = testConfig({ stripe: { secretKey: 'bad', webhookSecret: 'whsec_1', publishableKey: 'pk_test_1' } });
    expect(() => createBillingContext(config)).toThrow(BillingError);
    expect(() => createBillingContext(config)).toThrow(/sk_/);
  });

  it('拒绝 test/live 密钥混用', () => {
    const config = testConfig({
      stripe: { secretKey: 'sk_live_1', webhookSecret: 'whsec_1', publishableKey: 'pk_test_1' },
    });
    expect(() => createBillingContext(config)).toThrow(/环境不一致/);
  });

  it('拒绝重复 planKey 与空 features', () => {
    const config = testConfig({
      plans: [
        { key: 'a', type: 'subscription', ref: { lookupKey: 'a' }, features: ['x'] },
        { key: 'a', type: 'one_time', ref: { priceId: 'price_1' }, features: [] },
      ],
    });
    expect(() => createBillingContext(config)).toThrow(/重复/);
    expect(() => createBillingContext(config)).toThrow(/features/);
  });

  it('拒绝缺少 ref 的 plan', () => {
    const config = testConfig({
      plans: [{ key: 'a', type: 'subscription', ref: {} as never, features: ['x'] }],
    });
    expect(() => createBillingContext(config)).toThrow(/lookupKey 或 ref.priceId/);
  });
});
